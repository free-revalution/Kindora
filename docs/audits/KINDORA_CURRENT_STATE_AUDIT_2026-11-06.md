# Kindora 当前状态全面技术审计报告

| 项 | 值 |
|---|---|
| 审计执行日期 | **2026-11-07** |
| 审计基线提交 | `f874944`（本地 HEAD **等于** `origin/main`） |
| 审计分支 | `main` |
| 审计类型 | 只读审计与验证准备（**未实施任何整改**） |
| 依据任务书 | `docs/优化.md` |
| 产出物 | 本文件（唯一）。本次任务**不实施**任何修复。 |

---

## 0. 审计方法与取证边界

### 0.1 前置命令（任务书 § 2 要求）—— 实际执行结果

```bash
git status --short          # → ?? "docs/优化.md"   ?? "docs/修复.md"
git branch --show-current   # → main
git rev-parse HEAD          # → f874944c7909f71f7f236cd77a4cb1d6111c38f6
git log -5 --oneline        # → f874944 / 020b15d / 0d9175c / e948606 / 0060838
git fetch origin            # → 仅更新远程引用，未做任何合并/重置/切换
git rev-parse origin/main   # → f874944c7909f71f7f236cd77a4cb1d6111c38f6
git diff --stat             # → 空
```

**基线结论**：本地 HEAD 与远程 `origin/main` **完全一致**，均为 `f874944`。本报告以 `f874944` 为审计基线。

**工作区未提交内容（已记录，全程未触碰）**：

| 路径 | 状态 | 说明 |
|---|---|---|
| `docs/优化.md` | 未跟踪 | 本次审计的任务书，由用户放置 |
| `docs/修复.md` | 未跟踪 | 上一轮整改任务书，由用户放置 |

无任何已跟踪文件被修改（`git diff --stat` 为空）。本次审计**未执行** `git commit` / `push` / `reset` / `checkout` / `stash`，**未修改**任何业务代码、配置文件、依赖文件或数据库结构，**未自动格式化**，**未自动修复**任何 Lint / TypeScript / Rust 问题，**未删除或覆盖**任何用户文件。

### 0.2 审计环境

| 项 | 值 |
|---|---|
| 操作系统 | macOS 14 (Darwin 24.6.0), arm64 |
| Node | v20 |
| pnpm | 10.x |
| rustc / clippy | **1.99.1** |
| Rust 依赖树要求 | edition2024 → Rust ≥ 1.85（`rust-toolchain.toml` 注释所述） |

### 0.3 取证限制（必须声明，不得推测）

以下限制直接影响本报告的结论强度，全部如实标注，**没有任何一处用推测代替证据**：

1. **CI 日志正文不可读。** `GET /actions/jobs/{id}/logs` 与 `GET /actions/runs/{id}/logs` 对公开仓库的未认证请求均返回 **HTTP 403 `Must have admin rights to Repository.`**。因此 § 4 中 CI 的失败步骤**结论**（step-level `conclusion`）是真实 API 输出，但**失败的具体文本不可读**。第 3 节 SEC/CFG-01 的根因因此被标注为**强假设（有对照实验支撑，日志未证）**，而非既成事实。
2. **没有第二台真实设备。** 全部双设备 GUI 验收用例状态为 `NOT_RUN`，实际结果列留空。**没有任何一条标记 PASS。**
3. **没有任何 Provider 凭据。** 8 条 live Provider 测试被 `describe.skipIf` 跳过，状态为 `NOT_RUN`，**未计入通过数**。
4. **未运行打包后的桌面应用。** 本次只完成了 Tauri **生产编译**（`--no-bundle`），没有启动 `.app`，因此「打包应用重启后数据恢复」「首次启动引导」「Keychain 交互授权」等均未验证。
5. **未运行 `cargo audit`。** 网络取不到 RustSec  advisory-db，**未扫成 = `NOT_RUN`，不是「干净」**。CI 的 `cargo audit` 步骤**成功**（即命令成功执行且未发现问题），但这只代表 RUSTSEC advisory-db 在 CI 时刻可获取且无匹配项，本地复现失败。
6. **Rust 侧零平台 `cfg`。** `apps/desktop/src-tauri/src/` 全部源码**没有任何** `#[cfg(target_os = ...)]` 分支，因此本地 macOS 通过的检查不能代表 Linux/Windows 的 Rust 行为一定相同。
7. **本报告未评估** LLM 输出质量、Prompt 效果、UX 美观度、性能与内存占用——这些都需要真实环境与人工判断，超出本次只读审计的取证能力。

---

## 1. 执行摘要

Kindora 目前是一个**代码完成度很高、但真实环境验证几乎为零**的 V0.1 LAN Alpha 候选。本次审计在基线 `f874944` 上真实执行了 11 组验证命令：TypeScript 1035 个测试全部通过、8 个 live Provider 测试**被跳过**（非通过）、Rust 48 个测试全部通过、Typecheck / ESLint / Clippy / `cargo fmt` 全部 EXIT=0、macOS Tauri 生产构建成功。唯一失败项是 `pnpm format:check`，且**仅由未跟踪的 `docs/优化.md` 引起**，被 Git 跟踪的代码树 Prettier 干净。

核心业务链路（创建 Agent → LAN 发现 → TCP 连接 → 身份校验 → Consent → Profile 交换 → 匹配 → 破冰 → 聊天 → 持久化）在代码层**全部存在且有自动化测试**，13 个 GUI 页面全部接线。

但存在三个必须诚实标注的缺口：

1. **Rust 侧 `agent_sign` 完全不存在**，私钥每次加载都被读回 webview、在 JavaScript 里签名——安全体系的核心缺口，Keychain 接入**不等于**密钥安全完成。进一步地，**Tauri 的 ACL 不约束应用自定义命令**（`capabilities/default.json` 未定义 app manifest），因此一次 webview XSS 可同时取走**身份私钥、LLM API Key 与整个本地数据库**（SEC-03）。
2. **真实 SQLite 从未执行过**：168 个 storage 测试跑的是 `FakeSql` / 内存库；打包应用重启后的数据恢复**从未验证**。
3. **CI 从未通过**：15 次 main 运行**全部失败**，且 **Rust 的 5 个测试门在全部 15 次运行中一次都没有执行过**（永远 skipped）。

WebRTC 是显式 `STUB`，**不构成 LAN Alpha 阻塞项**。

**结论：不建议发布面向普通用户的 macOS Alpha**；可发布**面向开发者的预览版本**（前提是先修好 CI 与文档）。详见第 6 节。

---

## 2. 功能状态总表

状态词表严格限定为：`NOT_IMPLEMENTED` / `STUB` / `IMPLEMENTED` / `TESTED` / `VERIFIED` / `BLOCKED` / `NOT_RUN`。
**本报告中没有任何一个功能被标记为 `VERIFIED`** —— 因为不存在满足该状态定义（已通过对应真实环境和完整验收标准）的证据。

### 2.1 Agent

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| 创建 / 编辑 Agent | `TESTED` | `apps/desktop/src/lib/agent-service.ts:105` | desktop 151 通过 | 未在打包 App 中人工验证 |
| Profile 持久化 | `TESTED` | `packages/storage/src/profile-store.ts`、`sqlite-database.ts` | storage 168 通过 | 真实 SQLite 未执行 |
| 私钥写入 OS Keychain | `IMPLEMENTED` | `apps/desktop/src-tauri/src/secrets.rs:233` | 无 Rust 集成测试 | 未在真实 macOS Keychain 上交互验证（需用户授权弹窗） |
| 私钥读回 webview | `IMPLEMENTED` | `secrets.rs:250` → `tauri-agent-keychain.ts:131` → `agent-service.ts:203` | — | **这是缺口，不是功能**（见 SEC-01） |
| **Rust 侧 `agent_sign`** | **`NOT_IMPLEMENTED`** | **Rust crate 内零命中** | 无 | — |
| 前端 WebCrypto 签名 | `TESTED` | `packages/protocol/src/signature.ts` | protocol 215（含 signature 17） | 仅单元测试 |
| 浏览器 dev 回退（私钥入 localStorage） | `IMPLEMENTED` | `agent-service.ts:146-155` | — | dev-only，路径已自我标注降级 |

### 2.2 Protocol

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| KSA 0.1 Schema 与校验 | `TESTED` | `packages/protocol/src/envelope.ts`、`validation.ts` | protocol 215 | — |
| ES256 签名（canonical 覆盖） | `TESTED` | `signature.ts:102-173` | signature 17 | 两台真实设备从未互相验签 |
| RFC 8785 JCS | `TESTED` | `canonical-json.ts` | canonical-json 17 | — |
| 重放保护 | `TESTED` | `replay-protection.ts` | replay-protection 测试 | **进程内内存去重，重启后失效**（session 为临时态，影响有限） |
| TOFU keyId 绑定 | `TESTED` | `pairing-session.ts:869-909` | transport 211 | 未跨机验证 |

### 2.3 Transport

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| UDP 广播发现 | `IMPLEMENTED` | `apps/desktop/src-tauri/src/lan.rs:334-440`（`udp_*`） | Rust lib 13 + lan_e2e 18 | **未跨机验证**（同机 loopback） |
| TCP 连接（host / join） | `IMPLEMENTED` | `lan.rs` `join_connect` / `host_accept` | lan_e2e 18、lan_protocol_e2e 13 | **未跨机验证** |
| 帧长度上限 1 MiB | `TESTED` | `lan.rs:58`、`lan.rs:1340` | lan_limits `oversized_frame_is_rejected_and_drops_the_link` | — |
| 队列上限 256 条 / 4 MiB | `TESTED` | `lan.rs:65,71` | lan_limits + lib `enqueue_is_bounded_*` | — |
| 速率限制 50 msg/s | `TESTED` | `lan.rs:83`、`lan.rs:1357` | lan_limits `flooding_past_the_rate_limit_drops_the_link` | — |
| 连接数上限 1 | `TESTED` | `lan.rs:91`、`lan.rs:1040` | lan_limits `host_accepts_a_new_peer_after_the_first_one_leaves` | — |
| 断线清理 | `TESTED` | `lan.rs` `PeerCloseGuard` | lib 13 + lan_protocol_e2e 13 | — |
| 断线后重连 | `TESTED` | `packages/transport/src/connection-state.ts:56`、`lan-connect-service.ts:185` | lan_protocol_e2e `two_instance_reconnect_after_tcp_drop` | — |
| **WebRTC** | **`STUB`** | `packages/transport/src/webrtc-transport.ts:115-130` | webrtc-transport 测试 | 四个连接入口**全部**抛 `WEBRTC_NOT_IMPLEMENTED`，**没有任何路径能让 `connect()` 成功 resolve** |

### 2.4 Security

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| ECDH P-256 + HKDF-SHA256 + AES-256-GCM | `IMPLEMENTED` | `packages/transport/src/` 会话密钥协商 | transport 211 | 两台真实设备**从未握手**，会话加密未在真实链路验证 |
| 敏感字段守卫 | `TESTED` | `packages/protocol/src/sensitive-field-guard.ts` | 30 通过 | 误报率约 1/100000（SECURITY.md §5 自述） |
| Prompt Injection 消毒 | `TESTED` | `packages/protocol/src/prompt-injection-guard.ts` | 57 通过 | 启发式，非证明 |
| Profile 出站隐私过滤 | `TESTED` | `packages/protocol/src/profile-privacy-filter.ts` | 26 通过 | — |
| **私钥边界（Rust 原生签名）** | **`NOT_IMPLEMENTED`** | 见 SEC-01 | 无 | **明确安全缺口** |
| **IPC 权限边界（app 命令不受 ACL 约束）** | **`NOT_IMPLEMENTED`** | `capabilities/default.json`（无 app manifest）、`lib.rs:183-203` | 无 | **webview XSS 可同时取走私钥 / API Key / 业务库**（SEC-03） |
| 传输层 TLS | `NOT_IMPLEMENTED` | — | — | 仅 payload 加密，header 明文（SECURITY.md §3） |

### 2.5 Matching / Consent / Icebreaker / Chat

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| 匹配分析（LLM） | `IMPLEMENTED` | `packages/agent/src/` `analyzeMatch` | agent 148 | 真实 Provider 未验证 |
| 匹配结果展示（5 字段） | `TESTED` | `apps/desktop/src/views/MatchView.tsx` | MatchView 测试 | 未双机验证 |
| 人类同意 / 拒绝 | `IMPLEMENTED` | `packages/matching/src/orchestrator.ts`（`MatchOrchestrator`）、`views/ConsentView.tsx` | matching 86 | 未双机验证 |
| 撤销授权 | `IMPLEMENTED` | `profile-privacy-filter.ts`（仅出站生效） | protocol 26 | — |
| 黑名单拦截 | `IMPLEMENTED` | `packages/storage/src/blocked-agents-store.ts`、`views/BlockedAgentsView.tsx` | storage + desktop | 未双机验证 |
| 破冰生成 | `IMPLEMENTED` | `packages/agent/src/generate-icebreaker.ts` + `App.tsx:293` | agent 148 | **失败被静默吞掉**（见 UI-03） |
| 聊天发送 / 状态机 | `IMPLEMENTED` | `packages/matching/src/chat-orchestrator.ts` | matching 86 | 未双机验证 |
| 聊天持久化（PENDING/FAILED） | `IMPLEMENTED` | `packages/storage/src/chat-repository.ts` | storage 168（Mock） | 真实 SQLite 未执行 |
| **重启后恢复未完成消息** | **`NOT_RUN`** | `apps/desktop/src/lib/chat-persistence.ts:93` | 无 | **从未验证** |

### 2.6 Storage（SQLite 四态严格区分）

| 状态维度 | 结论 | 证据 |
|---|---|---|
| ① 数据库代码存在 | **是** | `packages/storage/src/sqlite-database.ts`（`SqliteKindoraDatabase`）、`apps/desktop/src/lib/tauri-sql-executor.ts`（`TauriSqlExecutor` → `plugin:sql`）、`Cargo.toml:27` `tauri-plugin-sql = { features = ["sqlite"] }`、6 张业务表 + `schema_migrations` 记账表（`sql-migrations.ts`） |
| ② 自动化 Mock 测试通过 | **是** | storage 168 通过；迁移测试使用 `packages/storage/src/__tests__/sql-migrator.test.ts:40` 的 `class FakeSql implements SqlExecutor` |
| ③ **真实 SQLite 执行成功** | **否 —— 从未发生** | 全仓库 `packages/` 与 `apps/` 测试中**零处**引用 `better-sqlite3` / `node:sqlite` / `sql.js` / `:memory:` 引擎；真实 SQLite 只在打包 Tauri 进程内由 `tauri-plugin-sql` 承载，而打包 App 本次**未运行** |
| ④ **打包应用重启后数据恢复成功** | **否 —— 从未发生** | 本次只做了 `tauri build --no-bundle`（EXIT=0），未启动 `.app`；重启恢复路径**无任何自动化覆盖** |

> **四种状态不可混为一谈。** 仓库目前站在 ①②，尚未触碰 ③④。

补充事实：
- **迁移版本管理存在且幂等**（`sql-migrator.ts` + `schema_migrations` 表），由 `apps/desktop/src/lib/database.ts:126` `runMigrations(serial)` 在启动时执行。
- **桌面 App 不再用 localStorage 存关键数据**：`database.ts` 选择 Tauri SQLite；localStorage 仅是浏览器 dev server 回退（`packages/storage/src/browser-store.ts`）。旧数据迁移由 `migrateLegacyLocalStorage` 在**写库成功之后**才删旧副本。
- **`packages/storage/package.json` 依赖只有 `@kindora/protocol`** —— 没有 SQLite 引擎依赖，因为 SQL 由 `SqlExecutor` 端口下发，引擎在 Rust 侧。这不是缺陷，但意味着**该包的 168 个测试永远无法触达真实 SQL 语义**。

### 2.7 LLM Provider

| Provider | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| OpenAI-compatible | `IMPLEMENTED` | `packages/llm/src/providers/openai-compatible.ts` | llm 56 通过 | **真实 API `NOT_RUN`** |
| Anthropic | `IMPLEMENTED` | `packages/llm/src/providers/anthropic.ts` | llm 56 通过 | **真实 API `NOT_RUN`** |
| Ollama | `IMPLEMENTED` | `packages/llm/src/providers/ollama.ts` | llm 56 通过 | **真实 API `NOT_RUN`**；且默认端点被 CSP 阻断（见 LLM-01） |
| MiniMax | `IMPLEMENTED` | 复用 openai-compatible，base `https://api.minimaxi.com/v1`（`llm-service.ts:330`） | llm 56 通过 | **真实 API `NOT_RUN`** |
| 超时 / 取消 / 有限退避 | `TESTED` | `packages/llm/src/http.ts:159-244` | provider-errors 36 | — |
| 统一错误模型 | `TESTED` | `packages/llm/src/errors.ts` | llm 56 | — |
| 流式输出 | `NOT_IMPLEMENTED` | 三个 provider 均 `stream: false` | — | 项目**未声称**支持流式，不算缺口 |
| JSON 格式输出 | `IMPLEMENTED` | provider 响应解析 | agent 148（Mock LLM） | 真实模型返回的 JSON 合规性未验证 |
| Token / 上下文上限 | `NOT_IMPLEMENTED` | 无相关代码 | — | 真实长上下文行为未知 |
| Provider 配置持久化 | `TESTED` | `llm-service.ts` + `settings-store.ts` | desktop + storage | — |
| **live Provider 测试** | **`NOT_RUN`** | `packages/llm/src/__tests__/providers.live.test.ts`（8 条） | 全部 `skipIf` **跳过** | 无凭据；文件头明确声明真实 429 与真实超时**不在**覆盖范围内 |

### 2.8 GUI

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| 页面与导航（13 个 view） | `IMPLEMENTED` | `apps/desktop/src/views/`、`App.tsx:61-95` | desktop 151 | **未在打包 App 中人工点过一遍** |
| 完整业务链路接线 | `IMPLEMENTED` | `App.tsx:188-341` | desktop 151 | 未双机验证 |
| 错误提示（部分） | `IMPLEMENTED` | keychain-error / database-error 视图 | desktop 151 | — |
| **React 错误边界** | **`NOT_IMPLEMENTED`** | 全仓库零命中 | 无 | 渲染期异常会白屏 |
| 破冰失败反馈 | **`NOT_IMPLEMENTED`** | `App.tsx:304` `.catch(() => {})` | — | **用户看不到失败原因** |
| 持久化失败反馈 | **`NOT_IMPLEMENTED`** | `chat-orchestrator.ts:420` 仅 `console.error` | — | **消息可能丢失而无提示** |

### 2.9 Packaging

| 功能点 | 状态 | 代码位置 | 测试证据 | 真实验证情况 |
|---|---|---|---|---|
| Tauri 生产编译 | `TESTED` | `apps/desktop/src-tauri/tauri.conf.json` | 本次 macOS `tauri build --no-bundle` **EXIT=0**，产出 `target/release/kindora-desktop` | CI 的 `Tauri build check` job（Linux）也成功 |
| 跨平台可编译性 | `IMPLEMENTED` | Rust 源零平台 `cfg` | CI Linux 构建成功 | Windows / macOS 未在 CI 验证 |
| **macOS 安装包（.dmg）** | **`NOT_IMPLEMENTED`** | `bundle.targets = "all"`，但本次用 `--no-bundle` | 无 | 仓库**无任何发布产物** |
| **代码签名 / 公证 / entitlements** | **`NOT_IMPLEMENTED`** | `tauri.conf.json` **无 `bundle.macOS` 块** | 无 | 未签名 App 在现代 macOS 上会被 Gatekeeper 拦截 |
| `minimumSystemVersion` | `NOT_IMPLEMENTED` | 同上 | 无 | — |
| Bundle identifier 合法性 | `IMPLEMENTED`（**有隐患**） | `identifier = "com.kindora.app"` | 本次构建 Tauri 主动警告：标识符以 `.app` 结尾与 macOS bundle 扩展名冲突 | 建议改为 `com.kindora.desktop` 之类 |

### 2.10 任务书 §4A 逐题回答（Agent 身份与密钥安全）

> 任务书 §4A 要求回答 7 个问题，并特别检查 `agent_sign` 是否已在 Rust 侧实现。逐题回答如下，答案均来自本次实际读码，证据位置已给出。

**Q1 —— Agent 私钥是否真正存储在系统 Keychain？**

**静态存储：是；运行时使用：否（私钥会被取回 webview）。**
私钥通过 `secrets.rs:233` `agent_key_store` → `keyring::Entry::set_password` 写入 OS Keychain（service 名 `com.kindora.app`，见 `secrets.rs:14`）。持久化的 Agent 记录里**只有** `{ kind: 'keychain', keyId }`，**不含私钥本体**（`agent-service.ts:138`；`sqlite-database.ts` 的 `saveAgent` 也会剥离 `privateKey`）。因此**静态存储是安全的**。
但 `agent-service.ts:203` 在每次加载时执行 `const privateKey = await keychain.load()`，把私钥读回 JS 内存 —— **运行时并未留在 Keychain 进程内**。

**Q2 —— 前端能否读取原始私钥？**

**能。** `secrets.rs:250` `agent_key_get` 返回 `Ok(Some(value))`（base64 PKCS#8 明文），经 `tauri-agent-keychain.ts:131` `invoke('agent_key_get')` 进入 webview。该命令**不受 Tauri capability 约束**（项目无 app 级 ACL manifest，见 SEC-03），因此任何本地 webview 代码都能取到。

**Q3 —— 签名是否在 Rust 原生层完成？**

**否。** `grep -rn "agent_sign" apps/desktop/src-tauri/` → **零命中**；前端也零命中（前端根本不调用这个不存在的命令）。实际签名在 webview 的 JavaScript 中完成：`agent-service.ts:210` `assertKeyMatchesPublicKey(privateKey, stored.publicKey)` 把私钥导入 WebCrypto → `connect-service.ts:735-751` `buildSigner()` → `createEnvelopeSigner` → `globalThis.crypto.subtle.sign`。**因此 `agent_sign` 判定为 `NOT_IMPLEMENTED`，这是一个明确的安全缺口，不能因为 Keychain 已接入就判定密钥安全体系完成。**

**Q4 —— 是否存在私钥通过 IPC、日志、错误信息或其他路径泄漏的可能？**

分四条路径分别核查：

| 泄漏路径 | 结论 | 证据 |
|---|---|---|
| **IPC** | **存在泄漏** | `agent_key_get` 通过 `invoke` 把私钥明文送进 webview（`secrets.rs:250` → `tauri-agent-keychain.ts:131`）。这是**当前最主要的泄漏路径**。 |
| **Rust 日志** | **未发现泄漏** | `apps/desktop/src-tauri/src/` 中没有任何 `log!` / `println!` / `eprintln!` / `dbg!` 输出包含 key / secret / value / private 的语句（grep 零命中）。 |
| **错误信息 / 错误类型** | **未发现泄漏** | `secrets.rs:140-215` 的 `AgentKeyError` / `SecretError` 只携带**分类字符串**（`keychain_locked`、`keychain_denied`、`keychain_unavailable`、`invalid_key`、`keyring`）与 keyring 后端的原始消息，**不携带密钥值**。 |
| **前端 console / 持久化** | **未发现泄漏** | `agent-service.ts` / `agent-keychain-migration.ts` / `tauri-agent-keychain.ts` 中唯一的 console 调用是 `agent-service.ts:264` 的迁移告警（打印 `report.error`，不含密钥）。持久化侧：生产路径下 `privateKey` **不进** localStorage、不进数据库。 |

**另一条已知的降级路径**：`agent-service.ts:153-154` —— 浏览器 dev server（`pnpm dev`，无 Tauri 运行时）下 `privateKeyStorage.kind === 'dev-localstorage'`，私钥以**明文**存放在 localStorage。代码与 `SECURITY.md` §2 已自我标注这是 dev-only 降级。

**Q5 —— 公钥指纹是否与实际连接身份绑定？**

**是。** 配对指纹 `derivePairingFingerprint` = `sha256(agentId ‖ spkiDer)`（`packages/transport/src/pairing-fingerprint.ts:55`），同时绑定 **agentId 与公钥**；`keyId` = `sha256(spki)`（`packages/protocol/src/crypto.ts:142`），也由同一把公钥导出。`pairing-session.ts:891-897` 在握手时**重算**期望 `keyId` 并与对端签名中的 `keyId` 比对，不符即拒（TOFU）。因此指纹与实际连接身份是绑定的。

**Q6 —— 签名验证是否覆盖正确的消息内容？**

**是。** `packages/protocol/src/signature.ts:102-113` 的签名输入包含：payload 的 **RFC 8785 规范化摘要** + `sender` + `messageType` + `timestamp` + `messageId` + **`recipient`**。因此：payload 任一字节被改 → 摘要变；消息被挪给另一个接收方 → `recipient` 不符（防止签名被「搬运」到另一场配对中重放）。17 个 signature 单元测试覆盖。

**Q7 —— 是否存在身份替换或重放攻击风险？**

| 风险 | 现状 | 残余风险 |
|---|---|---|
| **身份替换（冒名）** | 已缓解：每个信封都有 ES256 签名；`keyId` 变化即拒绝（TOFU）；配对码由 host 公钥导出。 | 重新配对是恢复手段 —— 意味着**攻击者若能诱导用户重新配对，就能换身份**。`SECURITY.md` §4 已如实记载。 |
| **重放（同一 session 内）** | 已缓解：`packages/protocol/src/replay-protection.ts` 的 `ReplayGuard` 按 `messageId` 去重 + 时间窗（默认最大 5 分钟、未来容差 30 秒）+ 有界容量 1024。 | `ReplayGuard` 是**进程内内存**状态，**应用重启后清零**。但会话密钥每次重连都重新协商（ECDH 临时密钥），旧密文解不开，因此实际风险有限。 |
| **跨 session 重放** | 已缓解：会话密钥每次重新协商；签名绑定 `recipient`；配对码是稳定标识符而非一次性密钥（`SECURITY.md` §4 的已知限制）。 | 配对码可被观察后重放 —— 需要攻击者同时「赢得」呈现匹配密钥的竞速。 |
| **签名验证只在 JS 侧** | 已知限制（`SECURITY.md` §7）：Rust 侧从不解析信封，因此 JCS 目前无需两侧一致；将来 Rust 一旦解析，必须实现**同一个** JCS，并注意 WebCrypto 输出 **P1363** 而 `p256` 默认输出 **DER**。 | 属于「未来实现时的陷阱」，不是当前漏洞。 |


---

## 3. 关键代码问题

严重程度定义：**P0** = 影响核心流程 / 安全 / 真实可用性；**P1** = 影响稳定性与外部体验；**P2** = 体验优化与未来功能。

---

### SEC-01 —— Rust 侧 `agent_sign` 完全不存在，私钥穿越 Rust→JS 边界 【P0 / 安全缺口】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/src/secrets.rs`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/lib/tauri-agent-keychain.ts`、`apps/desktop/src/lib/agent-service.ts`、`apps/desktop/src/lib/connect-service.ts`、`apps/desktop/src/lib/lan-connect-service.ts` |
| **代码位置** | `secrets.rs:233-295`（`agent_key_store` / `agent_key_get` / `agent_key_exists` / `agent_key_delete`）；`lib.rs:152-168`（4 个 `#[tauri::command]`）、`lib.rs:199-202`（注册进 `invoke_handler`）；`tauri-agent-keychain.ts:129-133`；`agent-service.ts:203-211`；`connect-service.ts:732-751`（`buildSigner`）；`lan-connect-service.ts:800-802` |
| **具体问题** | Rust 侧只提供「取回 / 存入 / 判断存在 / 删除」四把钥匙，**没有 `agent_sign` 命令**。`grep -rn "agent_sign" apps/desktop/src-tauri/` → **零命中**；前端也**零命中**（前端根本不调用一个不存在的命令）。签名实际发生在 **webview 的 JavaScript** 里：`agent-service.ts:203` `const privateKey = await keychain.load()` 把 base64 PKCS#8 私钥取回 JS 内存 → `agent-service.ts:210` `assertKeyMatchesPublicKey(privateKey, stored.publicKey)` 导入 WebCrypto → `connect-service.ts:735-751` `buildSigner()` 把 `agent.privateKey` 明文字符串交给 `createEnvelopeSigner` → 私钥在 webview 中以明文存在，签名由 `globalThis.crypto.subtle` 完成。 |
| **影响** | 任何在 webview 内取得代码执行能力的攻击者（例如渲染远端 Profile 字段时的 XSS）都能通过 `invoke('agent_key_get')` 直接取走**长期身份私钥**，从而**冒充用户身份**签名任意信封。`buildSigner()` 还用 `catch { return null; }` 吞掉导入失败——签名不可用时会**静默降级为未签名会话**（`connect-service.ts:749-751`）。 |
| **证据** | `grep -rn "agent_sign" apps/desktop/src-tauri/` → 零命中；`secrets.rs:250-266` `agent_key_get` 直接 `Ok(Some(value))` 返回明文；`lib.rs:199-202` 的 `invoke_handler` 列表中只有 4 个 `agent_key_*`，无 `agent_sign`；`SECURITY.md`「Known security limitations」**第 1 条**已如实记载此项，并推荐用 `p256` crate 在 Rust 侧实现 `agent_sign`。 |
| **推荐解决方案** | 在 Rust 侧新增 `#[tauri::command] async fn agent_sign(payload: String) -> Result<String, AgentKeyError>`：用 `p256` crate 的 `SigningKey` 从 Keychain 取出私钥、对 canonical 输入做 ECDSA-P256-SHA256、返回 **P1363（raw r‖s）** 格式以与 WebCrypto 对齐；前端 `buildSigner()` 改为调用该命令，`agent_key_get` 降级为仅在密钥生成/迁移时使用。**注意 `SECURITY.md` §7 已经预警的 P1363 / DER 编码陷阱。** |
| **备注** | **Keychain 已经接入 ≠ 密钥安全体系完成。** 私钥在**静态存储**上是安全的（`agent-service.ts:138` 持久化的记录只有 `{ kind: 'keychain', keyId }`，不含私钥；`sqlite-database.ts` 的 `saveAgent` 也会剥离 `privateKey`），但在**使用边界**上并未闭合。 |

---

### SEC-03 —— webview 的一次 XSS 可以同时拿走私钥、API Key 和整个本地数据库（Tauri ACL 未约束应用自定义命令）【P0】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/capabilities/default.json`、`apps/desktop/src-tauri/src/lib.rs`（`invoke_handler` 注册表 L183-203）、`apps/desktop/src-tauri/src/secrets.rs`（L67-99）、`apps/desktop/src/lib/tauri-secret-store.ts`（L32-40）、`apps/desktop/src/lib/llm-service.ts`（L22） |
| **代码位置** | `capabilities/default.json` 的 `permissions` 列表；`lib.rs:183-203` 注册的全部 **19** 个应用自定义命令；`secrets.rs:77` `secret_get`；`tauri-secret-store.ts:32` `invoke('secret_get', { key })` |
| **具体问题** | Tauri's IPC 授权逻辑在 `tauri-2.12.3/src/webview/mod.rs:2080`：<br>`if (plugin_command.is_some() \|\| has_app_acl_manifest \|\| !is_local) && … && invoke.acl.is_none() { reject }`<br>对本项目：① `agent_key_get` 等命令**不带 `plugin:` 前缀** → 第一项为 false；② 项目**没有 app 级 ACL manifest**（`apps/desktop/src-tauri/permissions/` 目录不存在，`build.rs` 也未声明 `app_manifest`）→ `has_app_acl_manifest` 为 **false**；③ 主窗口加载的是本地 `frontendDist` → `is_local` 为 **true**，`!is_local` 为 false。<br>**三项全为 false → 该拒绝分支整体不成立 → 应用自定义命令不受 capability 约束，任何本地 webview 都可以直接调用。** `capabilities/default.json` 只列了插件权限（`core:default`、`store:default`、`sql:default` + `sql:allow-load/execute/select/close`），**对 `agent_key_*` / `secret_*` 一个字都没写**——不是「没授权所以禁止」，而是「app 命令根本不经过 ACL」。<br>与此同时，`sql:allow-execute` / `sql:allow-select` **已授权**给主窗口，等于给了 webview 对业务库的任意 SQL 读写。 |
| **影响** | **一次 webview XSS 的爆炸半径是全部三样东西**：<br>① `invoke('agent_key_get')` → **长期身份私钥明文**（SEC-01）；<br>② `invoke('secret_get', { key: 'llm:openai:api-key' })` → **LLM API Key**。key 空间是可预测的（`llm-service.ts:22` `secretKeyFor = (provider) => \`llm:${provider}:api-key\``，provider ∈ openai / anthropic / ollama / minimax），`secret_list()` 虽然返回空数组（`secrets.rs:99`，keyring 3.x 无可移植枚举 API），但**攻击者只需猜 4 个固定字符串**；<br>③ `plugin:sql\|execute` → **整个业务库**（Agent、Profile、聊天记录、黑名单）可读可改可删。<br>产品定位是「Local-first、隐私优先」，而当前架构下 webview 一次 XSS 就同时拿到身份、凭据与数据。 |
| **证据** | `capabilities/default.json` 原文见上；`apps/desktop/src-tauri/permissions/` 目录**不存在**；`build.rs` 无 `app_manifest` 声明；Tauri 授权分支源码 `tauri-2.12.3/src/webview/mod.rs:2080`；`secrets.rs:77` `secret_get` 只做 key 字符集校验（`validate_key`，允许 ASCII 字母数字与 `: - _ .`）后原样返回 Keychain 内容；`llm-service.ts:22` 的 key 命名规则。 |
| **推荐解决方案** | ① **先做 SEC-01**（Rust 侧 `agent_sign`），从根上拿掉 ①；② 给 `secret_get` 加**最小权限**——只允许读取当前已配置 provider 的那一个 key（前端传 provider，Rust 端拼 key 名并校验白名单），或干脆改成 **Rust 侧直接发起 LLM 请求、不回传 API Key**；③ 引入 **app 级 ACL manifest**（`permissions/` 目录 + `build.rs` 的 `app_manifest`），把应用自定义命令纳入 capability 体系，这样 `agent_key_*` / `secret_*` 才能被逐条开关；④ 收紧 `sql:allow-execute` / `sql:allow-select`——若可行，改用参数化的**具名查询**（`sql:allow-execute` 是任意 SQL）而不是全量放行；⑤ 在 CSP 中保留 `script-src 'self'`（现有配置**已经**是正确的——`script-src 'self'` 且无 `unsafe-inline`/`unsafe-eval`，这一点做得对，要保持）。 |
| **备注** | 这条**不是**在指责当前实现「有洞」——它是一个**尚未被触发**的架构风险，且与 SEC-01 高度重叠（SEC-01 修好后 ① 消失，但 ② ③ 仍在）。**本条与 SEC-01 应作为同一个 P0 组合处理。** |


---

### CFG-01 —— CI 的 Rust 测试门在全部 15 次 main 运行中一次都没有执行过 【P0】

| 项 | 内容 |
|---|---|
| **文件路径** | `.github/workflows/ci.yml` |
| **代码位置** | `build` job（L83-218）vs `tauri-build` job（L220-291）；`Install dependencies`（约 L124，仅 `pnpm install --frozen-lockfile`）vs `Install Tauri Linux prerequisites`（L256-269） |
| **具体问题** | `Build & test` job 跑 `cargo clippy --all-targets --all-features -- -D warnings`，但**没有任何 apt-get 步骤**安装 Tauri 的 Linux 系统依赖（`libwebkit2gtk-4.1-dev` / `libjavascriptcoregtk-4.1-dev` / `libsoup-3.0-dev` / `libglib2.0-dev`）。而 `tauri-build` job **有**这一步，因此同一镜像上能成功编译同一个 crate。两者构成受控对照。 |
| **影响** | ① 最新一次运行在 **Rust Clippy** 步失败（exit 101），其后的 **Rust lib check / Rust unit tests / LAN e2e / LAN protocol e2e / LAN resource-limit / Format check 六步全部 `skipped`** → 这 6 个质量门在该次运行中**完全没有执行**。② **历史上 15 次 main 运行全部为 failure**，且 **Rust 的 5 个测试门在 15 次中一次都没有执行过**（永远 `skipped`）。③ 结论：**Rust 测试门在本仓库 CI 历史中从未跑过一次**，「CI 绿」在本项目上从来不存在。 |
| **证据（真实 API 输出）** | 运行 `42228916649`（`f874944`，2026-11-06）的 `Build & test` 步骤级结论：step 8 Typecheck=success、9 Lint=success、10 Build=success、11 Test=success、12 Rust format check=success、**13 Rust Clippy=failure**、14-19 全部 skipped、20-21 skipped、22-23 success。`Tauri build check`（同一 run）**success**，其 step 7 正是 `Install Tauri Linux prerequisites`。全部 15 次 main 运行结论均为 `failure`；12 次卡在 `Setup pnpm`（pnpm 版本钉死问题，已由 `e948606` 修复）、2 次卡在 `Test`、最新一次卡在 `Rust Clippy`。**Rust unit tests / Rust lib check / LAN e2e / LAN protocol e2e / LAN resource-limit 在 15 次中结论均为 `skipped`。** |
| **根因假设（**强假设，日志未证**）** | `tauri 2.12.3` 的默认 feature 集合含 `wry` → `webkit2gtk 2.0.2` + `javascriptcore-rs 1.1.2` + `soup3 0.5.0` + `glib 0.18.5`。这些 crate 的 `build.rs` 调用 `system_deps::Config::new().probe()`，在缺 `javascriptcoregtk-4.1` / `glib-2.0` / `libsoup-3.0` 时直接 `process::exit(1)`。`cargo metadata --filter-platform x86_64-unknown-linux-gnu` 已确认这 4 个包在 Linux 依赖图中。GitHub 的 `ubuntu-latest`（Ubuntu 24.04）镜像**只有 `pkg-config`，没有任何 webkit/gtk/soup 开发包**（已通过 `actions/runner-images` 仓库的 `Ubuntu2404-Readme.md` 核实）。**因为日志正文返回 HTTP 403，这一步无法用日志直接证实，只能由上述对照实验与依赖图推断。** |
| **推荐解决方案** | 把 `Install Tauri Linux prerequisites`（L256-269 的 apt-get 块）提取为**可复用步骤**，在 `build` job 的任何 `cargo` 步骤之前调用；或把 Rust 检查**整体迁到 `tauri-build` job**（该 job 已具备依赖且已证明可编译）。修好后应能第一次让 5 个 Rust 测试门真正进入 CI。 |

---

### SQL-01 —— 真实 SQLite 从未执行，持久化层只有 Mock 证据 【P0】

| 项 | 内容 |
|---|---|
| **文件路径** | `packages/storage/src/sqlite-database.ts`、`packages/storage/src/sql-migrator.ts`、`packages/storage/src/memory-database.ts`、`packages/storage/src/__tests__/sql-migrator.test.ts`、`apps/desktop/src/lib/tauri-sql-executor.ts` |
| **代码位置** | `sql-migrator.test.ts:40` `class FakeSql implements SqlExecutor`（唯一的执行器替身）；`tauri-sql-executor.ts`（`TauriSqlExecutor` → `plugin:sql\|load\|execute\|select`） |
| **具体问题** | storage 包的 168 个测试全部跑在内存实现或 `FakeSql` 上，**从未让一条 SQL 落进真实 SQLite 引擎**。`SqliteKindoraDatabase` 写的是 SQL 字符串，语义正确性依赖真实引擎。 |
| **影响** | 迁移语句的语法/幂等性、事务边界、字段类型映射、并发下的锁行为**都没有真实证据**。一条 `ALTER TABLE` 写错，168 个 Mock 测试**全部照绿**。 |
| **证据** | `grep -rn "better-sqlite3\|node:sqlite\|sql.js\|:memory:\|createConnection" packages/storage/src/__tests__ apps/desktop/src` → **零命中**。`packages/storage/package.json` 依赖仅 `@kindora/protocol` + typescript/vitest，**无任何 SQLite 引擎**。 |
| **推荐解决方案** | 在 CI 增加一个**真实 SQLite** 冒烟 job：用 `tauri-plugin-sql` 的 SQLite 在 Linux runner 上跑一遍 `runMigrations` → 建 Agent → 写 Profile → 写 Chat → 重开连接 → 读回，逐表比对。**在真实 SQLite 跑通之前，storage 的 168 个测试不应被当作持久化正确性的证据对外引用。** |

---

### SQL-02 —— 打包应用重启后的数据恢复从未验证 【P0】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src/lib/chat-persistence.ts`、`apps/desktop/src/lib/database.ts`、`apps/desktop/src-tauri/tauri.conf.json` |
| **代码位置** | `apps/desktop/src/lib/chat-persistence.ts:93`（`new ChatRepository({ database })`）；接线点 `apps/desktop/src/lib/connect-service.ts:566-570`（`database: () => getKindoraDatabase()`）；`database.ts:126`（`runMigrations(serial)`） |
| **具体问题** | PENDING → SENT / FAILED 的状态机、以及「重启后恢复未完成消息」的路径都只有 Mock 证据；打包后的 `.app` 本次**未运行**。 |
| **影响** | 任务书 §4C 第 ④ 态（打包应用重启后数据恢复成功）**从未发生**。用户最关心的「退出再打开还能看到聊天记录」在真实产品中**完全未知**。 |
| **证据** | 本次只执行了 `pnpm -C apps/desktop tauri build --no-bundle`（EXIT=0，产出 `target/release/kindora-desktop`），**没有启动该二进制**，也没有做任何「写数据 → 退出 → 重启 → 读回」。 |
| **推荐解决方案** | 写一个 `scripts/verify-restart.sh`：启动打包后的 App（`--no-bundle` 产物 + `tauri dev` 二选一），通过一个受控的 dev-only 入口写入 Agent + 3 条聊天消息，杀进程，重启，读回并比对。**这条与 SQL-01 可以合并为同一个 P0 任务。** |

---

### UI-01 —— 全仓库没有任何 React 错误边界 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src/App.tsx`、`apps/desktop/src/main.tsx` |
| **代码位置** | 根渲染处（`App.tsx` 末尾的 view switch / `main.tsx` 的 `createRoot(...).render(...)`） |
| **具体问题** | `grep -rn "ErrorBoundary\|componentDidCatch\|getDerivedStateFromError" apps/desktop/src packages/*/src` → **零命中**。 |
| **影响** | 任何渲染期异常（远端 Profile 字段触发的渲染崩溃、某个 view 的 `undefined` 访问）都会**白屏**，用户看不到任何原因，只能重启应用。配合 §2.6「关键数据已落库」的事实，用户甚至无法知道刚才的操作是否已生效。 |
| **推荐解决方案** | 新增 `apps/desktop/src/components/AppErrorBoundary.tsx`（`class` 组件，`getDerivedStateFromError` + `componentDidCatch`），在 `main.tsx` 最外层包裹；错误态显示可复制的技术摘要，并提供「复制诊断信息」按钮（**不得包含私钥 / API Key**）。 |

---

### UI-02 —— 持久化失败只写 `console.error`，用户完全无感 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `packages/matching/src/chat-orchestrator.ts` |
| **代码位置** | `chat-orchestrator.ts:412-421` `reportPersistenceFailure()`；调用点覆盖 `recordPending` / `recordSent` / `recordFailed` / 等全部落库动作 |
| **具体问题** | 函数体只有 `console.error(\`Kindora: could not ${what}.\`, err);`。注释明确写「A storage failure must not stop the conversation」——这个取舍在**发送路径**上是对的，但**在「先存 PENDING 再发送」这个顺序上会造成消息静默丢失**：PENDING 写失败 → 消息仍被发出 → 发送结果也写不进去 → 用户与对方都看不到这条消息，而界面上**没有任何提示**。 |
| **影响** | 磁盘满 / SQLite 锁 / 迁移失败等真实故障下，用户会认为消息已送达，实际已丢失。 |
| **推荐解决方案** | 保留「不阻断发送」的取舍，但把失败**上报到 UI**：新增 `onPersistenceWarning` 回调（或复用现有状态通道），在聊天视图顶部显示一条可关闭的告警条，写明「消息已发送但未能保存到本地」。同时在 `recordPending` 失败时**降级为不发送**（先保证本地有记录），因为丢失比延迟更难解释。 |

---

### UI-03 —— 破冰生成失败被静默吞掉，用户直接跳到空白聊天 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src/App.tsx` |
| **代码位置** | `App.tsx:293-317`，其中 **L304** 是 `.catch(() => { const chat = runChat(view.handle, view.consent, ''); setView({ kind: 'chat', ... }); })` |
| **具体问题** | `runIcebreaker()` 失败时，**error 对象被完全丢弃**（空 catch 回调），用户被直接送进一个没有破冰语的聊天界面，且**没有任何提示说「破冰生成失败」**。 |
| **影响** | 用户无法区分「系统判定不需要破冰」与「LLM 调用失败 / 未配置 API Key / 超时」两种完全不同的状态。这是最典型的「UI 假成功」路径——界面看起来正常，实际上功能没跑。 |
| **证据** | `App.tsx:304` 的 catch 回调不接收、不记录、不展示 error。 |
| **推荐解决方案** | `.catch((err) => { … })` 中把错误映射成用户可读文案（复用 `packages/llm/src/errors.ts` 的错误分类：未配置 Key / 超时 / HTTP 错误 / 解析失败），在聊天视图顶部显示一条非阻断提示「破冰生成失败：{原因}，你仍然可以直接聊天」。 |

---

### LLM-01 —— CSP 阻断 Ollama 默认端点，Ollama 在打包 App 中不可用 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src/lib/llm-service.ts`、`packages/llm/src/http.ts` |
| **代码位置** | `tauri.conf.json` → `app.security.csp`；`llm-service.ts:323` `defaultBaseUrl: 'http://localhost:11434'`；`http.ts:109`（默认传输策略）/ `http.ts:230`（实际调用 `globalThis.fetch`） |
| **具体问题** | LLM 传输层使用 `globalThis.fetch`，在打包 App 中运行于 **webview**，因此受 Tauri CSP 约束。现有 CSP 为：`connect-src 'self' ipc: http://ipc.localhost https://api.minimaxi.com https://api.openai.com https://api.anthropic.com https://*.anthropic.com https://*.openai.com;` —— **不含 `http://localhost:11434`**。 |
| **影响** | 用户在设置里选 Ollama 并保留默认 base URL 时，**所有请求都会被浏览器拒绝**，且报错信息是 CSP 拦截而非「Ollama 没启动」，用户与维护者都很难定位。 |
| **证据** | `tauri.conf.json` 的 `csp` 字段原文已列于 §2.7 之上；`llm-service.ts:323` 的默认值为 `http://localhost:11434`；`http.ts` 的传输为 `globalThis.fetch`（webview 上下文）。 |
| **推荐解决方案** | 二选一：① 在 CSP `connect-src` 中加入 `http://localhost:11434`（本地 Ollama 固定端口），并配 `http://127.0.0.1:11434`；② 更稳妥：让 Ollama 的 base URL 成为**用户可填的受控字段**，并在保存时校验 host 是否在允许列表内，同时把「自定义 base URL 需加入 CSP」写入开发者文档。**注意**：加 CSP 条目等于允许 webview 访问该主机，需评估这与「只允许 loopback」的取舍。 |

---

### LAN-01 —— `join_connect` 的竞态路径丢弃已 spawn 的任务与已连接的 socket 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/src/lan.rs` |
| **代码位置** | `join_connect`：`lan.rs:842-916`。关键顺序为 —— 先 `tokio::spawn` 读循环任务（**L875-887**）→ 构造 `TcpLink`（**L890-896**）→ **之后**才在 `g.join` 锁内做二次检查 `if g.join.is_some() { return Err(LanError::AlreadyRunning("join".into())); }`（**L908-911**） |
| **具体问题** | `join_connect` 有**两次**「是否已在 join 中」的判断：第一次在 `lan.rs:848-852`（在 `TcpStream::connect` 之前，正确），第二次在 `lan.rs:908-911`（**在连接 socket 并启动读循环之后**）。真正出问题的是第二次。二次检查失败时直接 `return Err`，此时：① 已 spawn 的读循环任务**没有被 abort，也没有被 join**（任务泄漏）；② 已建立的 TCP 连接被丢弃（对端看到一个刚建即断的连接）；③ 该 `TcpLink` 持有 `shutdown_tx`（`watch::Sender<bool>`），随 `link` 一起被 drop，而读循环那一侧持有的 `shutdown: watch::Receiver<bool>` 的 sender 此刻已消失 —— `tcp_read_loop`（**L1290-1322**）里的 `tokio::select!` 分支 `_ = shutdown.changed()` 在 sender 被 drop 后会**立即返回 `Err`**，而该分支的判断条件是 `if *shutdown.borrow()`（值为 `false`，因为从未 `send(true)`），于是走 `continue` → **select 立刻再次就绪 → 无限空转**（100% CPU 的忙循环），且该任务永不退出。 |
| **影响** | 竞态窗口很窄（需要两个 `join_connect` 近乎同时执行），但一旦触发：**CPU 空转 + 任务泄漏 + 对端看到幽灵连接**。在 macOS 上表现为应用「卡住但界面还在」。 |
| **证据** | `lan.rs:875-887`（`tokio::spawn`）与 `lan.rs:908-911`（二次检查与 `return Err`）的**先后顺序**；`lan.rs:1290-1322` 的 `tokio::select!` 与 `continue` 分支；`tcp_read_loop` 的 `shutdown` 参数类型为 `watch::Receiver<bool>`（`lan.rs:1290`）。 |
| **推荐解决方案** | ① 把「是否已在 join 中」的检查**前移到建立 socket 之前**（`g.join.is_some()` 在 `TcpStream::connect` 之前判断一次），消除竞态窗口；② 给 `tcp_read_loop` 的 shutdown 分支加上「sender 已断开」的处理：`shutdown.changed()` 返回 `Err` 时**直接 break**（而不是 `continue`），杜绝空转；③ 读循环任务改为持有 `JoinHandle`，在连接失败路径上显式 `abort()`。**并补一条 Rust 集成测试：并发调用 `join_connect` 两次，断言无残留任务、无忙循环。** |

---

### PKG-01 —— `tauri.conf.json` 没有 `bundle.macOS` 块：无签名、无公证、无 entitlements 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/tauri.conf.json` |
| **代码位置** | `bundle` 段（`active`、`targets: "all"`、`category`、描述、`icon`），**没有 `macOS` 子块** |
| **具体问题** | 缺少 `macOS.signingIdentity`、`macOS.entitlements`、`macOS.minimumSystemVersion`、`macOS.exceptionDomain` 等全部字段，也没有任何 `notarization` 配置。 |
| **影响** | 未签名的 `.app` 在 macOS 10.15+ 上会被 Gatekeeper 拦截，外部开发者必须右键 → 打开 或执行 `xattr -dr com.apple.quarantine`，否则**装完也启动不了**。这直接命中任务书 §7「外部开发者能否启动应用」。 |
| **推荐解决方案** | 短期：在 README 与发布说明中写明绕过步骤（`xattr -cr /Applications/Kindora.app`）与原因。长期：引入 `APPLE_CERTIFICATE` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 的 Tauri 公证流程（见第 7 节 P1-T3）。**公证需要付费的 Apple Developer Program 账号，这是发布路径上的一个真实成本门槛。** |

---

### PKG-02 —— Bundle identifier 以 `.app` 结尾，与 macOS bundle 扩展名冲突 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/tauri.conf.json` |
| **代码位置** | `identifier: "com.kindora.app"` |
| **具体问题** | 本次 `tauri build` 时 Tauri 主动输出警告：*"The bundle identifier `com.kindora.app` set in `tauri.conf.json` identifier ends with `.app`. This is not recommended because it conflicts with the application bundle extension on macOS."* |
| **影响** | macOS 的 `LaunchServices` 与 `NSBundle` 体系对 `.app` 后缀的标识符有特殊处理，可能导致**安装、启动、深度链接与「关于本机」注册**出现异常；也会让自动更新、崩溃报告等按 bundle id 索引的机制变脆。 |
| **推荐解决方案** | 改为不含 `.app` 的标识符，例如 `com.kindora.desktop` 或 `app.kindora.desktop`。**注意：这是破坏性变更——`secrets.rs:14` 的 `const SERVICE: &str = "com.kindora.app";` 是 Keyring 的 service 名，一旦标识符改名，**已写入 Keychain 的私钥与 API Key 会全部变成孤儿条目**，应用会报「OS keychain 里没有匹配的私钥」。必须与 PKG-01 的首次发布一起做（改名 + Keychain 迁移），且在改之前不要发布任何安装包。** |

---

### DOC-01 —— README 与 DEVELOPMENT_STATUS 仍宣称 `format:check` 有 111 个文件失败 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `README.md`、`docs/DEVELOPMENT_STATUS.md` |
| **代码位置** | `README.md:94`、`README.md:285`、`DEVELOPMENT_STATUS.md:61 / 89 / 107 / 242 / 258` |
| **具体问题** | 文档仍写「**One gate is still red:** `pnpm format:check` reports **111 files**」。但本次实测：`pnpm format:check` **只报 1 个文件**——`docs/优化.md`，而且它是**未跟踪的用户文件**，不在 Git 树里。**被 Git 跟踪的代码树 Prettier 完全干净。** 该陈述在 `f874944` 提交后就已经过期（`f874944` 的提交信息自己写的是「`pnpm format:check` **首次归零**」），文档与提交信息自相矛盾。 |
| **影响** | 外部开发者读到「111 个文件格式不通过」会直接判定项目代码质量失控，**这与实际状态相反**，会实质性地劝退外部贡献者。 |
| **证据** | 本次 `pnpm format:check` 输出只有一行 `[warn] docs/优化.md`；`git ls-files` 范围内的所有 `.ts/.tsx/.js/.json/.md/.css/.html` 无一被列出。 |
| **推荐解决方案** | 把这 5 处陈述统一改为「`pnpm format:check` 在 `f874944` 已归零（EXIT=0）」，并把 111 这个历史数字移到「历史记录」小节。 |

---

### DOC-02 —— `docs/phase16/manual-lan-e2e.md` 引用了不存在的 `build:fast` 脚本 【P1】

| 项 | 内容 |
|---|---|
| **文件路径** | `docs/phase16/manual-lan-e2e.md` |
| **代码位置** | `manual-lan-e2e.md:88` → `pnpm --filter @kindora/desktop build:fast    # builds the renderer` |
| **具体问题** | `apps/desktop/package.json` 的 scripts 只有 `dev` / `build` / `preview` / `tauri` / `tauri:dev` / `tauri:build` / `test` / `test:watch` / `typecheck` —— **没有 `build:fast`**（根 `package.json` 也没有）。 |
| **影响** | 这是**双设备人工验收手册的第一条命令**。外部开发者照抄即失败（`ERR_PNPM_NO_SCRIPT`），会直接中断验收流程 —— 而这份手册正是任务书 §6 要求的那套流程的落地文档。 |
| **证据** | `python3 -c "json.load(open('apps/desktop/package.json'))['scripts']"` 输出见 §2.9；`grep -rn "build:fast" package.json apps/*/package.json packages/*/package.json` → **零命中**。 |
| **推荐解决方案** | 把手册第 88 行改为 `pnpm --filter @kindora/desktop build`（或直接删掉该行 —— `tauri dev` 会自行构建前端），并**顺手全仓 grep 一遍 `pnpm run` 引用**的脚本名是否都存在。 |

---

### DOC-03 —— README 反复链接 GitHub Discussions，但仓库的 Discussions 功能是关闭的 【P2】

| 项 | 内容 |
|---|---|
| **文件路径** | `README.md`、`SECURITY.md` |
| **代码位置** | `README.md:14`（badge）、`README.md:370`（`docs/COMMUNITY.md` 提及）、`README.md:380`（正文链接）；`SECURITY.md:347` |
| **具体问题** | GitHub API 返回 `has_discussions: false`——**Discussions 功能未启用**。上述链接会 404。 |
| **影响** | 低。外部开发者点「Discussions」得到 404，会以为项目已废弃。 |
| **证据** | `GET /repos/free-revalution/Kindora` → `has_discussions: false`、`visibility: public`、`has_issues: true`、`open_issues_count: 0`。 |
| **推荐解决方案** | 要么在仓库设置里启用 Discussions，要么把 README/SECURITY 的链接改成 Issues / `docs/COMMUNITY.md` 锚点。 |

---

### TOOL-01 —— `rust-toolchain.toml` 钉的是 `stable` 而不是具体版本，构建不可复现 【P2】

| 项 | 内容 |
|---|---|
| **文件路径** | `rust-toolchain.toml` |
| **代码位置** | `[toolchain] channel = "stable"` |
| **具体问题** | `stable` 是滚动通道。CI 用 `dtolnay/rust-toolchain@stable`，本地也用 `stable` —— 但**每次都会拿到当时最新的 stable**。本次本地是 1.99.1；GitHub `ubuntu-latest` 镜像当前也是 1.99.1，两者一致只是巧合，不是保证。 |
| **影响** | 某天 stable 推到 1.100.0 并引入新 lint（或触发新的 deny-by-default lint）时，**所有人的本地构建与 CI 会同时变红**，且 `Cargo.lock` 拦不住（它不锁编译器）。 |
| **证据** | `cat rust-toolchain.toml` → `channel = "stable"`；注释自述理由是「依赖树需要 edition2024（Rust ≥ 1.85）」——**但 1.85 这个下限本身就可以直接钉**。 |
| **推荐解决方案** | 改为 `channel = "1.99.1"`（或团队认可的最低支持版本 1.85.0），并在 CI 同步使用同一具体版本。**注意 `apps/desktop/src-tauri/Cargo.toml:13` 写的是 `rust-version = "1.77.2"`，而依赖树实际要求 ≥ 1.85 —— 这个 `rust-version` 声明是错的，应一并修正，否则 `cargo` 的最低版本检查形同虚设。** |

---

### SEC-04 —— `keyring` 同时启用三平台 feature，依赖集是三个平台的并集 【P2】

| 项 | 内容 |
|---|---|
| **文件路径** | `apps/desktop/src-tauri/Cargo.toml` |
| **代码位置** | `Cargo.toml:34` `keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service"] }` |
| **具体问题** | Cargo 的 feature 是**可加的且不做目标平台条件化**——启用全部三个意味着依赖集始终包含三个平台的实现：`security-framework`（Cargo.lock 里有 2.11.1 与 3.7.0 两个版本）、`dbus-secret-service 4.1.0`、`windows-sys`（0.45/0.48/0.60/0.61 四个版本）+ `byteorder 1.5.0`。这些 crate 内部自己做 `cfg(target_os)`，所以**不会导致跨平台编译失败**（本次 macOS 构建成功即为证据）。 |
| **影响** | 主要影响**供应链面**：`cargo audit` / SBOM 要覆盖三套 OS 后端，即使只发布 macOS；同时 `security-framework` 出现**两个大版本**并存，说明依赖树里有重复的传递依赖。 |
| **证据** | `Cargo.lock` 中确实同时存在 `security-framework 2.11.1` 与 `3.7.0`、`dbus-secret-service 4.1.0`、四个 `windows-sys` 版本。 |
| **推荐解决方案** | 保留现状即可（功能正确），但把「三平台后端全部在依赖集中」写进 `SECURITY.md` 的依赖说明；后续做依赖收敛时留意 `security-framework` 的双版本问题。**本条不是发布阻塞项。** |

---

## 4. 测试证据表

### 4.1 本次真实运行（2026-11-07，macOS，rustc 1.99.1）

| 验证项 | 实际命令 | EXIT CODE | 通过数量 | 失败数量 | 跳过 | 是否真实执行 |
|---|---|---:|---:|---:|---:|---|
| TypeScript Tests | `pnpm -r test` | **0** | **1035** | 0 | **8** | ✅ 是 |
| Typecheck | `pnpm -r typecheck` | **0** | 7 个包全部通过 | 0 | 0 | ✅ 是 |
| ESLint | `pnpm lint` | **0** | 0 error | 0 | 0 | ✅ 是 |
| Prettier Check | `pnpm format:check` | **1** | — | **1 个文件** | — | ✅ 是（**失败原因见下**） |
| Rust fmt | `cargo fmt --check` | **0** | 全部通过 | 0 | 0 | ✅ 是 |
| Clippy | `cargo clippy --all-targets --all-features --message-format=short -- -D warnings` | **0** | 0 warning | 0 | 0 | ✅ 是 |
| Rust lib tests | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` | **0** | **13** | 0 | 0 | ✅ 是 |
| Rust LAN e2e | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test lan_e2e -- --test-threads=1` | **0** | **18** | 0 | 0 | ✅ 是 |
| Rust LAN protocol e2e | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test lan_protocol_e2e -- --test-threads=1` | **0** | **13** | 0 | 0 | ✅ 是 |
| Rust LAN limits | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test lan_limits -- --test-threads=1` | **0** | **4** | 0 | 0 | ✅ 是 |
| Tauri Build | `pnpm -C apps/desktop tauri build --no-bundle` | **0** | 产出 `target/release/kindora-desktop` | 0 | 0 | ✅ 是（macOS release 编译） |

**Rust 测试总计：13 + 18 + 13 + 4 = 48 个，全部通过，0 失败。**

**Vitest 逐包明细**（真实输出）：

| 包 | Test Files | Tests | 备注 |
|---|---|---|---|
| `packages/protocol` | 11 passed | **215 passed** | 含 signature 17 / canonical-json 17 / sensitive-field-guard 30 / prompt-injection-guard 57 / profile-privacy-filter 26 / replay-protection |
| `packages/transport` | 15 passed | **211 passed** | |
| `packages/storage` | 11 passed | **168 passed** | **全部跑在 `FakeSql` / 内存库上** |
| `packages/agent` | 15 passed | **148 passed** | |
| `packages/llm` | 4 passed \| 1 skipped | **56 passed \| 8 skipped** | 8 条 live 测试被跳过 |
| `packages/matching` | 8 passed | **86 passed** | |
| `apps/desktop` | 16 passed | **151 passed** | |
| **合计** | 80 passed \| 1 skipped | **1035 passed \| 8 skipped \| 0 failed** | 注册 1043 |

> **8 条 live Provider 测试记为「跳过」，不计入通过数。** 触发条件是 `KINDORA_LLM_LIVE === '1'` 加各 Provider 的 `KINDORA_LLM_{OPENAI,ANTHROPIC,OLLAMA,MINIMAX}_{KEY,MODEL,BASE_URL}` 环境变量；本次**没有任何一个凭据**，因此 8 条全部 `skipIf` 跳过。该文件头部注释明确声明：真实 429 与真实 Provider 超时**不在**其覆盖范围内。

**Prettier 失败的精确说明**：

```
Checking formatting...
[warn] docs/优化.md
[warn] Code style issues found in the above file.
```

唯一被标记的文件 `docs/优化.md` 是**本次审计任务书本身**，由用户放置且**未被 Git 跟踪**。被 Git 跟踪的代码树 Prettier **完全干净**。**本次未执行任何自动格式化**（任务书 §2 第 3 条）。在基线 `f874944` 的干净检出上，`pnpm format:check` 的结果是 **EXIT=0**。

### 4.2 历史运行记录（GitHub Actions，来自真实 API）

**仓库 `main` 分支共 15 次 CI 运行，结论全部为 `failure`。**

| 运行 ID | 提交 | 时间 | 失败步骤 |
|---|---|---|---|
| 42228916649 | `f874944` | 2026-11-06 | **Rust Clippy**（exit 101） |
| 41439323795 | `020b15d` | 2026-11-02 | Test |
| 41438593315 | `0d9175c` | 2026-11-02 | Test |
| 41434855529 | `0060838` | 2026-11-02 | Setup pnpm |
| 39951760646 | `cb519be` | 2026-10-23 | Setup pnpm |
| 39114550369 | `b1d7f62` | 2026-10-18 | Setup pnpm |
| 39109424526 | `f757aa5` | 2026-10-18 | Setup pnpm |
| 39094597777 | `af5da30` | 2026-10-18 | Setup pnpm |
| 39092677139 | `66a9803` | 2026-10-18 | Setup pnpm |
| 38747172861 | `52d1321` | 2026-10-15 | Setup pnpm |
| 38744580611 | `e693947` | 2026-10-15 | Setup pnpm |
| 38742435776 | `353f2d2` | 2026-10-15 | Setup pnpm |
| 38741090404 | `c5da270` | 2026-10-15 | Setup pnpm |
| 38736682393 | `2d2385c` | 2026-10-15 | Setup pnpm |
| 38588738419 | `bbf360a` | 2026-10-14 | Setup pnpm |

**最新一次运行 `42228916649` 的完整步骤级结论**（`Build & test` job）：

| # | 步骤 | 结论 |
|---:|---|---|
| 1–7 | Set up job / Checkout / Setup pnpm / Setup Node / Setup Rust / Cache cargo / Install dependencies | success |
| 8 | Typecheck | success |
| 9 | Lint | success |
| 10 | Build | success |
| 11 | Test | success |
| 12 | Rust format check | success |
| **13** | **Rust Clippy** | **failure** |
| 14 | Rust lib check (real PASS/FAIL) | **skipped** |
| 15 | Rust unit tests | **skipped** |
| 16 | LAN end-to-end Rust tests | **skipped** |
| 17 | LAN protocol end-to-end Rust tests | **skipped** |
| 18 | LAN resource-limit Rust tests | **skipped** |
| 19 | Format check | **skipped** |

同一次运行的两个兄弟 job：`Tauri build check` = **success**（其 step 7 正是 `Install Tauri Linux prerequisites`）；`Dependency audit (record only — not gating)` = **success**。

**Rust 测试门在 15 次运行中的结论分布（全部为 `skipped`）**：

| 步骤 | success | failure | skipped | 执行过几次 |
|---|---:|---:|---:|---:|
| Rust lib check | 0 | 0 | **15** | **0 / 15** |
| Rust unit tests | 0 | 0 | **15** | **0 / 15** |
| LAN end-to-end | 0 | 0 | **15** | **0 / 15** |
| LAN protocol end-to-end | 0 | 0 | **15** | **0 / 15** |
| LAN resource-limit | 0 | 0 | **15** | **0 / 15** |
| Rust Clippy | 0 | **1** | 0（该步仅在最后一次运行中存在） | 1 / 1 |

> **结论：本仓库的 CI 从未通过，且 Rust 的 5 个测试门从未在任何一次运行中执行过。** 「CI 已通过」在本项目上不存在，任何引用都属错误陈述。

### 4.3 静态代码判断（未执行，靠读代码得出）

| 结论 | 依据 |
|---|---|
| 私钥在 webview 内以明文存在并用于签名 | `secrets.rs:250` → `tauri-agent-keychain.ts:131` → `agent-service.ts:203` → `connect-service.ts:735-751` |
| WebRTC 无任何可用路径 | `webrtc-transport.ts:115-130`；`connect()` 四入口全部抛 `WEBRTC_NOT_IMPLEMENTED` |
| 没有任何 React 错误边界 | 全仓库 grep `ErrorBoundary` / `componentDidCatch` / `getDerivedStateFromError` → 零命中 |
| 持久化失败对用户不可见 | `chat-orchestrator.ts:420` 只有 `console.error` |
| 破冰失败对用户不可见 | `App.tsx:304` 空 catch 回调 |
| Ollama 默认端点会被 CSP 拒绝 | `tauri.conf.json` 的 `connect-src` 不含 `http://localhost:11434`；`llm-service.ts:323` |
| Rust 源无平台分支 | `apps/desktop/src-tauri/src/` 全部源码 grep `cfg(target_os` → 零命中 |
| 桌面 App 不再用 localStorage 存关键数据 | `packages/storage/src/browser-store.ts` 仅为 dev 回退；生产走 `SqliteKindoraDatabase` |
| `build:fast` 脚本不存在 | `apps/desktop/package.json` scripts 列表 |
| Discussions 未启用 | GitHub API `has_discussions: false` |

### 4.4 尚未运行（`NOT_RUN`）

| 项 | 原因 |
|---|---|
| 8 条 live Provider 测试（OpenAI / Anthropic / Ollama / MiniMax） | 无 API Key / 无本地 Ollama；按任务书要求**不尝试调用真实 API，也不伪造结果** |
| 真实 SQLite 执行 | 测试层只有 `FakeSql`；真实引擎在打包进程内，本次未运行打包 App |
| 打包应用启动 / 首次运行 / Keychain 交互授权 | 本次只做 `--no-bundle` 编译 |
| 打包应用重启后数据恢复 | 同上 |
| macOS 安装包（`.dmg` / `.app` bundle） | `bundle.targets = "all"` 但本次用 `--no-bundle`；仓库**无任何发布产物** |
| 代码签名 / 公证 | 无 Apple Developer 账号与证书 |
| Windows / macOS 的 Rust 构建矩阵 | CI 只有 Linux 一个平台 |
| `cargo audit`（本地） | 网络取不到 RustSec advisory-db → **未扫成，不是「干净」** |

### 4.5 被环境阻塞（`BLOCKED`）

| 项 | 阻塞原因 | 可解除条件 |
|---|---|---|
| 双设备 GUI 验收（全套） | 需要**两台真实 macOS 设备 + 两个人**操作 | 借两台 Mac + 一名协作者 |
| 真实双机 LAN 端到端（含跨网段） | 同上 | 同上 |
| macOS Keychain 交互授权验证 | 需要人工在系统弹窗中授权 | 任意一台 Mac 上人工点一次 |
| 真实 Provider 端到端 | 需要有效 API Key | 配置任一 Provider 的 Key |
| 签名 / 公证 | 需要付费 Apple Developer Program 账号 | 购买账号并配置 CI 密钥 |
| CI 日志正文 | GitHub API 对未认证请求返回 403（需要 admin 权限） | 用有 read 权限的 token 重新拉取 |

---

## 5. 双设备 GUI 验收任务书

### 5.1 验收前提

| 项 | 要求 |
|---|---|
| 设备 | 两台真实 macOS 设备（**不是**同一台机器的两个浏览器标签页） |
| 网络 | 同一 Wi-Fi 局域网；「断开 Wi-Fi」用例需第二张可用网络（如手机热点） |
| 安装 | 两台都装**同一个** `kindora-desktop` 构建产物（`.app` 或 `.dmg`） |
| 身份 | 两台设备各有独立的 macOS 用户账号（Keychain 不跨账号共享） |
| LLM | 双方各配置一个可用的 Provider Key（用于破冰与匹配分析） |
| 记录 | 每条用例填写「实际结果」并给出 PASS / FAIL / BLOCKED / NOT_RUN |

### 5.2 用例清单

> **本次全部用例状态为 `NOT_RUN`，实际结果列一律留空。任务书 §6 明确要求：没有真实设备执行不得标记 PASS。**

#### 基础流程

| Case ID | 前置条件 | 设备 A 操作 | 设备 B 操作 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|---|---|
| GA-01 首次启动 | 两台设备已安装，未创建过 Agent | 启动 App | 启动 App | A 显示欢迎页；B 显示欢迎页；无崩溃、无白屏 | | `NOT_RUN` |
| GA-02 创建 Agent | GA-01 通过 | 填昵称 + 简介 → 创建 | 同左 | 各自生成独立 agentId 与 ES256 密钥；Keychain 出现对应条目 | | `NOT_RUN` |
| GA-03 配置 LLM | GA-02 通过 | 设置页填入真实 API Key → 保存 | 同左 | 页面显示「Key 已配置」**且不回显明文**；Keychain 出现条目 | | `NOT_RUN` |
| GA-04 创建 Profile | GA-03 通过 | 填昵称/兴趣/社交意图/对话风格，逐项设置授权开关 | 同左 | Profile 落库；未授权字段不出现在本地持久化的出站副本里 | | `NOT_RUN` |
| GA-05 启动 LAN 发现 | 两台在同一 Wi-Fi | Home → Connect → Host（开始发现） | Home → Connect → Join | 双方都能看到对方 agentId 的发现条目 | | `NOT_RUN` |
| GA-06 建立 TCP 连接 | GA-05 通过 | 观察连接状态 | 输入配对码 → 连接 | A 显示 B 的配对码；B 输入后双方进入 `connected` | | `NOT_RUN` |
| GA-07 身份验证 | GA-06 通过 | 核对配对码 | 核对配对码 | 配对码是 host 公钥指纹；**双方不一致时连接必须关闭** | | `NOT_RUN` |
| GA-08 身份不符被拒 | 预先准备错误配对码 | — | 输入错误配对码 | 连接被关闭，UI 给出「配对码不匹配」的明确提示 | | `NOT_RUN` |
| GA-09 Consent | GA-07 通过 | 收到同意请求 → 同意 | 收到同意请求 → 同意 | 双方都看到对方已同意；任一方拒绝则交换终止 | | `NOT_RUN` |
| GA-10 Profile 交换 | GA-09 通过 | 观察已授权字段 | 观察已授权字段 | 对方**只能**看到我授权的字段；未授权字段在 wire 上不可见 | | `NOT_RUN` |
| GA-11 匹配结果 | GA-10 通过 | 等待分析 | 等待分析 | 双方均展示 Compatibility Signal / Common Ground / Recommended Topics / Potential Friction / Explanation 五项 | | `NOT_RUN` |
| GA-12 破冰生成 | GA-11 通过 | 等待破冰 | 等待破冰 | 生成一条破冰建议并展示；LLM 失败时**必须有可见提示**（验证 UI-03 修复） | | `NOT_RUN` |
| GA-13 编辑并确认破冰 | GA-12 通过 | 编辑文本 → 发送 | — | 发送的是用户编辑后的文本 | | `NOT_RUN` |
| GA-14 收到对方消息 | GA-13 通过 | — | 发送一条消息 | A 收到并实时显示 B 的消息 | | `NOT_RUN` |
| GA-15 消息持久化 | GA-14 通过 | 关闭 App | 关闭 App | 双方本地数据库各存有这 2 条消息 | | `NOT_RUN` |
| GA-16 重启后找回记录 | GA-15 通过 | 重新启动 → 打开历史 | 重新启动 → 打开历史 | **聊天记录完整恢复**（验证 SQL-02） | | `NOT_RUN` |

#### 异常流程

| Case ID | 前置条件 | 设备 A 操作 | 设备 B 操作 | 预期结果 | 实际结果 | 状态 |
|---|---|---|---|---|---|---|
| GA-17 对端关闭应用 | 已连接并有会话 | 继续操作 | **关闭 App** | A 在合理时间内感知断开（`disconnected`），UI 明确显示断开原因，**不静默卡死** | | `NOT_RUN` |
| GA-18 对端断 Wi-Fi | 已连接并有会话 | 继续操作 | **断开 Wi-Fi** | A 感知断开；A 的消息**不应**显示为已送达 | | `NOT_RUN` |
| GA-19 发送失败落 FAILED | GA-18 之后 | 尝试发送消息 | — | 消息状态落为 **FAILED** 并在界面上可见（验证 UI-02 修复） | | `NOT_RUN` |
| GA-20 对方重启后重连 | GA-19 之后 | 点重连 | 重新启动 App → 重新连接 | 双方重新建立会话；**会话密钥是全新的**（ECDH 每次重新协商） | | `NOT_RUN` |
| GA-21 重连后的聊天历史 | GA-20 通过 | 打开历史 | 打开历史 | 历史完整，**无重复消息**（按 messageId 去重） | | `NOT_RUN` |
| GA-22 PENDING / FAILED 状态机 | GA-19 之后 | 检查数据库 | 检查数据库 | 未完成消息为 PENDING，失败为 FAILED，**重启后仍在**且可见 | | `NOT_RUN` |
| GA-23 黑名单拦截 | GA-09 之前把 B 加入黑名单 | 加入黑名单 | 尝试连接 | A 侧**在 Profile 交换之前**就拦截；B 侧收到明确的「被拒绝」提示 | | `NOT_RUN` |
| GA-24 拒绝授权后的行为 | GA-09 阶段 | 点**拒绝** | 观察 | 交换终止；**A 的 Profile 一条都未发出** | | `NOT_RUN` |
| GA-25 撤销授权后生效 | 已完成 GA-10 | 撤销某个字段授权 → 再发一条消息 | 观察 | 该字段从后续出站消息中消失（SECURITY.md §2「下一次出站消息生效」） | | `NOT_RUN` |
| GA-26 并发 join 竞态 | 两台设备 | 快速连续点 Join 两次 | 观察 | 只建立一个会话；**无 CPU 空转**、无幽灵连接（验证 LAN-01 修复） | | `NOT_RUN` |
| GA-27 私钥不出 webview | 已打补丁版本 | — | — | 抓包 / DevTools 中**看不到**私钥明文；`agent_key_get` 不再可用（验证 SEC-01 修复） | | `NOT_RUN` |
| GA-28 大消息与洪泛 | 已连接 | 发送 > 1 MiB 帧 / 高频发送 | 观察 | 超限帧被拒并断开；洪泛被限速丢弃，**两端都不崩溃** | | `NOT_RUN` |

### 5.3 验收判定标准

- **可以标记 Alpha 候选**：GA-01 ~ GA-25 全部 PASS，GA-26 ~ GA-28 无 FAIL。
- **存在任何 FAIL**：必须先修复并重跑该 Case 与其依赖链。
- **本审计交付时**：全部 28 条为 `NOT_RUN`，**零条 PASS**。

---

## 6. Alpha 发布评估

### 6.1 结论

| 目标 | 结论 | 理由 |
|---|---|---|
| **开发者预览版本**（source-only，README 明示从源码构建） | **可以发布，但有前提** | 前提：① 先修好 CI（CFG-01），否则任何贡献者 PR 都无法获得可信信号；② 先修好 `docs/phase16/manual-lan-e2e.md` 的 `build:fast`（DOC-02），否则人工验收手册第一条命令就失败；③ 先修好 README 的「111 files」错误陈述（DOC-01）。 |
| **普通用户 macOS Alpha**（双击即用） | **不建议现在发布** | 缺 6 个 P0 条件（见 6.3）。最致命的三条：① **CI 从未通过**，项目没有可依赖的质量信号；② **私钥在 webview 内明文**（SEC-01），对一个主打「本地优先 + 隐私」的桌面应用是直接的产品价值冲突；③ **真实 SQLite 与重启恢复从未验证**，而「退出重开还能看到聊天记录」是用户最基本的预期。 |
| **公开 Beta / 正式发布** | **明确不建议** | 无签名 / 无公证（PKG-01）、无错误边界（UI-01）、无发布产物、bundle id 存在冲突（PKG-02）、安全文档已自述 8 项已知限制。 |

### 6.2 任务书 §7 的 10 步外部开发者走查 —— 逐项结论

假设一位**没参与过开发**的外部开发者，从 GitHub 下载源码：

| # | 步骤 | 能否完成 | 阻碍 |
|---:|---|---|---|
| 1 | 看懂项目是什么 | ✅ 能 | README 结构完整（389 行），V0.1 定位明确写了「Experimental, source only」。 |
| 2 | 按 README 配置环境 | ⚠️ **有坑** | README 的 Linux/macOS 依赖段落存在；但 `rust-toolchain.toml` 钉 `stable`（TOOL-01），且 `Cargo.toml` 的 `rust-version = "1.77.2"` 与实际要求的 1.85+ **矛盾**，可能误导人以为 1.77 可用。 |
| 3 | 成功构建桌面应用 | ⚠️ **有条件** | 本次 macOS 构建成功（EXIT=0）。但 README 未说明需要 Xcode Command Line Tools；CI 的 Linux 构建需要 apt-get 前置依赖（CFG-01 的成因）。 |
| 4 | 启动应用 | ⚠️ **有条件** | 从源码构建的 `.app` 未签名 → Gatekeeper 拦截（PKG-01），需 `xattr -dr com.apple.quarantine`；README **未写这个步骤**。 |
| 5 | 创建 Agent | ⚠️ **未验证** | 代码与测试齐备，但 Keychain 授权弹窗的真实交互未验证（GA-02 `NOT_RUN`）。 |
| 6 | 配置自己的 LLM API Key | ⚠️ **有坑** | Key 不回显、失败即整体失败，这些设计是对的；但**选 Ollama 会直接被 CSP 拦掉**（LLM-01），且错误信息不会提示原因。 |
| 7 | 完成一次 LAN 匹配 | ❌ **不能确认** | 全部跨机链路**从未在真实设备上跑过**；双设备验收 28 条全 `NOT_RUN`。 |
| 8 | 进行一次聊天 | ❌ **不能确认** | 同上。 |
| 9 | 退出并重新启动应用 | ⚠️ **未验证** | 未运行过打包 App。 |
| 10 | 找回此前的聊天记录 | ❌ **不能确认** | 真实 SQLite 未执行（SQL-01），重启恢复未验证（SQL-02）。 |

> **诚实结论：第 7、8、10 步——也就是产品的核心价值——目前没有任何真实证据。** 自动化测试证明的是「逻辑在受控环境里自洽」，不是「两个真人用两台 Mac 能聊上天」。

### 6.3 发布 Alpha 所需的 P0 条件（缺一不可）

| # | 条件 | 对应问题 | 工作量 |
|---:|---|---|---|
| 1 | CI 全绿，5 个 Rust 测试门**真正执行过** | CFG-01 | S |
| 2 | Rust 侧 `agent_sign` 落地，私钥不再穿越 webview；`secret_get` 收窄到最小权限；引入 app 级 ACL manifest | SEC-01、SEC-03 | **L** |
| 3 | 真实 SQLite 冒烟测试进 CI | SQL-01 | M |
| 4 | 打包应用「写 → 退 → 重启 → 读回」验证通过 | SQL-02 | M |
| 5 | 双设备 GUI 验收（GA-01 ~ GA-25）全部 PASS | 第 5 节 | **L**（含人力） |
| 6 | 人工验收手册可执行（`build:fast` 等失效引用清零） | DOC-02 | S |

### 6.4 任务书 §7 的发布配套项 —— 按阻碍程度分级

| 项 | 是否需要 | 分级 | 理由 |
|---|---|---|---|
| 提供 macOS 安装包 | **需要** | **P0** | 目前是「source only」，外部开发者要自己装 Rust / Node / pnpm / Xcode CLT，门槛过高。 |
| 代码签名与公证 | **需要** | **P1** | 不签名的 `.app` 装完打不开（Gatekeeper）。**但需要付费 Apple Developer 账号**，属于外部成本，先与 P0 并行决策。 |
| 首次启动引导 | **需要** | **P1** | 新用户第一屏是欢迎页，但「怎么创建 Agent → 怎么配 Key → 怎么连上对方」没有引导，且 Ollama 的 CSP 坑会直接卡住第一批用户。 |
| 示例 Profile | **建议提供** | **P2** | 能显著降低首次体验门槛，并让双机验收更快复现。 |
| 演示视频 | **建议提供** | **P2** | 对「两个陌生人如何在 LAN 上匹配」这种反直觉的交互，视频比文档有效。 |
| 匿名日志 / 诊断信息 | **需要（最小版本）** | **P1** | UI-01/02/03 三个「用户无感失败」的问题，没有诊断出口就永远只能靠用户口述复现。**必须保证诊断信息不含私钥与 API Key。** |
| 更完整的隐私说明 | **需要** | **P1** | `SECURITY.md` 已经相当诚实（8 项已知限制），但产品对「私钥会进 webview」这一事实的用户级披露缺失。隐私说明需要与 SEC-01 的修复进度同步更新——**先修再披露，不要先披露再修**。 |
| 启用 GitHub Discussions | 建议 | P2 | README 三处链接当前 404（DOC-03）。 |

---

## 7. 下一阶段整改路线图

> 本节只是**计划**，本次审计**不实施**其中任何一项。

### P0 —— 影响核心流程、安全与真实可用性

---

#### P0-1：让 Rust 测试门第一次真正进入 CI

| 项 | 内容 |
|---|---|
| **Task ID** | `P0-1` |
| **文件路径** | `.github/workflows/ci.yml`（`build` job L83-218；`tauri-build` job L220-291） |
| **修复要求** | 把 `tauri-build` job 中 L256-269 的 `Install Tauri Linux prerequisites`（apt-get 块）提取为**可复用步骤**（或 composite action），在 `build` job 的**第一个 `cargo` 步骤之前**调用；确保 `cargo fmt` / `cargo clippy` / `cargo test` / `cargo check` 全部能真正执行。同时建议把 `rust-toolchain.toml` 与 CI 的 `dtolnay/rust-toolchain` 统一到**同一个具体版本**（与 TOOL-01 合并处理）。 |
| **测试用例** | ① 在 `build` job 之后加一步 `cargo clippy --all-targets --all-features -- -D warnings`，要求 CI 页面显示 **success**；② `Build & test` 的步骤列表中，`Rust lib check` / `Rust unit tests` / `LAN end-to-end` / `LAN protocol end-to-end` / `LAN resource-limit` 五项结论**必须全部为 success 或 failure（不得再是 skipped）**；③ 故意提交一个 Clippy 违规，验证 CI 确实变红（**验证门是有效的，不是恒绿**）。 |
| **验收标准** | ① `main` 分支的 CI 结论为 **success**；② 5 个 Rust 测试门至少执行过一次并全部通过；③ `actions/runs` 页面可读出 Rust 步骤的真实结论；④ 至少一次「故意引入问题 → CI 变红 → 修复 → CI 变绿」的往返记录。 |
| **依赖任务** | 无（可立即开始） |
| **工作量估计** | **S**（约 0.5 天；根因确认约 0.5 天） |

---

#### P0-2：Rust 侧实现 `agent_sign`，闭合私钥边界

| 项 | 内容 |
|---|---|
| **Task ID** | `P0-2` |
| **文件路径** | `apps/desktop/src-tauri/src/secrets.rs`（新增 `agent_sign`）、`apps/desktop/src-tauri/src/lib.rs`（L152-202 注册命令）、`apps/desktop/src-tauri/Cargo.toml`（新增 `p256` 依赖）、`apps/desktop/src/lib/connect-service.ts`（`buildSigner` L732-751）、`apps/desktop/src/lib/lan-connect-service.ts`（L800-802）、`packages/protocol/src/signature.ts`（编码对齐）、`SECURITY.md`（限制 #1 与 #7 更新） |
| **修复要求** | ① 新增 `#[tauri::command] async fn agent_sign(canonical_input: String) -> Result<String, AgentKeyError>`：从 Keychain 读私钥 → `p256::ecdsa::SigningKey` → `sign_prehash`/对 canonical 字节签名 → 返回 **P1363 raw r‖s**（与 WebCrypto 一致，**注意 `SECURITY.md` §7 的 DER/P1363 陷阱**）。② `agent_key_get` 降级：仅在密钥**生成与迁移**时允许取回，签名路径不再暴露私钥。③ 前端 `buildSigner()` 改为调用 `agent_sign`，**不得再持有 `privateKey` 字符串**。④ 移除 `buildSigner()` 里 `catch { return null; }` 的静默降级——签名不可用必须**报错**，不能发未签名会话。⑤ 补充「私钥格式与公钥不匹配」的显式错误。⑥ **（承接 SEC-03）** 新增 `apps/desktop/src-tauri/permissions/` 目录与 `build.rs` 的 `app_manifest` 声明，把 `agent_key_*` / `secret_*` 纳入 capability 体系；`secret_get` 改为只接受 provider 名并在 Rust 端拼 key，不再接受任意 key；评估把 `sql:allow-execute` 收窄为具名查询。 |
| **测试用例** | ① Rust 单元测试：用固定私钥签一个已知输入，与 WebCrypto 产生的签名**逐字节相等**（P1363）；② Rust 集成测试：`agent_sign` 签 → JS 侧 `verifyEnvelope` 验 → 通过；③ 篡改 payload 一字节 → 验签失败；④ `agent_key_get` 在签名路径上**不再被调用**（可在 Rust 侧计数断言）；⑤ 私钥不在 Keychain 时 `agent_sign` 返回 `not_found` 且 UI 显示明确文案。⑥ **（SEC-03）** 引入 app manifest 后，`agent_key_get` / `secret_get` 在 capability 未授权时被 Tauri 拒绝（返回 "not allowed by ACL"）；`secret_get` 传入非白名单 key 时被 Rust 拒绝。 |
| **验收标准** | ① Rust 侧存在 `agent_sign` 命令且被注册进 `invoke_handler`；② 签名路径上私钥**不经过** IPC 返回给 webview；③ GA-27 通过（抓包/DevTools 中无私钥明文）；④ `SECURITY.md` 的「限制 #1」被改写为「已修复」并注明修复版本；⑤ 现有 protocol / transport 测试**全部不回归**。⑥ **（SEC-03）** `capabilities/default.json` 中可读地声明每个自定义命令的授权状态；越权调用有明确拒绝。 |
| **依赖任务** | 无（但工作量最大，建议第一个启动） |
| **工作量估计** | **L**（约 3–5 天，含编码对齐与回归） |

---

#### P0-3：真实 SQLite 进 CI + 打包应用重启恢复验证

| 项 | 内容 |
|---|---|
| **Task ID** | `P0-3` |
| **文件路径** | `packages/storage/src/sqlite-database.ts`、`packages/storage/src/sql-migrator.ts`、`apps/desktop/src/lib/tauri-sql-executor.ts`、`.github/workflows/ci.yml`（新增 job）、`apps/desktop/src/lib/chat-persistence.ts`（新增验证脚本） |
| **修复要求** | ① 在 CI 增加一个**真实 SQLite** job：在 Linux runner 上启动 `tauri-plugin-sql` 的 SQLite（或用 `rusqlite` 写一个最小 harness），真实执行 `runMigrations` → 建 Agent → 写 Profile → 写 3 条 Chat（含 PENDING/FAILED）→ **重开连接** → 读回并逐字段比对。② 增加一个**打包应用重启验证脚本**：启动打包产物 → 写入数据 → 杀进程 → 重启 → 读回比对。③ 若第 ① 步发现 SQL 语法或幂等性问题，**修复实现**（不是改测试）。 |
| **测试用例** | ① 迁移连续执行两次，第二次必须是**无操作**（幂等）；② 在**旧版本数据库**（schema_version 更低）上执行迁移，数据完整保留；③ PENDING 消息在重启后仍为 PENDING；④ 6 张业务表全部落盘且字段值逐字节一致；⑤ 迁移中途失败时，重启后可安全重跑（不产生半迁移状态）。 |
| **验收标准** | ① CI 中存在一个**跑真实 SQLite** 的 job 且为 green；② `packages/storage` 至少有 **1 个**使用真实引擎的测试（不再全部是 `FakeSql`）；③ 打包应用「写 → 退 → 重启 → 读回」的人工脚本可重复执行并通过；④ GA-16 / GA-22 在双设备验收中 PASS。 |
| **依赖任务** | P0-1（需要 CI 能跑 Rust/打包步骤） |
| **工作量估计** | **M**（约 2–3 天） |

---

#### P0-4：完成双设备 GUI 验收（GA-01 ~ GA-25）

| 项 | 内容 |
|---|---|
| **Task ID** | `P0-4` |
| **文件路径** | `docs/phase16/manual-lan-e2e.md`（用例正文）、新增 `docs/audits/two-device-acceptance-2026-XX.md`（实测记录） |
| **修复要求** | 借两台真实 macOS 设备 + 一名协作者，按第 5 节的 28 条用例逐条执行，**记录实际结果**。执行前先修 DOC-02（`build:fast`），否则手册第一条命令即失败。 |
| **测试用例** | 第 5 节全部 28 条。 |
| **验收标准** | GA-01 ~ GA-25 全部 **PASS**；GA-26 ~ GA-28 至少 **NOT FAIL**。每条用例都有手写的「实际结果」，没有空行。 |
| **依赖任务** | P0-1（CI 绿）、P0-3（数据能落库才谈得上恢复）、**P0-2 强烈建议先行**（否则 GA-27 无法 PASS） |
| **工作量估计** | **L**（人力密集，约 3–5 天 + 设备） |

---

### P1 —— 影响稳定性与外部体验

---

#### P1-1：修掉 `join_connect` 竞态与读循环空转

| 项 | 内容 |
|---|---|
| **Task ID** | `P1-1` |
| **文件路径** | `apps/desktop/src-tauri/src/lan.rs`（`join_connect` L842-916、`tcp_read_loop` L1290-1322） |
| **修复要求** | ① 把 `g.join.is_some()` 的检查**前移**到 `TcpStream::connect` 之前；② `tcp_read_loop` 的 shutdown 分支在 `changed()` 返回 `Err`（sender 已 drop）时**直接 break**，不 `continue`；③ 持有读循环的 `JoinHandle`，失败路径显式 `abort()`。 |
| **测试用例** | ① Rust 集成测试：并发调用 `join_connect` 两次，断言**只有一个**成功、另一个返回 `AlreadyRunning`、**无残留任务**、**CPU 不空转**（可用 `/proc` 或 tokio task 计数断言）；② 断开连接后读循环**在 1 秒内退出**（现有 `PeerCloseGuard` 语义不变）。 |
| **验收标准** | 新测试通过；CI 的 Rust 门实际执行（P0-1 完成后）；GA-26 PASS。 |
| **依赖任务** | P0-1 |
| **工作量估计** | **S**（约 1 天） |

---

#### P1-2：让失败对用户可见（错误边界 + 持久化告警 + 破冰失败提示）

| 项 | 内容 |
|---|---|
| **Task ID** | `P1-2` |
| **文件路径** | 新增 `apps/desktop/src/components/AppErrorBoundary.tsx`、`apps/desktop/src/main.tsx`、`apps/desktop/src/App.tsx`（L293-317）、`packages/matching/src/chat-orchestrator.ts`（L412-421） |
| **修复要求** | ① 新增根级 React 错误边界，展示可复制的技术摘要并提供「复制诊断信息」（**严禁包含私钥 / API Key / Profile 内容**）；② `chat-orchestrator` 的持久化失败通过回调上报到 UI，显示非阻断告警条「消息已发送但未能保存到本地」；③ `App.tsx` 的破冰 catch 回调接收 error，映射为用户可读文案并展示。 |
| **测试用例** | ① 渲染期抛错的组件被错误边界捕获，UI 显示错误页而非白屏；② 诊断信息文本**不含**私钥与 API Key（写一个断言测试扫敏感词）；③ 破冰 LLM 调用失败时聊天视图顶部出现提示；④ 持久化失败时告警条出现且**不阻断发送**。 |
| **验收标准** | 上述 4 条测试存在并通过；GA-19 / GA-12 在双机验收中体现可见提示。 |
| **依赖任务** | 无 |
| **工作量估计** | **M**（约 2 天） |

---

#### P1-3：解除 Ollama 的 CSP 阻断

| 项 | 内容 |
|---|---|
| **Task ID** | `P1-3` |
| **文件路径** | `apps/desktop/src-tauri/tauri.conf.json`（`app.security.csp`）、`apps/desktop/src/lib/llm-service.ts`（L323）、`packages/llm/src/http.ts` |
| **修复要求** | ① 在 CSP `connect-src` 中加入 `http://localhost:11434` 与 `http://127.0.0.1:11434`；② 把 Ollama 的 base URL 做成**用户可填**且**保存时校验 host**，只允许 loopback；③ 在设置页对「Ollama 未启动」给出明确文案（区分「CSP 拦截」与「服务未监听」）。 |
| **测试用例** | ① 打包 App 中选择 Ollama → 发起一次请求 → 观察到**到达**本地 Ollama 而非被 CSP 拒绝；② 把 base URL 改成非 loopback → 保存时给出明确拒绝；③ 现有 llm 包的 56 个测试不回归。 |
| **验收标准** | Ollama 在打包 App 中可用；配置非 loopback 端点被拒并有文案。 |
| **依赖任务** | 无 |
| **工作量估计** | **S**（约 0.5 天） |

---

#### P1-4：发布准备（bundle id、签名、公证、安装包）

| 项 | 内容 |
|---|---|
| **Task ID** | `P1-4` |
| **文件路径** | `apps/desktop/src-tauri/tauri.conf.json`（`identifier`、`bundle.macOS`）、`.github/workflows/`（新增 release job）、`README.md`（安装与绕过说明） |
| **修复要求** | ① `identifier` 从 `com.kindora.app` 改为不含 `.app` 的值（**必须在首次发布前完成**，否则已发布的安装包会与后续版本冲突）；② 增加 `bundle.macOS`：`entitlements`、`minimumSystemVersion`、`exceptionDomain`；③ 引入 Tauri 的签名 / 公证流程（`APPLE_CERTIFICATE` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 存为 CI secret）；④ 产出 `.dmg` 并挂到 GitHub Release；⑤ README 补充安装步骤与（若暂不签名）Gatekeeper 绕过说明。**注意：Apple Developer Program 是付费的，这是发布路径上的外部成本，应先与项目所有者确认是否投入。** |
| **测试用例** | ① 在**一台从未装过 Kindora 的干净 Mac** 上安装 `.dmg` → 双击启动**无需任何手工操作**；② 改动 bundle id 后验证 Keychain 条目与已落库数据仍可读取（**可能需要数据迁移**）；③ `tauri build` 不再出现 identifier 警告。 |
| **验收标准** | 干净 Mac 上零操作启动成功；CI 能自动产出并上传 `.dmg`；identifier 警告消失。 |
| **依赖任务** | P0-1（CI 需要绿）、P0-2（避免发布后立刻返工）、Apple Developer 账号 |
| **工作量估计** | **M**（约 2 天，不含 Apple 账号申请与审核等待时间） |

---

#### P1-5：修正文档中的过期与失效陈述

| 项 | 内容 |
|---|---|
| **Task ID** | `P1-5` |
| **文件路径** | `README.md`（L94、L285、L380）、`docs/DEVELOPMENT_STATUS.md`（L61/89/107/242/258）、`docs/phase16/manual-lan-e2e.md`（L88）、`SECURITY.md`（L347） |
| **修复要求** | ① 把 5 处「111 files」的陈述改为「`pnpm format:check` 在 `f874944` 已归零（EXIT=0）」，历史数字移到「历史记录」小节；② 把 `build:fast` 改为实际存在的脚本（`build`，或删掉该行——`tauri dev` 会自行构建）；③ **全仓扫一遍** `pnpm run <script>` / `pnpm --filter <pkg> <script>` 引用的脚本名是否都存在；④ 修正 README 的 Discussions 链接（启用功能或改指 Issues）。 |
| **测试用例** | ① `grep -rn "build:fast" docs/ README.md` → 零命中；② 逐条执行 `manual-lan-e2e.md` 里的每一条命令，**全部成功**；③ `pnpm format:check` 的实际输出与文档陈述一致。 |
| **验收标准** | 文档与仓库实际状态一致；人工验收手册可逐条照做。 |
| **依赖任务** | 无 |
| **工作量估计** | **S**（约 0.5 天） |

---

#### P1-6：钉住 Rust 工具链版本并修正 `rust-version`

| 项 | 内容 |
|---|---|
| **Task ID** | `P1-6` |
| **文件路径** | `rust-toolchain.toml`、`apps/desktop/src-tauri/Cargo.toml`（L13 `rust-version = "1.77.2"`）、`.github/workflows/ci.yml` |
| **修复要求** | ① `rust-toolchain.toml` 改为具体版本（如 `channel = "1.99.1"`），CI 的 `dtolnay/rust-toolchain` 同步；② `Cargo.toml` 的 `rust-version` 从 `1.77.2` 改为真实的下限（依赖树要求 edition2024 → **≥ 1.85**）；③ 在 README 的环境要求里写明「Rust ≥ 1.85」。 |
| **测试用例** | ① 在只装了指定版本的干净环境上 `cargo build` 成功；② `cargo build` 在 1.84 上给出**清晰的**版本错误而不是难懂的 edition2024 报错。 |
| **验收标准** | 本地与 CI 使用完全相同的编译器版本；`rust-version` 与实际要求一致。 |
| **依赖任务** | 无 |
| **工作量估计** | **S**（约 0.5 天） |

---

### P2 —— 体验优化与未来功能

| Task ID | 文件路径 | 修复要求 | 测试用例 | 验收标准 | 依赖任务 | 工作量 |
|---|---|---|---|---|---|---|
| **P2-1** | `packages/transport/src/webrtc-transport.ts`、新增 `docs/ROADMAP-webRTC.md` | 保持 `WEBRTC_NOT_IMPLEMENTED` 桩的诚实状态不变；在文档中明确写出「跨网路路径尚不可用」并给出计划里程碑。**不要在 LAN Alpha 期间实现 WebRTC。** | 现有 webrtc 测试保持绿；文档与代码状态一致 | README / 文档不含「支持跨网络」的误导表述 | 无 | S |
| **P2-2** | `packages/storage/src/sqlite-database.ts`、`packages/storage/package.json` | 收敛 `security-framework` 的双版本与 `windows-sys` 的四版本（见 SEC-04）；把「三平台后端全在依赖集」写进 `SECURITY.md`。 | `cargo tree -d` 的重复项数量下降；`cargo audit` 无新增告警 | 依赖树重复项减少且构建仍通过 | 无 | M |
| **P2-3** | `README.md`、`docs/COMMUNITY.md` | 启用 GitHub Discussions，或把三处链接改指 Issues；补一份 `docs/PRIVACY.md` 用户级隐私说明（与 SEC-01 的修复进度同步更新）。 | 每条外链返回 200 | 无 404 链接 | P0-2（隐私说明需反映最终私钥边界） | S |
| **P2-4** | 新增 `examples/profile-sample.json`、`apps/desktop/src/views/` | 提供一个示例 Profile 与一键导入，降低首次体验门槛并加速双机验收。 | 导入示例 Profile 后各字段正确落库并按授权过滤 | 外部开发者 5 分钟内能造出可用的 Agent | P1-3 | S |
| **P2-5** | 新增 `docs/RECORDING-GUIDE.md` | 写一份「双机录屏脚本」，供社区成员复现验收流程。 | 脚本可被第二个人独立执行 | 第三个人照脚本能独立完成一次匹配 | P0-4 | S |

---

## 附录 A：本次审计覆盖的文件与模块

### A.1 逐文件阅读 / 检查

**根目录**：`README.md`、`ROADMAP.md`、`SECURITY.md`、`CONTRIBUTING.md`、`package.json`、`pnpm-workspace.yaml`、`rust-toolchain.toml`、`.gitignore`、`.prettierrc*`、`.eslintrc*`

**Rust crate**：`apps/desktop/src-tauri/Cargo.toml`（**仓库根目录没有 `Cargo.toml`** —— 见附录 A.3）；另有 `experiments/phase21_experiment_a/Cargo.toml`

**docs/**：`ARCHITECTURE.md`、`DEVELOPMENT_STATUS.md`、`REMEDIATION_PROGRESS.md`、`REMEDIATION_TEST_REPORT.md`、`phase16/manual-lan-e2e.md`、`phase16/lan-security-coverage.md`、`PROTOCOL.md`、`COMMUNITY.md`

**`.github/workflows/`**：`ci.yml`（361 行，三个 job 全读）

**`packages/protocol/src/`**：`envelope.ts`、`validation.ts`、`signature.ts`、`canonical-json.ts`、`replay-protection.ts`、`profile-privacy-filter.ts`、`sensitive-field-guard.ts`、`prompt-injection-guard.ts`、`payloads.ts`、`rate-limiter.ts`、`builder.ts`、`serialization.ts`、`index.ts`

**`packages/agent/src/`**：`analyze-match.ts`（`analyzeMatch`，L66）、`identity.ts`（`createAgentIdentity`，L123）、`signer.ts`、`generate-icebreaker.ts`、`generate-chat-assist.ts`、`system-prompt.ts`、`context-builder.ts`、`profile-context.ts`、`heuristics.ts`、`output-parser.ts`、`profile.ts`

**`packages/transport/src/`**：`pairing-session.ts`（L300-1040 重点）、`connection-state.ts`、`webrtc-transport.ts`、`lan-transport.ts`、`loopback-transport.ts`、`pairing-code.ts`、`pairing-fingerprint.ts`、`session` 密钥协商

**`packages/storage/src/`**：`sqlite-database.ts`、`memory-database.ts`、`sql-migrator.ts`、`sql-migrations.ts`、`legacy-migration.ts`、`browser-store.ts`、`chat-repository.ts`、`profile-store.ts`、`blocked-agents-store.ts`、`settings-store.ts`、`secret-store.ts`、`in-memory-secret-store.ts`、`encrypted-local-storage-secret-store.ts`、`database.ts`、`database-stores.ts`、`sql-executor.ts`

**`packages/matching/src/`**：`orchestrator.ts`（`MatchOrchestrator`）、`consent-orchestrator.ts`、`chat-orchestrator.ts`、`chat-assist-orchestrator.ts`、`chat-persistence.ts`、`display.ts`

**`packages/llm/src/`**：`http.ts`、`errors.ts`、`providers/openai-compatible.ts`、`providers/anthropic.ts`、`providers/ollama.ts`、`providers.live.test.ts`

**`apps/desktop/src/`**：`App.tsx`、`main.tsx`、`lib/agent-service.ts`、`lib/agent-keychain-migration.ts`、`lib/tauri-agent-keychain.ts`、`lib/tauri-secret-store.ts`、`lib/tauri-sql-executor.ts`、`lib/database.ts`、`lib/chat-history.ts`、`lib/chat-persistence.ts`、`lib/connect-service.ts`、`lib/lan-connect-service.ts`、`lib/llm-service.ts`、`lib/runtime-stores.ts`；`views/` 全部 13 个视图 + `views/__tests__/`

**`apps/desktop/src-tauri/`**：`Cargo.toml`、`tauri.conf.json`、`build.rs`、`capabilities/default.json`、`src/lib.rs`、`src/main.rs`、`src/secrets.rs`、`src/lan.rs`（1819 行，重点 L300-500 / L820-960 / L990-1100 / L1280-1400 / L1420-1620）、`tests/lan_e2e.rs`、`tests/lan_protocol_e2e.rs`、`tests/lan_limits.rs`

**`packages/llm/src/__tests__/providers.live.test.ts`**（8 条 live 测试的实际内容）

### A.2 外部取证

| 来源 | 取得内容 |
|---|---|
| GitHub REST `/repos/{o}/{r}` | `has_discussions: false`、`visibility: public`、`open_issues_count: 0` |
| GitHub REST `/actions/runs?branch=main` | 15 次 main 运行及其结论 |
| GitHub REST `/actions/runs/{id}/jobs` | 全部 15 次运行的**逐步骤结论** |
| GitHub REST `/check-runs/{sha}` | 三个 job 的 check-run 状态 |
| GitHub REST `/actions/jobs/{id}/logs` | **HTTP 403 — 不可读**（已记为取证限制） |
| `actions/runner-images` 仓库 | Ubuntu 24.04 镜像内容清单（确认缺 webkit 开发包） |
| `cargo metadata --filter-platform x86_64-unknown-linux-gnu` | Linux 依赖图（确认含 `webkit2gtk` / `javascriptcore-rs` / `soup3` / `glib`，不含 `security-framework`） |

### A.3 不存在 / 未创建的文件（按任务书 §3 记录，不自行创建）

| 路径 | 状态 |
|---|---|
| **仓库根目录的 `Cargo.toml`** | **不存在** —— 任务书 §3 要求检查的 `Cargo.toml` 在仓库根**没有**；实际的 Rust crate 根是 `apps/desktop/src-tauri/Cargo.toml`，另有一个独立的 `experiments/phase21_experiment_a/Cargo.toml`。本次审计以后者为准，**未自行创建根 `Cargo.toml`**。 |
| `docs/audits/`（审计前） | **不存在** —— 本次按任务书要求创建 |
| `docs/audits/KINDORA_CURRENT_STATE_AUDIT_2026-11-06.md` | 审计前**不存在** —— 未覆盖任何文件 |
| `packages/storage/package.json` 的 SQLite 引擎依赖 | **不存在** —— 由设计决定（SQL 由 `SqlExecutor` 端口下发） |
| `apps/desktop/src-tauri/src/` 中的 `agent_sign` | **不存在** —— 见 SEC-01 |
| `apps/desktop/src/components/AppErrorBoundary.tsx` | **不存在** —— 见 UI-01 |
| `tauri.conf.json` 的 `bundle.macOS` 块 | **不存在** —— 见 PKG-01 |
| `apps/desktop/package.json` 的 `build:fast` 脚本 | **不存在** —— 见 DOC-02 |
| GitHub Releases / 安装包产物 | **不存在** —— 仓库为 source-only |

---

## 附录 B：状态词使用自查

本报告全文使用且仅使用这 7 个状态词：

| 状态 | 本报告中的用法 | 反引号标注的计数 |
|---|---|---:|
| `NOT_IMPLEMENTED` | Rust 侧 `agent_sign`、IPC 权限边界（app 命令不受 ACL 约束）、React 错误边界、流式输出、传输层 TLS、macOS 签名/公证/安装包、bundle.macOS、Token 上限 | **14** |
| `STUB` | WebRTC | **4**（其中 3 处是词表定义/摘要，只有 1 处是模块级状态判定） |
| `IMPLEMENTED` | 代码齐备但缺真实验证的绝大多数功能点 | **25** |
| `TESTED` | 本次真实运行通过、且断言与被测行为对应的功能点 | **24** |
| `VERIFIED` | **无任何功能点被标为此状态** | **0**（全文 5 次出现均为词表定义或否定陈述） |
| `BLOCKED` | 需要真实设备 / 凭据 / Apple 账号 / CI admin 权限的验证 | **3** |
| `NOT_RUN` | live Provider 测试、真实 SQLite、打包 App 启停与重启恢复、`.dmg` 产出、跨平台 Rust 矩阵、`cargo audit`（本地）、双设备 GUI 用例 | **45**（含 28 条 GUI 用例） |

> 计数方式：对全文被反引号包裹的状态词做精确匹配。`NOT_IMPLEMENTED` / `IMPLEMENTED` / `TESTED` 的计数低于功能点总数，是因为部分功能点在表格里直接写状态而未重复标注——**这不影响结论：本报告零个 `VERIFIED`**。

> **本报告没有任何一个功能被标记为 `VERIFIED`。** 依据任务书 §9：宁可标记 `NOT_RUN`，也不能把没有证据的功能标记为 `VERIFIED`。

---

**审计报告结束。本次任务不实施任何整改；下一步由项目所有者决定从 P0-1 与 P0-2 开始。**
