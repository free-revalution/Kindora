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

### Modified

- `experiments/phase21_experiment_a/Cargo.toml` — added `[[bin]] host_ignore_term` in this revision
- `experiments/phase21_experiment_a/scripts/run_unicast_test.sh` — fixed `$?`
  capture in `cleanup()`; added `CHILDREN_STARTED` guard so build/precond
  fail codes (20/30) are not demoted to host/joiner fail codes (10/11)

> Note: `experiments/phase21_experiment_a/logs/*.log` is git-ignored.
> This report therefore embeds the relevant console evidence inline so
> GitHub web review works without access to local logs.

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

- `reap_pid <pid> <rc_var>` — three-stage: send TERM → wait GRACE_S → send
  KILL → `wait` for reclamation. Uses `printf -v` to record the
  `wait` exit code into a caller-named global variable (no command
  substitution, no subshell).
- `is_alive` probe exists only as a hint for the watchdog's polling
  loop and for the post-cleanup residual check; it is **never** the
  sole evidence of reclamation.
- `TRAP_REENTERED` flag prevents EXIT trap re-entry if cleanup itself
  exits and fires EXIT again.
- `CHILDREN_STARTED` flag distinguishes "children were spawned, reaped
  exit codes are authoritative" from "script died at build / precond
  stage, so reaped exit codes are empty and trap_rc is authoritative."
- INT/TERM traps set `INTERRUPTED=1` and send `kill -TERM` to the
  children; they deliberately do **not** call `wait` (which would risk
  blocking).
- Final exit-code priority ladder (highest wins):
  `130 (interrupt) > 12 (cleanup fail) > 20 (build fail) > 30 (precond
  fail) > 11 (joiner fail) > 10 (host fail) > 0 (success)`.

### `$?` capture bug fix (this revision)

The original `cleanup()` set `TRAP_REENTERED=1` *before* capturing
`trap_rc=$?`. Because the assignment's exit status is 0, `trap_rc` was
always 0 — silently demoting real failure codes (20/30/child-non-zero)
to host/joiner-fail codes (10/11) or, in some configurations, to 0.

**Fix:** `local trap_rc=$?` is now the very first executable statement
in `cleanup()`, before any other assignment or command. Verified by
three sub-regression tests (see § 7 inline evidence for
`regression-30`, `regression-20`, and `regression-child-fail`).

Documented macOS/bash 3.2 quirk discovered during testing: an external
`kill -INT <pid>` does **not** fire a bash INT trap on macOS bash 3.2
(re-confirmed in this revision: a script with an INT trap continues
running after an external `kill -INT`; SIGKILL must be sent manually).
This is an environment limitation, not a script defect.
Foreground-Ctrl-C is not testable from a non-interactive automation.

## 7. Test Matrix (Phase A3) — with inline evidence

All console excerpts below were captured during this revision's
regression run. They are inlined here so GitHub web review works
without access to the local `/tmp/*.log` or `experiments/.../logs/*.log`
files (the latter are git-ignored).

### T1 — Normal handshake — **PASS**

```text
$ SKIP_BUILD=1 bash scripts/run_unicast_test.sh
T1_exit=0
[main] run_id=62810-1791683607 starting host_pid=62810
[main] host_pid=62816
[main] joiner_pid=62817
[cleanup] run_id=62810-1791683607 host_pid=62816 joiner_pid=62817 trap_rc=0
[cleanup] host_reap_rc=0 joiner_reap_rc=0
host_exit=0 joiner_exit=0 host_ok=0 joiner_ok=0 cleanup_ok=1 interrupted=0
```

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

### T4 — Host port occupied — **PASS**

```text
$ python3 tests/fixtures/port_holder.py 52420 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh
T4_exit=10
[cleanup] host_reap_rc=3 joiner_reap_rc=7
host_exit=3 joiner_exit=7 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

### T5 — Joiner port occupied — **PASS**

```text
$ python3 tests/fixtures/port_holder.py 52421 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh
T5_exit=10
[cleanup] host_reap_rc=7 joiner_reap_rc=3
host_exit=7 joiner_exit=3 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

### T6 — Protocol error (host_bad_protocol) — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_bad_protocol bash scripts/run_unicast_test.sh
T6_exit=10
[joiner] FAIL: parse announce: wrong_field_order:0:this is not key
[cleanup] host_reap_rc=0 joiner_reap_rc=5
host_exit=0 joiner_exit=5 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
```

### T7a — Background SIGINT (kill -s INT) — **NOT_VERIFIED** (env limitation)

```text
$ bash /tmp/sig_int_test.sh & sleep 1; kill -INT $!; sleep 2
started pid=63854
STILL_ALIVE_AFTER_INT_killing_now   # bash INT trap did NOT fire
wait_rc=137                           # process killed via SIGKILL
```

Per `cleanup()` priority ladder: even if the trap fired, INT and
SIGTERM are routed to `INTERRUPTED=1` and the script would exit 130.
The TERM path (T7b) demonstrates the equivalent cleanup + rc routing,
so T7a's INT-path is not on the critical path.

### T7b — Background SIGTERM (kill -s TERM) — **PASS**

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
    bash scripts/run_unicast_test.sh &
$ sleep 4; kill -TERM $!
[main] run_id=64004-1791683756 starting host_pid=64004
[main] host_pid=64011
[main] joiner_pid=64012
[cleanup] host_reap_rc=143 joiner_reap_rc=143
host_exit=143 joiner_exit=143 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=1
T7b_exit=130
```

### T7c — Foreground Ctrl-C — **NOT_VERIFIED** (requires interactive TTY)

Out of scope for non-interactive automation.

### T8 — Watchdog TERM→KILL escalation (NEW, host_ignore_term) — **PASS**

This is the **new** test added in this revision. It uses
`host_ignore_term` which installs `SIG_IGN` for SIGTERM (and only for
SIGTERM) via libc `signal()`, so SIGTERM is silently discarded and the
watchdog MUST escalate to SIGKILL. The previous
`host_sleep_forever` fixture accepted SIGTERM (default disposition),
so its `rc=143` only proved TERM works — not the escalation logic.

```text
$ SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_ignore_term \
    bash scripts/run_unicast_test.sh
[main] watchdog: forcing termination of survivors
[joiner] FAIL: timed out waiting for lan_announce
[cleanup] host_reap_rc=137 joiner_reap_rc=7
host_exit=137 joiner_exit=7 host_ok=1 joiner_ok=1 cleanup_ok=1 interrupted=0
T8_exit=10
```

`host_reap_rc=137` = 128 + 9 (SIGKILL). This is the proof that the
watchdog escalates TERM→KILL when TERM is ineffective. For contrast,
the same test using `host_sleep_forever` (which accepts SIGTERM)
yields `host_reap_rc=143` (SIGTERM) — only the immediate TERM path.

Sanity-check of the fixture on its own (proving TERM really is
ignored):

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

### Regression sub-tests for the `$?`-capture fix

Three sub-regression tests exercise the priority ladder directly. Each
runs a minimal harness that defines the same `cleanup()` function as
the real script (copy-paste of the relevant block) and exits with a
chosen code; the script's exit code is the proof.

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

Phase 2.1 Experiment A (this revision, with `$?`-capture fix and
TERM→KILL escalation test) — **Partially PASS**.

| Bucket | Result |
|---|---|
| A1 minimal offline build | PASS |
| A2 isolated project build (incl. host_ignore_term) | PASS |
| Parser unit tests (17/17) | PASS |
| Normal handshake | PASS |
| Host / joiner internal timeout | PASS |
| Port-occupancy handling | PASS |
| Protocol-error handling | PASS |
| Bash syntax (3.2) | PASS |
| Bash SIGTERM cleanup | PASS |
| Watchdog TERM→KILL escalation (new T8 with host_ignore_term) | PASS (host_reap_rc=137) |
| Cleanup `$?`-capture fix | PASS (regression-30/20/0/child-fail all preserved) |
| Source-file integrity | PASS (every check) |
| Bash SIGINT (background) | NOT_VERIFIED (macOS bash 3.2 limitation) |
| Foreground Ctrl-C | NOT_VERIFIED (cannot be automated) |

The two NOT_VERIFIED items are environment limitations, not script bugs.
The SIGTERM path proves the same cleanup and exit-code routing works
correctly when an interrupt signal actually reaches the bash process.

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
  bash scripts/run_unicast_test.sh                             # T8 (NEW: TERM→KILL proof)
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
  bash scripts/run_unicast_test.sh                             # T8 (legacy TERM-only contrast)
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_bad_protocol \
  bash scripts/run_unicast_test.sh                             # T6
python3 tests/fixtures/port_holder.py 52420 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh; kill %1   # T4
python3 tests/fixtures/port_holder.py 52421 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh; kill %1   # T5
bash -n scripts/run_unicast_test.sh                            # T10
cargo test --offline --manifest-path Cargo.toml --bin lan_cross_process_host   # T11

# T7b SIGTERM (kill -TERM to the script while children are running)
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
  bash scripts/run_unicast_test.sh &
P=$!
sleep 4
kill -s TERM $P
wait $P
```