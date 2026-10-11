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
# -----------------------------------------------------------------------------
echo "--- Scenario 2: reap_pid is the first waiter for a normal-exit child ---"
sleep 0.2 &
PID=$!
# Wait for the child to actually exit so reap_pid's wait is immediate.
wait "$PID" || true
HOST_REAP_RC=""
HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "scenario2.host_rc_is_0"      "0" "$HOST_REAP_RC"
expect_eq "scenario2.host_reaped_is_1"  "1" "$HOST_REAPED"

# -----------------------------------------------------------------------------
# Scenario 3: After reap_pid, calling reap_pid again is a no-op.
# Proof: change REAP_RC to a sentinel AFTER first reap — second reap must
# not overwrite.
# -----------------------------------------------------------------------------
echo "--- Scenario 3: second reap_pid on the same PID is a no-op ---"
sleep 0.2 &
PID=$!
wait "$PID" || true
HOST_REAP_RC=""
HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED   # first reap
HOST_REAP_RC=55  # sentinel AFTER first reap
reap_pid "$PID" HOST_REAP_RC HOST_REAPED   # second reap: must NOT touch rc
expect_eq "scenario3.rc_unchanged_after_second_reap" "55" "$HOST_REAP_RC"
expect_eq "scenario3.reaped_still_1"                 "1"  "$HOST_REAPED"

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
# -----------------------------------------------------------------------------
echo "--- Scenario 7: host and joiner variables are independent ---"
sleep 0.2 &
HOST_PID=$!
sleep 0.2 &
JOINER_PID=$!
wait "$HOST_PID" || true
wait "$JOINER_PID" || true

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