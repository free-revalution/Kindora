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
#   0   = PASS — both processes exited 0, both logs contain exact "OK".
#   10  = HOST_FAIL — host non-zero exit OR missing OK line.
#   11  = JOINER_FAIL — joiner non-zero exit OR missing OK line.
#   12  = CLEANUP_FAIL — a child survived cleanup; ps shows it alive.
#   20  = BUILD_FAIL — cargo build failed.
#   30  = PRECOND_FAIL — missing binary or bad env.
#   130 = INTERRUPTED — SIGINT / SIGTERM.
#
# Priority: 130 > 12 > 10 / 11 > 20 > 30 > 0.
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
HOST_REAP_RC=""
JOINER_REAP_RC=""
HOST_OK_LINE=1
JOINER_OK_LINE=1
CLEANUP_OK=1
INTERRUPTED=0
TRAP_REENTERED=0
CLEANUP_FINAL_RC=0
CHILDREN_STARTED=0   # 1 only after both children were spawned
SKIP_BUILD=${SKIP_BUILD:-0}     # 1 = skip cargo build (fixture scenario)

# Best-effort alive probe. macOS ps -p may misreport zombies; we use it only
# as a hint, never as sole evidence of reclamation. Reclamation must be
# proven by `wait` actually returning.
is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && ps -p "$pid" -o pid= >/dev/null 2>&1
}

# reap_pid <pid> <rc_var>
# Three-stage process termination: S1 send TERM/KILL, S2 best-effort probe,
# S3 wait for reclamation. The exit code from `wait` is written to the
# global variable named by <rc_var>. `wait` is only called after S1, which
# guarantees it operates on a dead or zombie child and so returns
# immediately per POSIX.
reap_pid() {
  local pid="$1"
  local rc_var="$2"
  [[ -z "$pid" ]] && return 0

  # S1: signal sending (best-effort)
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

  # S2: no separate "death judgment" step — kill -0 above is informational.
  # S3: reap. On a dead or zombie child POSIX guarantees `wait` returns
  # immediately. We capture the exit code into the caller-named variable
  # (no command substitution — avoids subshell side-effects).
  wait "$pid" 2>/dev/null
  local rc=$?
  printf -v "$rc_var" '%s' "$rc"
  return 0
}

cleanup() {
  # CRITICAL: capture $? as the very first statement. Any subsequent
  # assignment / command would clobber $?, so do NOT move this line below
  # any other statement. On direct entry this is the script's pre-cleanup
  # exit code; on re-entry it is the previous trap's exit code, which we
  # discard via TRAP_REENTERED.
  local trap_rc=$?

  if [[ "$TRAP_REENTERED" -eq 1 ]]; then
    exit "$CLEANUP_FINAL_RC"
  fi
  TRAP_REENTERED=1

  echo "[cleanup] run_id=$RUN_ID host_pid=${HOST_PID:-?} joiner_pid=${JOINER_PID:-?} trap_rc=$trap_rc" >&2

  reap_pid "$HOST_PID" HOST_REAP_RC
  reap_pid "$JOINER_PID" JOINER_REAP_RC

  echo "[cleanup] host_reap_rc=${HOST_REAP_RC:-?} joiner_reap_rc=${JOINER_REAP_RC:-?}" >&2

  # Verify OK lines only when the process exited cleanly.
  if [[ "${HOST_REAP_RC:-X}" == "0" ]] && grep -qx "OK" "$HOST_LOG" 2>/dev/null; then
    HOST_OK_LINE=0
  fi
  if [[ "${JOINER_REAP_RC:-X}" == "0" ]] && grep -qx "OK" "$JOINER_LOG" 2>/dev/null; then
    JOINER_OK_LINE=0
  fi

  # Best-effort residual check (ps -p may misreport zombies — informational).
  if [[ -n "$HOST_PID" ]] && is_alive "$HOST_PID"; then
    CLEANUP_OK=0
  fi
  if [[ -n "$JOINER_PID" ]] && is_alive "$JOINER_PID"; then
    CLEANUP_OK=0
  fi

  echo "=== HOST LOG ($HOST_LOG) ===" >&2
  cat "$HOST_LOG" 2>/dev/null || echo "(missing)" >&2
  echo "=== JOINER LOG ($JOINER_LOG) ===" >&2
  cat "$JOINER_LOG" 2>/dev/null || echo "(missing)" >&2
  echo "host_exit=${HOST_REAP_RC:-?} joiner_exit=${JOINER_REAP_RC:-?} host_ok=$HOST_OK_LINE joiner_ok=$JOINER_OK_LINE cleanup_ok=$CLEANUP_OK interrupted=$INTERRUPTED" >&2

  local rc=0
  # Priority ladder (highest first):
  #   130  SIGINT / SIGTERM (interrupt flag set by trap)
  #    12  cleanup fail — child survived cleanup
  #    20  build fail (preserved from the early exit in stage 1)
  #    30  precondition fail (preserved from the early exit in stage 2)
  #    11  joiner fail (joiner non-zero exit OR missing OK line)
  #    10  host   fail (host   non-zero exit OR missing OK line)
  #     0  success
  #
  # If the script exited before children started (build/precond fail),
  # CHILDREN_STARTED=0 and we MUST honour trap_rc (20 or 30) — otherwise
  # the host/joiner empty-string checks below would demote it to 10.
  if [[ "$INTERRUPTED" -eq 1 ]]; then
    rc=130
  elif [[ "$CLEANUP_OK" -eq 0 ]]; then
    rc=12
  fi
  if [[ "$CHILDREN_STARTED" -eq 0 ]]; then
    # No children were ever spawned; trap_rc is the authoritative code.
    if [[ "$trap_rc" -gt "$rc" ]]; then
      rc="$trap_rc"
    fi
  else
    # Children were spawned; trust the reaped exit codes over trap_rc
    # for the host/joiner buckets, but still let trap_rc win for any
    # higher-priority code (20 / 30 / 130) it carries.
    if [[ "$trap_rc" -gt "$rc" && "$trap_rc" -ne 0 ]]; then
      rc="$trap_rc"
    fi
    if [[ "$rc" -eq 0 ]]; then
      if [[ "${HOST_REAP_RC:-X}" != "0" || "$HOST_OK_LINE" -ne 0 ]]; then
        rc=10
      elif [[ "${JOINER_REAP_RC:-X}" != "0" || "$JOINER_OK_LINE" -ne 0 ]]; then
        rc=11
      fi
    fi
  fi

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

# --- 7) Reap exit codes (best-effort, may have been pre-killed) ---
# Wait may still race, but cleanup's reap_pid will retry if needed.
wait "$HOST_PID" 2>/dev/null && HOST_REAP_RC=0 || HOST_REAP_RC=$?
wait "$JOINER_PID" 2>/dev/null && JOINER_REAP_RC=0 || JOINER_REAP_RC=$?

# --- 8) Fall through to EXIT trap ---