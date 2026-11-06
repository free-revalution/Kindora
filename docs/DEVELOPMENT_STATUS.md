# Development status

**The honest version.** This document exists because the README is the place
people land, and a README that overstates what works is worse than no README at
all. Everything below is stated with the evidence that supports it.

- Last reviewed against `main` at commit `020b15d`, plus the **uncommitted
  Phase B – Phase G remediation work** in the working tree (see
  [REMEDIATION_PROGRESS.md](REMEDIATION_PROGRESS.md)).
- Test counts are a **static inventory of the test cases declared in the source
  tree** — counted, not inferred. They are _not_ a claim that the suite was
  run and passed at this commit; the CI badge in the README is the record of
  actual runs.
- **On 2026-11-06 the six TypeScript suites that carry the remediation were
  really executed, and all six came back green** — `protocol` **215/215**,
  `transport` **211/211**, `agent` **148/148**, `storage` **168/168**,
  `matching` **86/86**, `desktop` **151/151** — **979 cases**, with the
  ConnectView suite additionally run **five times in a row**, green every
  time. The evidence is in
  [REMEDIATION_TEST_REPORT.md](REMEDIATION_TEST_REPORT.md) § 8.8.16–§ 8.8.17.
- **A second run on the same day (the twentieth batch) added two more green
  suites** — the `@kindora/llm` suite (**56 passed, 8 skipped** — the eight
  skips are the live-provider cases, which need real credentials) and all
  **four Rust suites** (**48/48**). It also ran **`cargo fmt --check` and
  `cargo clippy -D warnings` for the first time, and both came back clean** —
  the two Rust gates that had never been executed against this tree.
  The evidence is in [REMEDIATION_TEST_REPORT.md](REMEDIATION_TEST_REPORT.md)
  § 8.8.19.
- **The same second run turned up 8 type defects** that the first run's
  single-error report had hidden — the first run stopped at the typecheck
  gate, so `packages/matching` and `apps/desktop` were never reached.
  **8 error instances across 5 files.** Note where they came from:
  **`08a-typecheck` itself reported only 1** (`pnpm -r typecheck` halts at
  the first failing package); **the other 7 came out of
  `09f-tauri-build`'s `tsc -b`**, which compiles the workspace packages'
  sources along with the desktop app's. All 8 were fixed with 3 regression
  cases added, and a third run on the same day (the twenty-first batch)
  **re-ran the type check: `pnpm -r typecheck` came back `EXIT=0`** — with
  `packages/matching` and `apps/desktop` typechecked for the first time and
  no new errors. Where they were:

  |   # | File                                                    | Phase | Errors | What was wrong                                                                                                                                                                                                                                                                                                                                                                                                   |
  | --: | ------------------------------------------------------- | ----- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  |   1 | `packages/storage/src/browser-store.ts`                 | A/B/D |      1 | `normaliseProfile(record.profile)` was called on a value typed `SocialProfile \| undefined`. The tempting fix — widen the parameter and fill in the privacy gates — would have produced an object that satisfies the `SocialProfile` type while missing every field the user actually sees. Instead a `isProfileShape()` guard now rejects a record with no usable profile and returns "there is no agent here". |
  |   2 | `apps/desktop/src/lib/chat-history.ts`                  | D     |      2 | `endedAt` / `closeReason` typed `undefined` where the contract says `null`.                                                                                                                                                                                                                                                                                                                                      |
  |   3 | `apps/desktop/src/lib/tauri-sql-executor.ts`            | D     |      3 | The constructor field was named `invoke` instead of `tauri`, out of step with the sibling adapters.                                                                                                                                                                                                                                                                                                              |
  |   4 | `apps/desktop/src/views/__tests__/ConsentView.test.tsx` | B     |      1 | The captured consent value was typed against the wrong type, so the assertion could not see the `state` field.                                                                                                                                                                                                                                                                                                   |
  |   5 | `apps/desktop/src/views/__tests__/MatchView.test.tsx`   | F     |      1 | Phase F added a required `notices` field to `AnalyzeMatchResult`; the fixture was never updated, so the suite no longer typechecked.                                                                                                                                                                                                                                                                             |

- **A third run on the same day (the twenty-first batch) turned the remaining
  toolchain gates green.** `pnpm -r typecheck` → **`EXIT=0`** (the 8 fixes
  above are effective, and `packages/matching` / `apps/desktop` were
  typechecked for the first time without a single new error);
  `pnpm -r --filter './packages/*' build` → **`EXIT=0`**; `pnpm lint` →
  **`EXIT=0`** — ESLint, the whole tree, for the first time; `cargo fmt
--check` and `cargo clippy -D warnings` → **`EXIT=0`** again; and
  **`pnpm -C apps/desktop tauri build` → `EXIT=0` — the first successful
  Tauri production build** (`Kindora.app`, 6.52 MiB, and
  `Kindora_0.1.0_aarch64.dmg`, 3.25 MiB). The evidence is in
  [REMEDIATION_TEST_REPORT.md](REMEDIATION_TEST_REPORT.md) § 8.8.20.
- **One gate is still red: `pnpm format:check` reports 111 files.**
  **81 of them were already unformatted at the baseline commit `020b15d`**
  (checked with `git show HEAD:<file> | npx prettier --check` on three
  baseline files — all three fail) **and 30 were added by the remediation**;
  the difference is `printWidth: 100` reflow, not semantics. **This is a
  pre-existing condition, not a regression**, and the fix is `pnpm format` —
  **not** adding `docs/` to `.prettierignore`, which would be manufacturing a
  PASS. **`.prettierignore` was not touched.** The step was **moved to the
  end** of CI's build job — it is **still blocking** (no `continue-on-error`,
  no `|| true`); it was moved so that one red formatter cannot hide the
  results of the other nine checks.
- **Phase B is green** — the privacy filter (26) and the privacy-boundary UI
  (13) both passed, and the block-list guards in the matching suite passed.
  **Phase D is green** — the storage suite came back 168/168 (the two
  failures from the 2026-11-05 run were both fixed and re-verified; three
  more cases were added on 2026-11-06 and have now been executed), and the
  desktop and matching suites passed alongside it.
- **Phase F is green** — all **104** of its cases (30 sensitive-field + 57
  prompt-injection at the protocol layer, 17 untrusted-context at the agent
  layer) passed. That includes the four structural claims that F2 rests on:
  the local profile stays outside every untrusted block, an injection the
  regexes do not recognise is still confined, a forged end marker is inert,
  and the hints are computed from the _sanitised_ peer profile.
- **Phase G is green** — all **12** cases passed, and the 210 pre-existing
  transport cases still pass alongside them.
- **What is still open:** the type check, the package builds, ESLint,
  `cargo fmt --check` and `cargo clippy` are **all green now** (2026-11-06,
  the twenty-first batch), and the **Tauri production build succeeds**. What
  is still open is: **`pnpm format:check`** (**111 files** — a pre-existing
  condition, see above), **the live LLM provider path** (Phase E2 — no
  credentials, so it stays `NOT_RUN`), **a real SQLite** (CI has no SQLite
  engine, so no SQL statement has ever been executed by one), and the **real
  two-device acceptance** (Phase H3 — it needs two physical machines). The
  rule already in use here is that a phase stays _implemented_ until every one
  of its acceptance rows is green.
- **CI now runs ten checks, and the key ones block** (2026-11-06, Phase H1).
  `.github/workflows/ci.yml` was rewritten into three jobs: the type check,
  **ESLint**, **Prettier**, the build, the tests, **`cargo fmt --check`**,
  **`cargo clippy`**, the Rust suites, a separate **Tauri build** job, and a
  separate **dependency audit** job that records but does not block (the
  task book asks for vulnerabilities to be _recorded_, not batch-upgraded).
  **Eight of those ten checks have now been run against the current tree and
  are green** — the type check (`pnpm -r typecheck`), the package builds,
  **ESLint**, **`cargo fmt --check`**, **`cargo clippy -D warnings`** (the
  latter with **0 errors**), the Rust suites, and the **Tauri production
  build** (which now completes: `Kindora.app` + `Kindora_0.1.0_aarch64.dmg`).
  **The one that is still red is `pnpm format:check`** (**111 files** — 81
  pre-existing, 30 from the remediation; the difference is `printWidth: 100`
  reflow), **and the dependency-audit job**, which by design _records_ rather
  than blocks. The formatter's fix is to run `pnpm format` — **not** to add
  `docs/` to `.prettierignore`, which would be manufacturing a PASS;
  **`.prettierignore` was not touched**, and the step was **moved to the end**
  of the build job while **staying blocking**, so that one red formatter
  cannot hide the other nine checks.
- **The dependency audit produced its first real result on 2026-11-06.**
  `pnpm audit` found **46 advisories** — **every one of them in a
  devDependency chain** (`vitest`, `happy-dom`, `jsdom`, `vite`, `postcss`,
  `esbuild`, `minimatch`, `brace-expansion`, `nanoid`, `form-data`,
  `source-map-js`, `postcss-selector-parser`, `tinypool`, `@vitest/mocker`) —
  severities **1 low / 20 moderate / 21 high / 4 critical**, and **none of
  them in a runtime dependency that ships to a user**. `cargo update --dry-run`
  found **68 crates behind their latest release** (67 on the twentieth batch;
  the delta is a crates.io index refresh between the two runs, **not** a
  change to the dependency tree — the lockfile was not modified). `pnpm
outdated -r` found **25 packages behind**, 5 of them runtime dependencies.
  **Nothing was upgraded** — task book line 149 says to _record_ vulnerabilities
  and outdated dependencies, not to batch-upgrade in this stage. `cargo audit`
  could **not** be run: fetching the RustSec advisory database failed with a
  network error, so the Rust side is still **`NOT_RUN`**, not "clean" — **and
  it has now failed that way twice in a row**. The discriminator matters:
  `cargo audit` exits **1** both when it _finds_ advisories and when it
  _cannot fetch the database_; the difference is whether the log contains a
  `Crates:` / `Vulnerabilities:` table. Without that table, **the scan never
  happened**.
- **No phase is called "verified" on the strength of the 2026-11-06 run
  alone.** The `llm` suite **has** now been executed — **56 passed, 8
  skipped** — but the eight skips are the live-provider cases, and every
  provider test still mocks `fetch`.
- **The LAN security scenarios all have a named, repeatable test.** A ledger
  maps the thirteen scenarios the task book lists to the specific test that
  pins each one down — and says, for each, which layer it exercises and what
  it does _not_ prove. See
  [`docs/phase16/lan-security-coverage.md`](phase16/lan-security-coverage.md).

---

## How to read the states

| State                        | Meaning                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented**              | The code exists and is covered by automated tests.                                                                                                                                       |
| **Implemented, unvalidated** | The code exists and the tests pass in a mocked or socket-level harness, but **no one has exercised it in the real thing** — a real LLM provider, a real Tauri window, two real machines. |
| **Implemented, not yet run** | The code exists and is covered by automated tests, but **those tests have not been executed**. Nothing about them may be called a pass.                                                  |
| **Not implemented**          | The code does not exist, or is a stub that throws.                                                                                                                                       |

---

## Test inventory

### TypeScript — Vitest

| Package              | Test files | Test cases |
| -------------------- | ---------: | ---------: |
| `@kindora/protocol`  |         11 |        215 |
| `@kindora/transport` |         15 |        211 |
| `@kindora/agent`     |         15 |        148 |
| `@kindora/storage`   |         11 |        168 |
| `@kindora/matching`  |          8 |         86 |
| `@kindora/desktop`   |         16 |        151 |
| `@kindora/llm`       |          5 |         43 |
| **Total**            |     **81** |   **1022** |

Counted from the `it(` declarations in `*.test.ts` / `*.test.tsx` across
`apps/desktop/src` and `packages/*/src`. Run them with `pnpm test`.

> **These numbers were re-counted on 2026-11-06 (after the sixteenth batch),
> from the working tree**, because the figures this table used to carry were
> stale:
>
> |                      | Test files | Test cases |
> | -------------------- | ---------: | ---------: |
> | Baseline `020b15d`   |         56 |        567 |
> | **Working tree now** |     **81** |   **1022** |
> | Delta                |    **+25** |   **+455** |
>
> Reproduce them:
>
> ```bash
> # the baseline
> git grep -lE "^[[:space:]]*it\(" 020b15d -- '*.test.ts' '*.test.tsx' | wc -l   # 56
> git grep -ohE "^[[:space:]]*it\(" 020b15d -- '*.test.ts' '*.test.tsx' | wc -l  # 567
> # the working tree
> find apps/desktop/src packages -name "*.test.ts" -o -name "*.test.tsx" | wc -l  # 81
> grep -rhoE "\bit\(" apps/desktop/src packages/*/src | wc -l                # 1022
> ```
>
> ⚠️ **The baseline lines use `[[:space:]]`, not `\s`.** `git grep -E` does
> **not** support `\s` — it is POSIX ERE, not PCRE — so `git grep -ohE
"^\s*it\("` returns **0 lines**, not 567. The counts above were produced
> with the `[[:space:]]` form; the earlier `\s` form was copied from a
> shell habit and would have reported a baseline of zero.
>
> Two independent counting methods agree on the per-package figures
> (`grep -rhoE "\bit\("` and `grep -rcE "^\s*it\("` summed per file).
> The count says _how many cases are **declared**_, **not** that any of them
> pass.
>
> **Two caveats that matter:**
>
> 1. **Declared ≠ runtime.** A few files generate cases inside a loop, so
>    vitest runs **more** cases than are written. The clearest example is
>    `packages/llm`: **44** declarations (43 `it(` + 1 `it.skipIf(`) become
>    **64** cases at runtime — `provider-errors.test.ts` writes 22 but registers
>    36 (a 9-case status table and a 3-provider × 3-case table), and
>    `providers.live.test.ts` writes 2 but registers 8 (one block per
>    provider). This table reports the **declared** count because that is the
>    number a reader can reproduce with the command above.
> 2. **Declared ≠ passed.** The Phase E suite was **never executed for
>    eighteen batches** — the eighteenth batch found out **why**:
>    `.cache/verify.sh` had **no `packages/llm` step at all**, so it was
>    skipped every time (a `04b-llm-test` step has now been added). The
>    twentieth batch ran it: **56 passed, 8 skipped**. The eight skips are
>    the live-provider cases — they need real credentials, so they stay
>    **`NOT_RUN`**, which is not a pass. See
>    [REMEDIATION_TEST_REPORT.md](REMEDIATION_TEST_REPORT.md) § 8.8.10 –
>    § 8.8.20.
>
>    **What has actually been run (as of 2026-11-06, the twenty-second batch):**
>
>    | Suite                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                              |
>    | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
>    | `packages/protocol`                     | ✅ **EXIT=0 — `215 passed (215)`**                                                                                                                                                                                                                                                                                                                                                                                  |
>    | `packages/transport`                    | ✅ **EXIT=0 — `211 passed (211)`**                                                                                                                                                                                                                                                                                                                                                                                  |
>    | `packages/agent`                        | ✅ **EXIT=0 — `148 passed (148)`**                                                                                                                                                                                                                                                                                                                                                                                  |
>    | `packages/storage`                      | ✅ **EXIT=0 — `168 passed (168)`**                                                                                                                                                                                                                                                                                                                                                                                  |
>    | `packages/matching`                     | ✅ **EXIT=0 — `86 passed (86)`**                                                                                                                                                                                                                                                                                                                                                                                    |
>    | `apps/desktop`                          | ✅ **EXIT=0 — `151 passed (151)`** — and the ConnectView suite was run **five times in a row**, green every time                                                                                                                                                                                                                                                                                                    |
>    | `packages/llm`                          | ✅ **EXIT=0 — `56 passed`, `8 skipped` (64)** — the eight skips are the live-provider cases, which need real credentials                                                                                                                                                                                                                                                                                            |
>    | `pnpm -r typecheck`                     | ✅ **EXIT=0** — the 8 errors above are all fixed; `packages/matching` and `apps/desktop` were typechecked for the first time, with no new errors (twentieth batch: ❌ EXIT=2 / 8 errors)                                                                                                                                                                                                                            |
>    | `pnpm -r --filter './packages/*' build` | ✅ **EXIT=0** — every workspace package builds                                                                                                                                                                                                                                                                                                                                                                      |
>    | `pnpm lint`                             | ✅ **EXIT=0** — ESLint, the whole tree, for the first time                                                                                                                                                                                                                                                                                                                                                          |
>    | `pnpm format:check`                     | ❌ **EXIT=1** — **111 files** (81 already unformatted at `020b15d`, 30 from the remediation); the difference is `printWidth: 100` reflow. **Fix: `pnpm format` — not `.prettierignore`.**                                                                                                                                                                                                                           |
>    | `cargo test --lib`                      | ✅ **EXIT=0 — `13 passed (13)`**                                                                                                                                                                                                                                                                                                                                                                                    |
>    | `cargo test --test lan_e2e`             | ✅ **EXIT=0 — `18 passed (18)`**                                                                                                                                                                                                                                                                                                                                                                                    |
>    | `cargo test --test lan_protocol_e2e`    | ✅ **EXIT=0 — `13 passed (13)`**                                                                                                                                                                                                                                                                                                                                                                                    |
>    | `cargo test --test lan_limits`          | ✅ **EXIT=0 — `4 passed (4)`**                                                                                                                                                                                                                                                                                                                                                                                      |
>    | `cargo fmt --check`                     | ✅ **EXIT=0** — first run against this tree                                                                                                                                                                                                                                                                                                                                                                         |
>    | `cargo clippy -D warnings`              | ✅ **EXIT=0**, **0 errors** — first run against this tree                                                                                                                                                                                                                                                                                                                                                           |
>    | `pnpm -C apps/desktop tauri build`      | ✅ **EXIT=0** — the first successful Tauri production build: `tsc -b` clean → `vite` 128 modules → Rust `release` profile in 43.35s → **`Kindora.app` (6.52 MiB)** → **`Kindora_0.1.0_aarch64.dmg` (3.25 MiB)** (twentieth batch: ❌ EXIT=1, died in `tsc -b`)                                                                                                                                                      |
>    | `pnpm audit`                            | ⚠️ **EXIT=1** — **46 advisories**, all in devDependency chains; recorded, **not** upgraded (task book line 149)                                                                                                                                                                                                                                                                                                     |
>    | `cargo audit`                           | ⏳ **`NOT_RUN`** — the RustSec advisory database could not be fetched (network error)                                                                                                                                                                                                                                                                                                                               |
>    | `pnpm outdated -r`                      | ✅ **EXIT=1 — a real result, not a usage error** — **25 packages behind** (5 of them runtime: `@tauri-apps/api`, `@tauri-apps/plugin-fs`, `react`, `react-dom`, `@tauri-apps/cli`; the rest devDependencies). The command now sets `npm_config_registry`, because `pnpm outdated` in pnpm 10 **rejects `--registry`** and that usage error also exits **1** — indistinguishable from "there are outdated packages". |
>    | `cargo update --dry-run`                | ✅ **EXIT=0** — **68 crates behind** their latest release (67 on the twentieth batch; the delta is a crates.io index refresh, not a tree change); the lockfile was **not** modified                                                                                                                                                                                                                                 |
>
>    That is **1035 TypeScript cases green** across seven suites (979 + 56),
>    plus **48 Rust cases**. The workspace-wide `tsc`, the package builds,
>    the linter and the formatter **now come back green** — except the
>    formatter, which reports **111 files** (a pre-existing condition). And
>    "green" is not the same as "accepted": before any phase is called
>    **`VERIFIED`**, the per-phase rule already in use still applies —
>    _if any of the acceptance rows are still red, the phase stays
>    `IMPLEMENTED`_ — and three of them stay open no matter how green the
>    tooling is: **the live LLM provider** (no credentials), **a real
>    SQLite** (CI has no SQLite engine), and **the real two-device
>    acceptance** (Phase H3, needs two physical machines).

The remediation added **25 new test files** and **+455 net test cases**:

| Phase                                     | New test files | Cases in the new files | Where                                                                                                                 |
| ----------------------------------------- | -------------: | ---------------------: | --------------------------------------------------------------------------------------------------------------------- |
| **A** (security)                          |              6 |                     88 | Canonical JSON, ES256 signatures, session encryption, fingerprint pairing, the A3 handshake, the inbound replay guard |
| **B** (privacy / consent / block list)    |              2 |                     39 | The privacy filter, the privacy-boundary UI                                                                           |
| **C** (LAN reliability)                   |              3 |                     25 | The connection state machine, the C3 pairing session, the connection-status banner                                    |
| **D** (local business database)           |              9 |                    149 | Schema, migrations, the database port, the chat repository, the legacy `localStorage` migration                       |
| **E** (LLM provider reliability)          |              3 |                     24 | The unified error model, a real-socket timeout, the live-provider suite                                               |
| **F** (prompt injection / sensitive data) |              1 |                     17 | The agent-layer untrusted-context suite (two protocol-layer files were **rewritten**, not added)                      |
| **G** (WebRTC status)                     |              1 |                     12 | The not-implemented stub, the signalling contract, the capability cross-check                                         |

The other **+101** net cases are additions to (and removals from) test files
that already existed at the baseline.

> ⚠️ **This bucket moved by 3 in the twenty-second batch, and it is worth
> seeing why.** The 20th batch added three regression cases to
> `packages/storage/src/__tests__/profile-store.test.ts` — a file that **already
> existed at the baseline** — so they land in _this_ bucket, not in the
> per-phase new-file table above. The per-phase table counts cases in **newly
> added** files; this bucket counts everything else. **354 + 101 = 455**, which
> is exactly the 1022 − 567 delta above.

The Phase A files, case by case:

| New file                                                       | Cases | Covers                                                                                                        |
| -------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/src/__tests__/canonical-json.test.ts`       |    17 | RFC 8785 conformance, including the RFC's own § 3.2.3 vector                                                  |
| `packages/protocol/src/__tests__/signature.test.ts`            |    17 | ES256 signing, verification, recipient binding, tamper detection                                              |
| `packages/transport/src/__tests__/pairing-fingerprint.test.ts` |    17 | Fingerprint derivation, Crockford base32, display and comparison                                              |
| `packages/transport/src/__tests__/session-crypto.test.ts`      |    28 | ECDH, HKDF, AES-256-GCM, frames, AAD binding, nonce discipline                                                |
| `packages/transport/src/__tests__/pairing-session-a3.test.ts`  |     4 | The whole handshake end to end, with real keys                                                                |
| `packages/transport/src/__tests__/pairing-replay.test.ts`      |     5 | The inbound replay guard — a replayed envelope is delivered once, and the guard-off control delivers it twice |

Six further cases were added to existing files
(`packages/agent/src/__tests__/identity.test.ts`,
`packages/storage/src/__tests__/profile-store.test.ts`).

**These files were run and were green in the fifth batch (2026-11-04), and the
Phase A suites were green again on 2026-11-06 inside the `protocol` (215/215),
`transport` (211/211) and `agent` (148/148) runs.** The Phase B, D, F and G
files were first executed on 2026-11-06 (seventeenth and eighteenth batches) and
came back **fully green** — the B privacy filter (26) and privacy-boundary UI
(13), the D storage suite (168/168), the 104 F cases and the 12 G cases, with
every pre-existing suite in the same packages still green alongside them.

**The one exception was Phase E** — for eighteen batches: the `@kindora/llm`
files had **never been executed**, because the local verification script had
no `packages/llm` step at all. That step was added (`04b-llm-test`) and the
twentieth batch ran it: **56 passed, 8 skipped** (the 8 are the
live-provider cases, which need real credentials). The eight skipped cases
stay **`NOT_RUN`**, which is not a pass.

### Rust — cargo

| Suite                                | Test cases | What it exercises                                                       |
| ------------------------------------ | ---------: | ----------------------------------------------------------------------- |
| `cargo test --lib`                   |         13 | Error-to-display-string contracts (`apps/desktop/src-tauri/src/lan.rs`) |
| `cargo test --test lan_e2e`          |         18 | The real `LanState` over **real UDP + TCP sockets**                     |
| `cargo test --test lan_protocol_e2e` |         13 | The KSA 0.1 envelope contract over a real socket                        |
| `cargo test --test lan_limits`       |          4 | Frame, rate and connection limits                                       |
| **Total**                            |     **48** |                                                                         |

All four suites came back green in the fifth batch (2026-11-04) — see
[REMEDIATION_TEST_REPORT.md](REMEDIATION_TEST_REPORT.md) § 8.4.11 — and **green
again on 2026-11-06 (the twentieth batch): 13 + 18 + 13 + 4 = 48/48**, with
`cargo fmt --check` and `cargo clippy -D warnings` (0 errors) run for the
first time against this tree and both clean. See § 8.8.19.

The two integration suites need `-- --test-threads=1`: parallel execution is
unreliable against the macOS and Linux kernel UDP buffer pools.

### What the tests do **not** cover

- **No test has ever called a live LLM provider.** Every provider test mocks
  `fetch`. Real request schemas, auth headers, rate-limit responses and error
  shapes are unverified against any real API.
- **No test drives the real Tauri window.** The LAN transport is tested at the
  Rust socket layer and through a JavaScript IPC shim
  (`apps/desktop/src/lib/lan-connect-service.ts`), but not through React
  against a live Tauri webview.
- **No two-machine test.** The LAN suite runs both ends of a conversation inside
  one process over the loopback interface.
- **The Phase A crypto tests are in-process.** They use real WebCrypto keys
  and a real loopback hub, so they exercise the actual wire format — but both
  peers live in one JavaScript process, and no test has yet driven a signed,
  encrypted session across two physical machines.
- **No SQL statement has ever been executed by a real SQLite.** The Phase D
  tests pin the statement _text_ (a contract test against a recording executor)
  and check the DDL against the DML statically — but the CI image has no
  SQLite engine, so the statements have never been run. Whether
  `sqlite-database.ts` actually opens the database, migrates it and reads a
  row back is **unverified**.

---

## Feature status

### Implemented

| Capability                                                                       | Evidence                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent profile — create, edit, persist                                            | `packages/agent/src/profile.ts`, `packages/storage/src/profile-store.ts` (`localStorage`) and `packages/storage/src/database-stores.ts` (`DatabaseProfileStore` — SQLite in the desktop app), `apps/desktop/src/views/CreateAgentForm.tsx`                                           |
| LLM provider adapters — OpenAI-compatible, Anthropic, Ollama, MiniMax            | `apps/desktop/src/lib/llm-service.ts:257` (`PROVIDER_PRESETS`), `packages/llm/src/providers/`                                                                                                                                                                                        |
| API keys in the OS secret store                                                  | `apps/desktop/src-tauri/src/secrets.rs`, `keyring` 3 with `apple-native` / `windows-native` / `sync-secret-service` (`apps/desktop/src-tauri/Cargo.toml:34`), wired as `secret_set` / `secret_get` / `secret_delete` / `secret_list` (`apps/desktop/src-tauri/src/lib.rs:130-146`)   |
| KSA 0.1 envelope — validation, replay guard, rate limiter, sensitive-field guard | `packages/protocol/src/{validation,replay-protection,rate-limiter,sensitive-field-guard}.ts`                                                                                                                                                                                         |
| LAN transport — UDP broadcast discovery on port 52419, then TCP                  | `apps/desktop/src-tauri/src/lan.rs:40` (`DISCOVERY_PORT = 52419`), `apps/desktop/src-tauri/src/lan.rs` (host/join), `packages/transport/src/lan-transport.ts`                                                                                                                        |
| Loopback transport                                                               | `packages/transport/src/loopback-transport.ts`                                                                                                                                                                                                                                       |
| Match report — 5 fields                                                          | `packages/protocol/src/index.ts:230-245` (`MatchAnalysis`: `compatibilitySignal`, `commonGround`, `recommendedTopics`, `potentialFriction`, `explanation`), produced by `packages/agent/src/analyze-match.ts`                                                                        |
| Consent — accept / reject / disconnect / block                                   | `packages/matching/src/consent-orchestrator.ts`, `packages/storage/src/blocked-agents-store.ts` (`localStorage`) and `packages/storage/src/database-stores.ts` (`DatabaseBlockedAgentsStore` — SQLite in the desktop app), managed in `apps/desktop/src/views/BlockedAgentsView.tsx` |
| Icebreaker — propose, use, edit, regenerate, skip                                | `packages/agent/src/generate-icebreaker.ts`, `packages/matching/src/orchestrator.ts`, `apps/desktop/src/lib/connect-service.ts`                                                                                                                                                      |
| Chat + "Ask My Agent" draft helper                                               | `packages/matching/src/chat-orchestrator.ts`, `packages/matching/src/chat-assist-orchestrator.ts`                                                                                                                                                                                    |
| Prompt-injection sanitiser with credential-pattern stripping                     | `packages/protocol/src/prompt-injection-guard.ts`                                                                                                                                                                                                                                    |
| RFC 8785 canonical JSON                                                          | `packages/protocol/src/canonical-json.ts` — 17 cases, **green** in the fifth batch                                                                                                                                                                                                   |
| Envelope signatures — ES256 over a recipient-bound signing input                 | `packages/protocol/src/signature.ts` — 17 cases, **green** in the fifth batch                                                                                                                                                                                                        |
| Session encryption — ECDH P-256 + HKDF-SHA256 + AES-256-GCM                      | `packages/transport/src/session-crypto.ts` — 28 cases, **green** in the fifth batch                                                                                                                                                                                                  |
| Pairing by identity fingerprint instead of a random code                         | `packages/transport/src/pairing-fingerprint.ts`, `pairing-session-a3.test.ts` — 17 + 4 cases, **green** in the fifth batch                                                                                                                                                           |
| The inbound replay guard                                                         | `packages/transport/src/pairing-session.ts` — 5 cases, **green** in the fifth batch                                                                                                                                                                                                  |
| English + 简体中文 UI                                                            | `apps/desktop/src/i18n/locale.ts:37` (`Locale = 'en' \| 'zh'`), `apps/desktop/src/i18n/dictionaries/{en,zh}.ts` (**312 keys each** — `grep -cE "^  '[a-zA-Z0-9.]+':"`), picker in `apps/desktop/src/views/Settings.tsx`                                                              |
| The AI never auto-sends                                                          | `packages/matching/src/` — every outbound message is gated behind an explicit user action in `apps/desktop/src/views/`                                                                                                                                                               |

### Implemented, green on every test suite — Phase B (the privacy remediation)

**Added by the Phase B remediation.** On 2026-11-06 the suites that carry it
came back green together: `packages/protocol` **215/215** (the 26 privacy-filter
cases among them), `packages/matching` **86/86** (the two-phase consent and the
block-list guards among them) and `apps/desktop` **151/151** — **the desktop
side, which had never been run at all, is green.** The earlier 85/86 was a
wait-window bug in the test, not in the implementation; it passes now.

What is still missing is _not_ a test result — see the closing note below.

| Capability                                                                | State                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-field authorisation — 10 switches, persisted                          | The UI, the persistence and the **minimum-necessary defaults** (interests on, bio / current activity / avatar off) are implemented. The protocol cases (26) and the desktop cases (13) are **both green**.                                                                                                               |
| The privacy filter — only authorised fields leave the device              | `packages/protocol/src/profile-privacy-filter.ts` — 26 cases, **green**.                                                                                                                                                                                                                                                 |
| Two-phase consent — minimal card → consent → full profile                 | `packages/matching/src/orchestrator.ts` was split into `identify()` → human consent → `exchangeAndMatch()`, and the **full profile is only exchanged after both sides have consented**. All 34 matching cases are **green**.                                                                                             |
| The block list — check before anything goes out, plus a management screen | The store itself is old and was green in the fifth batch. **What is new in Phase B**: the pre-send guard (it now reads the store directly, so it cannot be bypassed by skipping the UI) and the management screen `apps/desktop/src/views/BlockedAgentsView.tsx` — 13 cases in `privacy-boundaries.test.tsx`, **green**. |

> **Not "verified" yet.** The twentieth batch's typecheck came back with
> **8 errors** — none of them in `@kindora/protocol`, so the pre-existing
> union defect really is fixed, but **one was in `packages/storage`**, which
> carries Phase B's persisted privacy-boundary gates. All 8 are fixed with 3
> regression cases added, and the twenty-first batch **re-ran the type check:
> `EXIT=0`**, with `packages/matching` and `apps/desktop` typechecked for the
> first time and clean. The build and lint steps are green too. What is still
> open for Phase B is not the tooling — it is the **real two-device
> acceptance** (Phase H3) and the **format backlog**. The rule is that a
> phase stays _implemented_ until every acceptance row is green.

### Implemented, green on every test suite — Phase D (the local business database)

**Added by the Phase D remediation.** The storage suite was run twice on
2026-11-05 (the first run failed two cases; after both were fixed the second
came back 165/165 on the second run; on 2026-11-06 it was green again at
**168/168** — three cases were added after that second run and had not been
executed until now — alongside the
matching suite (**86/86**) and the desktop suite (**151/151**). The remaining
acceptance rows — **typecheck, build and lint — are now green** (the
twenty-first batch: `pnpm -r typecheck` EXIT=0, the package build EXIT=0,
`pnpm lint` EXIT=0). What is still open for Phase D is not the tooling:
**no SQL statement has ever been executed by a real SQLite** (CI has no
SQLite engine), and the four packaged-app restart checks have not been driven
by hand.

> **Two Phase D files carried type defects of their own.** The 2026-11-06
> typecheck (the twentieth batch) found **7** errors, and **two of them are
> in Phase D's own files**:
>
> | File                                         | Defect                                                                                                                                                                        | Fix                                                                                                                 |
> | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
> | `apps/desktop/src/lib/tauri-sql-executor.ts` | The constructor field was named `invoke`, which shadowed nothing but did not match the `TauriInvoke` interface the sibling adapters use                                       | Renamed to `tauri` — the same shape `tauri-secret-store.ts` and `tauri-agent-keychain.ts` already use               |
> | `apps/desktop/src/lib/chat-history.ts`       | `endedAt` / `closeReason` were typed `string \| undefined` where the view's contract says `string \| null`, because the storage layer marks "not ended" as an _absent_ column | Normalised with `?? null` **at the boundary**, so the screen never has to tell "still running" apart from "unknown" |
>
> Both are fixed, and the twenty-first batch **re-ran the type check:
> EXIT=0** — neither defect is back. See § 8.8.19 and § 8.8.20.

| Capability                                     | What is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The local business database (SQLite)           | `packages/storage/src/sql-migrations.ts` (6 business tables + a `schema_migrations` ledger, `SCHEMA_VERSION = 1`), `sql-migrator.ts` (`runMigrations` / `assertDatabaseHealthy`), `database.ts` (the `KindoraDatabase` port) with two implementations — `sqlite-database.ts` and `memory-database.ts`. The desktop app opens it through `tauri-plugin-sql` (`apps/desktop/src/lib/tauri-sql-executor.ts`). **149 test cases are written; the storage suite was run twice on 2026-11-05 and came back 165/165 green on the second run, and green again on 2026-11-06 — this time at 168/168.** |
| The failure path the first run exposed         | `runMigrations` executed the bookkeeping table, the version read and the version write **without** a `try` / `catch`, so a raw driver error could reach the UI instead of a `DatabaseError` — the very thing `DatabaseError`'s own comment forbids. All three are now wrapped, and four regression cases pin the behaviour. **Verified by the second run.**                                                                                                                                                                                                                                   |
| Chat history persistence                       | `packages/storage/src/chat-repository.ts` — every message is written down **before** it goes out (`PENDING`), then `SENT` / `FAILED`; a received message is `DELIVERED`. Wired in through the `ChatPersistence` port (`packages/matching/src/chat-persistence.ts`) and the desktop adapter (`apps/desktop/src/lib/chat-persistence.ts`); history is readable from `ChatHistoryView`.                                                                                                                                                                                                          |
| The legacy `localStorage` → database migration | `packages/storage/src/legacy-migration.ts` — the old copy is removed **only after** the database write succeeded, so a failed migration can be retried.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

> **⚠️ Two gaps that the tests cannot close:**
>
> 1. **CI has no SQLite.** The statements are pinned by a _contract_ test and a
>    _static_ DDL↔DML column check, but **no statement has ever been executed by a
>    real SQLite in CI**.
> 2. **The restart path has not been driven by hand.** "Create an agent, restart,
>    the data is still there" needs a packaged app — CI has no Tauri runtime.

### Implemented, unvalidated

**The code is there and the automated tests are green, but nobody has driven
it in the real thing:**

| Capability                                 | What is missing                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The desktop app in a real window           | A complete two-machine session has not been driven by hand. The app builds and launches.                                                                           |
| Every LLM-dependent feature                | No live provider call. See `packages/llm/src/__tests__/` — `fetch` is mocked throughout.                                                                           |
| LAN pairing through the GUI                | Verified at the Rust socket layer and via a JS IPC shim, not through React against a real Tauri window.                                                            |
| API-key persistence in the OS keychain     | The `keyring` path is implemented and unit-testable, but the end-to-end write into the macOS login keychain has not been confirmed on a real dev build.            |
| The agent's private key in the OS keychain | The code path exists (`apps/desktop/src-tauri/src/secrets.rs`), but the end-to-end write into the macOS login keychain has not been confirmed on a real dev build. |

### Not implemented

| Capability                                    | Evidence                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebRTC / cross-network pairing                | `packages/transport/src/webrtc-transport.ts` — `connect()` / `send()` / `onMessage()` / `onClose()` all throw a typed `WebRtcNotImplementedError` (stable code `WEBRTC_NOT_IMPLEMENTED`); there is **no code path** in which `connect()` resolves, so a fake "connected" state cannot occur. **Same-LAN only.** |
| TLS on the LAN transport                      | The TCP path is still plaintext TCP. The **payload** is encrypted by the session cipher, but the envelope header is not.                                                                                                                                                                                        |
| A Rust-side signer (`agent_sign`)             | The private key is read back into the webview to sign there. The Rust side only stores and returns the key (`apps/desktop/src-tauri/src/secrets.rs`); it cannot sign yet.                                                                                                                                       |
| A non-extractable identity key in the browser | Browser dev mode still keeps the private key in `localStorage` (`privateKeyStorage.kind === 'dev-localstorage'`). A non-extractable WebCrypto key in IndexedDB is the real fix.                                                                                                                                 |
| QR-code pairing                               | `packages/transport/src/qr-payload.ts` has the payload helpers; there is no UI for them.                                                                                                                                                                                                                        |
| Releases / installers                         | No git tags, no published releases. The **installer is now buildable** — `pnpm -C apps/desktop tauri build` produces `Kindora.app` and `Kindora_0.1.0_aarch64.dmg` — but nothing is published, and there is no signed build.                                                                                    |
| DHT / rendezvous / relay / TURN               | Not started.                                                                                                                                                                                                                                                                                                    |

---

## Screens

`apps/desktop/src/App.tsx:60-107` defines sixteen view states. The user-facing
screens are:

Welcome · Create/Edit agent · Home · Settings · **Blocked agents** · Connect ·
**Identify** · Match · Consent · Icebreaker · Chat · **Chat history**

plus three error/placeholder states — **Keychain error**, **Database error**,
and the initial `loading` state.

(LAN and Loopback are two modes _inside_ Connect, not separate screens.
`Identify`, `Blocked agents` and `Chat history` were added by the Phase B and
Phase D remediations.)

---

## Known technical limitations

These are current, real, and worth knowing before you rely on the software.

1. **The LAN transport has no TLS.** The TCP channel is plaintext. Phase A
   added end-to-end **payload** encryption on top (ECDH P-256 + HKDF-SHA256 +
   AES-256-GCM), so the contents of a message are not readable on the wire —
   but the envelope **header** (protocol, type, sender, message id, timestamp)
   and the **signature** are still in the clear, so an observer can see that
   two agents are talking and how much.
2. **The private key is read back into the webview to sign.** It is stored in
   the OS keychain, and it is imported into WebCrypto as non-extractable, but
   it crosses the Rust→JS boundary in the clear on the way. A Rust-side
   `agent_sign` command needs the `p256` crate and is not implemented.
3. **Browser dev mode keeps the private key in `localStorage`.** There is no
   OS keychain without the Tauri runtime, so the record is tagged
   `dev-localstorage`. The shipped desktop app uses the keychain.
4. **The pairing code is a stable identity fingerprint, not a one-time
   secret.** It is derived from the host's long-term key, so it does not
   change between sessions — which is what makes it useful, and what rules out
   a naive replay defence. It is not a credential: the session is
   authenticated by the ES256 signature on every envelope.
5. **The prompt-injection defence is heuristic.** It strips credential-like
   patterns and clearly delimits remote content as untrusted; it is not a proof.
6. **The sensitive-field guard can false-positive on base64url key material.**
   Roughly 1 in 100 000 per match attempt. The guard was deliberately not
   weakened, because weakening it would also stop it catching real secrets.
7. **Browser dev mode stores the API key in `localStorage`** (AES-GCM encrypted)
   rather than in the OS keychain, because there is no native runtime. The
   shipped desktop app uses the keychain. See `apps/desktop/src/lib/llm-service.ts:35-37`.
8. **No external security audit has been performed**, and no release has been
   published. Treat Kindora as research-grade software.
9. **The local business database has no foreign-key constraints.** SQLite
   foreign keys are off by default, and `PRAGMA foreign_keys=ON` would apply
   per connection — which a pooled plugin cannot guarantee. Referential
   integrity is therefore enforced **in the repository layer**
   (`packages/storage/src/chat-repository.ts`), not by the database.
10. **The database has no transactions.** `tauri-plugin-sql` pools its
    connections and exposes no transaction API, so `BEGIN`/`COMMIT` across
    statements would be unsafe. Every write is a **single statement**, every
    migration is **idempotent**, and the schema-version row is written **last**
    — a migration that dies half-way is simply re-run.

The full list, with the reasoning behind each item, is in
[SECURITY.md](../SECURITY.md).

---

## How to check these claims yourself

```bash
# Test inventory — 1022 declared TypeScript cases, 48 Rust cases
grep -roE "\bit\(" apps/desktop/src packages/*/src | wc -l
grep -rhoE "^[[:space:]]*#\[(tokio::)?test" apps/desktop/src-tauri/tests/ apps/desktop/src-tauri/src/ | wc -l

# The specific "not implemented" claims
grep -n "not implemented" packages/transport/src/webrtc-transport.ts
grep -rn "qr" apps/desktop/src/views

# The port
grep -n "DISCOVERY_PORT" apps/desktop/src-tauri/src/lan.rs

# The Phase A additions
grep -rn "canonicalize" packages/protocol/src/canonical-json.ts | head -1
grep -rn "signEs256\|verifyEnvelopeSignature" packages/protocol/src/signature.ts | head -2
grep -rn "derivePairingFingerprint" packages/transport/src/pairing-fingerprint.ts | head -1
grep -rn "agent_key_" apps/desktop/src-tauri/src/lib.rs

# The Phase D additions — the SQL plugin is genuinely called now
grep -rn "plugin:sql|" apps/desktop/src/lib/tauri-sql-executor.ts
grep -rn "tauri_plugin_sql" apps/desktop/src-tauri/src/lib.rs
grep -n "SCHEMA_VERSION" packages/storage/src/sql-migrations.ts

# What CI actually runs — ten checks, the key ones blocking
grep -n "name:" .github/workflows/ci.yml

# The thirteen LAN security scenarios and the test that pins each one down
grep -c "^### " docs/phase16/lan-security-coverage.md
```

If a claim here disagrees with the code, **the code wins** — please open an
issue or a PR to correct this document.
