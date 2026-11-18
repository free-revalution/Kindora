# Kindora P0-1 CI 整改报告

> **主题**：修复 GitHub Actions，让 Rust 检查真正执行。
> **基线提交**：`f874944c7909f71f7f236cd77a4cb1d6111c38f6`（`main` / `origin/main`）。
> **执行日期**：2026-11-07（本地执行）。
> **关联任务书**：`docs/修复.md` 所指《Kindora V0.1 Alpha 发布准备——分阶段整改执行任务书》V1.0，§ 三 P0-1。
> **配套审计报告**：`docs/audits/KINDORA_CURRENT_STATE_AUDIT_2026-11-06.md`（未覆盖、未修改）。

---

## 0. 一句话结论

P0-1 的根因是 **CI 运行环境缺少 Linux 系统库**，不是 Rust 代码本身有问题：`build` job 完全没有安装 WebKitGTK 依赖栈，而 `apps/desktop/src-tauri` 依赖 `tauri` 的默认 features（`wry` → `webkit2gtk`），其 build script 的 pkg-config 探测失败后直接 `process::exit(1)`，导致 cargo 以 101 退出，GitHub Actions 随即把该 job 后续的 5 个 Rust 检查步骤全部标为 `skipped`。修复方式是把已在同一次 run 中被证明可以成功编译该 crate 的系统库清单，抽取为一个共享的 composite action，并在 `build` job 中调用它。

**本轮结论：`PASS`**（修复已落地，本地验证全部通过，并在真实 GitHub Actions run `42581762187` 中确认全部 6 个 Rust 门禁**实际执行且成功**，无一被跳过）。

**最终验收：`PASS`**（2026-11-09。PR #1 已由用户合并，`main` 上的 `push` run `42604141206` 总结论 `success`；六个 Rust 门禁在 `main` 上全部实际执行并成功，`skipped` / `failure` / `cancelled` 均为 0。完整证据见 § 9。）

---

## 1. 执行基线（任务书 Step 1）

### 1.1 仓库状态

| 项                        | 值                                                                                           | 采集方式                    |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| 当前分支                  | `main`                                                                                       | `git branch --show-current` |
| `HEAD`                    | `f874944c7909f71f7f236cd77a4cb1d6111c38f6`                                                   | `git rev-parse HEAD`        |
| `origin/main`             | `f874944c7909f71f7f236cd77a4cb1d6111c38f6`                                                   | `git rev-parse origin/main` |
| `HEAD` 与任务书声明的基线 | **完全一致**，无偏差                                                                         | 人工比对                    |
| `git diff --stat`         | 空（无已跟踪文件的未提交修改）                                                               | `git diff --stat`           |
| `Cargo.lock` sha256       | `521ca69168588d80141ad5344440678696e7afacb390afdd3d5be3b4ed81cea3`（整改前后一致，未被修改） | `shasum -a 256`             |

### 1.2 工作区未提交文件（已识别并全程保护）

基线时刻 `git status --short`：

```
?? docs/audits/
?? docs/优化.md
?? docs/修复.md
```

| 路径           | 性质                                   | 本轮处理                                 |
| -------------- | -------------------------------------- | ---------------------------------------- |
| `docs/优化.md` | **用户文件**（前一阶段只读审计任务书） | 未读取修改、未格式化、未移动、未删除     |
| `docs/修复.md` | **用户文件**（既有整改任务书）         | 未读取修改、未格式化、未移动、未删除     |
| `docs/audits/` | 审计阶段交付物目录（未跟踪）           | 未覆盖；本轮报告以**新文件名**写入该目录 |

整改完成后 `git status --short`：

```
 M .github/workflows/ci.yml
?? .github/actions/
?? docs/audits/
?? docs/优化.md
?? docs/修复.md
```

除 `ci.yml` 与新增的 `.github/actions/` 外，用户未提交文件全部保持原状。

### 1.3 观察到的 CI 历史（真实 GitHub API 数据）

`main` 分支共 15 次 workflow run，**15 次全部为 `failure`**。最近一次为 run `42228916649`，`head_sha = f874944c79…`，即当前基线，本次分析以该 run 为准。

按 Rust 门禁在 15 次 run 中的实际结论统计（step 级 `conclusion`，来自 `/repos/{owner}/{repo}/actions/runs/{id}/jobs`）：

| Rust 门禁步骤                        | 出现过的结论                         | 是否曾成功执行               |
| ------------------------------------ | ------------------------------------ | ---------------------------- |
| `Rust Clippy`                        | `failure` ×1（仅当前 ci.yml 的一次） | 否                           |
| `Rust lib check (real PASS/FAIL)`    | 全部 `skipped`                       | 否                           |
| `Rust unit tests`                    | 全部 `skipped`                       | 否                           |
| `LAN end-to-end Rust tests`          | 全部 `skipped`                       | 否                           |
| `LAN protocol end-to-end Rust tests` | 全部 `skipped`                       | 否                           |
| `LAN resource-limit Rust tests`      | 全部 `skipped`                       | 否                           |
| `Rust format check`                  | `success` ×1                         | 是（唯一执行过的 Rust 步骤） |

> `Rust format check` 能通过而 `Rust Clippy` 失败，本身就是一条关键证据：`cargo fmt --check` **不编译依赖树**，不会触碰 `webkit2gtk-sys`；`cargo clippy` 会。

---

## 2. 根因分析（任务书 Step 2）

### 2.1 症状（run 42228916649，`build` job，19 个步骤）

| #    | 步骤                               | 结论          | 耗时       |
| ---- | ---------------------------------- | ------------- | ---------- |
| 1–11 | Set up job … Test（pnpm 全量）     | `success`     | 合计 ~75 s |
| 12   | Rust format check                  | `success`     | 0 s        |
| 13   | **Rust Clippy**                    | **`failure`** | **13 s**   |
| 14   | Rust lib check (real PASS/FAIL)    | `skipped`     | —          |
| 15   | Rust unit tests                    | `skipped`     | —          |
| 16   | LAN end-to-end Rust tests          | `skipped`     | —          |
| 17   | LAN protocol end-to-end Rust tests | `skipped`     | —          |
| 18   | LAN resource-limit Rust tests      | `skipped`     | —          |
| 19   | Format check（Prettier）           | `skipped`     | —          |

同一次 run 中的对照 job：

| job           | 系统库安装                                          | Rust/Tauri 步骤                           | 结论               |
| ------------- | --------------------------------------------------- | ----------------------------------------- | ------------------ |
| `build`       | **无**                                              | Rust Clippy                               | `failure`（13 s）  |
| `tauri-build` | **有**（`Install Tauri Linux prerequisites`，27 s） | `Build the Tauri app`（编译同一个 crate） | `success`（242 s） |

**同一次 run、同一个 `ubuntu-latest` runner 镜像、同一个 crate、同一组默认 features** —— 一个装了系统库成功、一个没装在 13 秒内失败。这是一个受控对照。

### 2.2 已确认根因

> **根因**：`build` job 未安装任何 Linux 系统库，而 `apps/desktop/src-tauri` 的依赖树在 Linux 上需要 WebKitGTK/GTK/GLib/Pango/libsoup/SQLite/D-Bus 等开发包。缺包时，依赖树中 `webkit2gtk-sys` 的 build script 探测失败并 `process::exit(1)`，cargo 以退出码 **101** 终止，整个 job 的 Rust 部分在第一个需要编译依赖树的步骤（Clippy）上失败；GitHub Actions 在 job 内某一步失败后会把该 job 后续所有步骤标记为 `skipped`，于是 5 个 Rust 门禁从未运行过。

证据链（每一环都可独立复核）：

| #   | 证据                                                                                                                                                                                                                                                                                                                             | 来源                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| E1  | `apps/desktop/src-tauri/Cargo.toml:25` 为 `tauri = { version = "2", features = [] }`；`features = []` **不会**关闭 default features                                                                                                                                                                                              | 源码                          |
| E2  | `tauri-2.12.3/Cargo.toml` 的 `default = ["wry","compression","common-controls-v6","dynamic-acl","x11","dbus"]`，`wry` 依赖 `webkit2gtk`                                                                                                                                                                                          | crates.io 源码                |
| E3  | `webkit2gtk-sys-2.0.2/build.rs`：`system_deps::Config::new().probe()` 失败时打印 `cargo:warning={s}` 并 `process::exit(1)`                                                                                                                                                                                                       | crates.io 源码                |
| E4  | `webkit2gtk-sys-2.0.2/Cargo.toml` 声明 `[package.metadata.system-deps.webkit2gtk_4_1] name = "webkit2gtk-4.1"`                                                                                                                                                                                                                   | crates.io 源码                |
| E5  | `cargo metadata --filter-platform x86_64-unknown-linux-gnu --locked`（373 个包）确实包含 `webkit2gtk-sys 2.0.2`、`soup3-sys 0.5.0`、`glib-sys 0.18.1`、`pango-sys 0.18.0`、`javascriptcore-rs-sys 1.1.1`、`libdbus-sys 0.2.7`、`libsqlite3-sys 0.30.1`、`tray-icon 0.25.1`                                                       | 本机实测                      |
| E6  | 这些 crate 探测的 pkg-config 模块名（逐个读 `build.rs` / `Cargo.toml` 得出）：`webkit2gtk-4.1`、`javascriptcoregtk-4.1`、`libsoup-3.0`、`pango`、`gtk+-3.0`、`gdk-3.0`、`gdk-x11-3.0`、`atk`、`cairo`、`cairo-gobject`、`gdk-pixbuf-2.0`、`glib-2.0`、`gobject-2.0`、`gio-2.0`、`dbus-1`、`sqlite3`、`ayatana-appindicator3-0.1` | 本机实测（registry 源码扫描） |
| E7  | `pkg-config` crate 在缺库时的错误文案为 ``The system library `{}` required by crate `{}` was not found.``（`pkg-config-0.3.34/src/lib.rs:367`）                                                                                                                                                                                  | crates.io 源码                |
| E8  | 失败步骤耗时 **13 s**——与「编译到某个 build script 探测失败」一致，与「编译整个依赖树后 lints 报错」不一致                                                                                                                                                                                                                       | run 步骤耗时                  |
| E9  | 本机（macOS）以**完全相同**的命令 `cargo clippy --all-targets --all-features -- -D warnings` 运行，退出码 0 且**零 warning**                                                                                                                                                                                                     | 本机实测                      |
| E10 | 同一 run 的 `tauri-build` job 装了系统库后成功编译同一 crate                                                                                                                                                                                                                                                                     | run 步骤结论                  |

**为什么 `dbus-1`、`sqlite3` 等不需要额外安装也能编过？** `tauri-build` job 的 apt 清单里并没有 `libdbus-1-dev`，但它成功编译了同一个 crate —— 这证明 `ubuntu-latest` 镜像**自带** `dbus-1.pc` 与 `sqlite3.pc`。本机 `pkg-config --exists` 也印证了 `sqlite3` 在多数发行版上是通用包。**因此本次修复不需要扩充 apt 清单，复制已被证明有效的清单即可。**

### 2.3 高概率原因（机制确定，但日志原文未能直接观测）

- Clippy 步骤失败时的 stderr **原文**应当是 `The system library \`webkit2gtk-4.1\` required by crate \`webkit2gtk-sys\` was not found.`（或同族 crate 的等价文案）。
- **未直接观测的原因**：GitHub REST 的 `/repos/{owner}/{repo}/actions/jobs/{job_id}/logs` 对本公开仓库的未认证请求返回 **HTTP 403 `Must have admin rights to Repository.`**；本轮没有更高权限的凭据。
- 因此该条属于「高概率原因」而非「已确认」：机制由 E1–E10 完整确定，但**没有把 CI 日志里那一行字读出来**。本报告不把它写成已观测事实。

### 2.4 尚未确认的推测（明确标注，不当作事实使用）

1. run 42228916649 当日 `ubuntu-latest` 具体镜像版本及其预装包清单——本轮**没有**去查 runner-images 的 README。该推测不影响修复，因为修复采用的是「同一 run 中已验证可用的清单」。
2. **系统库装好之后，Rust 门禁在 Linux 上是否全部为绿**——本机是 macOS，Linux 依赖树在本机根本无法编译（`cargo metadata` 显示 macOS 图里不含 `webkit2gtk`/`glib`/`soup3`）。Linux 专属的 `cfg` 分支理论上可能触发 macOS 上不存在的 lint。**这一点只能由真实的 GitHub Actions 运行回答。**
3. Rust 阶段在 Linux runner 上的实际墙钟时间——本机 macOS 的冷编译耗时不能代表 GitHub runner。

### 2.5 已排除的假设（附排除理由）

| 假设                                                | 排除理由                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 「Rust 代码有 clippy 错误」                         | E9：同样的 flag 本机退出 0、零 warning。且 13 s 的失败时长早于任何本 crate 的编译。                                    |
| 「`cargo fmt --check` 通过说明 Rust 环境正常」      | 错。rustfmt 不编译依赖树，不触发 `webkit2gtk-sys` 的探测。                                                             |
| 「cache 命中/损坏导致跳过」                         | `Cache cargo registry & target` 结论为 `success`；跳过是失败步的后继效应，不是 cache 的问题。                          |
| 「pnpm / node 版本问题」                            | 那是旧 run 的失败点（15 次里 11 次挂在 `Setup pnpm`）。当前 ci.yml 的 `Setup pnpm` 在 run 42228916649 中为 `success`。 |
| 「改 `Cargo.toml` 关掉 `tauri` 默认 features」      | 会移除 `wry`，桌面端将不再有 webview，产品功能被破坏；且属于改依赖，超出 P0-1 范围。                                   |
| 「加 `continue-on-error` 或跳过失败步骤让 CI 变绿」 | 任务书明令禁止，且会让门禁名存实亡。**本轮没有这样做。**                                                               |

---

## 3. 修改内容（任务书 Step 3）

### 3.1 新增文件

**`.github/actions/setup-tauri-linux/action.yml`**（新增，45 行）

一个 composite action，把原本内联在 `tauri-build` job 里的 apt 安装块**原样**搬出来：

```yaml
runs:
  using: composite
  steps:
    - name: Install Tauri Linux prerequisites
      shell: bash
      run: |
        sudo apt-get update
        sudo apt-get install -y \
          libwebkit2gtk-4.1-dev \
          libayatana-appindicator3-dev \
          librsvg2-dev \
          patchelf \
          build-essential \
          curl \
          wget \
          file \
          libssl-dev \
          libxdo-dev
```

包清单与改动前**逐字节相同**（未增、未删、未改顺序）。理由见 §7.2。

### 3.2 修改文件

**`.github/workflows/ci.yml`**（+57 / −15）

| 位置              | 改动                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件头注释        | 新增「What changed and why (the P0-1 CI remediation, 2026-11-07)」段落，说明根因、证据与修复方式                                                                                         |
| `build` job       | 在 `Setup Rust (stable)` 之后、`Cache cargo registry & target` 之前，新增 1 个步骤：`uses: ./.github/actions/setup-tauri-linux`（含 20 行说明注释）                                      |
| `tauri-build` job | 原本 14 行的内联 apt 块 → 2 行的 `uses: ./.github/actions/setup-tauri-linux` 调用；步骤在 job 中的**位置不变**（仍在 `Cache cargo registry & target` 之后、`Install dependencies` 之前） |

`build` job 改动后的完整步骤序列（19 步，与改动前步骤数一致，仅多出 1 步环境准备）：

```
1 Checkout · 2 Setup pnpm · 3 Setup Node · 4 Setup Rust (stable)
5 Setup Tauri Linux prerequisites   ← 新增
6 Cache cargo registry & target · 7 Install dependencies
8 Typecheck · 9 Lint · 10 Build · 11 Test
12 Rust format check · 13 Rust Clippy · 14 Rust lib check
15 Rust unit tests · 16 LAN end-to-end · 17 LAN protocol e2e · 18 LAN resource-limit
19 Format check
```

### 3.3 明确没有做的事

| 未做项                                                   | 原因                                                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 删除任何 Rust 步骤                                       | 任务书明令禁止                                                                                                                                                  |
| 给任何步骤加 `continue-on-error`                         | 任务书明令禁止；`build` / `tauri-build` 两个 job 仍无 job 级 `continue-on-error`                                                                                |
| 加 `if: always()` / 条件跳过                             | 任务书明令禁止                                                                                                                                                  |
| 改 `timeout-minutes`                                     | 依据真实耗时数据：`tauri-build` job 装完系统库后完整编译该 crate 仅需 **242 s**，`build` job 的 TS 段约 85 s，新增 apt 约 27 s，原有 30 min 预算充足（见 §7.3） |
| 改 `Cargo.toml` / `Cargo.lock` / `package.json` / 锁文件 | 超出范围；且会破坏产品功能                                                                                                                                      |
| 改任何业务代码                                           | 超出范围                                                                                                                                                        |
| 格式化 / 覆盖 / 删除用户未提交文件                       | 任务书全局约束 §1.2                                                                                                                                             |
| `git commit` / `git push` / 创建 Release                 | 任务书全局约束 §1.10「未经明确授权，不得 commit、push、创建 Release 或发布安装包」                                                                              |

---

## 4. 本地测试（任务书 Step 4）

执行环境：macOS（Darwin 24.6.0, arm64），`rustc`/`clippy` 1.99.1，Node 20，pnpm 10.32.1。
原始日志：`/tmp/kd-p01/verify.log`（逐命令完整 stdout/stderr + 退出码）。

### 4.1 验证矩阵

| #   | 命令                                                       |  EXIT |      通过 | 失败 | 跳过 | 是否真实执行          |
| --- | ---------------------------------------------------------- | ----: | --------: | ---: | ---: | --------------------- |
| 1   | `pnpm -r typecheck`                                        | **0** |         — |    — |    — | 是                    |
| 2   | `pnpm lint`                                                | **0** |         — |    — |    — | 是                    |
| 3   | `pnpm format:check`                                        | **1** |         — |    — |    — | 是（失败原因见 §4.2） |
| 4   | `pnpm -r test`                                             | **0** |      1035 |    0 |    8 | 是                    |
| 5   | `cargo fmt --check`                                        | **0** |         — |    — |    — | 是                    |
| 6   | `cargo clippy --all-targets --all-features -- -D warnings` | **0** | 0 warning |    0 |    — | 是                    |
| 7   | `cargo test --lib`                                         | **0** |        13 |    0 |    0 | 是                    |
| 8   | `cargo test --test lan_e2e -- --test-threads=1`            | **0** |        18 |    0 |    0 | 是                    |
| 9   | `cargo test --test lan_protocol_e2e -- --test-threads=1`   | **0** |        13 |    0 |    0 | 是                    |
| 10  | `cargo test --test lan_limits -- --test-threads=1`         | **0** |         4 |    0 |    0 | 是                    |

Rust 合计：**48 passed / 0 failed / 0 ignored**（13 + 18 + 13 + 4）。
TypeScript 合计：**1035 passed / 0 failed / 8 skipped**（8 个 skipped 全部来自 `packages/llm`，是测试自身声明的 skip，**不计为通过**）。

分包明细（Vitest）：

| 包                   | Test Files          | Tests                |
| -------------------- | ------------------- | -------------------- |
| `packages/protocol`  | 11 passed           | 215 passed           |
| `packages/llm`       | 4 passed, 1 skipped | 56 passed, 8 skipped |
| `packages/storage`   | 11 passed           | 168 passed           |
| `packages/agent`     | 15 passed           | 148 passed           |
| `packages/transport` | 15 passed           | 211 passed           |
| `packages/matching`  | 8 passed            | 86 passed            |
| `apps/desktop`       | 16 passed           | 151 passed           |

### 4.2 `pnpm format:check` 失败的分析（按任务书要求先判断文件是否被 Git 跟踪）

失败的两个文件**都不是 Git 跟踪文件**：

```
[warn] docs/audits/KINDORA_CURRENT_STATE_AUDIT_2026-11-06.md
[warn] docs/优化.md
```

| 文件                                                    | 性质                                   | 处理                                                           |
| ------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `docs/优化.md`                                          | **用户文件**，任务书原文               | **未格式化、未修改**（任务书：绝不自动格式化用户未跟踪的文件） |
| `docs/audits/KINDORA_CURRENT_STATE_AUDIT_2026-11-06.md` | 上一阶段的交付物，仍在用户未跟踪目录中 | **未格式化、未修改**（改动它属于「修改与当前阶段无关的文件」） |

**关键结论（决定 CI 上该步骤会不会红）**：GitHub Actions 只 checkout **Git 跟踪**的文件，因此本地这两个未跟踪文件**不会出现在 runner 上**。本轮已单独验证 Git 跟踪文件集合的 Prettier 状态：

```bash
git ls-files -z | grep -zE '\.(ts|tsx|js|cjs|mjs|json|md|css|html)$' \
  | xargs -0 npx prettier --check
# → All matched files use Prettier code style!   （exit 0）
```

即：**Git 跟踪的 241 个文件全部 Prettier 合规，CI 上的 `Format check` 步骤会通过。** 本地 `format:check` 的红灯只来自本地未跟踪文件。

### 4.3 无法在本地执行的验证（明确记为 `NOT_RUN` / `BLOCKED`，不记为通过）

| 项                                    | 状态      | 原因                                                                                                                                                                                |
| ------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在 Linux 上编译 Rust 依赖树           | `BLOCKED` | 本机为 macOS，Linux 依赖树无法在本机编译（macOS 依赖图不含 `webkit2gtk`/`glib`/`soup3`）                                                                                            |
| 在 Linux 容器中复现 CI 失败并验证修复 | `BLOCKED` | 本机容器/VM 镜像仓库不可达：`docker pull ubuntu:24.04` 返回 `EOF`；`mirror.gcr.io` 同样 `EOF`；OrbStack `orb create ubuntu` 返回 `image not found: {ubuntu oracular arm64 default}` |
| 真实 GitHub Actions 运行              | `PASS`    | run `42581762187`（PR #1，head `f14a547`）：3 个 job 全部 `success`，`build` job 20 个步骤全部 `success`、**零 `skipped`**                                                          |

---

## 5. GitHub Actions 状态（任务书 Step 5）

### 5.1 YAML 与作业图校验（已执行）

| 校验                  | 方式                                                            | 结果                             |
| --------------------- | --------------------------------------------------------------- | -------------------------------- |
| YAML 语法             | `js-yaml` 解析 `ci.yml` 与 `action.yml`                         | 均通过                           |
| YAML 语法（第二实现） | `actionlint v1.7.7`（本地下载后运行）                           | **exit 0，无任何告警**           |
| 基线对照              | 对 `git show HEAD:.github/workflows/ci.yml` 跑同版本 actionlint | exit 0（说明改动没有引入新问题） |
| 局部 action 引用      | `uses: ./.github/actions/setup-tauri-linux` → 路径存在          | 存在，引用合法                   |
| composite action 脚本 | 抽出内嵌 bash 后 `bash -n`                                      | 语法 OK                          |
| 作业图                | 解析后逐 job 打印步骤                                           | 见下                             |

```
build          : 19 steps, timeout 30, job-level continue-on-error = false
tauri-build    :  9 steps, timeout 45, job-level continue-on-error = false
dependency-audit: 9 steps, timeout 20, job-level continue-on-error = true  （本次未改动）
```

- `build` job 内 **没有任何** step 级 `continue-on-error`；
- 6 个 Rust 门禁 + `cargo fmt --check` + Prettier 全部**仍然存在且全部 blocking**；
- 没有 `needs:` / `if:` 依赖图变化（三个 job 之间无依赖关系，与改动前一致）。

### 5.2 真实运行状态

**已取得真实运行证据。**（首轮提交时未触发，原因是工作流的 `on.push.branches: [main]` 只匹配 `main` 的 push；随后经用户授权创建 PR #1，由 `on.pull_request.branches: [main]` 触发。）

| 项                                | 值                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------- |
| **Run URL**                       | **https://github.com/free-revalution/Kindora/actions/runs/42581762187**          |
| Run ID / event                    | `42581762187` / `pull_request`                                                   |
| head SHA                          | `f14a547af5325b2bc8b54f5f843aa3ae6337a70f`（= 本次修复 commit）                  |
| 总结论                            | **`success`**（created 2026-11-09T07:49:39Z → updated 07:56:33Z，run_attempt 1） |
| PR                                | https://github.com/free-revalution/Kindora/pull/1 （open，**未合并**）           |
| 对照：修复前的最近一次 `main` run | `42228916649`（head `f874944`），结论 `failure`                                  |

### 5.3 真实运行结果（run 42581762187）

`Build & test` job —— **20 个步骤全部 `success`，零 `skipped`**：

| #   | 步骤                                                               | 结论                                | 耗时 |
| --- | ------------------------------------------------------------------ | ----------------------------------- | ---: |
| 6   | **Setup Tauri Linux prerequisites**（本次新增的 composite action） | `success`                           | 29 s |
| 9   | Typecheck                                                          | `success`                           | 11 s |
| 10  | Lint                                                               | `success`                           |  4 s |
| 11  | Build                                                              | `success`                           | 14 s |
| 12  | Test                                                               | `success`                           | 40 s |
| 13  | Rust format check                                                  | `success`                           |  2 s |
| 14  | **Rust Clippy**                                                    | **`success`**（修复前为 `failure`） | 74 s |
| 15  | **Rust lib check (real PASS/FAIL)**                                | **`success`**（修复前为 `skipped`） |  1 s |
| 16  | **Rust unit tests**                                                | **`success`**（修复前为 `skipped`） | 71 s |
| 17  | **LAN end-to-end Rust tests**                                      | **`success`**（修复前为 `skipped`） | 29 s |
| 18  | **LAN protocol end-to-end Rust tests**                             | **`success`**（修复前为 `skipped`） | 43 s |
| 19  | **LAN resource-limit Rust tests**                                  | **`success`**（修复前为 `skipped`） |  2 s |
| 20  | Format check                                                       | `success`                           |  8 s |

`Tauri build check` job —— 全部 `success`，其中步骤 7 `Setup Tauri Linux prerequisites` = `success`（29 s），步骤 10 `Build the Tauri app` = `success`（95 s，缓存命中）。

`Dependency audit` job —— 全部 `success`（该 job 仍为 `continue-on-error` 的非门禁作业，与改动前一致）。

**这是本仓库历史上第一次 6 个 Rust 门禁全部真实执行并通过。**

---

## 6. 验收标准对照

> 说明：任务书 §3.4 的 CI-01…CI-09 逐条原文未在本次执行上下文中留存，下表按 §3.3 Step 1–5 与 §3.4 的要求逐项归纳，标签与原文的对应关系请与任务书核对。

| 编号  | 验收要求                                                                                                 | 状态                              | 证据                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CI-01 | 确认基线（分支、HEAD、`origin/main`、未提交文件）并记录                                                  | **PASS**                          | §1.1、§1.2                                                                                                             |
| CI-02 | 完整阅读 `ci.yml`，区分已确认根因 / 高概率原因 / 尚未确认的推测                                          | **PASS**                          | §2.2 / §2.3 / §2.4                                                                                                     |
| CI-03 | 不得把「缺 Linux 系统库」当作未经验证的前提；不得删除 Rust 步骤、加 `continue-on-error` 或无条件跳过失败 | **PASS**                          | §2.2 的 10 条证据链；§3.3；§5.1 作业图                                                                                 |
| CI-04 | 按实际根因做最小修复                                                                                     | **PASS**                          | §3.1–§3.3（新增 1 个 action + 1 个调用步骤）                                                                           |
| CI-05 | 本地跑通全部 10 条验证命令并记录真实退出码                                                               | **PASS**（含 1 项已知红灯的说明） | §4.1、§4.2                                                                                                             |
| CI-06 | `format:check` 失败时先判断文件是否被 Git 跟踪；不自动格式化用户未跟踪文件                               | **PASS**                          | §4.2（两个失败文件均未跟踪，均未改动）                                                                                 |
| CI-07 | 校验 YAML 与作业/步骤依赖图；确认所有 Rust 门禁仍在                                                      | **PASS**                          | §5.1（actionlint exit 0，6 个门禁俱在）                                                                                |
| CI-08 | 不伪造 Actions 结果；未经授权不 push                                                                     | **PASS**                          | §5.2（未 push，未编造任何 run 结果）                                                                                   |
| CI-09 | **只有在真实 GitHub Actions 中确认所有 Rust 检查步骤执行并成功后，才能把 P0-1 标记为 PASS**              | **PASS**                          | run `42581762187`：`build` job 步骤 13–19（fmt / Clippy / lib check / unit / LAN×3）全部 `success`，**无一 `skipped`** |

---

## 7. 未解决问题与风险

### 7.1 尚未解决的问题

| ID  | 问题                                                                            | 影响                                                                         | 处置建议                                                                                         |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| R1  | ~~**P0-1 尚无真实 GitHub Actions 证据**~~                                       | **已关闭** —— run `42581762187` 已取得真实证据，6 个 Rust 门禁全部 `success` | 无                                                                                               |
| R2  | Linux 专属的 clippy 告警在 macOS 上不可见                                       | **已关闭** —— Linux runner 上 Rust Clippy = `success`（74 s）                | 无                                                                                               |
| R3  | Clippy 失败步骤的 stderr 原文未读到（GitHub logs 接口 403）                     | 「缺库」这一结论靠代码路径推导，而非日志原文                                 | 如需字面证据，用有仓库 admin 权限的 token 拉取 job log                                           |
| R4  | 本地 `pnpm format:check` 仍为红                                                 | 与 CI 无关（CI 只 checkout 跟踪文件），但本地体验割裂                        | 属既有 Prettier 积压，建议另开 P1 任务清理；**不要**把 `docs/` 加进 `.prettierignore` 来制造假绿 |
| R5  | `rust-toolchain.toml` 为滚动 `stable`                                           | CI 工具链会随时间漂移，未来可能突然编译失败                                  | 属独立改进项（锁定具体版本），本轮不改                                                           |
| R6  | `Cargo.toml` 的 `rust-version = "1.77.2"` 与实际需求（edition2024 → ≥1.85）不符 | 误导性元数据                                                                 | 独立改进项，本轮不改                                                                             |
| R7  | 容器/VM 镜像仓库在本机不可达                                                    | 无法在本地做 Linux 侧复现                                                    | **已由 GitHub runner 验证替代**：run `42581762187` 在真实 `ubuntu-latest` 上跑通全部 Rust 门禁   |

### 7.2 为什么 apt 清单保持逐字节不变

任务书要求「不要重复安装不必要的依赖」。本次的处理是：

- **清单本身不增不减**。`libwebkit2gtk-4.1-dev` 会传递拉入 `libgtk-3-dev`、`libpango1.0-dev`、`libcairo2-dev`、`libatk1.0-dev`、`libgdk-pixbuf-2.0-dev`、`libjavascriptcoregtk-4.1-dev`、`libsoup-3.0-dev`、`libglib2.0-dev`，正好覆盖 E6 里除 `dbus-1` / `sqlite3` 之外的**全部** pkg-config 模块；而 `dbus-1` 与 `sqlite3` 经 §2.2 的对照实验证明 runner 镜像自带。**没有多余的包，也没有缺失的包。**
- `curl` / `wget` / `file` / `patchelf` / `libssl-dev` / `libxdo-dev` 严格说不是「编译依赖树」所必需，但它们是 Tauri 官方前置依赖清单的一部分，且 **`tauri-build` job 当前是绿的**——在一个已通过的作业上删包属于风险大于收益的改动，会把「修红的」变成「弄红的」。因此本轮原样保留，把「精简清单」列为独立的后续可选优化。

### 7.3 30 分钟超时的评估（已被真实运行证实）

run `42581762187` 的实测耗时（`Build & test` job）：

| 环节                                           |                              实测 |
| ---------------------------------------------- | --------------------------------: |
| apt 安装系统库                                 |                              29 s |
| pnpm install + typecheck + lint + build + test |                              71 s |
| Rust format check                              |                               2 s |
| Rust Clippy                                    |                              74 s |
| Rust lib check                                 |                               1 s |
| Rust unit tests                                |                              71 s |
| LAN end-to-end / protocol e2e / resource-limit |                     29 + 43 + 2 s |
| Prettier format check                          |                               8 s |
| **job 内步骤耗时合计**                         | **约 380 s（含 setup 约 470 s）** |

整个 run 从 `created` 到 `updated` 共 **约 7 分钟**。原 `timeout-minutes: 30` 余量充足，**未修改超时**这一判断已被真实数据证实。

---

## 8. 最终结论

| 维度                        | 结论                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根因是否定位                | **是**，证据链 10 条，含同一次 run 内的受控对照                                                                                                                       |
| 修复是否落地                | **是**，改动限于 `.github/` 两个文件，+57/−15，另新增 1 个 action                                                                                                     |
| 是否削弱了门禁              | **否**，6 个 Rust 门禁 + fmt + Prettier 全部保留且全部 blocking，无 `continue-on-error`、无条件跳过或删步骤                                                           |
| 本地验证                    | **10 条命令全部真实执行**：9 条 EXIT 0，1 条 EXIT 1（仅因两个未跟踪的本地文件；Git 跟踪树实测 EXIT 0，CI 上会通过）                                                   |
| 是否已取得真实 Actions 证据 | **是** —— run `42581762187`（PR #1，head `f14a547`）总结论 `success`，`build` job 20 步全 `success`、零 `skipped`                                                     |
| main 分支最终验收           | **是** —— run `42604141206`（`event=push`，`head_sha=c6db419`＝main HEAD）总结论 `success`，三个 job 全 `success`，零 `skipped` / `failure` / `cancelled`（详见 § 9） |
| **P0-1 状态**               | **`PASS`**（已正式关闭）                                                                                                                                              |

**P0-1 标记为 PASS。** 任务书规定的条件——「只有在真实 GitHub Actions 中确认所有 Rust 检查步骤执行并成功后」——已由 run `42581762187` 满足：Rust Clippy、Rust lib check、Rust unit tests、LAN end-to-end、LAN protocol end-to-end、LAN resource-limit **六个门禁全部 `success`，且全部为真实执行（不是 `skipped`）**。

**是否允许进入 P0-2**：**可以**（P0-1 的验收条件已全部满足）。

**是否需要用户介入**：**一项，纯流程性**：

1. ~~**合并 PR #1**~~ —— **已完成**（2026-11-09T10:50:15Z 由用户手动合并，main HEAD = `c6db4193c021cd5419edf9dad7bcc30774077fac`）。合并后 `main` 的 CI 已因 `on.push.branches: [main]` 自动触发并跑完，结论 `success`，完整证据见 § 9。
2. **确认 §6 的 CI-01…CI-09 标签与任务书原文的对应关系**（本次上下文中未留存 §3.4 逐条原文，表中为按 §3.3/§3.4 归纳）。

---

## 9. 最终验收：main 分支 push run（2026-11-09）

PR #1 由用户手动合并后，`main` 触发了一次 `event=push` 的 CI run。该 run 是任务书规定的**最终验收载体**（§ 8 中「合并 PR #1」这一条遗留流程项已于本次闭环）。

### 9.1 PR 合并记录

| 字段                          | 值                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| PR                            | [#1 `fix/p0-1-ci-rust-gates`](https://github.com/free-revalution/Kindora/pull/1)                          |
| `state`                       | `closed`                                                                                                  |
| `merged`                      | `true`                                                                                                    |
| `merged_at`                   | `2026-11-09T10:50:15Z`                                                                                    |
| `merge_commit_sha`            | `c6db4193c021cd5419edf9dad7bcc30774077fac`                                                                |
| `merge_commit`（PR 载荷对象） | `null` —— GitHub 对该次 squash 合并未回填嵌套对象；等价的 SHA 在 `merge_commit_sha` 字段中                |
| main 上的实际提交             | `c6db4193c021cd5419edf9dad7bcc30774077fac`                                                                |
| 提交标题                      | `fix(ci): install Tauri Linux prerequisites in build job (#1)`                                            |
| 父提交                        | `f874944c7909f71f7f236cd77a4cb1d6111c38f6`（P0-1 基线）                                                   |
| 提交改动                      | `.github/actions/setup-tauri-linux/action.yml`（新增 +34/−0）、`.github/workflows/ci.yml`（修改 +57/−15） |

**关于「不要把 PR merge ref 当成 main 分支的实际提交」**：合并完成后 `git ls-remote` 的 `refs/pull/1/merge` 已消失，`refs/pull/1/head` 仍指向 `f14a547`（分支头）。本节验收所依据的 main 提交是 `refs/heads/main = c6db4193c021cd5419edf9dad7bcc30774077fac`，即 squash 合并落到 main 上的那一个提交，**不是**任何 PR ref。

### 9.2 main push run

| 字段         | 值                                                                         |
| ------------ | -------------------------------------------------------------------------- |
| Run ID       | `42604141206`                                                              |
| URL          | https://github.com/free-revalution/Kindora/actions/runs/42604141206        |
| Workflow     | CI                                                                         |
| `event`      | `push` ✅                                                                  |
| `head_sha`   | `c6db4193c021cd5419edf9dad7bcc30774077fac`（＝ main HEAD，即合并提交本身） |
| `status`     | `completed` ✅                                                             |
| `conclusion` | **`success`** ✅                                                           |
| `created_at` | `2026-11-09T10:50:17Z`                                                     |
| `updated_at` | `2026-11-09T10:56:54Z`                                                     |
| 总耗时       | 约 6 分 37 秒                                                              |

### 9.3 Job 结论

| Job                                         | Job ID       | 结论          | 时间窗口              |
| ------------------------------------------- | ------------ | ------------- | --------------------- |
| Build & test                                | 129115634786 | **`success`** | 10:50:20Z → 10:56:53Z |
| Tauri build check                           | 129115634226 | **`success`** | 10:50:20Z → 10:53:15Z |
| Dependency audit (record only — not gating) | 129115634826 | **`success`** | 10:50:20Z → 10:53:33Z |

### 9.4 关键步骤结论（`Build & test` job）

| #      | Step                                   | 结论                          |
| ------ | -------------------------------------- | ----------------------------- |
| 6      | Setup Tauri Linux prerequisites        | ✅ `success`（P0-1 新增步骤） |
| 9      | Typecheck                              | ✅ `success`                  |
| 10     | Lint                                   | ✅ `success`                  |
| 11     | Build                                  | ✅ `success`                  |
| 12     | Test                                   | ✅ `success`                  |
| 13     | Rust format check                      | ✅ `success`                  |
| **14** | **Rust Clippy**                        | ✅ **`success`**              |
| **15** | **Rust lib check (real PASS/FAIL)**    | ✅ **`success`**              |
| **16** | **Rust unit tests**                    | ✅ **`success`**              |
| **17** | **LAN end-to-end Rust tests**          | ✅ **`success`**              |
| **18** | **LAN protocol end-to-end Rust tests** | ✅ **`success`**              |
| **19** | **LAN resource-limit Rust tests**      | ✅ **`success`**              |
| 20     | Format check                           | ✅ `success`                  |

### 9.5 skipped / failure / cancelled

**本 run 内 `skipped` = 0、`failure` = 0、`cancelled` = 0。** 三个 job 的每一个步骤（含 post 清理步骤）结论均为 `success`。

`Dependency audit` job 的 job 级 `continue-on-error: true` 是 P0-1 之前既有的设计（任务书第 149 行「记录依赖漏洞……本阶段不批量升级」），P0-1 未改动它；六个 Rust 门禁与全部前端 / Tauri 门禁仍为 blocking。

### 9.6 工作流内容一致性核对

`main` 上运行的 workflow 与 § 5.3 中被验证的分支版本**逐字节相同**（GitHub blob SHA 比对）：

| 文件                                           | main blob SHA                              | 分支 blob SHA | 本地工作树 blob SHA |
| ---------------------------------------------- | ------------------------------------------ | ------------- | ------------------- |
| `.github/workflows/ci.yml`                     | `ee56e76f1178ee4cbe9514f0f41f5fd6d4b882d0` | 同左          | 同左                |
| `.github/actions/setup-tauri-linux/action.yml` | `d53adedd0078ee16a7c84e0316243806f75f8b58` | 同左          | 同左                |

因此 § 5.3 的 PR run 证据与本节的 main run 证据出自**同一份 workflow**，不存在「main 上跑的是另一份配置」的可能。

### 9.7 日志获取限制

`GET /actions/runs/42604141206/logs` 与 `GET /actions/jobs/129115634786/logs` 均返回 **HTTP 403**：

```json
{ "message": "Must have admin rights to Repository." }
```

未认证的公开仓库请求无法下载 Actions 日志 —— 该端点要求带 `actions:read` 权限的令牌（classic PAT `repo`，或 fine-grained PAT 的 `Actions: Read`）。**本节不含任何日志正文**；所有结论均来自 REST API 返回的 step 级 `conclusion` 字段（该字段未认证可读）。

### 9.8 最终验收判定

| #   | 验收标准                                    | 判定 | 依据                                                                                                               |
| --- | ------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | PR #1 已合并                                | ✅   | `merged=true`，`merged_at=2026-11-09T10:50:15Z`，main HEAD = `c6db419`                                             |
| 2   | 找到对应的 main push CI run                 | ✅   | run `42604141206`，`event=push`，`head_sha=c6db419`，`status=completed`                                            |
| 3   | run 总体 `conclusion` = `success`           | ✅   | 三个 job 全部 `success`                                                                                            |
| 4   | 六个 Rust 门禁全部 `success` 且非 `skipped` | ✅   | 步骤 14–19 全部 `success`，`skipped=0`                                                                             |
| 5   | 前端、Tauri 原有检查全部成功                | ✅   | Typecheck / Lint / Build / Test / Rust format check / Format check / Tauri build check 全部 `success`              |
| 6   | 未通过跳过门禁、吞掉失败或修改测试取得绿色  | ✅   | 合并提交只含 2 个 `.github/` 文件；`skipped=failure=cancelled=0`；无新增 `continue-on-error`、无删步骤、无测试改动 |

**最终判定：`PASS`。P0-1 正式关闭。**

---

### 附：复现命令

```bash
# 基线
git status --short && git branch --show-current && git rev-parse HEAD && git rev-parse origin/main && git log -5 --oneline

# 依赖图与探测模块
cd apps/desktop/src-tauri
cargo metadata --format-version 1 --filter-platform x86_64-unknown-linux-gnu --locked \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['packages']))"

# CI 历史（step 级结论）
curl -s https://api.github.com/repos/free-revalution/Kindora/actions/runs/42228916649/jobs \
  | python3 -c "import json,sys;d=json.load(sys.stdin);[print(s['number'],s['name'],s['conclusion']) for j in d['jobs'] for s in j['steps']]"

# 本地验证
/tmp/kd-p01/verify.sh        # 完整日志 /tmp/kd-p01/verify.log，结果 /tmp/kd-p01/results.tsv

# 本次修复的真实 run（step 级结论）
curl -s "https://api.github.com/repos/free-revalution/Kindora/actions/runs/42581762187/jobs" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);[print(s['number'],s['name'],s['conclusion']) for j in d['jobs'] for s in j['steps']]"

# 最终验收：main 上的 push run（step 级结论）
curl -s "https://api.github.com/repos/free-revalution/Kindora/actions/runs/42604141206/jobs" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);[print(s['number'],s['name'],s['conclusion']) for j in d['jobs'] for s in j['steps']]"

# 工作流静态校验
actionlint .github/workflows/ci.yml
```
