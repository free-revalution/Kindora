#!/usr/bin/env bash
# test_reap_pid_harness.sh — unit tests for reap_pid() idempotency.
#
# These tests verify:
#   - reap_pid() captures the exit code exactly once even when called
#     repeatedly on the same PID.
#   - reap_pid() on a still-alive child correctly TERMs/KILMs and waits.
#   - reap_pid() on an empty PID does nothing.
#
# Exit codes: 0 = all pass; non-zero = first failure.

set -u

SCRIPT=/Users/jiang/development/Kindora/experiments/phase21_experiment_a/scripts/run_unicast_test.sh

# Default values that the real script uses (sourced separately).
GRACE_S=2
SKIP_BUILD=0

# Extract reap_pid() body from the real script.
eval "$(awk '/^reap_pid\(\) \{/,/^\}/' "$SCRIPT")"

# is_alive() also required.
eval "$(awk '/^is_alive\(\) \{/,/^\}/' "$SCRIPT")"

fail=0
n=0
expect_eq() {
  local label="$1" want="$2" got="$3"
  n=$((n + 1))
  if [[ "$got" != "$want" ]]; then
    echo "FAIL[$n] $label: expected='$want' got='$got'"
    fail=$((fail + 1))
  else
    echo "OK  [$n] $label: got='$got'"
  fi
}

# Test 1: reap a child that completes normally — first call returns rc=0.
# We start the sleeper in the SAME shell so wait works.
sleep 0.2 &
PID=$!
wait "$PID"  # already-collected baseline
HOST_REAP_RC=""; HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "first reap of normal child" "0" "$HOST_REAP_RC"
expect_eq "REAPED flag set after first reap" "1" "$HOST_REAPED"

# Test 2: SECOND reap on same PID must NOT change rc.
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "second reap preserves rc" "0" "$HOST_REAP_RC"
expect_eq "REAPED flag still 1" "1" "$HOST_REAPED"

# Test 3: reap a still-alive child — TERMs it, wait returns 143.
sleep 30 &
PID=$!
sleep 0.3  # ensure it's running
HOST_REAP_RC=""; HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "TERM-and-wait survivor rc=143" "143" "$HOST_REAP_RC"
expect_eq "REAPED flag set after TERM-and-wait" "1" "$HOST_REAPED"

# Test 4: reap empty PID — does nothing.
HOST_REAP_RC=""; HOST_REAPED=0
reap_pid "" HOST_REAP_RC HOST_REAPED
expect_eq "empty pid leaves rc empty" "" "$HOST_REAP_RC"
expect_eq "empty pid does not set REAPED" "0" "$HOST_REAPED"

# Test 5: TERM-ignored child must escalate to KILL (137).
# Start a child that explicitly ignores TERM.
bash -c 'trap "" TERM; sleep 30' &
PID=$!
sleep 0.3
HOST_REAP_RC=""; HOST_REAPED=0
reap_pid "$PID" HOST_REAP_RC HOST_REAPED
expect_eq "TERM-ignored escalates to KILL (137)" "137" "$HOST_REAP_RC"

if [[ "$fail" -eq 0 ]]; then
  echo "ALL $n CASES PASSED"
  exit 0
else
  echo "$fail OF $n CASES FAILED"
  exit 1
fi