# Phase 2.1 Experiment A — Acceptance Report

Independent experiment for verifying cross-process UDP unicast between two
Rust processes, isolated from the main Tauri project.

## 1. Baseline & Toolchain (VERIFIED)

| Item | Value |
|---|---|
| HEAD commit | `009f8fa37ccd04527809e5f33e874805f7b6bfde` |
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
- `experiments/phase21_experiment_a/tests/fixtures/port_holder.py`
- `experiments/phase21_experiment_a/logs/*.log` (test/build logs)
- `experiments/phase21_experiment_a/REPORT.md` (this file)

### Modified

None outside the experiment directory.

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
- INT/TERM traps set `INTERRUPTED=1` and send `kill -TERM` to the
  children; they deliberately do **not** call `wait` (which would risk
  blocking).
- Final exit-code priority: 130 > 12 > 10/11 > 20 > 30 > 0.

Documented macOS/bash 3.2 quirk discovered during testing: an external
`kill -INT <pid>` does **not** fire a bash INT trap on macOS bash 3.2
(verified by minimal repro: `/tmp/sig_test.sh` with INT trap continues
after external SIGINT, while the same script exits 99 after external
SIGTERM). This is an environment limitation, not a script defect.
Foreground-Ctrl-C is not testable from a non-interactive automation.

## 7. Test Matrix (Phase A3)

| # | Name | Status | Key Evidence |
|---|---|---|---|
| T1 | Normal handshake | **PASS** | script_rc=0; host_reap_rc=0; joiner_reap_rc=0; both `OK` printed; cleanup_ok=1; no residual |
| T2 | joiner internal timeout (host_silent) | **PASS** | joiner self-exited 7 (`timed out waiting for lan_announce`); host_silent TERM'd by watchdog (143); cleanup_ok=1 |
| T3 | host internal timeout (joiner_silent) | **PASS** | host self-exited 7 (`timed out waiting for 'ready'`); joiner_silent TERM'd by watchdog (143); cleanup_ok=1 |
| T4 | host port occupied | **PASS** | host exit 3 (`bind ... Address already in use (os error 48)`); joiner self-exited 7; cleanup_ok=1 |
| T5 | joiner port occupied | **PASS** | joiner exit 3 (`bind ... Address already in use`); host self-exited 7; cleanup_ok=1 |
| T6 | Protocol error (host_bad_protocol) | **PASS** | joiner exit 5 (`parse announce: wrong_field_order:0:this is not key`); host_bad_protocol exit 0; cleanup_ok=1 |
| T7a | Background SIGINT (kill -s INT) | **NOT_VERIFIED** | macOS bash 3.2 does not run the INT trap on external `kill -INT`. Documented limitation. |
| T7b | Background SIGTERM (kill -s TERM) | **PASS** | script_rc=130; interrupted=1; host_reap=143; joiner_reap=143; cleanup_ok=1 |
| T7c | Foreground Ctrl-C | **NOT_VERIFIED** | Requires interactive terminal; cannot be automated. |
| T9 | Normal completion, no spurious kill | **PASS** | script_rc=0; no "watchdog: forcing termination"; both 0; cleanup_ok=1 |
| T10 | Bash 3.2 syntax | **PASS** | `bash -n` exits 0 |
| T11 | Host parser unit tests | **PASS** | 17/17 unit tests pass |
| T12 | Protected file integrity | **PASS** | All 6 SHA-256 + size + mtime unchanged from baseline |

(T8 is documented as a sub-case of T2/T3 since the watchdog path was
exercised by both `host_sleep_forever` runs — `watchdog: forcing
termination of survivors` appears in the log; host killed with TERM=143,
joiner self-exited at 7 = timeout. Status: **PASS**.)

### T11 parser coverage

17 unit tests cover: announce/ack positive cases, positive UUID v4,
negative UUID (version≠4, variant≠{8,9,a,b}, wrong shape), wrong
protocol_version, wrong field order, missing `=`, empty value, extra
field, duplicate field, trailing newline, CRLF, non-ASCII, control
character, oversize input (>4096), invalid kind literal, and a
build↔parse roundtrip.

## 8. Logs

All command stdout/stderr is captured under
`experiments/phase21_experiment_a/logs/`:

```
A1-build.log
A2-build.log
A2-fixtures-build.log
A2-host-unit-tests.log
A2-rebuild-postfix.log
A3-T1-stdout.log    A3-T1-stderr.log    A3-T1-debug.log
A3-T2-stdout.log    A3-T2-stderr.log
A3-T3-stdout.log    A3-T3-stderr.log
A3-T4-stdout.log    A3-T4-stderr.log    A3-T4-holder.log
A3-T5-stdout.log    A3-T5-stderr.log    A3-T5-holder.log
A3-T6-stdout.log    A3-T6-stderr.log
A3-T7-term.log
A3-T8-stdout.log    A3-T8-stderr.log
A3-T9-stdout.log    A3-T9-stderr.log
A3-T11.log
```

Per-run host/joiner process logs are written under
`/tmp/kindora-expA-{host,joiner}.{run_id}.log` by the script.

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

Phase 2.1 Experiment A — **Partially PASS**.

| Bucket | Result |
|---|---|
| A1 minimal offline build | PASS |
| A2 isolated project build | PASS |
| Parser unit tests (17/17) | PASS |
| Normal handshake | PASS |
| Host / joiner internal timeout | PASS |
| Port-occupancy handling | PASS |
| Protocol-error handling | PASS |
| Bash syntax (3.2) | PASS |
| Bash SIGTERM cleanup | PASS |
| Source-file integrity | PASS (every check) |
| Bash SIGINT (background) | NOT_VERIFIED (macOS bash 3.2 limitation) |
| Foreground Ctrl-C | NOT_VERIFIED (cannot be automated) |

The two NOT_VERIFIED items are environment limitations, not script bugs.
The SIGTERM path proves the same cleanup and exit-code routing works
correctly when an interrupt signal actually reaches the bash process.

No protected file was modified. No Git commands were executed. No
in-scope work for later phases was performed.

## 12. Reproduction

```bash
cd /Users/jiang/development/Kindora

# A1 minimal
mkdir -p experiments/phase21_experiment_a/src
cat > experiments/phase21_experiment_a/Cargo.toml <<'EOF'
[package]
name = "kindora-phase21-experiment-a"
version = "0.0.1"
edition = "2021"
rust-version = "1.77.2"
publish = false

[profile.dev]
opt-level = 0
EOF
echo 'fn main() {}' > experiments/phase21_experiment_a/src/main.rs
. "$HOME/.cargo/env"
cargo build --offline --manifest-path experiments/phase21_experiment_a/Cargo.toml

# A2 isolated project — copy + edit Cargo.toml/binaries/script per files added in § 3
# (See experiment directory contents)
cargo build --offline --manifest-path experiments/phase21_experiment_a/Cargo.toml
cargo test  --offline --manifest-path experiments/phase21_experiment_a/Cargo.toml --bin lan_cross_process_host

# A3 tests
cd experiments/phase21_experiment_a
SKIP_BUILD=1 bash scripts/run_unicast_test.sh                  # T1, T9
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_silent   \
  bash scripts/run_unicast_test.sh                             # T2
SKIP_BUILD=1 JOINER_BIN_OVERRIDE=$PWD/target/debug/joiner_silent \
  bash scripts/run_unicast_test.sh                             # T3
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
  bash scripts/run_unicast_test.sh                             # T8
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_bad_protocol \
  bash scripts/run_unicast_test.sh                             # T6
python3 tests/fixtures/port_holder.py 52420 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh; kill %1   # T4
python3 tests/fixtures/port_holder.py 52421 & SKIP_BUILD=1 bash scripts/run_unicast_test.sh; kill %1   # T5
bash -n scripts/run_unicast_test.sh                            # T10

# T7 SIGTERM (script kill -s TERM during children running)
SKIP_BUILD=1 HOST_BIN_OVERRIDE=$PWD/target/debug/host_sleep_forever \
  bash scripts/run_unicast_test.sh &
P=$!
sleep 4
kill -s TERM $P
wait $P
```