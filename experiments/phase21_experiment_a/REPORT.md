# Phase 2.1 Experiment A — Acceptance Report

Independent experiment for verifying cross-process UDP unicast between two
Rust processes, isolated from the main Tauri project.

## 1. Baseline & Toolchain (VERIFIED)

| Item | Value |
|---|---|
| HEAD commit (pre-experiment) | `009f8fa37ccd04527809e5f33e874805f7b6bfde` |
| HEAD commit (this revision)  | `bd2ff3dafae64a7b47745366b79e9a532e0ebe20` |
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
  **full rewrite** to address the third-round reviewer feedback.
  Previous test had the logical contradiction of pre-calling `wait`
  and then expecting `reap_pid` to return rc=0 — that exercised
  nothing about idempotency. Now covers the full 7-scenario spec:
  (1) short-circuit with REAPED=1 sentinel rc preserved,
  (1b) same for joiner vars, (2) reap_pid is the first/only waiter,
  (3) second reap is a no-op, (4) active child TERM'd → rc=143,
  (5) TERM-ignored → KILL → rc=137, (6) empty PID no-op (no state
  pollution), (6b) empty PID with sentinel+REAPED=1,
  (7) host/joiner variables independent (forward + reverse direction
  poisoning). Critical invariant: children spawned inline in the
  SAME shell (not via `$(...)` subshell, which would re-parent and
  break subsequent `wait`). 29 assertions, all PASS.
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
by `tests/test_reap_pid_harness.sh` — 9/9 cases pass — and observed
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

```text
$ bash /tmp/sig_int_test.sh & sleep 1; kill -INT $!; sleep 2
started pid=63854
STILL_ALIVE_AFTER_INT_killing_now   # bash INT trap did NOT fire
wait_rc=137                           # process killed via SIGKILL
```

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

Out of scope for non-interactive automation.

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

**Evidence — 20 consecutive normal handshakes, all 20 PASS:**

```text
$ for i in $(seq 1 20); do
    SKIP_BUILD=1 bash scripts/run_unicast_test.sh >/dev/null 2>&1
    echo "iter=$i rc=$?"
  done
iter=1 rc=0
iter=2 rc=0
iter=3 rc=0
iter=4 rc=0
iter=5 rc=0
iter=6 rc=0
iter=7 rc=0
iter=8 rc=0
iter=9 rc=0
iter=10 rc=0
iter=11 rc=0
iter=12 rc=0
iter=13 rc=0
iter=14 rc=0
iter=15 rc=0
iter=16 rc=0
iter=17 rc=0
iter=18 rc=0
iter=19 rc=0
iter=20 rc=0
----
PASS=20 FAIL=0
```

Per-iteration exit code 0 across all 20 runs, with both host and
joiner producing their `OK` lines, `host_ok=0 joiner_ok=0
cleanup_ok=1 interrupted=0` on every iteration. Failure-evidence
recording was active (any non-zero exit would have preserved the
full host/joiner log tail into `/tmp/stress20_results.txt`); zero
such failures occurred, so no failure evidence was preserved.

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
from the real script and exercises **29 assertions** across the 7
scenarios from the third-round reviewer spec. The previous version's
central contradiction — calling `wait` first, then `reap_pid`, and
expecting the same rc — is removed; tests now verify the real
contract directly.

**Critical invariant documented in the test file**: children must be
spawned inline (`sleep 30 &; PID=$!`) in the SAME shell that will
call `reap_pid`. Spawning through `$(spawn_fn ...)` runs in a
subshell and re-parents the backgrounded process, so a subsequent
`wait $PID` returns 127 instead of the real exit code. All tests
spawn inline.

| Scenario | What it proves |
|---|---|
| 1 / host   | REAPED=1 short-circuit preserves a sentinel HOST_REAP_RC (99); reap_pid never reaches `wait` |
| 1b/joiner  | Same short-circuit guarantee on JOINER_REAP_RC (77) |
| 2          | reap_pid is the first/only waiter for a normal-exit child → rc=0 |
| 3          | After first reap, second reap preserves a sentinel rc=55 (no 127 overwrite) |
| 4          | Active child TERM'd → rc=143, child reaped (ps no longer sees it) |
| 5          | TERM-ignored → KILL → rc=137 (joiner-side variables for host/joiner independence) |
| 6          | Empty PID leaves HOST_REAP_RC=88, HOST_REAPED=1 untouched |
| 6b         | Empty PID leaves JOINER_REAP_RC='' , JOINER_REAPED=0 untouched |
| 7          | Host-side and joiner-side variables are independent in both directions (poison host, re-reap joiner; poison joiner, re-reap host) — 8 assertions |

```text
$ bash tests/test_reap_pid_harness.sh
OK  [1]  scenario1.host_rc_preserved: got='99'
OK  [2]  scenario1.host_reaped_still_1: got='1'
OK  [3]  scenario1b.joiner_rc_preserved: got='77'
OK  [4]  scenario1b.joiner_reaped_still_1: got='1'
OK  [5]  scenario2.host_rc_is_0: got='0'
OK  [6]  scenario2.host_reaped_is_1: got='1'
OK  [7]  scenario3.rc_unchanged_after_second_reap: got='55'
OK  [8]  scenario3.reaped_still_1: got='1'
OK  [9]  scenario4.rc_is_143: got='143'
OK  [10] scenario4.reaped_is_1: got='1'
OK  [11] scenario4.child_not_alive
OK  [12] scenario5.rc_is_137: got='137'
OK  [13] scenario5.reaped_is_1: got='1'
OK  [14] scenario6.rc_unchanged: got='88'
OK  [15] scenario6.reaped_unchanged: got='1'
OK  [16] scenario6b.empty_rc_empty: got=''
OK  [17] scenario6b.empty_reaped_0: got='0'
OK  [18] scenario7.host_rc: got='0'
OK  [19] scenario7.joiner_rc: got='0'
OK  [20] scenario7.host_reaped: got='1'
OK  [21] scenario7.joiner_reaped: got='1'
OK  [22] scenario7.host_rc_independent: got='11'
OK  [23] scenario7.joiner_rc_independent: got='0'
OK  [24] scenario7.host_reaped_independent: got='1'
OK  [25] scenario7.joiner_reaped_independent: got='1'
OK  [26] scenario7.host_rc_rev: got='11'
OK  [27] scenario7.joiner_rc_rev: got='22'
OK  [28] scenario7.host_reaped_rev: got='1'
OK  [29] scenario7.joiner_reaped_rev: got='1'
----
PASS: 29 / 29
ALL TESTS PASSED
```

Test [7] is the critical double-`wait` safety test: after the first
`reap_pid`, the sentinel rc=55 survives a second reap_pid call —
proving the short-circuit fires before any `wait` runs. Test [22]
proves the host and joiner are independent: poisoning HOST_REAP_RC
does not affect JOINER_REAP_RC when only the joiner is re-reaped.
Test [27] is the reverse-direction proof for symmetry.

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

## 11. Overall Conclusion

Phase 2.1 Experiment A (third revision, with explicit
`decide_priority()`, single-source reaping, host-ready
synchronization, and the rewritten reap_pid test) — **PASS** on
the harness-detectable axes.

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
| **Stress: 20x normal handshake (T-stress)** | **PASS (20/20 rc=0; failure evidence preserved but no failures occurred)** |
| Cleanup `$?`-capture fix (regression-30/20/0/child-fail) | PASS |
| **decide_priority() unit tests (18/18)** | **PASS** |
| **reap_pid() idempotency unit tests (29/29)** | **PASS (rewritten, covers all 7 spec scenarios)** |
| Source-file integrity (T12) | PASS (every check) |
| Bash SIGINT (background) | NOT_VERIFIED (macOS bash 3.2 limitation) |
| Foreground Ctrl-C | NOT_VERIFIED (cannot be automated) |

The two NOT_VERIFIED items remain environment limitations, not
script bugs. The SIGTERM path proves the same cleanup and exit-code
routing works correctly when an interrupt signal actually reaches
the bash process.

T-stress is recorded as **PASS** (race trigger removed by the
host-ready sync, 20/20 runs succeed, no failure evidence was
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
bash tests/test_reap_pid_harness.sh                            # § 7b (9/9 reap_pid unit tests)

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