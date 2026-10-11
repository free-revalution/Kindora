#!/usr/bin/env bash
# run_unicast_test.sh — Phase 2.1 Experiment A.
#
# Drives two independent Rust binaries (lan_cross_process_host and
# lan_cross_process_joiner) and verifies they complete a single
# cross-process UDP exchange:
#
#   joiner -> host : "ready"
#   host -> joiner : lan_announce (key=value, 3 lines)
#   joiner -> host : lan_invite_ack (key=value, 3 lines)
#
# Exit codes (single source of truth):
#    0  = PASS       — both processes exited 0, both logs contain exact "OK".
#   10  = HOST_FAIL  — host non-zero exit OR missing OK line.
#   11  = JOINER_FAIL— joiner non-zero exit OR missing OK line.
#   12  = CLEANUP_FAIL — a child survived cleanup; ps shows it alive.
#   20  = BUILD_FAIL — cargo build failed.
#   30  = PRECOND_FAIL — missing binary or bad env.
#  130  = INTERRUPTED — SIGINT / SIGTERM reached this bash process.
#
# Priority (highest wins):
#   130 > 12 > 20 > 30 > 11 > 10 > 0
#
# State machine for each child:
#   EMPTY    — never spawned (script exited before reaching spawn line)
#   REAPED   — exit code captured (either by main-flow `wait` or by
#              reap_pid's `wait`); the stored value is authoritative and
#              must NOT be re-waited.
#   SURVIVOR — process still running when cleanup started; must be
#              TERM'd, given a grace window, then KILL'd before being
#              waited on. After successful TERM/KILL+wait, transitions
#              to REAPED.
#
# Idempotency:
#   - TRAP_REENTERED blocks recursive EXIT-trap firing.
#   - Each child's `_REAPED` flag prevents double `wait`.
#
# Bash 3.2 compatible (no `wait -n`, no GNU coreutils dependency).

set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
HOST_BIN="$PROJECT_ROOT/target/debug/lan_cross_process_host"
JOINER_BIN="$PROJECT_ROOT/target/debug/lan_cross_process_joiner"

# Allow fixtures to override the binaries for negative tests.
HOST_BIN_OVERRIDE=${HOST_BIN_OVERRIDE:-}
JOINER_BIN_OVERRIDE=${JOINER_BIN_OVERRIDE:-}
[[ -n "$HOST_BIN_OVERRIDE"   ]] && HOST_BIN="$HOST_BIN_OVERRIDE"
[[ -n "$JOINER_BIN_OVERRIDE" ]] && JOINER_BIN="$JOINER_BIN_OVERRIDE"

HOST_PORT=${HOST_PORT:-52420}
JOINER_PORT=${JOINER_PORT:-52421}
TIMEOUT_S=${TIMEOUT_S:-10}
GRACE_S=${GRACE_S:-2}      # TERM -> KILL grace window

# Run identifier for log uniqueness.
RUN_ID="$$-$(date +%s)"
HOST_LOG="/tmp/kindora-expA-host.${RUN_ID}.log"
JOINER_LOG="/tmp/kindora-expA-joiner.${RUN_ID}.log"

# Persistent state (populated as we go).
HOST_PID=""
JOINER_PID=""
HOST_REAP_RC=""          # authoritative exit code (set once when REAPED)
JOINER_REAP_RC=""
HOST_REAPED=0            # 1 once exit code captured (no re-wait)
JOINER_REAPED=0
HOST_OK_LINE=1           # 0 = "OK" line present in log
JOINER_OK_LINE=1
CLEANUP_OK=1             # 0 = a child survived cleanup
INTERRUPTED=0            # 1 = SIGINT/SIGTERM received
TRAP_REENTERED=0
CLEANUP_FINAL_RC=0
CHILDREN_STARTED=0       # 1 only after both children were spawned
SKIP_BUILD=${SKIP_BUILD:-0}     # 1 = skip cargo build (fixture scenario)

# Best-effort alive probe. macOS ps -p may misreport zombies; we use it only
# as a hint, never as sole evidence of reclamation. Reclamation must be
# proven by `wait` actually returning.
is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && ps -p "$pid" -o pid= >/dev/null 2>&1
}

# try_wait <pid>
# If the PID is a child of this shell and is reaped (dead, status known),
# `wait` returns the exit code. Returns the exit code via $? AND sets
# the global REAPED flag is NOT done here — caller decides.
# This function exists solely as a single, well-tested wrapper around `wait`.
try_wait() {
  local pid="$1"
  [[ -z "$pid" ]] && return 127
  wait "$pid" 2>/dev/null
  return $?
}

# reap_pid <pid> <rc_var> <reaped_var>
# Single-source reaping for a child. Guarantees that:
#   - the global variable <rc_var>* receives the exit code exactly once
#   - the global variable <reaped_var>* is set to 1 upon completion
#   - the function is idempotent: if <reaped_var> is already 1, it does
#     nothing and returns
#   - if the child is still alive, it is TERM'd, given GRACE_S, then
#     KILL'd before being waited on
#   - if <pid> is empty (child never spawned), it does nothing and
#     leaves <rc_var>* empty (which decide_priority maps to "no failure")
#
# * The variable names are passed by name; we use printf -v to write into
#   the caller's globals without invoking a subshell.
reap_pid() {
  local pid="$1"
  local rc_var="$2"
  local reaped_var="$3"

  # Idempotency: if already reaped, do nothing. Prevents re-wait race.
  if [[ "$(eval printf '%s' \"\$$reaped_var\")" == "1" ]]; then
    return 0
  fi
  # Empty PID → child never spawned; leave rc empty.
  if [[ -z "$pid" ]]; then
    return 0
  fi

  # S1: if still alive, send TERM, wait GRACE_S, then KILL if needed.
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    local elapsed=0
    while kill -0 "$pid" 2>/dev/null && [[ "$elapsed" -lt "$GRACE_S" ]]; do
      sleep 1
      elapsed=$((elapsed + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  # S2/S3: wait once. POSIX/bash guarantee `wait` returns immediately
  # for a dead or zombie child. We capture into the caller's variable
  # by name; this is the only place that ever sets the reaped value.
  wait "$pid" 2>/dev/null
  local rc=$?
  printf -v "$rc_var" '%s' "$rc"
  printf -v "$reaped_var" '%s' "1"
  return 0
}

# decide_priority
# Single, explicit exit-code decision. Reads the documented state
# variables and returns exactly one of the documented codes.
#
# Priority (highest wins):
#   130 > 12 > 20 > 30 > 11 > 10 > 0
#
# Rules (in evaluation order; first matching rule wins):
#   1. INTERRUPTED=1                              → 130
#   2. CLEANUP_OK=0 (child survived cleanup)      →  12
#   3. trap_rc=20 (build fail)                    →  20
#      — wins over host/joiner fail because build fail happened before
#        child failures and reflects a more fundamental defect.
#      — also covers the CHILDREN_STARTED=0 case naturally.
#   4. trap_rc=30 (precond fail)                  →  30
#   5. JOINER_REAP_RC != 0  OR JOINER_OK_LINE!=0  →  11
#      — only when CHILDREN_STARTED=1 (otherwise OK_LINE/RC are stale
#        defaults with no meaning).
#   6. HOST_REAP_RC   != 0  OR HOST_OK_LINE!=0    →  10
#      — only when CHILDREN_STARTED=1.
#   7. otherwise                                  →   0
#
# Notes:
#   - In rules 5 and 6 we deliberately consider "non-empty RC != 0" the
#     failure condition. An empty RC means "we did not get a chance to
#     reap" — only valid when CHILDREN_STARTED=0, already covered by
#     rules 3/4.
#   - Rules 3 and 4 are evaluated regardless of CHILDREN_STARTED so the
#     priority holds even in pathological combinations (defensive).
decide_priority() {
  if [[ "$INTERRUPTED" -eq 1 ]]; then
    echo 130; return 0
  fi
  if [[ "$CLEANUP_OK" -eq 0 ]]; then
    echo 12; return 0
  fi
  if [[ "${trap_rc:-0}" -eq 20 ]]; then
    echo 20; return 0
  fi
  if [[ "${trap_rc:-0}" -eq 30 ]]; then
    echo 30; return 0
  fi
  if [[ "$CHILDREN_STARTED" -eq 1 ]]; then
    if [[ "${JOINER_REAP_RC:-X}" != "0" || "$JOINER_OK_LINE" -ne 0 ]]; then
      echo 11; return 0
    fi
    if [[ "${HOST_REAP_RC:-X}" != "0" || "$HOST_OK_LINE" -ne 0 ]]; then
      echo 10; return 0
    fi
  fi
  echo 0
}

cleanup() {
  # CRITICAL: capture $? as the very first statement. Any subsequent
  # assignment / command would clobber $?, so do NOT move this line below
  # any other statement. On direct entry this is the script's pre-cleanup
  # exit code; on re-entry it is the previous trap's exit code, which we
  # discard via TRAP_REENTERED.
  local trap_rc=$?

  # Idempotency: never run cleanup body twice.
  if [[ "$TRAP_REENTERED" -eq 1 ]]; then
    exit "$CLEANUP_FINAL_RC"
  fi
  TRAP_REENTERED=1

  echo "[cleanup] run_id=$RUN_ID host_pid=${HOST_PID:-?} joiner_pid=${JOINER_PID:-?} trap_rc=$trap_rc host_reaped=$HOST_REAPED joiner_reaped=$JOINER_REAPED" >&2

  # Reap each child at most once. reap_pid checks the _REAPED flag and
  # short-circuits if main flow has already captured the exit code.
  reap_pid "$HOST_PID"   HOST_REAP_RC   HOST_REAPED
  reap_pid "$JOINER_PID" JOINER_REAP_RC JOINER_REAPED

  echo "[cleanup] host_reap_rc=${HOST_REAP_RC:-?} joiner_reap_rc=${JOINER_REAP_RC:-?}" >&2

  # Verify OK lines only when the process exited cleanly.
  if [[ "${HOST_REAP_RC:-X}" == "0" ]] && grep -qx "OK" "$HOST_LOG" 2>/dev/null; then
    HOST_OK_LINE=0
  fi
  if [[ "${JOINER_REAP_RC:-X}" == "0" ]] && grep -qx "OK" "$JOINER_LOG" 2>/dev/null; then
    JOINER_OK_LINE=0
  fi

  # Best-effort residual check (ps -p may misreport zombies — informational).
  # We use is_alive on PIDs that we know we spawned AND we set alive-check
  # criterion to "non-zero HOST/joiner REAP_RC + still alive". If a child
  # exited cleanly (RC=0) we trust the wait; if it exited non-zero but ps
  # still shows it, that's an inconsistency → cleanup_fail.
  if [[ -n "$HOST_PID" ]] && [[ "${HOST_REAP_RC:-X}" != "0" ]] && is_alive "$HOST_PID"; then
    CLEANUP_OK=0
  fi
  if [[ -n "$JOINER_PID" ]] && [[ "${JOINER_REAP_RC:-X}" != "0" ]] && is_alive "$JOINER_PID"; then
    CLEANUP_OK=0
  fi

  echo "=== HOST LOG ($HOST_LOG) ===" >&2
  cat "$HOST_LOG" 2>/dev/null || echo "(missing)" >&2
  echo "=== JOINER LOG ($JOINER_LOG) ===" >&2
  cat "$JOINER_LOG" 2>/dev/null || echo "(missing)" >&2
  echo "host_exit=${HOST_REAP_RC:-?} joiner_exit=${JOINER_REAP_RC:-?} host_ok=$HOST_OK_LINE joiner_ok=$JOINER_OK_LINE cleanup_ok=$CLEANUP_OK interrupted=$INTERRUPTED" >&2

  # Single explicit decision.
  local rc
  rc=$(decide_priority)
  CLEANUP_FINAL_RC="$rc"
  exit "$rc"
}
trap cleanup EXIT

# Signal handlers: set flag, kick TERM into both children so cleanup's reap
# can `wait` immediately. We deliberately do NOT call `wait` inside the trap.
trap 'INTERRUPTED=1; kill -TERM "$HOST_PID" "$JOINER_PID" 2>/dev/null || true' INT TERM

# --- 0) Early interrupt ---
if [[ "$INTERRUPTED" -eq 1 ]]; then
  echo "INTERRUPTED before build" >&2
  exit 0
fi

# --- 1) Build ---
cd "$PROJECT_ROOT" || exit 30
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  if ! cargo build --quiet --bin lan_cross_process_host --bin lan_cross_process_joiner; then
    echo "BUILD_FAIL" >&2
    exit 20
  fi
fi

# --- 2) Binary presence ---
[[ -x "$HOST_BIN" ]]   || { echo "PRECOND_FAIL: missing $HOST_BIN";   exit 30; }
[[ -x "$JOINER_BIN" ]] || { echo "PRECOND_FAIL: missing $JOINER_BIN"; exit 30; }

# --- 3) Pre-start interrupt ---
if [[ "$INTERRUPTED" -eq 1 ]]; then
  echo "INTERRUPTED before start" >&2
  exit 0
fi

echo "[main] run_id=$RUN_ID starting host_pid=$$" >&2

# --- 4) Start Host ---
"$HOST_BIN" "$HOST_PORT" "$JOINER_PORT" >"$HOST_LOG" 2>&1 &
HOST_PID=$!
echo "[main] host_pid=$HOST_PID" >&2

# --- 5) Start Joiner (concurrent) ---
"$JOINER_BIN" "$JOINER_PORT" "$HOST_PORT" >"$JOINER_LOG" 2>&1 &
JOINER_PID=$!
echo "[main] joiner_pid=$JOINER_PID" >&2

CHILDREN_STARTED=1

# --- 6) Watchdog: TERM/KILL if TIMEOUT_S exceeded ---
TOTAL_WAIT_S=$(( TIMEOUT_S + 2 ))
elapsed=0
while [[ "$elapsed" -lt "$TOTAL_WAIT_S" ]]; do
  if ! is_alive "$HOST_PID" && ! is_alive "$JOINER_PID"; then
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
if is_alive "$HOST_PID" || is_alive "$JOINER_PID"; then
  echo "[main] watchdog: forcing termination of survivors" >&2
  kill_step_for_watchdog() {
    local pid="$1"
    [[ -z "$pid" ]] && return 0
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      local e=0
      while kill -0 "$pid" 2>/dev/null && [[ "$e" -lt "$GRACE_S" ]]; do
        sleep 1
        e=$((e + 1))
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
  }
  kill_step_for_watchdog "$HOST_PID"
  kill_step_for_watchdog "$JOINER_PID"
fi

# --- 7) Reap exit codes ONCE ---
# After the watchdog, both children are dead/zombie. `wait` returns
# immediately and we record the exit code as authoritative.
# From this point on, HOST_REAPED=1 / JOINER_REAPED=1 prevents any
# further `wait` in cleanup() from running.
wait "$HOST_PID" 2>/dev/null && HOST_REAP_RC=0 || HOST_REAP_RC=$?
HOST_REAPED=1
wait "$JOINER_PID" 2>/dev/null && JOINER_REAP_RC=0 || JOINER_REAP_RC=$?
JOINER_REAPED=1

# --- 8) Fall through to EXIT trap ---