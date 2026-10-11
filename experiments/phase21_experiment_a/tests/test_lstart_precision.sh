#!/usr/bin/env bash
# test_lstart_precision.sh — in-tree Round-10/11/12/13 verifier for the
# `ps -o lstart=` precision property used by the reap harness's
# PID-reuse guards.
#
# Purpose (Round-10 audit carried forward to Round-11 wording
# calibration, Round-12 set -u boundary fix, Round-13 exit-code
# policy):
#   The reap harness relies on `ps -o lstart=` (process start time
#   via strftime %c) as an identity token to detect different-second
#   PID reuse. Two properties matter:
#     (a) lstart is STABLE for the same process across `ps` calls
#         within a fraction of a second.
#     (b) Two processes spawned within the same wall-clock second
#         produce IDENTICAL lstart strings — i.e., lstart is
#         second-precision on macOS bash 3.2 and cannot distinguish
#         same-second reuse.
#   This script exercises both properties and reports them with the
#   verdict vocabulary required by Round-11/12:
#     PASS — verified empirically in this run.
#     NOT_VERIFIED — could not be exercised in this run (e.g., no
#       same-second collision observed in a small sample, OR no
#       lstart could be read for the spawned PID group).
#     RISK_REMAINS — limitation documented; not eliminated.
#
#   This script does NOT exercise actual PID reuse, does NOT
#   fabricate a reused-PID slot, and does NOT claim to eliminate
#   the check-then-kill race. It only reports what `ps -o lstart=`
#   actually returns on this host.
#
# What "lstart match" means (Round-12 wording calibration):
#   A current lstart that equals the recorded spawn-time lstart
#   means THIS CHECK did not detect a difference. It does NOT
#   prove the PID still belongs to the original process, because:
#     - Same-second PID reuse is indistinguishable (Round-10
#       audit, RISK_REMAINS).
#     - The check-then-kill race between lstart read and
#       kill -KILL delivery is not atomically closed (Round-10
#       audit, RISK_REMAINS).
#   The cleanup policy in this script and in the reap harness
#   is therefore "allowed by this check, not identity-confirmed",
#   and treats any PID that does not pass as residual (refused).
#
# Exit-code policy (Round-13):
#   This script is meant to be runnable from automation. The
#   prior rounds returned exit 0 unconditionally, so a residual
#   PIDs case (cleanup failure) was indistinguishable from a
#   clean run. Round-13 gates the exit code on CLEANUP_OK:
#     - Cleanup failure (STEP5 detected residual PIDs):
#         exit code = 1 — regardless of the collision verdict.
#         A NOT_VERIFIED verdict for collision does NOT excuse
#         a failed cleanup.
#     - Cleanup success (STEP5 reports no residual PIDs):
#         exit code = 0 — regardless of whether the collision
#         observation is PASS or NOT_VERIFIED. NOT_VERIFIED for
#         the same-second collision property is independent of
#         cleanup outcome.
#   Both verdict branches (COLLIDED=1 and COLLIDED=0) flow
#   through the same CLEANUP_OK gate, so neither branch can
#   leak a stale exit 0 when cleanup actually failed.
#
# Constraints:
#   - Bash 3.2 compatible (no ${var,,} / ${var^^}, no associative arrays).
#   - macOS `ps -o lstart=` only — no /proc, no GNU ps, no etimes.
#   - Self-contained: does NOT source the reap harness.
#   - Cleanup only kills processes this script started AND whose
#     lstart still matches the recorded spawn-time lstart. Any
#     PID that does not pass this narrow check is reported as
#     residual and left alive — same policy as
#     pid_safe_kill_with_identity.
#   - No broad-pattern `pkill` / `kill -<sig> -1` etc.
#
# Test injection (only for exercising the no-collision branch in
# a controlled environment — DO NOT use in production runs):
#   LSTART_FORCE_NO_COLLISION=1
#     Force STEP3 to emit the NOT_VERIFIED verdict WITHOUT
#     requiring a real no-collision observation. The TSV file is
#     still populated from the actual `ps -o lstart=` output, so
#     STEP4 cleanup still uses real lstart data. Used by the
#     Round-12 boundary test to verify the no-collision path
#     under `set -u`. Output clearly labels it as "TEST
#     INJECTION" so production runs do not confuse it with a
#     genuine observation.

set -u

# --- Initialize all variables that may be referenced later.
#     set -u requires that any variable used in a test be
#     initialized before the test, regardless of which branch
#     set it. Round-11 left COLLIDED unset until the collision
#     branch fired, which would trip set -u if the no-collision
#     branch ran instead. Initialize everything up front.
COLLIDED=0
COLLIDED_NOTE=""
CLEANUP_PIDS=""
KILLED=0
REPORTED_RESIDUAL=""
STILL_ALIVE=""
DISTINCT_COUNT=0
TOTAL_COUNT=0
# Round-13: cleanup outcome (1=success / 0=failure). Initialized
# up front because set -u forbids reading an unset variable. The
# final verdict branch checks this and overrides the collision
# verdict — NOT_VERIFIED for collision behavior alone does NOT
# excuse a failed cleanup.
CLEANUP_OK=1

# --- Environment banner ---
ENV_OS="$(uname -s 2>/dev/null || echo unknown)"
ENV_REL="$(uname -r 2>/dev/null || echo unknown)"
ENV_PS_PATH="$(command -v ps 2>/dev/null || echo none)"
ENV_BASH_VER="${BASH_VERSION:-unknown}"
echo "ENV: uname=$ENV_OS $ENV_REL bash=$ENV_BASH_VER ps=$ENV_PS_PATH"

# --- Guard: ps must exist ---
if [[ "$ENV_PS_PATH" = "none" || ! -x "$ENV_PS_PATH" ]]; then
  echo "FAIL: ps not available on this host"
  exit 1
fi

# --- Helper: read lstart for a PID, stripped ---
read_lstart() {
  local pid="$1"
  [[ -z "$pid" ]] && return 1
  ps -p "$pid" -o lstart= 2>/dev/null \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# --- 1. lstart must work on this ps at all ---
SAMPLE_PID=$$
SAMPLE_LSTART_1="$(read_lstart "$SAMPLE_PID")"
if [[ -z "$SAMPLE_LSTART_1" ]]; then
  echo "FAIL: ps -o lstart= returned empty for current shell (PID=$SAMPLE_PID)"
  exit 1
fi
echo "STEP1: ps -o lstart= on $$ => [$SAMPLE_LSTART_1]"

# --- 2. Stability across `ps` calls within <1s ---
LSTART_2="$(read_lstart "$SAMPLE_PID")"
LSTART_3="$(read_lstart "$SAMPLE_PID")"
if [[ "$SAMPLE_LSTART_1" != "$LSTART_2" || "$SAMPLE_LSTART_1" != "$LSTART_3" ]]; then
  echo "FAIL: lstart not stable across calls: [$SAMPLE_LSTART_1] [$LSTART_2] [$LSTART_3]"
  exit 1
fi
echo "STEP2: lstart stable across 3 ps calls (same second) => [$SAMPLE_LSTART_1]"
echo "STEP2_VERDICT: PASS — lstart is stable within <1s"

# --- 3. Same-second collision demonstration ---
# Strategy: spawn N sleep processes back-to-back without any
# `wait` or subshell hang. Capture each PID + lstart. If at
# least two of them land in the same wall-clock second AND
# have identical lstart strings, that demonstrates the
# precision limit. If N is large enough that some collision
# occurs with overwhelming probability, we can call it
# PASS. If by chance all spawns cross second boundaries (or
# ps cannot be read for any of them), we report NOT_VERIFIED.
#
# Notes for bash 3.2: do NOT use `( sleep N &)` inside $()
# (hangs on macOS). Use the safe pattern: spawn to bg, save
# $!, disown, then read ps.
#
# IMPORTANT: macOS `ps -o lstart=` output contains spaces
# (e.g. "Sun Oct 11 16:12:05 2026"). We store the lstart +
# PID pair with a TAB separator and process the TSV with awk
# using -F'\t' so the date spaces don't split our fields.
N=40
PIDS=""
TSV_FILE="$(mktemp -t lstart_tsv.XXXXXX)"
trap 'rm -f "$TSV_FILE"' EXIT
for i in $(seq 1 $N); do
  # Background sleep; record PID immediately.
  sleep 8 >/dev/null 2>&1 &
  P=$!
  PIDS="$PIDS $P"
  disown $P 2>/dev/null || true
done
# Read lstart for each PID. If the spawn finished faster than
# 1 wall-clock second, all N processes will share the same
# lstart second. Use TAB separator to survive spaces in lstart.
> "$TSV_FILE"
for p in $PIDS; do
  L="$(read_lstart "$p")"
  if [[ -n "$L" ]]; then
    printf '%s\t%s\n' "$L" "$p" >>"$TSV_FILE"
  fi
done
# Count distinct lstart values across all N PIDs.
DISTINCT_COUNT=$(awk -F'\t' 'NF >= 2 && $2 != "" { print $1 }' "$TSV_FILE" | sort -u | wc -l | tr -d ' ')
TOTAL_COUNT=$(awk -F'\t' 'NF >= 2 && $2 != "" { print $2 }' "$TSV_FILE" | wc -l | tr -d ' ')
echo "STEP3: spawned $TOTAL_COUNT processes; distinct lstart seconds = $DISTINCT_COUNT"

if [[ "$TOTAL_COUNT" -eq 0 ]]; then
  # Boundary case: ps could not return lstart for any of the
  # spawned PIDs. The collision property cannot be exercised.
  # NOT_VERIFIED, not PASS.
  CLEANUP_PIDS="$PIDS"
  echo "STEP3: NO lstart could be read for any spawned PID"
  echo "STEP3_VERDICT: NOT_VERIFIED — same-second collision cannot be exercised when ps returns no lstart for the spawned group"
elif [[ "$DISTINCT_COUNT" -lt "$TOTAL_COUNT" ]]; then
  # Real same-second collision observed.
  COLLIDED=1
  # Show one example collision: pick the first lstart that
  # appears at least twice and list the PIDs that share it.
  COLLIDED_EXAMPLE=$(awk -F'\t' '
    { seen[$1] = seen[$1] " " $2 }
    END { for (l in seen) { n = split(seen[l], p, " "); if (n > 1) { printf "lstart=[%s] share_count=%d pids=%s\n", l, n-1, seen[l]; exit } } }
  ' "$TSV_FILE")
  echo "STEP3: SAME-SECOND COLLISION observed — example: $COLLIDED_EXAMPLE"
  echo "STEP3_VERDICT: PASS — same-second processes have identical lstart on this host"
else
  # No collision: every spawn crossed a wall-clock second.
  # This is rare but possible. NOT_VERIFIED, not PASS.
  echo "STEP3: no same-second collision observed in this run (all $TOTAL_COUNT spawns crossed a second boundary)"
  echo "STEP3_VERDICT: NOT_VERIFIED — same-second collision not exercised; precision may still be sub-second on this host, but the macOS bash 3.2 + ps -o lstart= combination in the reap harness is documented as second-precision based on the Round-10 audit (see REPORT.md § 7b)"
fi

# --- Optional test-injection path: force the NOT_VERIFIED
#     verdict for boundary testing under set -u. Production
#     runs MUST NOT set this. ---
if [[ "${LSTART_FORCE_NO_COLLISION:-}" = "1" ]]; then
  echo ""
  echo "*** WARNING: LSTART_FORCE_NO_COLLISION=1 — TEST INJECTION ***"
  echo "*** Forcing STEP3 verdict to NOT_VERIFIED regardless of ***"
  echo "*** actual observation. TSV file still holds real data; ***"
  echo "*** STEP4 cleanup still uses real lstart values. ***"
  echo "*** This branch is for verifying the no-collision path ***"
  echo "*** under set -u; not a production result. ***"
  COLLIDED=0
  COLLIDED_NOTE=" (FORCED via LSTART_FORCE_NO_COLLISION=1)"
  echo "STEP3_VERDICT (overridden): NOT_VERIFIED${COLLIDED_NOTE}"
fi

# --- 4. Cleanup: only kill processes whose lstart matches what
#        we recorded at spawn time.
#
#        Round-12 wording calibration: a current lstart equal to
#        the recorded lstart means THIS CHECK did not detect a
#        difference. It does NOT confirm identity, because:
#          - Same-second reuse is indistinguishable on macOS bash 3.2
#            (Round-10 audit, RISK_REMAINS).
#          - The check-then-kill race between this lread and the
#            kill -KILL delivery is not atomically closed
#            (Round-10 audit, RISK_REMAINS).
#        The cleanup therefore uses "lstart check did not detect
#        a difference" as a NECESSARY but not SUFFICIENT
#        condition for kill. Any PID that does not pass the check
#        is reported as residual and left alive — refuses to
#        kill, not "safe to kill".
#
#        Source: $TSV_FILE, which is "<lstart>\t<pid>" lines.
while IFS=$'\t' read -r L P; do
  [[ -z "$P" || -z "$L" ]] && continue
  CUR="$(read_lstart "$P")"
  if [[ "$CUR" = "$L" ]]; then
    # lstart check did not detect a difference. Allowed by
    # this check. Same-second reuse NOT excluded — see the
    # wording above and the RISK_REMAINS declaration in REPORT.
    if kill -KILL "$P" 2>/dev/null; then
      KILLED=$((KILLED + 1))
    fi
  else
    # lstart mismatch — different-second PID reuse is detectable;
    # OR the process is gone. Refuse to kill and report as
    # residual. The harness policy is "refuse, not risk".
    REPORTED_RESIDUAL="$REPORTED_RESIDUAL $P"
  fi
done <"$TSV_FILE"

echo "STEP4: cleanup killed=$KILLED (allowed by lstart check, identity not confirmed; same-second reuse RISK_REMAINS) residual=${REPORTED_RESIDUAL:-<none>}"

# --- 5. Final residual check: are any of our PIDs still alive? ---
sleep 0.3
for p in $PIDS; do
  if kill -0 "$p" 2>/dev/null; then
    STILL_ALIVE="$STILL_ALIVE $p"
  fi
done
STILL_ALIVE="${STILL_ALIVE# }"
if [[ -n "$STILL_ALIVE" ]]; then
  # Round-13: residual PIDs after cleanup. Round-12 wording kept
  # "NOT_VERIFIED" here which conflated a missing collision
  # observation with a cleanup failure. They are different
  # things — a NOT_VERIFIED collision verdict does NOT excuse
  # a failed cleanup. Flag the failure here; the verdict
  # summary at the end maps CLEANUP_OK=0 to a non-zero exit.
  CLEANUP_OK=0
  echo "STEP5: residual PIDs from this script still alive: [$STILL_ALIVE]"
  echo "STEP5_VERDICT: FAIL — cleanup left residual PIDs; final exit will be non-zero"
else
  echo "STEP5: no residual PIDs from this script"
  echo "STEP5_VERDICT: PASS — cleanup left no residual PIDs"
fi

# --- 6. Final verdict summary ---
echo ""
echo "=========================================="
echo "LSTART PRECISION VERIFIER — verdict summary"
echo "=========================================="
# Lstart-stability verdict is always PASS (STEP1/2 already exit
# non-zero on failure). COLLIDED (initialized at top) is set -u
# safe in both branches.
echo "  - lstart stability within <1s:        PASS"
if [[ "$COLLIDED" -eq 1 ]]; then
  echo "  - same-second collision demonstrated: PASS"
else
  echo "  - same-second collision:              NOT_VERIFIED${COLLIDED_NOTE} (this run did not observe a collision)"
fi

# Cleanup verdict (Round-13: this row gates the exit code).
if [[ "$CLEANUP_OK" -eq 1 ]]; then
  echo "  - cleanup (no residual):             PASS (only killed on lstart match; same-second reuse RISK_REMAINS)"
else
  echo "  - cleanup (residual detected):       FAIL — residual PIDs: [$STILL_ALIVE]"
fi

# Round-13 exit-code policy:
#   - Cleanup failure (CLEANUP_OK=0) → exit 1, regardless of the
#     collision verdict. NOT_VERIFIED for collision does NOT
#     excuse a failed cleanup.
#   - Cleanup success (CLEANUP_OK=1) → exit 0, regardless of
#     whether the collision verdict was PASS or NOT_VERIFIED.
#   - All branches flow through the same gate so neither verdict
#     branch can leak a stale exit 0 when cleanup actually failed.
if [[ "$CLEANUP_OK" -ne 1 ]]; then
  echo ""
  echo "  IMPLICATION: STEP5 reported residual PIDs [$STILL_ALIVE]."
  echo "    Cleanup did not terminate every process this script"
  echo "    started. This is independent of the same-second collision"
  echo "    observation (Round-10 RISK_REMAINS) and of the"
  echo "    check-then-kill race window."
  echo ""
  echo "  FINAL: FAIL — cleanup left residual processes; exit non-zero"
  exit 1
fi

# Cleanup succeeded — print the same IMPLICATION / RESULT lines
# the prior rounds carried, with the Round-12 wording preserved.
echo ""
if [[ "$COLLIDED" -eq 1 ]]; then
  echo "  IMPLICATION (documented in REPORT § 7b Round-10 audit):"
  echo "    lstart is second-precision on this host; same-second PID"
  echo "    reuse is NOT distinguishable. The reap harness's"
  echo "    pid_safe_kill_with_identity / pid_safe_kill_orphan refuse"
  echo "    to kill in this case rather than risk killing a stranger."
  echo "    This is a documented RISK_REMAINS, not an eliminated risk."
  echo ""
  echo "  RESULT: PASS for stability and same-second collision."
  echo "          RISK_REMAINS for same-second reuse (documented)."
  echo ""
  echo "  CLEANUP OK: PASS — exit 0"
else
  echo "  IMPLICATION: Round-10 audit documented same-second collision"
  echo "  on macOS bash 3.2 + ps -o lstart=; this run did not reproduce"
  echo "  it but the documented result stands. RISK_REMAINS unchanged."
  echo ""
  echo "  RESULT: PASS for stability. NOT_VERIFIED for same-second"
  echo "          collision in this specific run."
  echo ""
  echo "  CLEANUP OK: PASS — exit 0 (NOT_VERIFIED for collision is"
  echo "              preserved; cleanup success is independent)"
fi

exit 0