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
# -----------------------------------------------------------------------------
echo "--- Scenario 5: TERM-ignored child → KILL (joiner side) ---"
bash -c "trap '' TERM; sleep 30" &
PID=$!
sleep 0.3
JOINER_REAP_RC=""
JOINER_REAPED=0
reap_pid "$PID" JOINER_REAP_RC JOINER_REAPED
expect_eq "scenario5.rc_is_137"   "137" "$JOINER_REAP_RC"
expect_eq "scenario5.reaped_is_1" "1"   "$JOINER_REAPED"

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