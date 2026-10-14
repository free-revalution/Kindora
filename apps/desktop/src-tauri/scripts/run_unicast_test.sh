#!/usr/bin/env bash
# run_unicast_test.sh — Phase 2.1 Experiment A.
#
# Drives two independent Rust binaries (lan_cross_process_host and
# lan_cross_process_joiner) and verifies they complete a single
# cross-process UDP exchange:
#
#   joiner -> host : "ready"
#   host -> joiner : lan_announce
#   joiner -> host : lan_invite_ack
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

HOST_PORT=${HOST_PORT:-52420}
JOINER_PORT=${JOINER_PORT:-52421}
TIMEOUT_S=${TIMEOUT_S:-10}
GRACE_S=${GRACE_S:-2}      # TERM -> KILL grace window

HOST_LOG="/tmp/kindora-expA-host.$$.log"
JOINER_LOG="/tmp/kindora-expA-joiner.$$.log"

HOST_PID=""
JOINER_PID=""
HOST_EXIT_CODE=""
JOINER_EXIT_CODE=""
HOST_OK_LINE=1
JOINER_OK_LINE=1
CLEANUP_OK=1
INTERRUPTED=0

trap 'INTERRUPTED=1' INT TERM

is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && ps -p "$pid" -o pid= >/dev/null 2>&1
}

kill_step() {
  # Send TERM, wait up to GRACE_S, then KILL if still alive.
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  if is_alive "$pid"; then
    kill -TERM "$pid" 2>/dev/null || true
    local elapsed=0
    while is_alive "$pid" && [[ "$elapsed" -lt "$GRACE_S" ]]; do
      sleep 1
      elapsed=$((elapsed + 1))
    done
    if is_alive "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
}

cleanup() {
  local trap_rc=$?

  kill_step "$HOST_PID"
  kill_step "$JOINER_PID"

  # Reap exit codes if main flow did not set them.
  if [[ -z "$HOST_EXIT_CODE" ]]; then
    if [[ -n "$HOST_PID" ]] && is_alive "$HOST_PID"; then
      HOST_EXIT_CODE=124   # unreachable (kill_step should have killed it)
    else
      wait "$HOST_PID" 2>/dev/null
      HOST_EXIT_CODE=$?
    fi
  fi
  if [[ -z "$JOINER_EXIT_CODE" ]]; then
    if [[ -n "$JOINER_PID" ]] && is_alive "$JOINER_PID"; then
      JOINER_EXIT_CODE=124
    else
      wait "$JOINER_PID" 2>/dev/null
      JOINER_EXIT_CODE=$?
    fi
  fi

  # Verify OK lines only when the process exited cleanly (code 0).
  if [[ "$HOST_EXIT_CODE" -eq 0 ]] && grep -qx "OK" "$HOST_LOG" 2>/dev/null; then
    HOST_OK_LINE=0
  fi
  if [[ "$JOINER_EXIT_CODE" -eq 0 ]] && grep -qx "OK" "$JOINER_LOG" 2>/dev/null; then
    JOINER_OK_LINE=0
  fi

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
  echo "host_exit=${HOST_EXIT_CODE:-?} joiner_exit=${JOINER_EXIT_CODE:-?} host_ok=$HOST_OK_LINE joiner_ok=$JOINER_OK_LINE cleanup_ok=$CLEANUP_OK interrupted=$INTERRUPTED" >&2

  local rc=0
  if [[ "$INTERRUPTED" -eq 1 ]]; then
    rc=130
  elif [[ "$CLEANUP_OK" -eq 0 ]]; then
    rc=12
  fi
  if [[ "$trap_rc" -gt "$rc" ]]; then
    rc="$trap_rc"
  fi
  if [[ "$rc" -eq 0 ]]; then
    if [[ "$HOST_EXIT_CODE" -ne 0 || "$HOST_OK_LINE" -ne 0 ]]; then
      rc=10
    elif [[ "$JOINER_EXIT_CODE" -ne 0 || "$JOINER_OK_LINE" -ne 0 ]]; then
      rc=11
    fi
  fi

  exit "$rc"
}
trap cleanup EXIT

# --- 0) Early interrupt ---
if [[ "$INTERRUPTED" -eq 1 ]]; then
  echo "INTERRUPTED before build" >&2
  exit 0
fi

# --- 1) Build ---
cd "$PROJECT_ROOT" || exit 30
if ! cargo build --quiet --bin lan_cross_process_host --bin lan_cross_process_joiner; then
  echo "BUILD_FAIL" >&2
  exit 20
fi

# --- 2) Binary presence ---
[[ -x "$HOST_BIN" ]]   || { echo "PRECOND_FAIL: missing $HOST_BIN";   exit 30; }
[[ -x "$JOINER_BIN" ]] || { echo "PRECOND_FAIL: missing $JOINER_BIN"; exit 30; }

# --- 3) Pre-start interrupt ---
if [[ "$INTERRUPTED" -eq 1 ]]; then
  echo "INTERRUPTED before start" >&2
  exit 0
fi

# --- 4) Start Host ---
"$HOST_BIN" "$HOST_PORT" "$JOINER_PORT" >"$HOST_LOG" 2>&1 &
HOST_PID=$!

# --- 5) Start Joiner (concurrent) ---
"$JOINER_BIN" "$JOINER_PORT" "$HOST_PORT" >"$JOINER_LOG" 2>&1 &
JOINER_PID=$!

# --- 6) Watchdog: TERM/KILL if TIMEOUT_S exceeded ---
# Both children are expected to finish in <TIMEOUT_S.
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
  kill_step "$HOST_PID"
  kill_step "$JOINER_PID"
fi

# --- 7) Reap exit codes ---
wait "$HOST_PID" && HOST_EXIT_CODE=0 || HOST_EXIT_CODE=$?
wait "$JOINER_PID" && JOINER_EXIT_CODE=0 || JOINER_EXIT_CODE=$?

# --- 8) Fall through to EXIT trap ---