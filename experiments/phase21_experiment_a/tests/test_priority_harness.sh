#!/usr/bin/env bash
# test_priority_harness.sh — unit tests for decide_priority().
#
# These tests exercise the priority-decision function in isolation.
# They are NOT a substitute for integration tests against the real
# run_unicast_test.sh script (see REPORT.md § 7), but they document
# the priority semantics as a single, auditable artifact.
#
# Exit codes: 0 = all pass; non-zero = first failure's test number.

set -u

SCRIPT=/Users/jiang/development/Kindora/experiments/phase21_experiment_a/scripts/run_unicast_test.sh

# Reset state between cases.
reset_state() {
  INTERRUPTED=0
  CLEANUP_OK=1
  CHILDREN_STARTED=1
  HOST_REAP_RC=""
  JOINER_REAP_RC=""
  HOST_OK_LINE=1
  JOINER_OK_LINE=1
  trap_rc=0
}

# Extract decide_priority() body from the real script (single source).
eval "$(awk '/^decide_priority\(\) \{/,/^\}/' "$SCRIPT")"

fail=0
n=0
expect() {
  local label="$1" want="$2"
  n=$((n + 1))
  local got
  got=$(decide_priority)
  if [[ "$got" != "$want" ]]; then
    echo "FAIL[$n] $label: expected=$want got=$got"
    fail=$((fail + 1))
  else
    echo "OK  [$n] $label: got=$got"
  fi
}

# Cases from the task spec and additional defensive combinations.
reset_state; CLEANUP_OK=0; CHILDREN_STARTED=0; trap_rc=20
expect "trap_rc=20 + cleanup_fail" 12

reset_state; CHILDREN_STARTED=1; trap_rc=30
HOST_REAP_RC=7; HOST_OK_LINE=1
expect "trap_rc=30 + host_fail" 30

reset_state; INTERRUPTED=1; CLEANUP_OK=0
expect "interrupted + cleanup_fail" 130

reset_state; HOST_REAP_RC=7; JOINER_REAP_RC=5
HOST_OK_LINE=1; JOINER_OK_LINE=1
expect "host_fail + joiner_fail" 11

reset_state; HOST_REAP_RC=0; JOINER_REAP_RC=0
HOST_OK_LINE=0; JOINER_OK_LINE=0
expect "happy_path" 0

reset_state; CHILDREN_STARTED=0; trap_rc=20
expect "build_fail_only" 20

reset_state; CHILDREN_STARTED=0; trap_rc=30
expect "precond_fail_only" 30

reset_state; INTERRUPTED=1
expect "interrupted_only" 130

reset_state; HOST_REAP_RC=4; HOST_OK_LINE=1; JOINER_REAP_RC=0; JOINER_OK_LINE=0
expect "host_fail_only" 10

reset_state; JOINER_REAP_RC=5; JOINER_OK_LINE=1; HOST_REAP_RC=0; HOST_OK_LINE=0
expect "joiner_fail_only" 11

reset_state; CLEANUP_OK=0; HOST_REAP_RC=7; JOINER_REAP_RC=5
HOST_OK_LINE=1; JOINER_OK_LINE=1
expect "cleanup_fail + host_fail + joiner_fail" 12

reset_state; INTERRUPTED=1; CLEANUP_OK=0; CHILDREN_STARTED=0; trap_rc=20
expect "cleanup_fail + interrupted + build_fail" 130

reset_state; CHILDREN_STARTED=1; trap_rc=20; HOST_REAP_RC=4; HOST_OK_LINE=1
expect "trap_rc=20 + host_fail" 20

reset_state; CLEANUP_OK=0; CHILDREN_STARTED=1; trap_rc=30
HOST_REAP_RC=4; HOST_OK_LINE=1
expect "trap_rc=30 + cleanup_fail + host_fail" 12

reset_state; CHILDREN_STARTED=0; trap_rc=0
expect "no_children_trap_rc_0" 0

# Additional defensive cases.
reset_state; CHILDREN_STARTED=0; trap_rc=20; HOST_OK_LINE=0; JOINER_OK_LINE=0
expect "CHILDREN_STARTED=0 with OK_LINE=0 (defensive)" 20

reset_state; INTERRUPTED=1; CHILDREN_STARTED=0; trap_rc=30
expect "interrupted + precond_fail" 130

reset_state; CLEANUP_OK=0; trap_rc=0; HOST_REAP_RC=0; JOINER_REAP_RC=0
HOST_OK_LINE=0; JOINER_OK_LINE=0
expect "cleanup_fail only" 12

if [[ "$fail" -eq 0 ]]; then
  echo "ALL $n CASES PASSED"
  exit 0
else
  echo "$fail OF $n CASES FAILED"
  exit 1
fi