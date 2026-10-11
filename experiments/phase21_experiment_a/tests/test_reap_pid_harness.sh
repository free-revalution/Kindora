#!/usr/bin/env bash
# test_reap_pid_harness.sh — unit tests for reap_pid() idempotency.
#
# These tests verify the contract of reap_pid() without depending on
# macOS bash 3.2's incidental "second wait returns same exit code"
# behaviour. The contract is:
#
#   reap_pid <pid> <rc_var> <reaped_var>:
#     1. If <reaped_var> is already 1: do nothing, return 0. (Short-circuit.)
#     2. If <pid> is empty: do nothing, leave <rc_var>/<reaped_var> untouched.
#     3. Otherwise: if still alive, TERM, grace-window, KILL. Then `wait`.
#        Write the captured exit code into <rc_var> and 1 into <reaped_var>.
#
# The "doesn't clobber" guarantee is enforced by:
#   - When <reaped_var> is already 1, reap_pid never reaches the `wait`
#     line (the short-circuit returns at the top).
#   - The host/joiner REAPED flags are independent, so a stale reaping
#     of one child cannot affect the other.
#
# IMPORTANT INVARIANT: children must be spawned in the SAME shell that
# eventually calls reap_pid (so that `wait` works). Spawning through
# `$(spawn ...)` runs in a subshell and re-parents the child, breaking
# the contract. Tests therefore spawn inline.
#
# Exit codes: 0 = all pass; non-zero = number of failures.

set -u

# Locate the real script relative to this test file's location, so the
# test works regardless of where the repo is cloned.
TEST_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$TEST_DIR/.." && pwd)
SCRIPT="$PROJECT_ROOT/scripts/run_unicast_test.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FATAL: cannot find run_unicast_test.sh at $SCRIPT" >&2
  echo "  PROJECT_ROOT resolved to: $PROJECT_ROOT" >&2
  exit 2
fi

# Default values that the real script uses.
GRACE_S=2
SKIP_BUILD=0

# Extract reap_pid() and is_alive() from the real script.
eval "$(awk '/^reap_pid\(\) \{/,/^\}/' "$SCRIPT")"
eval "$(awk '/^is_alive\(\) \{/,/^\}/' "$SCRIPT")"

# Counters.
n=0
fail=0
ok_count=0
ok()   { n=$((n + 1)); ok_count=$((ok_count + 1)); echo "OK  [$n] $1"; }
fail() { n=$((n + 1)); fail=$((fail + 1)); echo "FAIL[$n] $1"; }
expect_eq() {
  local label="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    ok "$label: got='$got'"
  else
    fail "$label: expected='$want' got='$got'"
  fi
}

# -----------------------------------------------------------------------------
# First-wait observation helper (INFORMATIONAL ONLY on macOS bash 3.2).
#
# Why informational and not a hard assertion:
#   macOS bash 3.2 has a quirky behaviour where the FIRST background
#   child to deliver SIGCHLD is implicitly reaped (or at least removed
#   from the `jobs` table) before any explicit `wait` runs. Only the
#   most recently terminated background job remains in `jobs -l` (in
#   `Done` state). The job that finished earlier is gone from the
#   table, but that does NOT mean the current shell has called `wait`
#   on it — bash 3.2 also returns 0 (not 127) for a second `wait` on
#   a previously reaped child.
#
#   Concretely: `jobs -l` shows at most ONE Done entry at any time.
#   If we spawned two children in scenario 7 and both finished before
#   the test queried `jobs`, only the second one shows up. The first
#   is unobservable through `jobs`.
#
#   Therefore this helper records what `jobs -l` reports at the
#   observation point. It is NOT a hard assertion — it surfaces the
#   observed platform behaviour as a diagnostic line so the reader
#   can see exactly what the harness saw.
#
# Why this is still better than the previous version:
#   - The test still does NOT call `wait` before `reap_pid` (third-
#     round reviewer's actual complaint about scenario 2/3/7).
#   - reap_pid's INTERNAL `wait` therefore is the only `wait` the
#     test code calls. Even if bash 3.2 silently reaps earlier
#     children via SIGCHLD, reap_pid's `printf -v rc_var` write is
#     what the test asserts on, and bash's silent reap does NOT
#     produce a `printf -v` side effect — only reap_pid does.
#   - The sentinel-overwrite test (rc=55 survives second reap) is
#     still meaningful: even if bash reaps under us, sentinel is set
#     AFTER reap_pid's first printf -v, so the second reap_pid's
#     short-circuit (REAPED=1) protects it.
#
# What this helper does:
#   - Records the `jobs -l` snapshot to stderr before reap_pid.
#   - Does NOT fail if the snapshot doesn't contain the PID.
#   - Does fail if reap_pid's own side-effect (REAPED=1) is missing.
# -----------------------------------------------------------------------------
record_jobs_snapshot() {
  local label="$1" stage="$2" pid="$3"
  local jobs_line
  jobs_line=$(jobs -l 2>/dev/null || true)
  if [[ "$jobs_line" == *"$pid"* ]]; then
    echo "[diag] $label:$stage: jobs lists $pid (current shell has not yet reaped it)" >&2
  else
    echo "[diag] $label:$stage: jobs does NOT list $pid (bash 3.2 may have auto-reaped earlier SIGCHLD; observation unavailable)" >&2
  fi
}

# Defensive cleanup: kill any still-running children we spawned.
cleanup_children() {
  local p
  for p in $(jobs -p); do
    kill -KILL "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
}
trap cleanup_children EXIT

# -----------------------------------------------------------------------------
# collect_descendants_pids <root_pid>
#   Output: space-separated list of ALL descendant PIDs (any depth)
#   under <root_pid>. The root_pid itself is NOT in the output.
#
#   Algorithm: BFS via `pgrep -P`. Each iteration collects the
#   children of every PID in the current frontier, then advances
#   the frontier to those children. Stops when a frontier has no
#   children left.
#
#   Why this is needed (eighth-round review fix):
#     The seventh-round `owned_pids` whitelist was constructed
#     using `pgrep -P "$PID"` — only direct children. That captures
#     at most one level of the process tree. A regression that
#     changes the fixture from a single-process `exec sleep 30`
#     into a deeper tree (e.g. `bash -c "bash -c sleep 30"`) would
#     leave deeper descendants OUT of the whitelist, and cleanup
#     would either (a) miss them entirely or (b) attempt to use
#     `pkill -P $PID` which still only reaches one level. With
#     BFS we capture the entire subtree at observation time, so
#     cleanup is correct for any depth the fixture spawns.
#
#   Why we don't kill "the whole subtree":
#     This function only OBSERVES and returns. Killing is done
#     by the caller, which uses the returned list as the
#     whitelist for explicit PID-based kills (no name pattern).
#
#   PID-reuse caveat:
#     The returned list is captured at observation time T0. If a
#     process in the list dies AND its PID is reused by an
#     unrelated process before our cleanup runs, we would attempt
#     to kill the unrelated process. Mitigations:
#       (1) Each kill is guarded by pid_is_alive (kills -0).
#       (2) Each kill is further guarded by pid_still_in_subtree
#       which verifies the target's parent chain still leads to
#       <root_pid>.
#     Both guards are applied in scenario 5's cleanup paths.
# -----------------------------------------------------------------------------
collect_descendants_pids() {
  local root="$1"
  if [[ -z "$root" ]]; then
    echo ""
    return 0
  fi
  local current="$root"
  local next=""
  local all=""
  local pid children
  while [[ -n "$current" ]]; do
    next=""
    for pid in $current; do
      children=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ' || true)
      children="${children% }"
      [[ -n "$children" ]] && next="$next $children"
      [[ -n "$children" ]] && all="$all $children"
    done
    current="${next# }"
  done
  all="${all# }"
  echo "$all"
}

# pid_is_alive <pid>
#   Returns 0 if <pid> is alive (kill -0 succeeds), 1 otherwise.
#   Used as the first guard before any kill: if the PID is gone,
#   skip the kill entirely (the process may have died naturally,
#   or its PID may have been reused — in either case we don't
#   want to kill whatever now holds that PID number).
pid_is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# pid_still_in_subtree <pid> <root_pid>
#   Returns 0 if walking <pid>'s parent chain reaches <root_pid>.
#   Returns 1 otherwise (chain doesn't include root, or pid is
#   gone). Cycle-protected. This is the second guard against
#   PID reuse: even if some new process now owns <pid>'s
#   number, if its parent chain doesn't end at <root_pid>, we
#   refuse to kill it.
pid_still_in_subtree() {
  local pid="$1"
  local root="$2"
  [[ -z "$pid" || -z "$root" ]] && return 1
  local current="$pid"
  local seen=""
  while [[ -n "$current" && "$current" != "1" && "$current" != "0" ]]; do
    if [[ "$current" == "$root" ]]; then
      return 0
    fi
    # Cycle protection (shouldn't happen in real process trees).
    if [[ " $seen " == *" $current "* ]]; then
      return 1
    fi
    seen="$seen $current"
    current=$(ps -A -o pid,ppid 2>/dev/null \
              | awk -v p="$current" '$1 == p { print $2; exit }')
  done
  return 1
}

# -----------------------------------------------------------------------------
# pid_get_lstart <pid>
#   Output: the lstart (process start time) string for <pid>, with
#   leading/trailing whitespace stripped. Empty output if <pid> is
#   gone (ps can't find it). lstart is a stable identity token:
#   two `ps` calls for the SAME process return the SAME lstart
#   regardless of timing. Two DIFFERENT processes at the SAME
#   PID (PID reuse) return DIFFERENT lstart values (because they
#   started at different times). This is what makes lstart usable
#   as a PID-reuse-detection token: if lstart at observation time
#   differs from lstart at kill time, the PID was reused.
#
#   Why lstart (and not etime):
#     etime is the elapsed time SINCE the process started,
#     computed at the moment `ps` runs. Two `ps` calls for the
#     same process return DIFFERENT etime values (the process
#     has aged by a few microseconds). lstart is the absolute
#     start time — stable across calls.
#
#   Why lstart (and not just parent-chain walking):
#     Parent chains are stable BUT can be reparented (an orphan
#     loses its real parent and gets PPID=1). They also don't
#     distinguish "same PID, same parent, different process"
#     after a reuse. lstart is orthogonal: it depends only on
#     which process currently holds that PID number.
#
#   Format on macOS bash 3.2:
#     "Sun Oct 11 15:24:37 2026"
#   No tabs. Safe to use TAB as the field separator in TSVs.
pid_get_lstart() {
  local pid="$1"
  [[ -z "$pid" ]] && return 1
  ps -p "$pid" -o lstart= 2>/dev/null \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# identity_lookup_lstart <identities_tsv> <pid>
#   Look up the recorded lstart for <pid> in a TSV string.
#   <identities_tsv> format: one "<pid><TAB><lstart>" per line.
#   Returns the lstart string, or empty if <pid> is not in the TSV.
identity_lookup_lstart() {
  local tsv="$1"
  local pid="$2"
  [[ -z "$tsv" || -z "$pid" ]] && return 1
  printf '%s\n' "$tsv" | awk -F'\t' -v p="$pid" '$1 == p { print $2; exit }'
}

# collect_descendants_with_depth <root_pid>
#   Output: one "<depth><TAB><pid>" line per descendant. Root is
#   NOT included (we never need its depth to kill it). Depth 1 =
#   direct children of root; depth 2 = grandchildren; etc.
#
#   BFS over `pgrep -P`, same as collect_descendants_pids, but
#   records the depth of each descendant so callers can sort by
#   real depth (not by PID number, which is unrelated to depth).
#
#   Why a separate function (not just a flag on collect_descendants_pids):
#     The BFS list and the depth-tagged list have different shapes
#     (space-separated PIDs vs TSV). Mixing them in one function
#     would require callers to parse different formats. Cleaner to
#     keep two outputs.
collect_descendants_with_depth() {
  local root="$1"
  if [[ -z "$root" ]]; then
    echo ""
    return 0
  fi
  local current="$root" depth=0 next="" all="" pid="" children="" first=1 line
  while [[ -n "$current" ]]; do
    next=""
    for pid in $current; do
      if [[ "$depth" -gt 0 ]]; then
        line="$depth	$pid"
        if [[ "$first" -eq 1 ]]; then
          all="$line"
          first=0
        else
          all="$all"$'\n'"$line"
        fi
      fi
      children=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ' || true)
      children="${children% }"
      [[ -n "$children" ]] && next="$next $children"
    done
    current="${next# }"
    depth=$((depth + 1))
  done
  echo "$all"
}

# record_identities <root_pid>
#   Output: one "<pid><TAB><lstart>" line per PID in the subtree
#   (including the root). Each lstart is captured at the time
#   this function is called. Callers should call this AT
#   OBSERVATION TIME (before any cleanup), then pass the output
#   to pid_safe_kill_with_identity / pid_safe_kill_orphan as a
#   snapshot of which PIDs were ours at T0.
#
#   PIDs that no longer exist (lstart is empty after ps lookup)
#   are skipped. In practice every PID in a freshly-spawned
#   subtree will have an lstart, but the filter makes the helper
#   robust to a race where a child exits between collect and
#   record.
record_identities() {
  local root="$1"
  [[ -z "$root" ]] && return 0
  local descendants
  descendants=$(collect_descendants_pids "$root")
  local pids="$root"
  [[ -n "$descendants" ]] && pids="$root $descendants"
  local pid lstart first=1 line
  for pid in $pids; do
    lstart=$(pid_get_lstart "$pid")
    if [[ -n "$lstart" ]]; then
      line="$pid	$lstart"
      if [[ "$first" -eq 1 ]]; then
        echo "$line"
        first=0
      else
        echo "$line"
      fi
    fi
  done
}

# pid_safe_kill_with_identity <pid> <root_pid> <identities_tsv> [depth]
#   Sanctioned kill primitive for descendants still expected to
#   be in <root_pid>'s subtree. Kill <pid> ONLY if ALL of:
#     1. PID appears in identities_tsv (we observed it at T0).
#     2. PID is alive (kill -0).
#     3. PID's current lstart matches the lstart we recorded.
#        (Detects PID reuse — if the PID was reused by an
#        unrelated process, lstart differs and we refuse.)
#     4. If root_pid is still alive: PID is still in root's
#        subtree (parent chain leads to root). If root is dead,
#        we skip the subtree check (root's death may have
#        legitimately reparented the descendant, in which case
#        pid_safe_kill_orphan is the right primitive, not this
#        one). The caller decides whether to fall back.
#
#   The optional [depth] arg, when non-empty, is recorded into
#   the kill log (if $KILL_LOG_FILE is set) so verifiers can
#   assert the actual kill order.
#
#   This primitive REPLACES the eighth-round pid_safe_kill for
#   scenario 5 paths where the descendant is still expected to
#   be in the fixture's subtree. The old pid_safe_kill is
#   retained (renamed/refactored) but scenario 5 does not use it.
pid_safe_kill_with_identity() {
  local pid="$1"
  local root="$2"
  local identities_tsv="$3"
  local depth="${4:-}"
  [[ -z "$pid" || -z "$root" || -z "$identities_tsv" ]] && return 0

  # (1) Membership.
  local expected_lstart
  expected_lstart=$(identity_lookup_lstart "$identities_tsv" "$pid")
  [[ -z "$expected_lstart" ]] && return 0

  # (2) Aliveness.
  if ! pid_is_alive "$pid"; then return 0; fi

  # (3) Identity (lstart match).
  local current_lstart
  current_lstart=$(pid_get_lstart "$pid")
  if [[ "$current_lstart" != "$expected_lstart" ]]; then
    # PID reused — refuse to kill. Log so verifiers can observe
    # the refusal if they care.
    if [[ -n "${KILL_LOG_FILE:-}" ]]; then
      printf 'REFUSE pid=%s root=%s reason=pid-reuse expected_lstart=[%s] current_lstart=[%s]\n' \
        "$pid" "$root" "$expected_lstart" "${current_lstart:-<empty>}" \
        >>"$KILL_LOG_FILE"
    fi
    return 0
  fi

  # (4) Subtree check (only if root is alive).
  if pid_is_alive "$root"; then
    if ! pid_still_in_subtree "$pid" "$root"; then
      if [[ -n "${KILL_LOG_FILE:-}" ]]; then
        printf 'REFUSE pid=%s root=%s reason=not-in-subtree\n' \
          "$pid" "$root" >>"$KILL_LOG_FILE"
      fi
      return 0
    fi
  fi

  # All guards passed. Kill and log.
  kill -KILL "$pid" 2>/dev/null || true
  if [[ -n "${KILL_LOG_FILE:-}" ]]; then
    printf 'KILL pid=%s root=%s depth=%s\n' "$pid" "$root" "${depth:-?}" \
      >>"$KILL_LOG_FILE"
  fi
  return 0
}

# pid_safe_kill_orphan <pid> <identities_tsv>
#   Sanctioned kill primitive for descendants that have been
#   reparented to PID 1 (init). Cannot use subtree check (the
#   orphan's parent chain leads to init, not to our root).
#   Kill <pid> ONLY if ALL of:
#     1. PID appears in identities_tsv (we observed it at T0).
#     2. PID is alive (kill -0).
#     3. PID's current lstart matches the lstart we recorded.
#        This is the ONLY proof of identity we have for orphans;
#        without it, a reused PID would be killed.
#
#   This primitive REPLACES the eighth-round pid_safe_kill_owned
#   for scenario 5's post-check 3 (Gap 2) cleanup path.
pid_safe_kill_orphan() {
  local pid="$1"
  local identities_tsv="$2"
  [[ -z "$pid" || -z "$identities_tsv" ]] && return 0

  # (1) Membership.
  local expected_lstart
  expected_lstart=$(identity_lookup_lstart "$identities_tsv" "$pid")
  [[ -z "$expected_lstart" ]] && return 0

  # (2) Aliveness.
  if ! pid_is_alive "$pid"; then return 0; fi

  # (3) Identity (lstart match).
  local current_lstart
  current_lstart=$(pid_get_lstart "$pid")
  if [[ "$current_lstart" != "$expected_lstart" ]]; then
    if [[ -n "${KILL_LOG_FILE:-}" ]]; then
      printf 'REFUSE_ORPHAN pid=%s reason=pid-reuse expected_lstart=[%s] current_lstart=[%s]\n' \
        "$pid" "$expected_lstart" "${current_lstart:-<empty>}" \
        >>"$KILL_LOG_FILE"
    fi
    return 0
  fi

  # All guards passed. Kill and log.
  kill -KILL "$pid" 2>/dev/null || true
  if [[ -n "${KILL_LOG_FILE:-}" ]]; then
    printf 'KILL_ORPHAN pid=%s\n' "$pid" >>"$KILL_LOG_FILE"
  fi
  return 0
}

# pid_safe_kill <pid> <root_pid>
#   Kill <pid> only if it is alive AND still in <root_pid>'s
#   subtree (both guards pass). Otherwise no-op.
#
#   NOTE (ninth round): this is the EIGHTH-ROUND primitive.
#   Scenario 5 does NOT use this directly anymore — it uses
#   pid_safe_kill_with_identity instead, which adds the lstart
#   identity check. This function is retained so the verification
#   scripts can still source the harness to get the full helper
#   set without breaking; it is not used in any cleanup path.
pid_safe_kill() {
  local pid="$1"
  local root="$2"
  [[ -z "$pid" ]] && return 0
  if pid_is_alive "$pid" && pid_still_in_subtree "$pid" "$root"; then
    kill -KILL "$pid" 2>/dev/null || true
    return 0
  fi
  return 0
}

# pid_safe_kill_owned <pid> <whitelist_string>
#   EIGHTH-ROUND primitive. Scenario 5 does NOT use this
#   directly anymore — post-check 3 uses pid_safe_kill_orphan
#   (which adds the lstart identity check). This function is
#   retained so verification scripts that source the helpers
#   don't see a missing-symbol error.
pid_safe_kill_owned() {
  local pid="$1"
  local whitelist="$2"
  [[ -z "$pid" || -z "$whitelist" ]] && return 0
  if [[ " $whitelist " != *" $pid "* ]]; then
    return 0
  fi
  if pid_is_alive "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
    return 0
  fi
  return 0
}

# -----------------------------------------------------------------------------
# Scenario 1: Main flow already waited and set REAPED=1. reap_pid must
# short-circuit and NOT touch the stored exit code or REAPED flag.
#   Proof: HOST_REAP_RC is preset to a sentinel (99) and HOST_REAPED=1.
#   reap_pid must not run `wait` again. If it did, HOST_REAP_RC would be
#   overwritten with the real exit code (0 for sleep 30). The fact that
#   99 survives proves the short-circuit ran first.
# -----------------------------------------------------------------------------
echo "--- Scenario 1: short-circuit when REAPED already 1 (host) ---"
sleep 30 &
PID=$!
sleep 0.3   # ensure child is running
HOST_REAP_RC=99       # sentinel
HOST_REAPED=1         # pretend main flow already captured the exit code
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "scenario1.host_rc_preserved"   "99" "$HOST_REAP_RC"
expect_eq "scenario1.host_reaped_still_1" "1"  "$HOST_REAPED"
kill -KILL "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
unset PID

# -----------------------------------------------------------------------------
# Scenario 1b: Same as scenario 1 but using JOINER_* variables.
# -----------------------------------------------------------------------------
echo "--- Scenario 1b: short-circuit when REAPED already 1 (joiner) ---"
sleep 30 &
PID=$!
sleep 0.3
JOINER_REAP_RC=77
JOINER_REAPED=1
reap_pid "$PID" JOINER_REAP_RC JOINER_REAPED
expect_eq "scenario1b.joiner_rc_preserved"   "77" "$JOINER_REAP_RC"
expect_eq "scenario1b.joiner_reaped_still_1" "1"  "$JOINER_REAPED"
kill -KILL "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
unset PID

# -----------------------------------------------------------------------------
# Scenario 2: Child exited normally, REAPED=0. reap_pid does the FIRST
# (and only allowed) wait. We DO NOT pre-wait.
#
# Fourth-round change: pre-`wait` was removed; replaced with `sleep`
# so the child exits naturally (zombie state) without the current
# shell having called `wait` on it. `record_jobs_snapshot` records
# `jobs -l` state at observation points as a diagnostic line — see
# the function's documentation for why this cannot be a hard
# assertion on macOS bash 3.2.
# -----------------------------------------------------------------------------
echo "--- Scenario 2: reap_pid is the first waiter for a normal-exit child ---"
sleep 0.2 &
PID=$!
# Wait for the child to actually exit (zombie state). DO NOT call `wait`
# here — that would re-parent the wait to the test and make reap_pid's
# internal wait a second wait, which bash 3.2 silently turns into a 0.
sleep 0.4
# Diagnostic: record what `jobs -l` shows before reap_pid. macOS bash 3.2
# may have already auto-reaped this child via SIGCHLD, in which case
# the snapshot will be empty — see record_jobs_snapshot docs.
record_jobs_snapshot "scenario2" "before" "$PID"
HOST_REAP_RC=""
HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
record_jobs_snapshot "scenario2" "after"  "$PID"
expect_eq "scenario2.host_rc_is_0"      "0" "$HOST_REAP_RC"
expect_eq "scenario2.host_reaped_is_1"  "1" "$HOST_REAPED"
unset PID

# -----------------------------------------------------------------------------
# Scenario 3: After reap_pid, calling reap_pid again is a no-op.
# Proof: change REAP_RC to a sentinel AFTER first reap — second reap must
# not overwrite.
#
# Fourth-round change: same as Scenario 2 — no pre-`wait`, jobs state
# recorded via `record_jobs_snapshot`.
# -----------------------------------------------------------------------------
echo "--- Scenario 3: second reap_pid on the same PID is a no-op ---"
sleep 0.2 &
PID=$!
sleep 0.4   # child has exited; do NOT call wait
record_jobs_snapshot "scenario3" "before_first" "$PID"
HOST_REAP_RC=""
HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED   # first reap (and first wait)
expect_eq "scenario3.first_reap_rc_is_0"    "0" "$HOST_REAP_RC"
expect_eq "scenario3.first_reap_reaped_is_1" "1" "$HOST_REAPED"
HOST_REAP_RC=55  # sentinel AFTER first reap
reap_pid "$PID" HOST_REAP_RC HOST_REAPED   # second reap: must NOT touch rc
expect_eq "scenario3.rc_unchanged_after_second_reap" "55" "$HOST_REAP_RC"
expect_eq "scenario3.reaped_still_1"                 "1"  "$HOST_REAPED"
unset PID

# -----------------------------------------------------------------------------
# Scenario 4: Active child is TERM'd by reap_pid.
# -----------------------------------------------------------------------------
echo "--- Scenario 4: active child TERM'd by reap_pid ---"
sleep 30 &
PID=$!
sleep 0.3
HOST_REAP_RC=""
HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "scenario4.rc_is_143"      "143" "$HOST_REAP_RC"
expect_eq "scenario4.reaped_is_1"    "1"   "$HOST_REAPED"
# child should be reaped by reap_pid; ps should not see it
if is_alive "$PID"; then
  fail "scenario4.child_not_alive: ps still sees $PID"
else
  ok "scenario4.child_not_alive"
fi

# -----------------------------------------------------------------------------
# Scenario 5: TERM-ignored child escalates to KILL (137). Uses joiner-side
# variables for host/joiner independence.
#
# Fixture: `bash -c "trap '' TERM; exec sleep 30" &`
#
# The `exec sleep 30` is critical — it replaces the bash subshell's
# process image with `sleep` itself. After exec, $! is the sleep
# process PID, not a bash. When reap_pid later sends TERM, the
# inherited `trap '' TERM` makes the sleep ignore it (because
# signals that ignore disposition is inherited across exec), the
# grace window elapses, reap_pid escalates to KILL, and the SAME
# PID is reaped. No orphan process is left behind.
#
# The pre-fifth-round fixture was `bash -c "trap '' TERM; sleep 30"`
# (no exec). That left a TWO-process tree: an outer bash and an
# inner sleep. reap_pid's KILL targeted the outer bash (the PID
# returned by $!), but the inner sleep survived — bash had
# already forked it — and was adopted by PID 1 (init). The orphan
# ran for the full 30 seconds. ChatGPT caught this in the
# fifth-round review; this scenario now uses `exec` so the
# process tree has exactly one node.
#
# Sixth-round regression guard (closed two gaps ChatGPT flagged in
# cfb2f28).
#   1. Pre-check `scenario5.pre_no_pid_children` FAILURE used to
#      only log a fail and CONTINUE — if the fixture were ever
#      reverted to a non-exec form, reap_pid would then be called
#      on the outer bash, the outer bash would die, the inner
#      sleep would be reparented to init, and the harness would
#      leak an orphan process. Now, if the pre-check fails the
#      scenario ABORTS: the spawned subtree is KILL'd (children
#      FIRST so they die before being reparented, then $PID),
#      reap_pid is NOT called, and the function `return`s
#      immediately so subsequent scenarios still run.
#   2. Post-check `scenario5.post_no_pid_children` used to only
#      query `pgrep -P "$PID"`. That misses orphans that have
#      been REPARENTED to PID 1 (init) — which is exactly the
#      leak mode that motivated the fifth-round fix. Now the
#      scenario records the set of `sleep` PIDs that PID 1 had
#      BEFORE the fixture was spawned, then computes the set
#      difference AFTER reap_pid. Any new sleep PIDs under init
#      are an orphan leak.
#
# Seventh-round isolation hardening (closed over-broad cleanup):
#   The sixth-round cleanup used `pkill -KILL -P 1 sleep` to
#   sweep init's sleep children. That is a test-isolation
#   violation: it would kill ANY sleep under PID 1, including
#   unrelated processes that happen to be there. The seventh
#   round replaces every such cleanup with PID-scoped kills:
#     - Pre-check failure: kill children by PID (whitelisted),
#       then kill $PID.
#     - Post-condition 1: kill $PID only (it's in owned_pids).
#     - Post-condition 2: kill remaining descendants by PID
#       (they were observed as children of $PID — provably ours).
#     - Post-condition 3 (Gap 2 detection): detect new init-sleep
#       PIDs via diff, classify each as "provably ours" (PID was
#       in owned_pids at observation time) vs "unprovable" (any
#       other PID). Kill only the provable ones. Any unprovable
#       ones are left alone and reported as residual — the test
#       does NOT claim cleanup success in that case.
#   This preserves both Gap 1 (pre-check abort) and Gap 2 (orphan
#   detection) while making the cleanup strictly scoped to PIDs
#   this scenario demonstrably created.
# -----------------------------------------------------------------------------
echo "--- Scenario 5: TERM-ignored child escalates to KILL (joiner side) ---"
run_scenario_5() {
  # Baseline: snapshot the set of `sleep` PIDs currently parented
  # to PID 1 (init). Any new entries in this set after reap_pid
  # are orphans created by the fixture or reap_pid.
  # Strip trailing newline so an empty pipeline stays empty (we
  # use empty-string semantics in the diff below, NOT a "(none)"
  # sentinel — that previously caused a spurious FAIL when both
  # before and after were empty).
  local init_sleep_before
  init_sleep_before=$(ps -A -o pid,ppid,comm 2>/dev/null \
    | awk '$2 == 1 && $3 ~ /^sleep/ { print $1 }' | sort -n)
  init_sleep_before=${init_sleep_before%$'\n'}

  # Spawn the TERM-ignoring, single-node process tree.
  bash -c "trap '' TERM; exec sleep 30" &
  local PID=$!
  sleep 0.3

  # Capture the set of PIDs we can PROVABLY attribute to this
  # scenario at observation time. This is the WHITELIST for every
  # kill below — we never target a PID that isn't in this set,
  # so we cannot affect unrelated processes (including unrelated
  # sleep processes that happen to be parented to PID 1).
  #
  # Ninth-round addition: in addition to the PID whitelist, we
  # also capture the lstart (process start time) of every PID
  # in the subtree. lstart is the second proof of identity —
  # even if a PID is reused by an unrelated process before our
  # cleanup runs (rare but possible on a long-running host),
  # comparing lstart at kill time to lstart at observation time
  # detects the reuse and refuses the kill. Without lstart, the
  # whitelist check + alive check would both pass for a reused
  # PID (the new process is alive AND has the same PID number)
  # and we would kill an unrelated process.
  #
  # We keep both:
  #   - owned_pids: simple space-separated PIDs (used for the
  #     membership branch of pid_safe_kill_with_identity /
  #     pid_safe_kill_orphan, and for the provable/unprovable
  #     classification in post-checks 2/3).
  #   - identities_tsv: "<pid><TAB><lstart>" per line (used by
  #     pid_safe_kill_with_identity and pid_safe_kill_orphan
  #     to verify the PID hasn't been reused).
  #
  # Both are captured at the SAME instant (T0 = observation
  # time). The race window between observation and kill is
  # the only window where reuse can slip through; we narrow
  # it by recording lstart immediately before each kill call.
  local fixture_descendants
  fixture_descendants=$(collect_descendants_pids "$PID")
  local owned_pids="$PID"
  if [[ -n "$fixture_descendants" ]]; then
    owned_pids="$PID $fixture_descendants"
  fi
  local identities_tsv
  identities_tsv=$(record_identities "$PID")

  # Pre-condition: with `exec`, $! IS the sleep process — it must
  # have no children. If it does, the fixture is wrong AND any
  # subsequent reap_pid would KILL only the outer shell while the
  # inner sleep gets adopted by init. ABORT the scenario without
  # calling reap_pid — calling reap_pid on a known-leaky fixture
  # would manufacture the very orphan we're trying to prevent.
  #
  # Ninth-round cleanup (this revision):
  #     1. Walk the subtree in REAL DEPTH order (deepest first),
  #        computed by collect_descendants_with_depth. We do NOT
  #        use PID numeric order as a depth proxy — a higher-
  #        numbered PID can be a direct child of a lower-numbered
  #        parent, and a lower-numbered PID can be a grandchild.
  #     2. Within each depth, sort by PID ascending for
  #        determinism (so verifiers can assert a specific kill
  #        sequence, not just "some ordering").
  #     3. Each kill goes through pid_safe_kill_with_identity,
  #        which verifies (a) PID in identities_tsv,
  #        (b) PID alive, (c) lstart matches (PID-reuse guard),
  #        (d) PID still in $PID's subtree.
  #     4. After all descendants are gone, kill $PID itself via
  #        pid_safe_kill_with_identity (identity check still
  #        applies to $PID).
  #     5. wait $PID so subsequent scenarios see a clean state.
  #   No `pkill -KILL -P 1 sleep` of any kind.
  if [[ -n "$fixture_descendants" ]]; then
    fail "scenario5.pre_no_pid_children: $PID has descendants ($fixture_descendants); fixture did not exec — aborting scenario to prevent orphan manufacture"
    # Depth-first kill order. The sort key is depth (descending),
    # then PID (ascending). Tab-separated because depth and PID
    # are guaranteed to be on the same line.
    local depth_pids_sorted
    depth_pids_sorted=$(collect_descendants_with_depth "$PID" \
                          | sort -t$'\t' -k1,1nr -k2,2n)
    local line depth pid
    while IFS=$'\t' read -r depth pid; do
      [[ -z "$pid" ]] && continue
      pid_safe_kill_with_identity "$pid" "$PID" "$identities_tsv" "$depth"
    done <<<"$depth_pids_sorted"
    # Kill the root last.
    pid_safe_kill_with_identity "$PID" "$PID" "$identities_tsv" "0"
    wait "$PID" 2>/dev/null || true
    # Subsequent scenarios still run because we `return` (not `exit`).
    return 1
  fi
  ok "scenario5.pre_no_pid_children ($PID has no children)"

  JOINER_REAP_RC=""
  JOINER_REAPED=0
  reap_pid "$PID" JOINER_REAP_RC JOINER_REAPED
  expect_eq "scenario5.rc_is_137"   "137" "$JOINER_REAP_RC"
  expect_eq "scenario5.reaped_is_1" "1"   "$JOINER_REAPED"

  # Post-condition 1: $PID must be gone.
  if kill -0 "$PID" 2>/dev/null; then
    fail "scenario5.post_pid_dead: $PID still alive after reap_pid"
    # $PID is provably ours. Use pid_safe_kill_with_identity so
    # we re-verify aliveness, lstart (PID-reuse guard), and that
    # $PID is still in its own subtree.
    pid_safe_kill_with_identity "$PID" "$PID" "$identities_tsv" "0"
  else
    ok "scenario5.post_pid_dead ($PID is gone)"
  fi

  # Post-condition 2: no descendant of $PID remains.
  #
  # Ninth-round (problem 2 uniform ownership): every residual
  # PID is classified as provable (in owned_pids) or unprovable.
  # Provable ones are killed via pid_safe_kill_with_identity
  # (membership + alive + lstart + subtree). Unprovable ones
  # are reported as residual with their PIDs, NOT killed.
  #
  # Kill order: deepest-first by REAL depth (not by PID number).
  # We re-query depth from the current pgrep -P because the
  # subtree may have shifted slightly since observation; using
  # observed depths would skip newly-orphaned-to-$PID PIDs.
  local remaining_children
  remaining_children=$(pgrep -P "$PID" 2>/dev/null | tr '\n' ' ' || true)
  remaining_children="${remaining_children% }"
  if [[ -n "$remaining_children" ]]; then
    local provable_residual=""
    local unprovable_residual=""
    local c
    for c in $remaining_children; do
      if [[ " $owned_pids " == *" $c "* ]]; then
        provable_residual="$provable_residual $c"
      else
        unprovable_residual="$unprovable_residual $c"
      fi
    done
    provable_residual="${provable_residual# }"
    unprovable_residual="${unprovable_residual# }"

    # Kill provable ones deepest-first. Build a depth-ordered
    # list restricted to the provable set.
    if [[ -n "$provable_residual" ]]; then
      local depth_pids_sorted
      depth_pids_sorted=$(collect_descendants_with_depth "$PID" \
                            | sort -t$'\t' -k1,1nr -k2,2n \
                            | awk -F'\t' -v prov=" $provable_residual " \
                                'index(prov, " " $2 " ") > 0')
      local line depth pid
      while IFS=$'\t' read -r depth pid; do
        [[ -z "$pid" ]] && continue
        pid_safe_kill_with_identity "$pid" "$PID" "$identities_tsv" "$depth"
      done <<<"$depth_pids_sorted"
    fi

    if [[ -n "$unprovable_residual" ]]; then
      fail "scenario5.post_no_pid_children: $PID has residual PIDs we cannot prove are ours (unprovable=$unprovable_residual; provable_cleaned='${provable_residual:-<none>}'; owned_pids=[$owned_pids]) — leaving residual, NOT claiming cleanup success"
    else
      fail "scenario5.post_no_pid_children: $PID still has children ($remaining_children) — orphan leak"
    fi
  else
    ok "scenario5.post_no_pid_children (no descendants under $PID)"
  fi

  # Post-condition 3 (Gap 2): PID 1 (init) must NOT have any NEW
  # sleep PIDs that weren't there before the fixture was spawned.
  local init_sleep_after
  init_sleep_after=$(ps -A -o pid,ppid,comm 2>/dev/null \
    | awk '$2 == 1 && $3 ~ /^sleep/ { print $1 }' | sort -n)
  init_sleep_after=${init_sleep_after%$'\n'}
  local new_orphans=""
  if [[ -z "$init_sleep_before" && -z "$init_sleep_after" ]]; then
    new_orphans=""
  elif [[ -z "$init_sleep_before" ]]; then
    new_orphans="$init_sleep_after"
  elif [[ -z "$init_sleep_after" ]]; then
    new_orphans=""
  else
    new_orphans=$(comm -13 <(printf '%s\n' "$init_sleep_before") \
                        <(printf '%s\n' "$init_sleep_after") \
                  | grep -v '^$' || true)
  fi
  if [[ -n "$new_orphans" ]]; then
    # Split into "provably ours" (in owned_pids whitelist) and
    # "unprovable" (any other PID). This is the isolation
    # contract: we only ever kill PIDs we can prove belong to
    # this scenario. Unrelated sleep processes under init are
    # NEVER killed by this test.
    local provable_orphans=""
    local unprovable_orphans=""
    local o
    for o in $new_orphans; do
      # Whitespace-tokenized membership check.
      if [[ " $owned_pids " == *" $o "* ]]; then
        provable_orphans="$provable_orphans $o"
      else
        unprovable_orphans="$unprovable_orphans $o"
      fi
    done
    provable_orphans="${provable_orphans# }"
    unprovable_orphans="${unprovable_orphans# }"

    # Kill only the provable ones. The orphans are now under
    # PID 1, NOT under $PID, so we use pid_safe_kill_orphan
    # (membership + lstart identity) instead of
    # pid_safe_kill_with_identity (which requires the target
    # to still be under $PID's subtree). The lstart check is
    # the ONLY proof of identity we have for orphans; without
    # it, a reused PID under init would be killed.
    if [[ -n "$provable_orphans" ]]; then
      for o in $provable_orphans; do
        pid_safe_kill_orphan "$o" "$identities_tsv"
      done
    fi

    if [[ -n "$unprovable_orphans" ]]; then
      # Do NOT kill these — they may belong to an unrelated
      # process that we cannot prove is ours. Report as failure
      # with residual PIDs and do NOT claim cleanup success.
      fail "scenario5.post_no_init_orphans: init adopted sleep PIDs we cannot prove are ours (unprovable=$unprovable_orphans; provable_cleaned='${provable_orphans:-<none>}'; owned_pids=[$owned_pids]; before=[${init_sleep_before:-<empty>}] after=[${init_sleep_after:-<empty>}]) — leaving residual, NOT claiming cleanup success"
    else
      fail "scenario5.post_no_init_orphans: init adopted sleep PIDs we provably created ($provable_orphans) — cleaned; before=[${init_sleep_before:-<empty>}] after=[${init_sleep_after:-<empty>}]"
    fi
  else
    ok "scenario5.post_no_init_orphans (init has no new sleep children; before=[${init_sleep_before:-<empty>}] after=[${init_sleep_after:-<empty>}])"
  fi

  return 0
}
run_scenario_5
# Whatever run_scenario_5 returned (0 on success, 1 on early-abort),
# the harness continues. The fail counter was already incremented
# for the early-abort case via the `fail` helper.

# -----------------------------------------------------------------------------
# Scenario 6: Empty PID does nothing — no wait, no state change.
# -----------------------------------------------------------------------------
echo "--- Scenario 6: empty PID is a no-op ---"
HOST_REAP_RC=88
HOST_REAPED=1
reap_pid "" HOST_REAP_RC HOST_REAPED
expect_eq "scenario6.rc_unchanged"      "88" "$HOST_REAP_RC"
expect_eq "scenario6.reaped_unchanged"  "1"  "$HOST_REAPED"

JOINER_REAP_RC=""
JOINER_REAPED=0
reap_pid "" JOINER_REAP_RC JOINER_REAPED
expect_eq "scenario6b.empty_rc_empty"   ""  "$JOINER_REAP_RC"
expect_eq "scenario6b.empty_reaped_0"   "0" "$JOINER_REAPED"

# -----------------------------------------------------------------------------
# Scenario 7: Host-side and joiner-side variables are independent.
# Reap two distinct children, then verify host sentinel survives a
# joiner re-reap and vice versa.
#
# Fourth-round change: same as Scenarios 2/3 — no pre-`wait`. Jobs
# state recorded via `record_jobs_snapshot` for both PIDs before
# reap_pid runs. On macOS bash 3.2, expect to see one `[diag]` line
# reporting the PID is present in `jobs -l` (the most recently
# terminated child) and one reporting it is absent (the earlier-
# terminated child, which bash 3.2 has auto-cleaned from the table).
# -----------------------------------------------------------------------------
echo "--- Scenario 7: host and joiner variables are independent ---"
sleep 0.2 &
HOST_PID=$!
sleep 0.2 &
JOINER_PID=$!
# Wait for both children to exit naturally. DO NOT call `wait` —
# reap_pid must do the first wait.
sleep 0.5
record_jobs_snapshot "scenario7" "before_host"   "$HOST_PID"
record_jobs_snapshot "scenario7" "before_joiner" "$JOINER_PID"

HOST_REAP_RC=""
HOST_REAPED=0
JOINER_REAP_RC=""
JOINER_REAPED=0
reap_pid "$HOST_PID"   HOST_REAP_RC   HOST_REAPED
reap_pid "$JOINER_PID" JOINER_REAP_RC JOINER_REAPED
expect_eq "scenario7.host_rc"          "0" "$HOST_REAP_RC"
expect_eq "scenario7.joiner_rc"        "0" "$JOINER_REAP_RC"
expect_eq "scenario7.host_reaped"      "1" "$HOST_REAPED"
expect_eq "scenario7.joiner_reaped"    "1" "$JOINER_REAPED"

# Now poison HOST_REAP_RC and call reap_pid on the joiner — host
# sentinel must survive.
HOST_REAP_RC=11  # sentinel
reap_pid "$JOINER_PID" JOINER_REAP_RC JOINER_REAPED
expect_eq "scenario7.host_rc_independent"   "11" "$HOST_REAP_RC"
expect_eq "scenario7.joiner_rc_independent" "0"  "$JOINER_REAP_RC"
expect_eq "scenario7.host_reaped_independent"   "1" "$HOST_REAPED"
expect_eq "scenario7.joiner_reaped_independent" "1" "$JOINER_REAPED"

# Reverse direction: poison JOINER_REAP_RC and re-reap host.
JOINER_REAP_RC=22  # sentinel
reap_pid "$HOST_PID" HOST_REAP_RC HOST_REAPED
expect_eq "scenario7.host_rc_rev"          "11" "$HOST_REAP_RC"
expect_eq "scenario7.joiner_rc_rev"        "22" "$JOINER_REAP_RC"
expect_eq "scenario7.host_reaped_rev"      "1" "$HOST_REAPED"
expect_eq "scenario7.joiner_reaped_rev"    "1" "$JOINER_REAPED"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo "----"
echo "PASS: $ok_count / $n"
if [[ "$fail" -eq 0 ]]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$fail OF $n TESTS FAILED"
  exit 1
fi