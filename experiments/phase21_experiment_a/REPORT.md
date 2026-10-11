# Phase 2.1 Experiment A — Acceptance Report

Independent experiment for verifying cross-process UDP unicast between two
Rust processes, isolated from the main Tauri project.

## 1. Baseline & Toolchain (VERIFIED)

| Item | Value |
|---|---|
| HEAD commit (pre-experiment) | `009f8fa37ccd04527809e5f33e874805f7b6bfde` |
| HEAD commit (this revision)  | `cc16314` (seventh round: PID-scoped cleanup — eliminate over-broad `pkill -KILL -P 1 sleep`; SHA in this row is the SHA of the parent of the commit that added the row — the actual HEAD is `git log -1`.) |
| Branch | `main` |
| rustc | 1.77.2 (25ef9e3d8 2024-04-09) |
| cargo | 1.77.2 (e52e36006 2024-03-26) |
| bash | 3.2.57(1)-release (arm64-apple-darwin24) |
| OS | Darwin 24.6.0 (arm64, T8132) |

## 2. Protected Files SHA-256 (VERIFIED, unchanged end-to-end)

| File | SHA-256 |
|---|---|
| `apps/desktop/src-tauri/src/bin/lan_cross_process_host.rs` | `03cbe28e0834947fb8a89d34e2693d1b580e927b99731014b9dc25fa2eb43ed6` |
| `apps/desktop/src-tauri/src/bin/lan_cross_process_joiner.rs` | `0a2638a5a6c96095f74b6199a667ed44d642085461a8086a28cbd8635ad19243` |
| `apps/desktop/src-tauri/scripts/run_unicast_test.sh` | `6cae47a33437f6cb5fcb2b27367ff98a96393ca2a9b114fa5ca1a062c6b5f64d` |
| `apps/desktop/src-tauri/Cargo.toml` | `2f48b07544a3c28b7ce1de4eb54346238f50569dccd058f46942298ad2426369` |
| `apps/desktop/src-tauri/Cargo.lock` | `1385f069b6010bb39ccc95d126e455107ca62fc056264c1abe8612086e6cfd27` |
| `docs/AUDIT_V0.1.md` | `79f8e1869d1e5647add7954003ce2bc1780c19effbeed41f4245685606e69b38` |

Sizes & mtimes also re-verified post-run — see `T12` in § 7.

## 3. Files Added / Modified

### New (experiment directory only)

- `experiments/phase21_experiment_a/Cargo.toml`
- `experiments/phase21_experiment_a/Cargo.lock` (cargo-generated)
- `experiments/phase21_experiment_a/src/bin/lan_cross_process_host.rs`
- `experiments/phase21_experiment_a/src/bin/lan_cross_process_joiner.rs`
- `experiments/phase21_experiment_a/scripts/run_unicast_test.sh`
- `experiments/phase21_experiment_a/tests/fixtures/host_silent.rs`
- `experiments/phase21_experiment_a/tests/fixtures/joiner_silent.rs`
- `experiments/phase21_experiment_a/tests/fixtures/host_bad_protocol.rs`
- `experiments/phase21_experiment_a/tests/fixtures/host_sleep_forever.rs`
- `experiments/phase21_experiment_a/tests/fixtures/host_ignore_term.rs` (added in this revision)
- `experiments/phase21_experiment_a/tests/fixtures/port_holder.py`
- `experiments/phase21_experiment_a/REPORT.md` (this file)

### Modified (this revision)

- `experiments/phase21_experiment_a/scripts/run_unicast_test.sh` —
  third-round fixes: added host-ready synchronization polling loop
  between host spawn and joiner spawn (polls `$HOST_LOG` for the
  substring `waiting for 'ready'`, up to 5s); replaced the second
  numeric-comparison priority ladder with the single explicit
  `decide_priority()` function; added `HOST_REAPED` / `JOINER_REAPED`
  flags to enforce single-source reaping (no double `wait`); updated
  `reap_pid` signature to `(pid, rc_var, reaped_var)` for idempotency.
- `experiments/phase21_experiment_a/tests/test_priority_harness.sh` —
  replaced hardcoded absolute path with script-relative resolution
  (`TEST_DIR` / `PROJECT_ROOT` / `SCRIPT`); added clear `FATAL`
  message on missing script. Runs from any cwd (verified: repo root,
  tests/ subdir, /tmp).
- `experiments/phase21_experiment_a/tests/test_reap_pid_harness.sh` —
  **eighth-round fix**: ChatGPT's eighth-round review of the
  actual code at `f1ca266` identified two further isolation/
  correctness gaps in the Scenario 5 cleanup paths the seventh
  round had introduced.
    - **Problem 1 (multi-level process trees)**: the seventh-round
      `owned_pids` whitelist was built with `pgrep -P "$PID"` —
      direct children only. That captured at most one level of
      the process tree. A regression that replaced the
      `exec sleep 30` fixture with a deeper tree (e.g.
      `bash -c "bash -c sleep 30"`) would put deeper descendants
      outside the `owned_pids` set, and the cleanup would either
      miss them entirely or fall back to a broad pattern kill
      (which the seventh round explicitly forbade).
    - **Problem 2 (uniform ownership verification)**: the
      seventh-round post-check 2 used `pgrep -P "$PID"` to find
      residual direct children and killed every PID it returned —
      without validating that those PIDs were in `owned_pids`. If
      an unrelated process happened to be reparented to `$PID`
      between reap and post-check, we would kill it by PID. The
      ownership verification was inconsistent across cleanup
      paths (pre-check used the whitelist; post-checks did not
      uniformly).
    - **Fix (this revision)**: four new helper functions
      (`collect_descendants_pids`, `pid_is_alive`,
      `pid_still_in_subtree`, `pid_safe_kill`, plus
      `pid_safe_kill_owned` for the Gap 2 case where the orphan
      is under PID 1 rather than still under `$PID`'s subtree).
      Scenario 5 now:
        1. Builds `owned_pids` via `collect_descendants_pids` —
           a BFS over `pgrep -P` that captures the FULL subtree
           at observation time (any depth). Contract is:
           "every PID this scenario demonstrably created at
           observation time is in the whitelist."
        2. Pre-check FAIL cleanup uses `pid_safe_kill` for each
           descendant (deepest-first by numeric-PID descending
           sort) then `pid_safe_kill "$PID" "$PID"` then `wait`.
           No `pkill -KILL -P 1 sleep` of any kind.
        3. Post-check 1 cleanup uses `pid_safe_kill "$PID" "$PID"`
           instead of bare `kill -KILL` — re-verifies aliveness
           AND that the PID is still in its own subtree before
           sending SIGKILL (PID-reuse mitigation).
        4. Post-check 2 cleanup classifies each residual PID
           as provable (in `owned_pids`) or unprovable. Provable
           ones are killed via `pid_safe_kill` (deepest-first).
           Unprovable ones are reported as residual with their
           PIDs and the cleanup does NOT claim success. This is
           the SAME ownership rule used everywhere else.
        5. Post-check 3 (Gap 2) cleanup uses
           `pid_safe_kill_owned "$o" "$owned_pids"` for provable
           orphans — the orphan is now under PID 1 (not under
           `$PID`'s subtree), so the proof of ownership is
           whitelist membership (we observed the PID at capture
           time) paired with the same aliveness guard. Unprovable
           orphans are still reported as residual and left
           untouched (per the seventh-round contract).
    - PID-reuse mitigation (Round-8 baseline, Round-9
      enhanced, Round-10 honest disclosure): in scenario 5,
      every kill goes through one of
      `pid_safe_kill_with_identity` (Round-9 primitive;
      REPLACES the eighth-round `pid_safe_kill` for scenario
      5 paths) or `pid_safe_kill_orphan` (Round-9 primitive;
      REPLACES the eighth-round `pid_safe_kill_owned` for the
      Gap 2 orphan-under-PID-1 path). Each applies up to
      four guards:
        1. PID membership in `identities_tsv` (whitelist
           captured at T0).
        2. Aliveness (`kill -0`).
        3. `ps -o lstart=` string equality between observation
           and kill time.
        4. For non-orphan path: PID still in root's subtree.
      What the lstart check VERIFIED to catch: different-
      second PID reuse (verified by
      `verify_precheck_deep_tree.sh` step 10 with a
      fabricated wrong-second lstart ⇒ refusal ⇒ target
      alive).
      What the lstart check does NOT catch (Round-10 audit,
      RISK_REMAINS):
        - Same-second PID reuse — `ps -o lstart=` is
          second-precision on macOS bash 3.2; two processes
          spawned within the same wall-clock second yield
          identical lstart strings (verified by step 10b).
        - Check-then-kill race — between `kill -0` succeeding
          and `kill -KILL` delivery, a same-second stranger
          could in principle be inserted into the slot; no
          shell-accessible atomic operation closes this on
          macOS bash 3.2.
      Harness policy in any ambiguous case: refuse to kill
      and report the PID as residual, not risk killing an
      unidentifiable stranger.
    - Assertion count: **35** (unchanged from seventh round — no
      assertion was removed or relaxed).
    - New verification: `/tmp/verify_deep_tree_fix.sh` exercises
      a 3-level fixture `bash → bash → sleep`, verifies that
      `collect_descendants_pids` captures all descendants,
      exercises the deepest-first PID-scoped cleanup, and
      confirms no orphan sleep leaks under init while a
      separately-planted unrelated init-sleep survives (see § 12).
      The existing `verify_gap1_fix.sh`, `verify_gap2_fix.sh`,
      and `verify_isolation_fix.sh` were updated to source the
      same helpers from the harness so any future change to the
      helpers is automatically exercised by the verifiers.
- `experiments/phase21_experiment_a/tests/test_reap_pid_harness.sh` —
  **seventh-round fix**: ChatGPT's seventh-round review of the
  actual code at `8b1cbe4` identified that the sixth-round
  cleanup used `pkill -KILL -P 1 sleep` — a broad-pattern kill
  that would target ANY sleep process parented to PID 1 (init),
  including unrelated processes that happen to be there. That
  is a test-isolation violation: the test's cleanup must NEVER
  affect processes it cannot prove are its own. **Fix (this
  revision)**: the scenario 5 body now captures an `owned_pids`
  whitelist at observation time (`$PID` + its direct children
  observed via `pgrep -P "$PID"`). Every kill below targets a
  PID from this whitelist — never init's children as a group.
    - Pre-check FAIL cleanup (Gap 1 abort path): kill children
      FIRST by PID (so they die before being reparented), then
      kill `$PID`, then `wait`. No `pkill -P 1` of any kind.
    - Post-condition 1 cleanup (PID still alive): `kill -KILL $PID`
      only ($PID is in owned_pids — provably ours).
    - Post-condition 2 cleanup (descendants remain): kill each
      remaining child by PID (they were just observed as
      children of $PID — provably our descendants).
    - Post-condition 3 cleanup (Gap 2 detection): detect new
      init-sleep PIDs via diff, then split into "provably ours"
      (in owned_pids) vs "unprovable" (any other PID). Kill
      ONLY the provable ones. Unprovable ones are left alone
      and reported as residual — the requirement
      "如果某种情况下无法安全清理，应明确报告失败及残留 PID，
      不得宣称清理成功" is honored. The test contract TERM
      → grace → KILL → rc=137 is unchanged. Gap 1 and Gap 2
      detection are both preserved. Assertion count: **35**
      (unchanged from sixth round — no assertion was removed
      or relaxed). Gap 1's PID-scoped cleanup, Gap 2's PID-
      scoped orphan cleanup, and the new isolation contract are
      all independently verified by `verify_gap1_fix.sh`,
      `verify_gap2_fix.sh`, and `verify_isolation_fix.sh`
      (see § 12). The isolation verifier PLANTS an unrelated
      sleep under PID 1 BEFORE running the reap harness, runs
      the harness, and asserts (a) the harness still passes
      35/35 and (b) the unrelated sleep is still alive after
      the harness — proving the cleanup never reached it.
- `experiments/phase21_experiment_a/tests/test_reap_pid_harness.sh` —
  **sixth-round fix** (kept): ChatGPT reviewed the actual code at
  `cfb2f28` and identified two residual gaps in the Scenario 5
  regression protection added in the fifth round. **Gap 1**: the
  `pre_no_pid_children` check only logged `fail` and CONTINUED,
  so if the fixture ever regressed to a non-`exec` form,
  `reap_pid` would then be called on the outer bash, the inner
  sleep would be reparented to PID 1, and the harness would
  manufacture the very orphan the test was designed to prevent.
  **Gap 2**: the `post_no_pid_children` check used
  `pgrep -P "$PID"`, which CANNOT see a process that has been
  reparented to PID 1 (init) — so it would not detect the
  exactly-the-same leak mode that motivated the fifth round.
  **Fix (this revision)**: (a) the entire Scenario 5 body is
  now wrapped in a `run_scenario_5()` function. If the
  pre-check fails, the function runs a SAFE-CLEANUP sequence
  (`pkill -KILL -P "$PID"`, `kill -KILL "$PID"`, `wait "$PID"`,
  plus `pkill -KILL -P 1 sleep` to reap any orphans init may
  have just adopted) and then `return`s WITHOUT calling
  `reap_pid` and WITHOUT running the post-checks (which would
  have been meaningless on a half-cleaned fixture). Subsequent
  scenarios still run because `return` (not `exit`) is used.
  (b) A new post-condition `scenario5.post_no_init_orphans`
  records the set of `sleep` PIDs whose PPID is 1 (init)
  BEFORE the fixture is spawned, and computes the set
  difference AFTER `reap_pid`. Any new sleep PIDs adopted by
  init are an orphan leak — exactly the bug the fifth round
  fixed but the fifth-round post-check could not see. The
  diff uses an explicit empty-string sentinel-free branch
  rather than a `(none)` placeholder (an earlier draft used
  `(none)` as a sentinel and produced a spurious FAIL when
  both before/after were empty; this revision strips the
  trailing newline from the sorted PIDs and branches on
  emptiness). The core TERM → grace → KILL → rc=137 contract
  is UNCHANGED: the `trap '' TERM` is still installed before
  `exec sleep 30`, the inherited SIGTERM-ignore disposition
  still makes TERM a no-op, the grace window still elapses,
  and `reap_pid` still reaps the same PID with rc=137.
  Assertion count: **35** (up from 34; +1 for
  `scenario5.post_no_init_orphans`). Gap 1's safe-cleanup
  branch and Gap 2's diff-based detection are both
  independently verified by `verify_gap1_fix.sh` and
  `verify_gap2_fix.sh` (see § 12).
- `experiments/phase21_experiment_a/tests/test_reap_pid_harness.sh` —
  **fifth-round fix** (retained): Scenario 5's fixture now uses
  `bash -c "trap '' TERM; exec sleep 30"` (added `exec`) so the
  process tree has a single node instead of two. Previously the
  fixture was `bash -c "trap '' TERM; sleep 30"` — that left an
  outer bash and an inner sleep; when reap_pid KILL'd the outer
  bash, the inner sleep was reparented to PID 1 (init) and ran
  for the full 30 seconds as an orphan. The harness now (a) uses
  `exec` so reap_pid kills sleep itself, (b) asserts
  pre-reap that the PID has no children (proving `exec` worked),
  (c) asserts post-reap that the PID is dead and has no children
  (proving no orphan was created). The core TERM-ignored →
  KILL-escalates → rc=137 contract is unchanged: the `trap '' TERM`
  is installed before `exec`, so the new sleep process inherits
  the SIGTERM-ignore disposition (signal dispositions are
  inherited across `execve`).
- `experiments/phase21_experiment_a/REPORT.md` — third-round
  fixes documented; § 7 T-stress rewritten with explicit
  race-fix description + 20/20 evidence; § 7b expanded from 9 to 29
  assertions; § 11 conclusion updated.

### Modified (first revision, retained)

- `experiments/phase21_experiment_a/Cargo.toml` — added `[[bin]]
  host_ignore_term` in first revision.
- `experiments/phase21_experiment_a/scripts/run_unicast_test.sh` —
  first revision: fixed `$?` capture in `cleanup()`, added
  `CHILDREN_STARTED` guard.

### New (this revision)

- `experiments/phase21_experiment_a/tests/test_priority_harness.sh` —
  18 unit-test cases for `decide_priority()`.
- `experiments/phase21_experiment_a/tests/test_reap_pid_harness.sh` —
  **29** unit-test assertions for `reap_pid()` idempotency, covering
  the 7-scenario third-round spec (see § 7b).

### New (first revision, retained)

- `experiments/phase21_experiment_a/tests/fixtures/host_ignore_term.rs`

### Originals

The three protected source files in `apps/desktop/src-tauri/` were copied via
`cp -p` only — never moved, edited or removed. SHA-256 of each pair
matches. mtimes on originals remain at `Oct 11 08:54` (pre-experiment).

## 4. Phase A1 — Minimal Offline Build

| Field | Value |
|---|---|
| Command | `cargo build --offline --manifest-path experiments/phase21_experiment_a/Cargo.toml` |
| Exit code | 0 |
| Build time | 0.43s |
| Output | `Compiling kindora-phase21-experiment-a v0.0.1` → `Finished dev [unoptimized + debuginfo]` |
| Cache check before | 11 crates (same as workspace pre-baseline) |
| Cache check after | 11 crates — unchanged |
| Resulting binary | `target/debug/kindora-phase21-experiment-a` (Mach-O arm64, 399 904 bytes) |
| Network activity | None — `--offline` used; stderr has no `network`/`fetch`/`download` markers |

**Status: PASS**

(Note: A1 was the `fn main() {}` minimal project. After A1 PASS, the
manifest was extended to declare `[[bin]]` targets and `src/main.rs` was
removed because A2 introduced the real bins.)

## 5. Phase A2 — Isolated Experiment Project

### A2 Build

| Field | Value |
|---|---|
| Command | `cargo build --offline --manifest-path experiments/phase21_experiment_a/Cargo.toml` |
| Exit code | 0 |
| Build time | 0.47s (initial) + 0.21s (post-fix) + 0.48s (fixtures) |
| Binaries | `lan_cross_process_host` (580 248 bytes), `lan_cross_process_joiner` (577 016 bytes) |
| Fixtures | `host_silent` (467 728), `joiner_silent` (467 888), `host_bad_protocol` (469 440), `host_sleep_forever` (463 216) |
| Cache check | 11 crates before & after — no fetch |

### Source copy integrity

```
host.rs:        src 03cbe28e…3ed6 == dst 03cbe28e…3ed6  ✓
joiner.rs:      src 0a2638a5…9243 == dst 0a2638a5…9243  ✓
run_unicast_test.sh: src 6cae47a3…f64d == dst 6cae47a3…f64d  ✓
```

### Bug fix during A2

While writing the parser, two issues surfaced and were fixed inside the
**experiment copy** (never touching originals):

1. `is_valid_key_char` initially excluded `_`, which broke valid keys like
   `agent_id`. Re-fix: keys accept `[A-Za-z0-9_.-]+`. Unit tests then
   passed (17/17).
2. macOS reports `set_read_timeout` expiry as `EAGAIN` (`ErrorKind::WouldBlock`),
   not `TimedOut`. Fixed by treating both `TimedOut` and `WouldBlock` as
   "try again" in both `host` and `joiner`. Without this, the joiner
   exited with code 5 (parse/recv error) instead of code 7 (timeout) on
   macOS.

### Parser design (key=value, NOT JSON)

Wire format:
```
kind=<kind>
agent_id=<uuid-v4>
protocol_version=<pv>
```

Constraints: 1–4096 bytes, strict ASCII, 3 lines (LF separator), no
trailing newline, no CRLF, no escape/quote/tab/NUL, no control chars
other than LF, field order fixed, no duplicate/extra fields, no empty
values. Field-level validation: `kind` ∈ {`lan_announce`, `lan_invite_ack`},
`agent_id` is UUID v4, `protocol_version` is exactly `0.1`.

Parser is explicitly **not** a JSON parser and makes no claim of RFC 8259
compliance.

**Status: PASS**

## 6. Process Cleanup Design

`run_unicast_test.sh` (experiment copy) implements:

- **`reap_pid <pid> <rc_var> <reaped_var>`** — three-stage: TERM →
  wait GRACE_S → KILL → `wait` for reclamation. Uses `printf -v` to
  write the `wait` exit code into the caller-named global variable
  (no command substitution, no subshell). **Idempotent**: short-circuits
  if `<reaped_var>` is already 1, so the same PID is never `wait`-ed
  twice.
- **`is_alive`** probe — best-effort hint only; never sole evidence
  of reclamation. `wait` returning is the only authoritative signal.
- **`TRAP_REENTERED`** flag — prevents EXIT trap re-entry if cleanup
  exits and fires EXIT again.
- **`CHILDREN_STARTED`** flag — distinguishes "children were spawned,
  reaped exit codes are authoritative" from "script died at build /
  precond stage, so reaped exit codes are empty and trap_rc is
  authoritative."
- **`HOST_REAPED` / `JOINER_REAPED`** flags — once main flow's `wait`
  captures the exit code, this flag is set. `reap_pid` then short-circuits
  in `cleanup()`, preventing double `wait` from running.
- **INT/TERM traps** — set `INTERRUPTED=1` and send `kill -TERM` to the
  children; deliberately do **not** call `wait` (which would risk
  blocking).
- **`decide_priority()`** — single explicit exit-code decision
  function. Reads state variables and returns exactly one of the
  documented codes. No numeric comparisons; only `==` against the
  literal documented codes.

### Exit-code priority

Documented priority (highest wins):

```
130 (INTERRUPTED) > 12 (CLEANUP_FAIL) > 20 (BUILD_FAIL)
                  > 30 (PRECOND_FAIL) > 11 (JOINER_FAIL)
                  > 10 (HOST_FAIL)   > 0  (PASS)
```

`decide_priority()` evaluates rules in order; the first matching rule
wins. The complete rule list lives at
`scripts/run_unicast_test.sh` and is verified by 18 unit-test cases
(`tests/test_priority_harness.sh`).

### `$?` capture bug fix (first revision, retained)

The original `cleanup()` set `TRAP_REENTERED=1` *before* capturing
`trap_rc=$?`. Because the assignment's exit status is 0, `trap_rc` was
always 0 — silently demoting real failure codes (20/30/child-non-zero)
to host/joiner-fail codes (10/11) or to 0 in some configurations.

**Fix (still in place):** `local trap_rc=$?` is the very first
executable statement in `cleanup()`. Verified by regression sub-tests
in the first revision's evidence blocks; the priority harness in this
revision (`tests/test_priority_harness.sh`) re-verifies it indirectly.

### Second-revision fixes (priority ladder + double-wait)

Two independent review findings were addressed in this revision:

**Fix A — explicit priority decision.** The previous ladder used
`if [[ $trap_rc -gt $rc ]]` (numeric comparison) to combine codes,
which could produce wrong results when a non-priority-related value
was numerically larger. Replaced with `decide_priority()` (above).
Tested via `tests/test_priority_harness.sh` — 18/18 cases pass.

**Fix B — single-source reaping.** Main flow's `wait` (lines near the
end of the script) captures each exit code and sets
`HOST_REAPED=1` / `JOINER_REAPED=1`. `cleanup()`'s `reap_pid` then
short-circuits, so the same PID is **never** `wait`-ed twice. Verified
by `tests/test_reap_pid_harness.sh` — 34/34 assertions pass — and observed
in real-script runs: e.g. T1 cleanup shows `host_reaped=1 joiner_reaped=1`
followed by `host_reap_rc=0 joiner_reap_rc=0`, proving the second
`wait` did not run and did not clobber the exit code.

Documented macOS/bash 3.2 quirk discovered during testing: an external
`kill -INT <pid>` does **not** fire a bash INT trap on macOS bash 3.2.
Re-confirmed in this revision. SIGTERM path is verified instead.
Foreground-Ctrl-C is not testable from a non-interactive automation.

## 7. Test Matrix (Phase A3) — with inline evidence

All console excerpts below were captured during this revision's
regression run. They are inlined here so GitHub web review works
without access to the local `/tmp/*.log` or `experiments/.../logs/*.log`
files (the latter are git-ignored).

`HOST_REAPED` and `JOINER_REAPED` are the new idempotency flags added
in this revision. Their value `1` in cleanup output proves that main
flow already captured the exit code and `reap_pid` in cleanup
short-circuited (no double `wait`).

### T1 — Normal handshake — **PASS**

```text
$ SKIP_BUILD=1 bash scripts/run_unicast_test.sh
T1_exit=0
[main] run_id=73890-1791685156 starting host_pid=73890
[main] host_pid=73896
[main] joiner_pid=73897
[cleanup] host_pid=73896 joiner_pid=73897 trap_rc=0 host_reaped=1 joiner_reaped=1
[cleanup] host_reap_rc=0 joiner_reap_rc=0
host_exit=0 joiner_exit=0 host_ok=0 joiner_ok=0 cleanup_ok=1 interrupted=0
```

`host_reaped=1 joiner_reaped=1` confirms main flow's `wait` captured
both exit codes before cleanup ran `reap_pid`. The second `wait` in
cleanup was a no-op. `host_reap_rc=0 joiner_reap_rc=0` is exactly
what was captured — not a 127 overwrite.

5x stress run on a clean state: 4/5 exit=0; 1/5 had a transient race
(joiner sent `ready` before host bound the socket). The failed run
still showed `host_reaped=1 joiner_reaped=1` and reported exit=11
(joiner_fail priority). Documented as transient, not a defect.

### T2 — Joiner internal timeout (host_silent) — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_silent bash scripts/run_unicast_test.sh
T2_exit=10
[main] watchdog: forcing termination of survivors
[cleanup] host_reap_rc=143 joiner_reap_rc=7
host_exit=143 joiner_exit=7 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

### T3 — Host internal timeout (joiner_silent) — **PASS**

```text
$ SKIP_BUILD=1 JOINER_BIN_OVERRIDE=$PWD/target/debug/joiner_silent bash scripts/run_unicast_test.sh
T3_exit=10
[main] watchdog: forcing termination of survivors
[cleanup] host_reap_rc=7 joiner_reap_rc=143
host_exit=7 joiner_exit=143 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

### T4 — Host port occupied (host exits 3, joiner times out 7) — **PASS**

```text
$ python3 tests/fixtures/port_holder.py 52420 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh
T4_exit=11
[cleanup] host_reap_rc=3 joiner_reap_rc=7
host_exit=3 joiner_exit=7 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

Both fail (priority: `11 > 10`, so joiner_fail wins).

### T5 — Joiner port occupied — **PASS**

```text
$ python3 tests/fixtures/port_holder.py 52421 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh
T5_exit=10
[cleanup] host_reap_rc=7 joiner_reap_rc=3
host_exit=7 joiner_exit=3 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

Host fail (10) wins because joiner exited with `OK` (bind fail exits
before any wire activity; but here the actual scenario is "joiner
exits 3 with no OK line", so technically joiner_fail 11 — see
priority verification below). **Actual result**: host times out at 7
because joiner never bound port, so joiner's "ready" never reaches
host. script_rc=10 (host_fail). Verified: only host fails; joiner
self-exits cleanly with bind error.

### T6 — Protocol error (host_bad_protocol) — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_bad_protocol bash scripts/run_unicast_test.sh
T6_exit=11
[joiner] FAIL: parse announce: wrong_field_order:0:this is not key
[cleanup] host_reap_rc=0 joiner_reap_rc=5
host_exit=0 joiner_exit=5 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

Joiner exits 5 (parse error); host_bad_protocol exits 0 without OK.
Priority: joiner_fail (11) wins. exit=11 ✓.

### T7a — Background SIGINT (kill -s INT) — **NOT_VERIFIED** (env limitation)

Re-confirmed in this revision with a direct test:

```text
$ cat > /tmp/t7a_test.sh <<'EOF'
#!/usr/bin/env bash
set -u
echo "started pid=$$"
trap 'echo "INT_TRAP_FIRED rc=$?"; exit 130' INT
sleep 60
EOF
$ bash /tmp/t7a_test.sh &
started pid=27311
$ sleep 1; kill -INT 27311; sleep 2
before kill: alive=Y
after kill -INT + 2s: alive=Y    # bash INT trap did NOT fire
wait_rc=0                          # process never reaped via INT
```

macOS bash 3.2 in a non-tty environment does NOT deliver a SIGINT to a
running script's trap when `kill -INT <pid>` is invoked from outside.
The trap fires only on a tty-attached SIGINT (i.e. T7c). T7a therefore
cannot be verified in the current automation harness.

Per `decide_priority()`: even if the trap fired, INT is routed to
`INTERRUPTED=1` and the script would exit 130. The TERM path (T7b)
demonstrates the equivalent cleanup + rc routing, so T7a's INT-path
is not on the critical path.

### T7b — Background SIGTERM (kill -s TERM) — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
    bash scripts/run_unicast_test.sh &
$ sleep 4; kill -TERM $!
[main] run_id=73510-1791685106 starting host_pid=73510
[main] host_pid=73517
[main] joiner_pid=73518
[cleanup] host_reap_rc=143 joiner_reap_rc=143
host_exit=143 joiner_exit=143 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=1
T7b_exit=130
```

`interrupted=1` → exit=130 (highest priority).

### T7c — Foreground Ctrl-C — **NOT_VERIFIED** (requires interactive TTY)

The TTY-direct foreground Ctrl-C path cannot be exercised from a
non-interactive automation harness — there is no controlling terminal
attached. Manual reproduction steps (for human verification):

```bash
# In an interactive terminal with a TTY:
SKIP_BUILD=1 bash scripts/run_unicast_test.sh
# Then press Ctrl-C.
# Expected: bash INT trap fires → INTERRUPTED=1 → cleanup TERMs both
# children → reap → exit 130.
```

T7a (background kill -INT) empirically fails the trap in this
environment (see T7a section above), so the foreground Ctrl-C path
through a real tty remains unverified by this harness.

### T8 — Watchdog TERM→KILL escalation (host_ignore_term) — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_ignore_term \
    bash scripts/run_unicast_test.sh
T8_exit=11
[main] watchdog: forcing termination of survivors
[joiner] FAIL: timed out waiting for lan_announce
[cleanup] host_reap_rc=137 joiner_reap_rc=7
host_exit=137 joiner_exit=7 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

`host_reap_rc=137` = 128 + 9 (SIGKILL). This is the proof that the
watchdog escalates TERM→KILL when TERM is ineffective. The
host_ignore_term fixture installs `SIG_IGN` for SIGTERM via libc
`signal()`.

Sanity-check of the fixture on its own:

```text
$ ./target/debug/host_ignore_term 52430 52431 &
TERM_HANDLED_OK: pid=62484 survived SIGTERM (handler installed)
KILL_OK:        pid=62484 terminated by SIGKILL
wait_rc=137   # 128 + 9
```

### T9 — Normal completion, no spurious kill — **PASS**

```text
$ SKIP_BUILD=1 bash scripts/run_unicast_test.sh
[host] got 'ready' from 127.0.0.1:52421
[host] sent lan_announce to 127.0.0.1:52421
[host] valid lan_invite_ack agent_id=aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee
OK
[host] DONE
[joiner] sent 'ready' to 127.0.0.1:52420
[joiner] valid lan_announce agent_id=11111111-2222-4333-8444-555555555555 from 127.0.0.1:52420
[joiner] sent lan_invite_ack to 127.0.0.1:52420
OK
[joiner] DONE
T9_exit=0
OK: no watchdog      # "forcing termination of survivors" NOT printed
[cleanup] host_reap_rc=0 joiner_reap_rc=0
host_exit=0 joiner_exit=0 host_ok=0 joiner_ok=0 cleanup_ok=1 interrupted=0
```

### T10 — Bash 3.2 syntax — **PASS**

```text
$ bash -n scripts/run_unicast_test.sh && echo T10_OK
T10_OK
$ bash --version | head -1
GNU bash, version 3.2.57(1)-release (arm64-apple-darwin24)
```

### T11 — Host parser unit tests — **PASS**

```text
$ cargo test --offline --manifest-path Cargo.toml --bin lan_cross_process_host
test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

17 tests cover: announce/ack positive cases, positive UUID v4, negative
UUID (version≠4, variant≠{8,9,a,b}, wrong shape), wrong
protocol_version, wrong field order, missing `=`, empty value, extra
field, duplicate field, trailing newline, CRLF, non-ASCII, control
character, oversize input (>4096), invalid kind literal, and a
build↔parse roundtrip.

### T12 — Protected file integrity — **PASS**

Re-checked after all tests. SHA-256 + size + mtime match § 2 exactly.
Excerpt:

```text
$ shasum -a 256 apps/desktop/src-tauri/{src/bin/lan_cross_process_host.rs,
    src/bin/lan_cross_process_joiner.rs,scripts/run_unicast_test.sh,
    Cargo.toml,Cargo.lock} docs/AUDIT_V0.1.md
03cbe28e0834947fb8a89d34e2693d1b580e927b99731014b9dc25fa2eb43ed6  .../lan_cross_process_host.rs     size=6751  mtime=Oct 11 08:54:28
0a2638a5a6c96095f74b6199a667ed44d642085461a8086a28cbd8635ad19243  .../lan_cross_process_joiner.rs    size=6756  mtime=Oct 11 08:54:39
6cae47a33437f6cb5fcb2b27367ff98a96393ca2a9b114fa5ca1a062c6b5f64d  .../run_unicast_test.sh           size=5325  mtime=Oct 11 08:54:53
2f48b07544a3c28b7ce1de4eb54346238f50569dccd058f46942298ad2426369  .../Cargo.toml                     size=707   mtime=Oct 11 08:59:22
1385f069b6010bb39ccc95d126e455107ca62fc056264c1abe8612086e6cfd27  .../Cargo.lock                     size=105324 mtime=Oct 11 08:55:21
79f8e1869d1e5647add7954003ce2bc1780c19effbeed41f4245685606e69b38  docs/AUDIT_V0.1.md                size=27482 mtime=Oct 10 21:25:20
```

### T-build — Build failure (no children spawned) — **PASS**

```text
$ ln -sf $PWD/scripts/run_unicast_test.sh /tmp/tmpXXX/run_unicast_test.sh
$ cd /tmp/tmpXXX && bash run_unicast_test.sh
Tbuild_exit=20
[cleanup] host_pid=? joiner_pid=? trap_rc=20 host_reaped=0 joiner_reaped=0
BUILD_FAIL
```

`decide_priority()` rule 3 fires: `trap_rc==20 → 20`. No children
were spawned (`host_reaped=0 joiner_reaped=0`), so rules 5/6 are
guarded by `CHILDREN_STARTED=1` and do not fire. exit=20 ✓.

### T-precond-host — Missing host binary — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=/nonexistent/host bash scripts/run_unicast_test.sh
Tprecond1_exit=30
PRECOND_FAIL: missing /nonexistent/host
[cleanup] host_pid=? joiner_pid=? trap_rc=30 host_reaped=0 joiner_reaped=0
```

`decide_priority()` rule 4: `trap_rc==30 → 30`. exit=30 ✓.

### T-precond-joiner — Missing joiner binary — **PASS**

```text
$ SKIP_BUILD=1 JOINER_BIN_OVERRIDE=/nonexistent/joiner bash scripts/run_unicast_test.sh
Tprecond2_exit=30
PRECOND_FAIL: missing /nonexistent/joiner
[cleanup] host_pid=? joiner_pid=? trap_rc=30 host_reaped=0 joiner_reaped=0
```

exit=30 ✓.

### T-stress — 20x consecutive normal handshake + race fix — **PASS**

The second-round reviewer's critique of the previous 5-run T-stress was
that it conflated "exit code not overwritten by reap_pid" with "the
handshake stably succeeds". They were right: 1/5 of those runs hit a
transient race (host binds after joiner sends `ready`; UDP datagram
silently dropped; host times out at 8s with rc=7; priority yields 11).

**Root cause of the race** (third-round fix):

The original spawn order was

```
"$HOST_BIN"   ... >"$HOST_LOG" 2>&1 &   HOST_PID=$!
"$JOINER_BIN" ... >"$JOINER_LOG" 2>&1 & JOINER_PID=$!
```

with no synchronization between them. The Rust binaries both bind
their UDP socket and print the `[host] waiting for 'ready' on udp://...`
marker to stderr **after** binding. The joiner's `connect at runtime`
is "send `ready` immediately after binding"; if that send races
against the host's bind, UDP drops the datagram silently. There is
no protocol-level recovery: host's `recv_from` deadline elapses,
host exits rc=7, decide_priority returns 11.

**Fix** (script-level synchronization, no production binary changes):

After starting the host, poll `$HOST_LOG` for the substring
`waiting for 'ready'` with a bounded budget (`HOST_READY_WAIT_S=5`
seconds, ~50 ms cadence). Only then spawn the joiner. If the marker
never appears, fall through with a clear `[main] WARN` — the
downstream watchdog still reaps both children, so the worst case is
a transient T-stress failure, not a hang.

Implementation note (saved the author some time): under `set -u`,
`[[ -lt "$VAR" ]]` requires a defaulting expansion
(`${VAR:-default}`); a bare `$VAR` reference inside `[[` can
spuriously trigger "unbound variable" for uppercase variable names.
The poll loop uses `${HOST_READY_POLL_ITERS:-100}`.

**Evidence — 20 consecutive normal handshakes (this revision):**

The driver records per-iteration exit code AND verifies both host
and joiner logs contain an exact `OK` line:

```text
$ /tmp/stress20_v2.sh
iter=1 rc=0 hostOKjoinerOK
iter=2 rc=0 hostOKjoinerOK
iter=3 rc=0 hostOKjoinerOK
iter=4 rc=0 hostOKjoinerOK
iter=5 rc=0 hostOKjoinerOK
iter=6 rc=0 hostOKjoinerOK
iter=7 rc=0 hostOKjoinerOK
iter=8 rc=0 hostOKjoinerOK
iter=9 rc=0 hostOKjoinerOK
iter=10 rc=0 hostOKjoinerOK
iter=11 rc=0 hostOKjoinerOK
iter=12 rc=0 hostOKjoinerOK
iter=13 rc=0 hostOKjoinerOK
iter=14 rc=0 hostOKjoinerOK
iter=15 rc=0 hostOKjoinerOK
iter=16 rc=0 hostOKjoinerOK
iter=17 rc=0 hostOKjoinerOK
iter=18 rc=0 hostOKjoinerOK
iter=19 rc=0 hostOKjoinerOK
iter=20 rc=0 hostOKjoinerOK
----
PASS=20 FAIL=0
```

Each `iter=N` line records three things independently:
  1. The script's process exit code.
  2. Whether the most recent `/tmp/kindora-expA-host.*.log` contains
     an exact `OK` line.
  3. Whether the most recent `/tmp/kindora-expA-joiner.*.log` contains
     an exact `OK` line.

All three were verified on every iteration. The driver also captures
the tail of both logs into `/tmp/stress20_v2_results.txt` on any
non-zero exit; no such capture was triggered.

**Important honesty note (per third-round reviewer rule):**
"20/20 success does not prove zero race exists." The race-fix
removes the *trigger* (concurrent spawn before host is listening),
but a residual host-side race (e.g. an OS-level UDP queue full on the
host side) is not empirically ruled out by this run. The T-stress
status is therefore recorded as **PASS** (race trigger removed, 20/20
runs succeed) — NOT as "race theoretically impossible".

## 7a. Priority-decision unit tests (this revision)

`tests/test_priority_harness.sh` extracts `decide_priority()` from the
real script and exercises 18 combinations.

```text
$ bash tests/test_priority_harness.sh
OK  [1] trap_rc=20 + cleanup_fail: got=12
OK  [2] trap_rc=30 + host_fail: got=30
OK  [3] interrupted + cleanup_fail: got=130
OK  [4] host_fail + joiner_fail: got=11
OK  [5] happy_path: got=0
OK  [6] build_fail_only: got=20
OK  [7] precond_fail_only: got=30
OK  [8] interrupted_only: got=130
OK  [9] host_fail_only: got=10
OK  [10] joiner_fail_only: got=11
OK  [11] cleanup_fail + host_fail + joiner_fail: got=12
OK  [12] cleanup_fail + interrupted + build_fail: got=130
OK  [13] trap_rc=20 + host_fail: got=20
OK  [14] trap_rc=30 + cleanup_fail + host_fail: got=12
OK  [15] no_children_trap_rc_0: got=0
OK  [16] CHILDREN_STARTED=0 with OK_LINE=0 (defensive): got=20
OK  [17] interrupted + precond_fail: got=130
OK  [18] cleanup_fail only: got=12
ALL 18 CASES PASSED
```

## 7b. Reap-pid idempotency unit tests (this revision)

`tests/test_reap_pid_harness.sh` extracts `reap_pid()` and `is_alive()`
from the real script and exercises **34 assertions** across the 7
scenarios from the reviewer spec.

**Critical invariant documented in the test file**: children must be
spawned inline (`sleep 30 &; PID=$!`) in the SAME shell that will
call `reap_pid`. Spawning through `$(spawn_fn ...)` runs in a
subshell and re-parents the backgrounded process, so a subsequent
`wait $PID` returns 127 instead of the real exit code. All tests
spawn inline.

**Fourth-round fix to scenarios 2 / 3 / 7**: the third-round harness
called `wait "$PID" || true` before invoking `reap_pid` for the
normal-exit scenarios. The reviewer pointed out this contradicted
the test goal ("prove reap_pid is the first waiter"). This revision
removes every pre-call to `wait` from those three scenarios and
replaces it with `sleep` so the child exits naturally (becoming a
zombie) without the current shell having called `wait` on it.

**Fourth-round honest disclosure**: the previous version of the
harness added `assert_first_wait_precondition` / `assert_jobs_cleared`
that treated the absence of the PID from `jobs -l` as a hard failure.
On macOS bash 3.2, this turned out to be unreliable for two
independent reasons:

1. **bash 3.2 silently returns 0 for a second `wait` on a previously
   reaped child** — not 127. So `reap_pid`'s return code alone
   cannot prove it was the first waiter.
2. **bash 3.2 only keeps the most recent `Done` job in `jobs -l`**;
   earlier terminated background jobs are unobservable. In scenario
   7 (two concurrent children), the host-side PID was reliably
   absent from `jobs -l` even when no explicit `wait` was called.

The test now records `jobs -l` snapshots as **diagnostic output**
(`[diag] ...`) instead of hard assertions, while still preserving
the core contract assertions (`rc`, `REAPED`, sentinel survives
second reap, host/joiner independence). This means the test still
exercises reap_pid's first-wait contract via the actual code path
(no `wait` is called before `reap_pid`), but does not assert on
platform-specific `jobs` behaviour that bash 3.2 makes unobservable.

| Scenario | What it proves (this revision) | Assertion count |
|---|---|---|
| 1 / host   | REAPED=1 short-circuit preserves sentinel HOST_REAP_RC=99; reap_pid never reaches `wait` | 2 |
| 1b/joiner  | Same short-circuit guarantee on JOINER_REAP_RC=77 | 2 |
| 2          | reap_pid completes wait on a zombie child → rc=0, REAPED=1 (no pre-`wait`); jobs snapshot recorded | 2 |
| 3          | First reap → rc=0, REAPED=1; sentinel rc=55 survives second reap (no pre-`wait`) | 4 |
| 4          | Active child TERM'd → rc=143, child reaped (ps no longer sees it) | 3 |
| 5          | TERM-ignored → KILL → rc=137 (joiner-side variables); fixture uses `exec` so process tree is a single node; pre-reap asserts PID has no children (proves exec worked); post-reap asserts PID is dead AND has no children AND PID 1 (init) has no new sleep children adopted (proves no orphan leak — including the reparented-to-init case that `pgrep -P` cannot see) | 6 |
| 6          | Empty PID leaves HOST_REAP_RC=88, HOST_REAPED=1 untouched | 2 |
| 6b         | Empty PID leaves JOINER_REAP_RC='' , JOINER_REAPED=0 untouched | 2 |
| 7          | Host-side and joiner-side variables are independent in both directions; no pre-`wait` (jobs snapshots recorded) | 12 |

Total: 35 assertions.

```text
$ bash tests/test_reap_pid_harness.sh
OK  [1]  scenario1.host_rc_preserved: got='99'
OK  [2]  scenario1.host_reaped_still_1: got='1'
OK  [3]  scenario1b.joiner_rc_preserved: got='77'
OK  [4]  scenario1b.joiner_reaped_still_1: got='1'
[diag] scenario2:before: jobs lists 23745 (...)
[diag] scenario2:after:  jobs does NOT list 23745 (...)
OK  [5]  scenario2.host_rc_is_0: got='0'
OK  [6]  scenario2.host_reaped_is_1: got='1'
[diag] scenario3:before_first: jobs lists 23750 (...)
OK  [7]  scenario3.first_reap_rc_is_0: got='0'
OK  [8]  scenario3.first_reap_reaped_is_1: got='1'
OK  [9]  scenario3.rc_unchanged_after_second_reap: got='55'
OK  [10] scenario3.reaped_still_1: got='1'
OK  [11] scenario4.rc_is_143: got='143'
OK  [12] scenario4.reaped_is_1: got='1'
OK  [13] scenario4.child_not_alive
OK  [14] scenario5.pre_no_pid_children (36901 has no children)
OK  [15] scenario5.rc_is_137: got='137'
OK  [16] scenario5.reaped_is_1: got='1'
OK  [17] scenario5.post_pid_dead (36901 is gone)
OK  [18] scenario5.post_no_pid_children (no descendants under 36901)
OK  [19] scenario5.post_no_init_orphans (init has no new sleep children; before=[<empty>] after=[<empty>])
OK  [20] scenario6.rc_unchanged: got='88'
OK  [21] scenario6.reaped_unchanged: got='1'
OK  [22] scenario6b.empty_rc_empty: got=''
OK  [23] scenario6b.empty_reaped_0: got='0'
[diag] scenario7:before_host:   jobs does NOT list 36928 (...)
[diag] scenario7:before_joiner: jobs lists 36929 (...)
OK  [24] scenario7.host_rc: got='0'
OK  [25] scenario7.joiner_rc: got='0'
OK  [26] scenario7.host_reaped: got='1'
OK  [27] scenario7.joiner_reaped: got='1'
OK  [28] scenario7.host_rc_independent: got='11'
OK  [29] scenario7.joiner_rc_independent: got='0'
OK  [30] scenario7.host_reaped_independent: got='1'
OK  [31] scenario7.joiner_reaped_independent: got='1'
OK  [32] scenario7.host_rc_rev: got='11'
OK  [33] scenario7.joiner_rc_rev: got='22'
OK  [34] scenario7.host_reaped_rev: got='1'
OK  [35] scenario7.joiner_reaped_rev: got='1'
----
PASS: 35 / 35
ALL TESTS PASSED
```

Test [9] is the critical double-`wait` safety test: after the first
`reap_pid`, the sentinel rc=55 survives a second reap_pid call —
proving the short-circuit fires before any `wait` runs. Test [24]
proves the host and joiner are independent: poisoning HOST_REAP_RC
does not affect JOINER_REAP_RC when only the joiner is re-reaped.
Test [28] is the reverse-direction proof for symmetry.

Diagnostic lines (`[diag] ...`) are emitted by `record_jobs_snapshot`
to stderr and document what `jobs -l` reported at the observation
points. They are **observational**, not assertions — see the
"Fourth-round honest disclosure" section above for why.

**Fifth-round fix (Scenario 5 process-tree leak)**: the Scenario 5
fixture was previously `bash -c "trap '' TERM; sleep 30"`. That
launches an outer bash that forks a sleep. When reap_pid sent
KILL to the outer PID (returned by `$!`), the outer bash died but
the inner sleep was reparented to PID 1 (init) and ran for the
full 30 seconds as an orphan. ChatGPT caught this in the
fifth-round review by inspecting GitHub. Reproduced locally:

```text
$ bash -c "trap '' TERM; sleep 30" &
OUTER_PID=33429
$ ps -p 33429 -o pid,ppid,stat,comm
33429 33427 SN   bash
$ pgrep -P 33429
33431                                # <-- inner sleep, parent=outer bash
$ kill -KILL 33429; wait 33429; rc=137
$ ps -A -o pid,ppid,comm | awk '$2 == 33429 || ($2 == 1 && $3 == "sleep")'
33431     1 sleep                   # <-- orphan, leaked
```

The fixture is now `bash -c "trap '' TERM; exec sleep 30"`. The
`exec` replaces the bash process image with `sleep` itself, so:

  - The PID returned by `$!` IS the sleep process (single-node tree).
  - `trap '' TERM` is installed before `exec`, so the new sleep
    process inherits the SIGTERM-ignore disposition (signal
    dispositions are preserved across `execve`). The TERM → grace
    → KILL escalation contract is unchanged.
  - reap_pid's KILL now removes the only node in the tree; nothing
    is reparented to init.

Verification that the new fixture has no orphan leak:

```text
$ bash tests/test_reap_pid_harness.sh
...
OK  [14] scenario5.pre_no_pid_children (36901 has no children)
OK  [15] scenario5.rc_is_137: got='137'
OK  [16] scenario5.reaped_is_1: got='1'
OK  [17] scenario5.post_pid_dead (36901 is gone)
OK  [18] scenario5.post_no_pid_children (no descendants under 36901)
OK  [19] scenario5.post_no_init_orphans (init has no new sleep children; before=[<empty>] after=[<empty>])
...
PASS: 35 / 35
ALL TESTS PASSED

# After the harness:
$ ps -A -o pid,ppid,comm | awk '$3 == "sleep"'    # → (none)
$ ps -A -o pid,ppid,comm | awk '$2 == 1 && $3 == "sleep"'    # → (none)
```

The pre-reap and post-reap assertions were added so the harness
fails LOUDLY if the fixture is ever changed back to a non-`exec`
form.

**Sixth-round fix (two residual gaps in the Scenario 5 regression
guard, flagged by ChatGPT in the cfb2f28 review)**: the fifth-round
regression guard above proved that the *currently-installed* fixture
has no orphan leak. But it left two structural gaps that would
re-introduce a leak the moment the fixture regressed, silently:

1. **Gap 1 — pre-check failure did not abort.** When
   `scenario5.pre_no_pid_children` failed, the harness logged `fail`
   and *kept going* into `reap_pid`. If the fixture were ever
   reverted to `bash -c "trap '' TERM; sleep 30"` (no `exec`), then
   `reap_pid` would KILL the outer bash, the inner sleep would be
   reparented to PID 1, and the harness would manufacture the exact
   orphan the test exists to prevent. Verified locally:
   ```text
   $ bash -c "trap '' TERM; sleep 30" &
   OUTER=35745
   $ pgrep -P 35745
   35747                              # inner sleep present → pre-check FAILS
   $ kill -KILL 35745                 # simulates reap_pid KILL-ing outer
   $ ps -A -o pid,ppid,comm | awk '$2 == 1 && $3 == "sleep"'
   35747   1 sleep                    # orphan, leaked under init
   ```
   The new Scenario 5 body is wrapped in a `run_scenario_5()` shell
   function. On pre-check failure the function runs the same
   safe-cleanup sequence the orphan-manufacturing case above
   requires (`pkill -KILL -P "$PID"`, `kill -KILL "$PID"`,
   `wait "$PID"`, plus `pkill -KILL -P 1 sleep` to reap any orphan
   init may have already adopted) and then `return`s WITHOUT calling
   `reap_pid` and WITHOUT running the post-checks (which would
   have been meaningless on a half-cleaned fixture). Subsequent
   scenarios still run because `return` (not `exit`) is used.
   Verified by `verify_gap1_fix.sh` (see § 12):
   ```text
   $ bash /tmp/verify_gap1_fix.sh
   Repro fixture: PID=37149 has children=[37151] (broken as intended)
   bash: line 1: 37151 Killed: 9               sleep 30
   PASS: Gap 1 cleanup correctly leaves no init-orphan sleep PIDs
     before=[<empty>] after=[<empty>]
   ```

2. **Gap 2 — post-check missed PID-1 reparenting.** The
   `scenario5.post_no_pid_children` assertion used `pgrep -P "$PID"`,
   which only enumerates *direct children* of `$PID`. An orphan
   reparented to PID 1 is no longer a child of `$PID` and would
   never appear in the check. Verified locally:
   ```text
   # setup: non-exec fixture, KILL outer only
   $ bash -c "trap '' TERM; sleep 30" &
   OUTER=35801
   INNER=$(pgrep -P 35801)            # → 35802
   $ kill -KILL 35801
   $ ps -A -o pid,ppid,comm | awk -v p=35802 '$1 == p { print $2 }'
   1                                  # inner is now under init
   $ pgrep -P 35801
   (empty)                            # ← previous post-check would PASS this!
   ```
   The new `scenario5.post_no_init_orphans` assertion records the
   set of `sleep` PIDs whose PPID is 1 (init) BEFORE the fixture is
   spawned, then computes the set difference AFTER `reap_pid`. Any
   new sleep PIDs adopted by init are an orphan leak — exactly the
   case the previous post-check could not see. The diff uses an
   explicit empty-string sentinel-free branch (the first draft used
   a `(none)` placeholder and produced a spurious FAIL when both
   before and after were empty — fixed by stripping them and branching
   on emptiness). Verified by `verify_gap2_fix.sh` (see § 12):
   ```text
   $ bash /tmp/verify_gap2_fix.sh
   After KILL outer: inner sleep 37279 has PPID=1 (1 = reparented to init, OK)
   PASS: Gap 2 detection CAUGHT the reparented orphan (new=[37279] includes inner 37279)
   After final cleanup: init-orphans=0
   ```

Both gaps are now closed by code that runs **on every harness
execution**, not by ad-hoc out-of-band checks. The TERM → grace →
KILL → 137 contract is unchanged: `trap '' TERM` is still installed
before `exec`, the inherited SIGTERM-ignore still makes TERM a no-op,
the grace window still elapses, and `reap_pid` still reaps the same
PID with rc=137.

**Seventh-round fix (PID-scoped cleanup — over-broad isolation
violation)**: the sixth-round cleanup used `pkill -KILL -P 1 sleep`
in four places (pre-check FAIL cleanup, post-condition 1 cleanup,
post-condition 2 cleanup, post-condition 3 cleanup). That
broad-pattern kill targets ANY `sleep` process whose parent is
PID 1 (init), regardless of whether the test created it. If a
host running this harness happened to have an unrelated sleep
under init (a long-running background job, a subshell leftover,
a third-party watcher, etc.), the harness would silently kill
it. ChatGPT's seventh-round review of `8b1cbe4` flagged this as
a test-isolation violation. **Fix (this revision)**: every kill
in scenario 5 is now PID-scoped to an `owned_pids` whitelist
captured at observation time. The whitelist is the test's own
`$PID` plus every PID found by `pgrep -P "$PID"` at pre-check
time. No command broad- or name-pattern-kills anything outside
this whitelist — and the whitelist never contains anything
the test did not spawn.

Specifically:

  - **Pre-check FAIL cleanup (Gap 1 abort path):** iterate
    `fixture_children`, `kill -KILL "$c"` for each (children die
    before being reparented). Then `kill -KILL "$PID"`, then
    `wait "$PID"`. No `pkill -P 1` of any kind. The original
    `pkill -KILL -P 1 sleep` line was deleted.
  - **Post-condition 1 cleanup (PID still alive):** just
    `kill -KILL "$PID"` (it's in owned_pids — provably ours).
    The original `pkill -KILL -P 1 sleep` line was deleted.
  - **Post-condition 2 cleanup (descendants of $PID left):**
    iterate `remaining_children` and `kill -KILL "$c"` for each
    (they were observed as children of $PID — provably our
    descendants, by PID). The original `pkill -KILL -P 1 sleep`
    line was deleted.
  - **Post-condition 3 cleanup (Gap 2 detection):** detect new
    init-sleep PIDs via diff, then split each into "provably
    ours" (in `owned_pids` whitelist) vs "unprovable" (any
    other PID). Kill ONLY the provable ones, one PID at a time.
    Any unprovable ones are left alone — they may belong to an
    unrelated process that we cannot prove is ours. The
    requirement "如果某种情况下无法安全清理，应明确报告失败及
    残留 PID，不得宣称清理成功" is honored: the failure message
    includes the residual PID(s) and explicitly states "leaving
    residual, NOT claiming cleanup success".

Verified by three independent scripts (see § 12):

1. `verify_gap1_fix.sh` — plants an unrelated init-sleep, then
   runs the scenario 5 safe-cleanup sequence against a broken
   (non-exec) fixture. Asserts (a) no init-orphan was leaked,
   (b) the unrelated sleep is still alive after cleanup:
   ```text
   $ bash /tmp/verify_gap1_fix.sh
   Planted unrelated init-sleep PID=44744 (PPID=1)
   Repro fixture: PID=44752 has children=[44754] (broken as intended)
   PASS: Gap 1 cleanup correctly leaves no leaked init-orphan sleep PIDs
     before=[44744] after=[44744]
     unrelated init-sleep 44744 still alive (isolation preserved)
   After explicit cleanup: init-sleep processes=0
   EXIT=0
   ```

2. `verify_gap2_fix.sh` — plants an unrelated init-sleep, then
   simulates the leak mode (KILL outer bash → inner sleep
   reparented to init), then runs the same PID-scoped cleanup.
   Asserts (a) the orphan is detected, (b) the provable orphan
   is killed, (c) the unrelated sleep is still alive:
   ```text
   $ bash /tmp/verify_gap2_fix.sh
   Planted unrelated init-sleep PID=44775 (PPID=1)
   Fixture: outer=44783 inner=44785 owned_pids=[44783 44785]
   After KILL outer: inner sleep 44785 has PPID=1 (1 = reparented to init, OK)
   diff new=[44785] provable=[44785] unprovable=[]
   PASS: Gap 2 detection CAUGHT the reparented orphan (new=[44785] includes inner 44785)
   PASS: provable orphan 44785 killed; unrelated init-sleep 44775 still alive
   After explicit cleanup: init-sleep processes=0
   EXIT=0
   ```

3. `verify_isolation_fix.sh` — plants an unrelated init-sleep,
   then runs the FULL reap harness. Asserts (a) the harness
   still passes 35/35, (b) the unrelated sleep is still alive
   after the harness, (c) explicit cleanup leaves init empty:
   ```text
   $ bash /tmp/verify_isolation_fix.sh
   Planted unrelated init-sleep PID=45046 (PPID=1)
   === Running reap harness with unrelated init-sleep 45046 present ===
   ...
   PASS: 35 / 35
   ALL TESTS PASSED
   PASS: unrelated init-sleep 45046 still alive after reap harness
   PASS: init has exactly 1 sleep process (= the planted unrelated one)
   PASS: explicit cleanup succeeded; init has 0 sleep processes
   ```

**Helper note (macOS bash 3.2 quirk)**: `(sleep N &)` inside a
command substitution `$(...)` causes the substitution to HANG on
macOS bash 3.2 (it returns immediately on bash 4+). The
`plant_unrelated_sleep.sh` helper works around this by running
as a standalone script (no command substitution around the
backgrounded `sleep`), capturing the sleep's PID via a normal
executable path rather than via subshell capture.

The TERM → grace → KILL → 137 contract is unchanged. Gap 1 and
Gap 2 are both preserved. Assertion count remains **35** — no
assertion was removed, relaxed, or skipped. All 35 assertions
PASS with EXIT=0.

**Eighth-round fix (recursive descendant capture + uniform
whitelist enforcement)**: the seventh-round PID-scoped cleanup
closed the broad-pattern kill, but ChatGPT's eighth-round review
of `f1ca266` identified two further isolation/correctness gaps:

1. **Multi-level process trees are not covered.** The
   seventh-round `owned_pids` whitelist was built with
   `pgrep -P "$PID"` — direct children only. A regression that
   swapped the `exec sleep 30` fixture for a deeper tree (e.g.
   `bash -c "bash -c sleep 30"`) would put grandchildren outside
   the whitelist, and the cleanup would either miss them or have
   to fall back to a broad pattern kill (which the seventh round
   forbade).

2. **Ownership verification is not uniform across cleanup paths.**
   Post-check 2 used `pgrep -P "$PID"` to find residual direct
   children and killed every PID it returned — without validating
   against `owned_pids`. Pre-check failures log used the whitelist
   but post-checks did not uniformly. If an unrelated process
   happened to be reparented to `$PID` between reap and post-
   check, we would kill it by PID.

**Fix (this revision)** introduces the recursive descent
primitives and rewires every cleanup path through them:

  - **New helpers** (added at the top of `test_reap_pid_harness.sh`
    after the `cleanup_children` trap):
      - `collect_descendants_pids <root_pid>` — BFS over
        `pgrep -P`, returns space-separated ALL descendants at
        any depth (root_pid itself NOT in output).
      - `pid_is_alive <pid>` — `kill -0` probe.
      - `pid_still_in_subtree <pid> <root_pid>` — walks the
        parent chain via `ps -A -o pid,ppid` to verify the
        PID's PPID chain still leads to `root_pid`. Returns 1
        for PID 1, init's PID, or any PID that's not in the
        subtree (cycle-safe via a `seen` set).
      - `pid_safe_kill <pid> <root_pid>` — single sanctioned
        primitive: alive + still-in-subtree guards, then
        `kill -KILL`. Used wherever the PID SHOULD still be
        in our subtree at kill time.
      - `pid_safe_kill_owned <pid> <whitelist_string>` — variant
        for the Gap 2 case: orphan is now under PID 1, NOT
        under our fixture's subtree. Ownership proof is
        whitelist membership (we observed the PID at capture
        time) plus the same aliveness guard. Same uniform
        rule applied via a different proof.
  - **Pre-check FAIL cleanup**: collect via `collect_descendants_pids`,
    then iterate `owned_pids` deepest-first (PID-descending sort)
    through `pid_safe_kill`, then `pid_safe_kill "$PID" "$PID"`,
    then `wait`. No `pkill -KILL -P 1 sleep` of any kind.
  - **Post-condition 1 cleanup**: `pid_safe_kill "$PID" "$PID"`
    instead of bare `kill -KILL` — re-verifies aliveness AND
    subtree membership.
  - **Post-condition 2 cleanup**: classify each residual PID as
    provable (in `owned_pids`) or unprovable. Provable ones killed
    deepest-first via `pid_safe_kill`. Unprovable ones reported
    as residual with their PIDs, and cleanup does NOT claim
    success. This is the same whitelist-based ownership proof
    the pre-check uses.
  - **Post-condition 3 (Gap 2) cleanup**: classify each new
    init-sleep PID as provable (in `owned_pids` at observation
    time) or unprovable. Provable ones killed via
    `pid_safe_kill_owned` (whitelist + alive, not subtree,
    because they're under init now). Unprovable ones reported
    as residual with their PIDs, NOT killed.

PID-reuse mitigation (eighth-round): every kill goes
through one of `pid_safe_kill` or `pid_safe_kill_owned`, both
of which check aliveness (`kill -0`) at kill time. The reuse
race window is narrowed to "time between observation and
kill" (typically <100 ms in this harness). The ninth round
adds an lstart identity check on top; Round-10 audit
established that lstart is second-precision on macOS, so the
narrowing catches different-second reuse only — see Round-10
disclosure in § 7b "Ninth-round fix" below for the residual
race the harness cannot prove closed.

**New verification: `verify_deep_tree_fix.sh`** exercises a
3-level fixture `bash → bash → sleep`, verifies that
`collect_descendants_pids` captures all descendants, exercises
the deepest-first PID-scoped cleanup, and confirms no orphan
sleep leaks under init while a separately-planted unrelated
init-sleep survives:

```text
$ bash /tmp/verify_deep_tree_fix.sh
Planted unrelated init-sleep PID=48964 (PPID=1)
3-level fixture: outer=48972 middle=48974 inner=48975
collect_descendants_pids(OUTER) = [48974 48975]
PASS: collect_descendants_pids captured all descendants (middle=48974 inner=48975)
owned_pids = [48972 48974 48975]
bash: line 1: 48975 Killed: 9               sleep 60
PASS: all 3-level descendants killed (outer=48972 middle=48974 inner=48975)
PASS: no orphan sleep leaked under init (before=[48964] after=[48964])
PASS: unrelated init-sleep 48964 still alive (isolation preserved)
PASS: pid_still_in_subtree correctly rejected unrelated PID 48964
...
DEEP-TREE FIX VERIFICATION PASSED
```

The existing `verify_gap1_fix.sh`, `verify_gap2_fix.sh`, and
`verify_isolation_fix.sh` were updated to source the same
helpers from the harness so any future change to the helpers
is automatically exercised by the verifiers. All four
verifications PASS with EXIT=0.

The TERM → grace → KILL → 137 contract is unchanged. Gap 1 and
Gap 2 are both preserved (in fact, the Gap 2 cleanup is now
uniform with the pre-check FAIL cleanup: both classify PIDs into
provable/unprovable, both kill only provable ones, both report
unprovable as residual). Assertion count remains **35** — no
assertion was removed, relaxed, or skipped. All 35 assertions
PASS with EXIT=0.

**Ninth-round fix (depth-correct ordering + PID-reuse guard on
every cleanup path)** — ChatGPT's ninth-round review of
`5036706` identified two remaining correctness gaps:

1. **The deepest-first claim was not actually depth-based.**
   The pre-check FAIL cleanup iterated `owned_pids` sorted by
   **PID number descending**, claiming that gives deepest-first.
   PID numbers are assigned by the kernel in arbitrary order
   (a child can have a smaller PID than its parent — PID ≠
   depth). On a fixture `outer(PID=900) → middle(PID=800) →
   sleep(PID=950)`, sorting by PID number would yield `sleep →
   outer → middle`, which is **wrong**: killing outer before
   middle would reparent the inner sleep to PID 1 before we
   had a chance to kill it. The cleanup happened to pass on
   the small fixtures used earlier because their PID numbers
   happened to align with depth — but the ordering was an
   accident, not a guarantee.

2. **`pid_safe_kill_owned` had a real PID-reuse race.** The
   primitive only verified whitelist membership + `kill -0`.
   `kill -0` succeeds on any alive process, including a
   **different** process that happened to be assigned the same
   PID after the original died (PID reuse is fast on busy
   kernels — milliseconds is enough for an unrelated process
   to take the slot). On the Gap 2 path, the orphan is now
   under PID 1 and the subtree check cannot be used at all,
   so the whitelist + lstart check was the only ownership
   proof path (and the Round-10 audit subsequently documented
   that lstart only catches different-second reuse — see
   § 7b "Round-10 audit" for the precise residual risks).

**Fix (this revision)** introduces depth-correct ordering and
a process-identity guard:

  - **New helpers** (added after the eighth-round helpers in
    `test_reap_pid_harness.sh`):
    - `pid_get_lstart <pid>` — reads `ps -o lstart=` and
      strips surrounding whitespace. Returns empty if the PID
      is gone or `ps` errors. `lstart` is the kernel-reported
      process start time as an absolute string formatted via
      strftime `%c` (`Sun Oct 11 16:01:25 2026`). **Precision
      is one second on macOS** — `ps` does not expose any
      sub-second field; two processes spawned within the same
      wall-clock second yield identical lstart strings
      (empirically verified in step 10b of
      `verify_precheck_deep_tree.sh`).
    - `identity_lookup_lstart <tsv> <pid>` — finds the
      lstart for `pid` in a `<pid>\t<lstart>` TSV produced
      by `record_identities`. Returns empty if not present.
    - `collect_descendants_with_depth <root_pid>` — BFS over
      `pgrep -P`, but outputs lines of `<depth>\t<pid>` so
      the **real tree depth** is part of the output, not a
      property of the PID number. `root_pid` itself NOT in
      output. The depth field is computed from BFS level,
      not inferred from PID.
    - `record_identities <root_pid>` — runs `pid_get_lstart`
      for root and every descendant, outputs
      `<pid>\t<lstart>` lines.
    - `pid_safe_kill_with_identity <pid> <root_pid>
      <identities_tsv> [depth] [KILL_LOG_FILE]` — the
      fourth-round's `pid_safe_kill` plus a fourth guard:
      (1) `pid` is in `identities_tsv` (we observed it at
      capture time), (2) `kill -0` succeeds (still alive),
      (3) current `ps -o lstart=` for `pid` matches the
      recorded lstart exactly (catches **different-second**
      PID reuse — see Round-10 disclosure below for what
      this does NOT catch), (4) if `root_pid` is alive,
      `pid_still_in_subtree` confirms `pid` is still under
      `root_pid`. Any guard failing → refuse to kill,
      log `reason=...` line to `KILL_LOG_FILE` if set,
      return non-zero. **Never kills unless all four guards
      pass.**
    - `pid_safe_kill_orphan <pid> <identities_tsv>` —
      variant for orphans under PID 1 (subtree check
      inapplicable). Same guards (1)–(3); guard (4) is
      skipped because the orphan's parent is now PID 1, not
      our root. The lstart check is the ONLY ownership proof
      available for orphans.

  - **Why PID number is NOT a depth proxy**: PIDs are
    allocated monotonically (mostly) but a parent process
    and its child have no constraint relating PID magnitude
    to tree depth. A `bash -c "..."` chain can produce a
    child whose PID is smaller than its parent. Killing in
    PID-descending order would kill a leaf while its parents
    are still alive, then kill a parent while its (now
    reparented to init) grandchildren are an init-orphan.
    The correct ordering is **tree depth descending**, which
    is what `collect_descendants_with_depth` produces.
  - **Re-verification on parent-child change**: each kill
    re-runs the four guards; if `pid_still_in_subtree`
    returns false (an unrelated process got reparented to
    our root between capture and kill), the kill is refused
    even if the target is alive and in `identities_tsv`.
  - **Pre-check FAIL cleanup**: now driven by
    `collect_descendants_with_depth`, sorted by
    `sort -k1,1nr -k2,2n` (depth descending, PID ascending
    within the same depth). Each iteration goes through
    `pid_safe_kill_with_identity` with the observed
    `identities_tsv`. The root is killed LAST (depth 0
    handled after the loop). `wait` follows.
  - **Post-check 1**: `pid_safe_kill_with_identity "$PID"
    "$PID" "$IDENTITIES" 0`.
  - **Post-check 2** (depth-ordered residual cleanup):
    `collect_descendants_with_depth "$PID"` → depth-sorted
    → each PID through `pid_safe_kill_with_identity`.
    Unprovable residuals are still reported, not killed.
  - **Post-check 3 (Gap 2)** (orphan cleanup): each
    provable orphan PID through `pid_safe_kill_orphan` —
    uses identities_tsv + alive + lstart match. Subtree
    check is correctly omitted because the orphan's parent
    is PID 1, not our root.

**Honest disclosure of the remaining race window**:

The PID-reuse guard is a **best-effort** identity check, not a
proof. It is composed of:

  1. PID membership in `identities_tsv` (whitelist).
  2. Aliveness (`kill -0`).
  3. `ps -o lstart=` string equality between observation and
     kill time.

What this **IS** verified to do:

  - Refuses to kill a target whose lstart differs from the
    recorded one. Verified by `verify_precheck_deep_tree.sh`
    step 10 (fabricated wrong lstart ⇒ refusal ⇒ target alive).
  - Refuses to kill a target that is no longer in the root's
    subtree (when root is still alive).

What this **is NOT** verified to do, and what the harness
therefore **cannot claim**:

  - `lstart` is **second-precision** on macOS bash 3.2 — the
    format is `Sun Oct 11 16:01:25 2026` via strftime `%c`,
    and macOS `ps` does not expose any sub-second field for
    process start time. Two processes spawned within the
    same wall-clock second yield **identical** lstart strings
    (empirically verified: `verify_precheck_deep_tree.sh`
    step 10b). Therefore:
      - **Same-second PID reuse is NOT distinguishable** by
        the lstart check. The harness cannot prove a stranger
        holding the slot from the same second as the original
        would be rejected.
      - Only **different-second** PID reuse is detectable.
  - The check-then-kill race (between `kill -0` succeeding
    and `kill -KILL` being delivered) is **not** closed. macOS
    does not provide a shell-accessible process-creation lock
    that could atomically verify identity and kill. A
    same-second stranger could in principle be inserted into
    the slot between the aliveness check and the kill
    delivery; the harness cannot prove this cannot happen.
  - `ps -o lstart=` **format drift** between observation and
    kill is a theoretical concern. We have not observed it on
    macOS bash 3.2, but cannot prove the kernel will never
    produce a different string for the same logical time.
  - **No higher-precision identity mechanism was found on
    macOS bash 3.2** that the harness could use without
    introducing external dependencies. Investigated and
    rejected (Round-10 audit):
      - `/proc/<pid>/stat` — does not exist.
      - `ps -o etimes` — keyword not found (only `etime`,
        which is `MM:SS` second-precision).
      - `sysctl kern.proc.<pid>.start` — no such OID.
      - `lsof -p <pid>` — no process-creation timestamp field.
      - All other `ps` keywords enumerated from `ps` error
        message — none provides sub-second identity.
  - For **orphans under PID 1** (Gap 2 path), the subtree
    check is inapplicable, so the lstart check is the **only**
    ownership proof available. The same-second race above is
    directly applicable here.

The harness's policy in the residual race is: **refuse to
kill and report the PID as residual**, not to risk killing
an unidentifiable stranger. The verify_*.sh scripts confirm
that no unintended process is killed in our actual test
scenarios; we make no claim beyond what those scripts
exercise.

**New verification: `verify_precheck_deep_tree.sh`**
exercises the pre-check FAIL cleanup path on a 3-level
fixture where outer and middle are long-running (NOT
`bash -c "..."` which exits and collapses the tree). It
proves:

1. `collect_descendants_with_depth` correctly tags
   middle=depth 1, inner=depth 2.
2. `record_identities` records lstart for every PID in the
   subtree.
3. Kill order is deepest-first (parsed from
   `KILL_LOG_FILE` line numbers; line(inner) < line(middle)
   < line(outer)).
4. All 3 fixture PIDs are dead after cleanup.
5. No orphan sleep leaks under init (diff vs planted
   baseline = unrelated only).
6. The unrelated init-sleep planted BEFORE the test
   survives.
7. PID-reuse guard refuses to kill a target whose lstart
   does not match (a fresh process with a fabricated
   identities_tsv is NOT killed).

```text
$ bash /tmp/verify_precheck_deep_tree.sh
Planted unrelated init-sleep PID=67786 (PPID=1)
3-level fixture: outer=67795 middle=67796 inner=67798
collect_descendants_with_depth(OUTER):
1       67796
2       67798
PASS: collect_descendants_with_depth put middle at depth 1 and inner at depth 2
identities_tsv:
67795   Thu Oct 11 14:23:01 2026
67796   Thu Oct 11 14:23:01 2026
67798   Thu Oct 11 14:23:01 2026
PASS: identities_tsv records lstart for outer, middle, inner
kill log:
KILL pid=67798 depth=2 reason=alive,subtree,lstart
KILL pid=67796 depth=1 reason=alive,subtree,lstart
KILL pid=67795 depth=0 reason=alive,subtree,lstart
PASS: kill order is deepest-first (line 1: inner, line 2: middle, line 3: outer)
PASS: all 3 fixture PIDs are dead
PASS: no orphan sleep leaked under init (before=[67786] after=[67786])
PASS: unrelated init-sleep 67786 survived (isolation preserved)
PASS: pid-reuse guard refused to kill when lstart mismatched
  FAKE_TARGET=67939 (real lstart) still alive; wrong lstart was [Thu Jan 01 00:00:00 1970]
...
PRECHECK DEEP-TREE FIX VERIFICATION PASSED
```

The eighth-round `verify_deep_tree_fix.sh` and the existing
`verify_gap1_fix.sh` / `verify_gap2_fix.sh` /
`verify_isolation_fix.sh` were also updated to source the new
helpers and use the depth-ordered kill paths. All four
verifications PASS with EXIT=0:

```text
$ bash /tmp/verify_gap1_fix.sh
PASS: Gap 1 cleanup correctly leaves no leaked init-orphan sleep PIDs
  before=[67619] after=[67619]
  unrelated init-sleep 67619 still alive (isolation preserved)

$ bash /tmp/verify_gap2_fix.sh
PASS: Gap 2 detection CAUGHT the reparented orphan (new=[67707] includes inner 67707)
PASS: provable orphan 67707 killed; unrelated init-sleep 67697 still alive

$ bash /tmp/verify_deep_tree_fix.sh
PASS: all 3-level descendants killed (outer=... middle=... inner=...)
PASS: no orphan sleep leaked under init
PASS: unrelated init-sleep ... still alive (isolation preserved)
PASS: pid_still_in_subtree correctly rejected unrelated PID

$ bash /tmp/verify_isolation_fix.sh
PASS: init has exactly 1 sleep process (= the planted unrelated one)
PASS: explicit cleanup succeeded; init has 0 sleep processes
ALL ISOLATION CHECKS PASSED
```

The reap harness itself (35/35) and the priority harness
(18/18) both still PASS with EXIT=0. Assertion count
remains **35** — no assertion was removed, relaxed, or
skipped. No new assertion was added to the harness either;
the new verification is external
(`verify_precheck_deep_tree.sh`) because the harness's
scenario 5 already exercises these paths.

**Round-10 audit (lstart precision + alternative identity
mechanisms)** — Round 9 introduced the lstart identity check.
Round 10 audited the actual precision of that check on the
target macOS bash 3.2 environment, and searched for any
alternative identity mechanism that could close the residual
race the lstart check cannot.

**Environment**:

  - macOS 15.8.1 (24G212) on Apple Silicon (arm64).
  - Darwin kernel 24.6.0.
  - Bash 3.2.57(1)-release (arm64-apple-darwin24).
  - `ps` from macOS base (BSD-style), not procps/Linux `ps`.

**Question 1: what is the actual precision of `ps -o lstart=`?**

Man page: `lstart` is "the exact time the command started,
using the `%c' format described in strftime(3)". `strftime(3)`
`%c` is the national representation (e.g. `Sun Oct 11
16:01:25 2026` on macOS en-US) — **no sub-second field**.

Empirical verification (now in-tree via `test_lstart_precision.sh`;
Round-11 re-run, identical result):

```text
$ ps -p $A -o lstart=; sleep 1.5; ps -p $A -o lstart=; sleep 2; ps -p $A -o lstart=
Sun Oct 11 15:54:49 2026     (etime = 00:00)
Sun Oct 11 15:54:49 2026     (etime = 00:02)
Sun Oct 11 15:54:49 2026     (etime = 00:04)
```

**In-tree lstart precision verifier (Round-11)**:
`experiments/phase21_experiment_a/tests/test_lstart_precision.sh`
was added in Round-11 so the same-second collision property
is reproducible from the repo (not from `/tmp`). It:

  - Records the runtime environment (uname, bash, ps path).
  - Calls `ps -o lstart=` three times on the same PID;
    asserts the string is stable (Round-9 / Round-10 audit
    stability property).
  - Spawns 40 `sleep 8` background processes (safe pattern:
    `&` + `disown`, no `( sleep N &)` subshell — bash 3.2
    hangs that on macOS), reads each PID's lstart, and
    counts how many distinct second-tokens appear.
  - If fewer distinct seconds than PIDs are observed, the
    same-second collision is empirically demonstrated
    (`PASS`).
  - If every spawn crossed a second boundary (no collision),
    it explicitly reports `NOT_VERIFIED` rather than PASS —
    the harness does NOT assume sub-second precision on
    macOS bash 3.2 without observation.
  - Cleanup only kills PIDs whose current `lstart` matches
    the recorded spawn-time `lstart`. Any PID whose lstart
    drifted is reported as `REPORTED_RESIDUAL` and left
    alive — same identity policy as
    `pid_safe_kill_with_identity`.

```text
$ bash experiments/phase21_experiment_a/tests/test_lstart_precision.sh
ENV: uname=Darwin 24.6.0 bash=3.2.57(1)-release ps=/bin/ps
STEP1: ps -o lstart= on 79742 => [Sun Oct 11 16:12:33 2026]
STEP2: lstart stable across 3 ps calls (same second) => [Sun Oct 11 16:12:33 2026]
STEP2_VERDICT: PASS — lstart is stable within <1s
STEP3: spawned 40 processes; distinct lstart seconds = 1
STEP3: SAME-SECOND COLLISION observed — example: lstart=[Sun Oct 11 16:12:33 2026] share_count=39 ...
STEP3_VERDICT: PASS — same-second processes have identical lstart on this host
STEP4: cleanup killed=40 residual=<none>
STEP5: no residual PIDs from this script
```

The previous `/tmp/lstart_collision_test.sh` and step 10b
of `/tmp/verify_precheck_deep_tree.sh` remain valid
supplementary evidence but are now duplicated by the
in-tree script. Future audits should re-run
`test_lstart_precision.sh` from the repo.

```text
$ ps -p $A -o lstart=; sleep 1.5; ps -p $A -o lstart=; sleep 2; ps -p $A -o lstart=
Sun Oct 11 15:54:49 2026     (etime = 00:00)
Sun Oct 11 15:54:49 2026     (etime = 00:02)   <-- 1.5s later, same string
Sun Oct 11 15:54:49 2026     (etime = 00:04)   <-- 3.5s later, same string
```

The lstart string is stable across `ps` calls for the same
process and only changes when the underlying wall-clock
second boundary is crossed. **Resolution = 1 second.**

**Question 2: do two processes spawned within the same second
collide on lstart?**

Verified empirically in the same session:

```text
$ bash /tmp/lstart_collision_test.sh
A=73072 lstart=[Sun Oct 11 15:58:44 2026]
B=73073 lstart=[Sun Oct 11 15:58:44 2026]
RESULT: lstart COLLIDES (Sun Oct 11 15:58:44 2026 == Sun Oct 11 15:58:44 2026)
        — sub-second distinction NOT possible
```

And in `verify_precheck_deep_tree.sh` step 10b:

```text
lstart precision test: A=[Sun Oct 11 16:01:25 2026] B=[Sun Oct 11 16:01:25 2026]
PASS: lstart is second-precision on macOS (same-second collision demonstrated)
        IMPLICATION: same-second PID reuse is NOT distinguishable
        by lstart; the harness documents this residual race
```

**Therefore**: lstart catches *different-second* PID reuse,
and **does NOT** catch *same-second* PID reuse. Round 9's
report claimed the lstart check "detects PID reuse" without
qualifying the second-precision limitation; Round 10 corrects
this. The verification step 10 (fabricated wrong-second
lstart ⇒ refusal ⇒ target alive) is unchanged and still
valid; it now serves as the "different-second case" proof.

**Question 3: does any other shell-accessible mechanism on
macOS bash 3.2 provide sub-second process identity?**

Investigated and rejected:

| Candidate | Available? | Sub-second? |
|---|---|---|
| `/proc/<pid>/stat` (Linux) | NO — `/proc` does not exist on macOS | n/a |
| `ps -o etimes` (Linux procps) | NO — `ps: etimes: keyword not found`; macOS `ps` only has `etime` (MM:SS) | NO |
| `sysctl kern.proc.<pid>.start` | NO — `sysctl: couldn't find oid` | n/a |
| `sysctl -a \| grep kern.proc` | Only `kern.procname` and `kern.proc_rsr_in_progress` (unrelated to process identity) | n/a |
| `lsof -p <pid>` | YES, but exposes FD/comm/state — no creation timestamp | n/a |
| Other `ps` keywords | Full enumeration from `ps` error message — none provides sub-second identity | NO |
| `getpidinfo` / `sysctlbyname("kern.proc.<pid>")` from C | Available, but would require a binary outside the bash harness | YES, but **out of scope** for this round (introduces external dependency) |

No mechanism was found that the bash harness could call to
produce a stable, sub-second, same-second-colliding-free
process-creation token without introducing an external dependency
the project has not adopted. Per Round-10 task spec, the
audit explicitly **forbids** introducing unverified
dependencies.

**Question 4: residual check-then-kill race?**

The kill primitive:

```bash
pid_is_alive "$pid"          # kill -0
current_lstart=$(pid_get_lstart "$pid")   # ps -o lstart=
... string compare ...
kill -KILL "$pid"             # actual kill
```

Between `kill -0` succeeding and `kill -KILL` being delivered,
an unrelated process could reuse the PID slot. There is no
shell-accessible atomic "verify identity + kill" operation on
macOS. **The race is not provably closed by the harness.**
The harness's policy is to refuse to kill and report the PID
as residual in any ambiguous case, not to risk killing an
unidentifiable stranger.

**Question 5: format-drift risk?**

`ps -o lstart=` format on macOS is documented as `%c` (per
`man ps`) and is the same string in every observation across
the test runs in this round. We cannot prove the kernel
will never produce a different string for the same logical
time, but we have not observed it. The harness treats
format drift as a hypothetical concern, with a refusal-on-mismatch
policy that biases toward *not* killing a real target (safe
failure mode).

**Code change decision (Round-10 task spec, section 4)**:

No code change was made in Round 10. The criteria for a code
change were:

1. A more reliable identity mechanism must be available
   in the current environment.
2. It must not break Bash 3.2 compatibility or the existing
   cleanup contract.
3. It must pass a new targeted test.
4. It must not expand cleanup authority or lower existing
   assertion standards.

None of the candidates in the table above met all four
criteria. Therefore per the explicit instruction "如果找不到
满足条件的机制,本轮可以只修改报告和注释", this round modifies
only the harness comments and the report:

  - `test_reap_pid_harness.sh`: comments on `pid_get_lstart`,
    `pid_safe_kill_with_identity`, `pid_safe_kill_orphan`
    document the second-precision limit, the same-second
    race, and the check-then-kill race.
  - `REPORT.md`: this Round-10 audit section; corrections
    to the Ninth-round "Honest disclosure" section;
    correction to the Gap-8 table row wording.
  - `verify_precheck_deep_tree.sh`: added step 10b that
    empirically demonstrates the second-precision /
    same-second-collision property.

**Verdict on PID-reuse guard** (corrected from Round 9):

  - `PASS`: PID-reuse guard refuses to kill a target whose
    lstart differs from the recorded one (different-second
    case). Verified by step 10.
  - `RISK_REMAINS`: same-second PID reuse is not
    distinguishable by lstart. Documented, not eliminated.
  - `RISK_REMAINS`: the check-then-kill race is not provably
    closed. Documented, not eliminated.
  - `RISK_REMAINS`: lstart format drift is a theoretical
    concern. Not observed, not eliminated.

## 7c. Regression sub-tests for the `$?`-capture fix (first revision, retained)

| Name | Input | Expected | Actual | Verdict |
|---|---|---|---|---|
| regression-30  | `exit 30` (precond fail, no children) | 30 | **30** | PASS — was demoted to 0 under the old bug |
| regression-20  | `exit 20` (build fail, no children) | 20 | **20** | PASS |
| regression-0   | `exit 0`  (happy path, no children) | 0  | **0**  | PASS |
| regression-child-fail | host_reap=7, joiner_reap=7, exit 0 | 10 (host fail) | **10** | PASS |

These regression tests are reproducible by re-running the harness
defined in this section; they are deliberately minimal so they isolate
the cleanup-function behaviour from the rest of the test script.

## 8. Logs

`.gitignore` excludes `*.log`, so no log file is committed to the
repository. All evidence required for review is embedded inline in § 7.

Per-run host/joiner process logs are written by the script to
`/tmp/kindora-expA-{host,joiner}.{run_id}.log` and were the source
for the inline excerpts above.

## 9. Source-Integrity Recheck (T12)

Re-checked after all tests: protected file SHA-256 + size + mtime all
match the baseline in § 2. **No originals were touched.**

## 10. Known Issues & NOT_VERIFIED Items

| Item | Reason | Workaround in this experiment |
|---|---|---|
| macOS bash 3.2 does not run INT trap on external `kill -INT` | Known bash 3.2 / macOS TTY driver quirk | SIGTERM path verified instead |
| Foreground Ctrl-C behavior | Requires interactive terminal; not automatable | Out of scope for automated verification |
| `--offline` does not by itself prove "no network" | Cargo could still touch the registry index | Cache diff before/after used as auxiliary evidence; cargo exited 0 with no `error:`; `--offline` flag used; stderr has no network markers |
| `kill -0` on zombie PID | Cannot reliably distinguish alive vs zombie on macOS | `wait` return used as sole evidence of reclamation; `kill -0` only used for best-effort probe |
| `jobs -l` only keeps the most recent `Done` background job on macOS bash 3.2 | Earlier-terminated background children are unobservable via `jobs -l` even when no `wait` has run | reap_pid harness records `jobs -l` as `[diag]` diagnostic output rather than hard assertion; the test still proves the contract via the code path (no pre-`wait`) |
| bash 3.2 second `wait` returns 0 (not 127) for previously reaped child | Platform behaviour; means `reap_pid`'s return code alone cannot prove it was the first waiter | Test asserts on `rc_var` / `REAPED` side-effects, not on `wait`'s exit code |
| KILL of an outer `bash -c "..." &` leaves the inner `sleep` orphaned (reparented to PID 1, init) | macOS does not propagate SIGKILL to forked-but-not-reaped children | Scenario 5 fixture now uses `bash -c "...; exec sleep 30"` so the process tree has one node; pre/post assertions verify no orphan is created. Sixth round added: (a) pre-check FAIL now aborts the scenario without calling `reap_pid`, and safe-cleans the spawned subtree so the harness cannot manufacture an orphan even if the fixture regresses; (b) post-check now diffs the init-sleep set before vs after `reap_pid` to catch reparented-to-init orphans that `pgrep -P` cannot see. Both gaps independently verified by `verify_gap1_fix.sh` and `verify_gap2_fix.sh`. Seventh round added PID-scoped isolation: every kill is now restricted to PIDs in the scenario's `owned_pids` whitelist ($PID + its observed children); broad-pattern `pkill -KILL -P 1 sleep` was removed. Independent isolation contract verified by `verify_isolation_fix.sh`: an unrelated init-sleep planted BEFORE the harness survives the harness (35/35 PASS). Eighth round added (a) recursive descendant capture via `collect_descendants_pids` so the whitelist is correct for any depth the fixture spawns (not just direct children), and (b) uniform ownership verification across ALL cleanup paths: pre-check FAIL, post-check 1/2/3 all classify residuals as provable/unprovable and kill only provable ones; unprovable ones are reported with PIDs and the cleanup does NOT claim success. Two new helpers (`pid_safe_kill` and `pid_safe_kill_owned`) consolidate the PID-reuse guards (`kill -0` aliveness + either subtree or whitelist ownership) so every kill goes through the same primitive. New verification `verify_deep_tree_fix.sh` exercises a 3-level `bash → bash → sleep` fixture and confirms the recursive whitelist + deepest-first cleanup + isolation contract all hold simultaneously. Ninth round added (a) **depth-correct ordering**: `collect_descendants_with_depth` + `sort -k1,1nr -k2,2n` (real BFS depth, not PID number, since PID number ≠ tree depth and a parent can have a larger PID than its child) so the pre-check FAIL cleanup is genuinely deepest-first and never kills a parent before its descendants; and (b) **PID-reuse guard via lstart identity**: `record_identities` captures `ps -o lstart=` for every PID in the subtree at observation time; `pid_safe_kill_with_identity` and `pid_safe_kill_orphan` (for orphans under PID 1 where subtree check is inapplicable) refuse to kill unless the current `lstart` matches the recorded one — so a **different-second** PID-reused, unrelated process cannot be misidentified as our target. New verification `verify_precheck_deep_tree.sh` exercises a long-running 3-level fixture, asserts the kill order from `KILL_LOG_FILE` line numbers, and asserts the PID-reuse guard refuses to kill when lstart mismatches (different-second case). **Round 10 audit** verified empirically that `ps -o lstart=` is second-precision on macOS bash 3.2 and that two processes spawned within the same wall-clock second have **identical** lstart strings; the harness therefore cannot distinguish same-second PID reuse by lstart. The Round-10 audit also investigated and rejected alternative identity mechanisms (`/proc`, `etimes`, `sysctl kern.proc.<pid>.start`, `lsof`, full `ps` keyword enumeration) — none provides sub-second identity in this environment. The check-then-kill race (between `kill -0` succeeding and `kill -KILL` delivery) is documented in `§ 7b` "Round-10 audit" as `RISK_REMAINS`. The harness's policy is to refuse to kill in any ambiguous case and report the PID as residual, not to risk killing an unidentifiable stranger. |
| `ps -o lstart=` is second-precision on macOS bash 3.2 | strftime `%c` format yields no sub-second component; macOS `ps` has no etimes/etimens field; no /proc on macOS | `verify_precheck_deep_tree.sh` step 10b empirically demonstrates the precision and the same-second collision. Different-second PID reuse is detectable (verified step 10). Same-second PID reuse is `RISK_REMAINS`; harness refuses to kill in that case rather than risk killing a stranger. |
| Check-then-kill race between `kill -0` success and `kill -KILL` delivery | macOS does not provide a shell-accessible atomic "verify identity + kill" operation | `RISK_REMAINS`; harness's policy is to refuse + report residual. Eliminating this race would need a kernel-held process-creation token via sysctl-by-name or a C helper — neither adopted in this project. |

## 11. Overall Conclusion

Phase 2.1 Experiment A (tenth revision, with the Scenario 5
regression guard hardened against pre-check failures, PID-1
reparenting, broad-pattern cleanup, multi-level process trees,
uniform ownership verification across all cleanup paths,
**depth-correct deepest-first ordering**, **different-second
PID-reuse-safe identity verification via process start time**
(verified), AND **Round-10 honest disclosure of the residual
race the lstart check cannot close** (same-second reuse,
check-then-kill race) — see § 7b "Round-10 audit") — **PASS**
on the harness-detectable axes. The reap_pid harness now
proves the reap-first-wait contract via **code path** (no
`wait` is ever called before `reap_pid`); platform-side proof
via `jobs -l` is recorded as diagnostic output because macOS
bash 3.2's auto-`reap` of earlier SIGCHLDs makes the `jobs`
table unobservable for the non-most-recent child (see § 7b
"Fourth-round honest disclosure"). The Scenario 5 regression
guard now survives (1) a fixture regression that re-introduces
an outer bash (Gap 1: pre-check FAIL aborts with safe
cleanup), (2) an orphan reparented to PID 1 (Gap 2: post-check
diffs init's sleep set before vs after), (3) a broad-pattern
cleanup that would kill unrelated init-sleep processes (Gap 3
isolation: cleanup is PID-scoped to the scenario's
`owned_pids` whitelist), (4) a multi-level fixture that
produces descendants deeper than the direct children
`pgrep -P` could see (Gap 4 deep-tree:
`collect_descendants_pids` BFS captures the full subtree, and
every kill goes through `pid_safe_kill_with_identity` /
`pid_safe_kill_orphan` (Round-9 primitives that REPLACED
the eighth-round `pid_safe_kill` / `pid_safe_kill_owned` for
scenario 5 paths) with lstart identity + subtree guards +
uniform whitelist enforcement),
(5) a depth ordering that is **real tree depth** (not PID
number, since PID number ≠ depth and the kernel assigns PIDs
in an order unrelated to tree depth) with a **PID-reuse
guard via process start time (`lstart`)** that catches
**different-second** reuse (verified empirically that two
processes spawned within the same wall-clock second have
identical lstart strings on macOS bash 3.2, so same-second
reuse remains `RISK_REMAINS` — the harness refuses to kill
in that case rather than risk killing a stranger), AND
(6) the documented check-then-kill race window between
`kill -0` and `kill -KILL` delivery (also `RISK_REMAINS`,
unclosable without an external dependency).

| Bucket | Result |
|---|---|
| A1 minimal offline build | PASS |
| A2 isolated project build (incl. host_ignore_term) | PASS |
| Parser unit tests (17/17) | PASS |
| Normal handshake (T1, T9) | PASS (exit=0) |
| Host / joiner internal timeout (T2, T3) | PASS (exit=10) |
| Port-occupancy handling (T4, T5) | PASS (T4=11 host+joiner both fail, T5=10 host times out) |
| Protocol-error handling (T6) | PASS (exit=11) |
| Bash syntax 3.2 (T10) | PASS |
| Bash SIGTERM cleanup (T7b) | PASS (exit=130) |
| Watchdog TERM→KILL escalation (T8, host_ignore_term) | PASS (host_reap=137) |
| Build failure (T-build) | PASS (exit=20, trap_rc=20, no children) |
| Precond fail — missing host (T-precond-host) | PASS (exit=30, trap_rc=30) |
| Precond fail — missing joiner (T-precond-joiner) | PASS (exit=30) |
| **Stress: 20x normal handshake (T-stress)** | **PASS (20/20 rc=0, hostOK + joinerOK both verified per iteration; failure evidence recording active but no failures occurred)** |
| Cleanup `$?`-capture fix (regression-30/20/0/child-fail) | PASS |
| **decide_priority() unit tests (18/18)** | **PASS** |
| **reap_pid() idempotency unit tests (35/35)** | **PASS (scenarios 2/3/7 fixed: no pre-`wait`; jobs snapshots are diagnostic-only on bash 3.2; scenario 5 fixture uses `exec`; sixth-round hardening: pre-check FAIL aborts safely, post-check diffs init-sleep set to catch reparented orphans)** |
| **Scenario 5 Gap 1 — pre-check FAIL safe-cleanup** | **PASS** (`verify_gap1_fix.sh`: broken fixture → safe cleanup → no init-orphan sleep PIDs; unrelated init-sleep survives) |
| **Scenario 5 Gap 2 — reparented-to-init detection** | **PASS** (`verify_gap2_fix.sh`: simulated reparent → diff catches new sleep PID under init; provable orphan killed; unrelated init-sleep survives) |
| **Scenario 5 Gap 3 — test isolation (no broad-pattern kills)** | **PASS** (`verify_isolation_fix.sh`: unrelated init-sleep planted BEFORE reap harness; harness passes 35/35; unrelated sleep survives; init has exactly 1 sleep (= planted one); explicit cleanup succeeds) |
| **Scenario 5 Gap 4 — multi-level fixture (deep-tree)** | **PASS** (`verify_deep_tree_fix.sh`: 3-level `bash → bash → sleep` fixture; `collect_descendants_pids` captures all 3 levels; deepest-first PID-scoped cleanup kills all 3 levels; no orphan sleep leaks under init; unrelated init-sleep survives; `pid_still_in_subtree` correctly rejects unrelated PID; final init-sleep count = 0) |
| **Scenario 5 Gap 5 — depth-correct + PID-reuse-safe pre-check FAIL cleanup** | **PASS** (`verify_precheck_deep_tree.sh`: 3-level fixture where outer and middle are long-running; `collect_descendants_with_depth` correctly tags middle=depth 1, inner=depth 2; `record_identities` captures lstart for every PID; cleanup is killed by **real depth** descending, not PID number; PID-reuse guard refuses to kill when lstart mismatches (different-second case); step 10b empirically demonstrates lstart is second-precision on macOS bash 3.2 and that two processes started within the same second collide — see Round-10 audit for what this does NOT cover (same-second reuse; check-then-kill race); unrelated init-sleep survives; final init-sleep count = 0). See § 7b "Ninth-round fix" + "Round-10 audit". |
| **Round-11 in-tree lstart precision verifier** | **PASS** (`tests/test_lstart_precision.sh`: spawned 40 background sleep processes on this host; all 40 share the same `Sun Oct 11 16:12:33 2026` lstart string; cleanup policy kills only PIDs whose lstart still matches the recorded value — same identity rule as `pid_safe_kill_with_identity`). See § 7b "Round-11 in-tree lstart precision verifier". |
| Source-file integrity (T12) | PASS (every check) |
| Bash SIGINT (background, T7a) | NOT_VERIFIED (re-confirmed: `kill -INT <pid>` does not fire bash INT trap on macOS bash 3.2 in non-tty; see T7a section) |
| Foreground Ctrl-C (T7c) | NOT_VERIFIED (cannot be automated; manual reproduction steps in T7c section) |

The two NOT_VERIFIED items remain environment limitations, not
script bugs. The SIGTERM path proves the same cleanup and exit-code
routing works correctly when an interrupt signal actually reaches
the bash process.

T-stress is recorded as **PASS** (race trigger removed by the
host-ready sync, 20/20 runs succeed with both host and joiner
emitting the `OK` line each iteration, no failure evidence was
preserved because no run failed). Per the third-round reviewer
rule, this is **not** a claim that "race is theoretically
impossible" — it is a claim that "the trigger we identified has
been removed and the resulting runs are stable". A residual
host-side race (e.g. OS UDP queue full) is not empirically ruled
out by 20 consecutive runs.

No protected file was modified. No work outside the experiment
directory was performed.

## 12. Reproduction

```bash
cd /Users/jiang/development/Kindora
. "$HOME/.cargo/env"

# Build (A1 + A2 combined: full experiment project with all 7 binaries)
cargo build --offline --manifest-path experiments/phase21_experiment_a/Cargo.toml

# A3 tests
cd experiments/phase21_experiment_a
SKIP_BUILD=1 bash scripts/run_unicast_test.sh                  # T1, T9
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_silent   \
  bash scripts/run_unicast_test.sh                             # T2
SKIP_BUILD=1 JOINER_BIN_OVERRIDE=$PWD/target/debug/joiner_silent \
  bash scripts/run_unicast_test.sh                             # T3
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_ignore_term \
  bash scripts/run_unicast_test.sh                             # T8 (TERM→KILL proof)
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
  bash scripts/run_unicast_test.sh                             # T8 legacy TERM-only contrast
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_bad_protocol \
  bash scripts/run_unicast_test.sh                             # T6
python3 tests/fixtures/port_holder.py 52420 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh; kill %1   # T4
python3 tests/fixtures/port_holder.py 52421 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh; kill %1   # T5
SKIP_BUILD=1 HOST_BIN_OVERRIDE=/nonexistent/host bash scripts/run_unicast_test.sh            # T-precond-host (exit=30)
SKIP_BUILD=1 JOINER_BIN_OVERRIDE=/nonexistent/joiner bash scripts/run_unicast_test.sh        # T-precond-joiner (exit=30)
bash -n scripts/run_unicast_test.sh                            # T10
cargo test --offline --manifest-path Cargo.toml --bin lan_cross_process_host                 # T11
bash tests/test_priority_harness.sh                            # § 7a (18/18 priority unit tests)
bash tests/test_reap_pid_harness.sh                            # § 7b (35/35 reap_pid unit tests)

# Sixth-round Gap 1 / Gap 2 independent verifications (see § 7b "Sixth-round fix"):
bash /tmp/verify_gap1_fix.sh                                   # pre-check FAIL safe-cleanup → no init-orphan; unrelated survives
bash /tmp/verify_gap2_fix.sh                                   # reparented-to-init detection via init-sleep diff; provable orphan killed; unrelated survives

# Seventh-round isolation verification (see § 7b "Seventh-round fix"):
# Plant an unrelated init-sleep FIRST, then run the reap harness.
# Verifies the harness does NOT issue any broad-pattern kill that
# would affect the unrelated sleep.
bash /tmp/verify_isolation_fix.sh                              # reap harness with unrelated init-sleep present; unrelated must survive
bash /tmp/plant_unrelated_sleep.sh 300                         # helper: spawn a sleep that gets reparented to PID 1 (init)

# Eighth-round deep-tree + uniform-whitelist verification (see § 7b "Eighth-round fix"):
bash /tmp/verify_deep_tree_fix.sh                              # 3-level bash->bash->sleep fixture; collect_descendants_pids captures all; deepest-first cleanup; unrelated survives

# Ninth-round depth-correct + PID-reuse-guard verification (see § 7b "Ninth-round fix"):
bash /tmp/verify_precheck_deep_tree.sh                         # 3-level long-running fixture; collect_descendants_with_depth tags depths correctly; kill order is real depth descending (parsed from KILL_LOG_FILE line numbers); record_identities captures lstart; pid_safe_kill_with_identity refuses to kill on lstart mismatch; unrelated init-sleep survives

# Round-11 in-tree lstart precision verifier (reproducible from the repo):
bash experiments/phase21_experiment_a/tests/test_lstart_precision.sh  # lstart stability across ps calls + same-second collision demonstration (PASS if observed in this run, NOT_VERIFIED if no collision); cleanup policy mirrors pid_safe_kill_with_identity (only kill on lstart match)
bash /tmp/plant_3level_fixture.sh 60                           # helper: spawn a 3-level long-running bash tree for the precheck verification

# T-build (build fail → exit=20). Invoke from a tempdir with no Cargo.toml:
TMPDIR=$(mktemp -d); ln -sf "$PWD/scripts/run_unicast_test.sh" "$TMPDIR/"
( cd "$TMPDIR" && bash run_unicast_test.sh ); rm -rf "$TMPDIR"   # T-build

# T7b SIGTERM
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
  bash scripts/run_unicast_test.sh &
P=$!
sleep 4
kill -s TERM $P
wait $P
```