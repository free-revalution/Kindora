# Kindora 整改执行清单（REMEDIATION PLAN）

**来源任务书：** [`docs/修复.md`](./修复.md)
**基线 commit：** `020b15d`（"commit logo"），分支 `main`
**基线复核日期：** 2026-11-02
**最近更新：** 2026-11-06（**第二十三批：把 Phase A / Phase C 的「阶段级」状态从 `VERIFIED` 改回 `IMPLEMENTED`** —— 一处「文档自相矛盾」的订正。**第五批（2026-11-04）把这两个阶段的阶段级单元格填成了 `VERIFIED`，但同一个仓库里的另外四份文档当时就写着「一个阶段都没到 `VERIFIED`」** —— `README.md`、「本文件 § 9.3」、`docs/REMEDIATION_TEST_REPORT.md` § 8.8.20.10、`docs/phase16/manual-lan-e2e.md`。**根因是把两层混成了一层**：第五批原文写的是「Phase A 与 Phase C 的『实现部分』状态升为 `VERIFIED`」——「实现部分」指的是**条目**（A1–A4 / C1–C3 / C-3a）；这些条目自己的验收标准与对应测试确实都过了，**条目级的 `VERIFIED` 一个不动**，只有阶段级那一格要改。**判据有两条，都是任务书原文**：第 1121 行「真实双设备完整流程全部通过，才能将 LAN 核心流程标记为 VERIFIED」—— Phase C 就是「LAN 核心流程」，而 H3 至今 `BLOCKED`；§ 2.2 最后一条「不允许将未实现功能标记为 VERIFIED」—— A-1 的 Rust 侧 `agent_sign` 全树不存在（`grep -rn "agent_sign" apps/desktop/src-tauri/ apps/desktop/src packages/*/src` 返回空，而四个 `agent_key_*` command 都在，所以是「未实现」不是「没找到」）。**本仓库自己的规则早就是对 B / D / E / F / G 用过同一条判据**（「仍不是 `VERIFIED` —— H3 仍 `BLOCKED`」/「CI 里没有真 SQLite」）—— **A 与 C 是仅有的两个例外**。**第四批 / 第五批的历史记录一字未改**；本批没有改任何产品代码、没有新增用例、没有删任何测试、没有提交、没有推送 → § 8.8.22）

**上一批（第二十二批）：** 2026-11-06（补跑第二十批新增的 3 条回归用例 —— **发现一处证据缺口并把它堵上。** 第二十批修完 8 个类型缺陷后新增了 3 条回归用例；第二十一批复跑时**从 `08a-typecheck` 开始**，`01`~`07` **七个 TS 套件全部被跳过** —— 于是**那 3 条用例从来没有被执行过**。**这是靠文件时间戳与日志时间戳对照查出来的，不是靠记忆**：`profile-store.test.ts` 最后修改 **15:17:44**，而 `04-storage-test` 跑在 **14:08:38** —— **那次运行跑的是旧文件**；桌面端两个文件同理。**⚠️ 根因是一个混淆：「类型检查通过」被当成了「用例跑过」** —— `08a` 只做类型检查、不做运行，而第二十批改完代码后没有再跑一遍套件。✅ **本批从 `01-protocol-test` 整条重跑**：`01`~`07` **全 EXIT=0**、`07` 连跑 5 次每次 151/151、`08a`/`08b`/`08c` **EXIT=0**；**`packages/storage` 从 165/165 变成 168/168 —— 那 3 条新用例全过**；`apps/desktop` **151/151**（那两处只改类型、不增删用例，但**仍是新代码下的第一次运行**）；`packages/llm` **56 通过 + 8 跳过**（**跳过仍是跳过，不是通过**）；`pnpm -r test` **EXIT=0** —— **合计 1035 条 TypeScript 用例全绿**。✅ **Rust 那一侧不必重跑**：所有 `*.rs` 里最新的一个是 2026-11-05 14:11:21，而四套件跑在 2026-11-06 20:01~20:02 —— **源文件一个字节都没动**，**48/48 的证据依然成立**。（**「什么时候可以不重跑」的判据不是「上批跑过了」，而是「自那次运行以来被测文件有没有变过」——查过才能说没变。**）🔴 **顺带修掉一处**假的**复现命令**：`docs/DEVELOPMENT_STATUS.md` 里那条「基线 567 条用例」的 `git grep -ohE "^\s*it\("` —— **它返回的是 0，不是 567**，因为 `git grep -E` 是 **POSIX ERE、不是 PCRE，不支持 `\s`**；正确写法是 `[[:space:]]`。**一个会让人以为「基线是 0 条用例」的假命令，比没有命令更坏。**⚠️ **本批没有让任何阶段前进一格 —— 这是对的**：H3 真实双设备仍 `BLOCKED`、E2 真实 provider 仍 `NOT_RUN`、CI 里仍没有真 SQLite、`08d` 仍红、`09h` 仍 `NOT_RUN`。**补齐证据 ≠ 前进一个阶段** → § 8.8.21）

**上一批（第十九批）：** 2026-11-06（**Phase H 落地 —— H1（CI 重写）+ H2（LAN 安全测试台账）。本批一行业务代码都没改，验收状态全部 `NOT_RUN`** —— `.github/workflows/ci.yml` 重写为**三个 job**，任务书 H1 的**十项要求全覆盖**：typecheck / **ESLint** / **Prettier** / **cargo fmt --check** / **cargo clippy** / `cargo test --lib` / `pnpm -r test` / **Tauri 构建检查**（独立 job，`--no-bundle`）/ **依赖安全检查**（独立 job，**记录不阻断** —— 任务书第 149 行「记录依赖漏洞和过期依赖，但不要在本阶段批量升级」）/ **关键检查全部阻断**；`.cache/verify.sh` 补 `08d-format-check`。H2 新增 `docs/phase16/lan-security-coverage.md` —— **13 个安全场景 → 具体用例的逐条台账，13/13 都有可重复的自动化测试，新增 0 条用例**；台账里查清了一件容易搞错的事：**Rust 传输层本身不做认证**（字节管道，设计如此），真正挡下"未知设备"的是**会话层的指纹钉住**。⚠️ **四条新门禁本地一次都没跑过 → CI 现在预期是红的** —— 这是任务书第 10 条「关键检查失败时 CI 必须失败，不能只输出 warning」的直接后果，**不是**通过屏蔽 lint 制造 PASS。**H3 仍 `BLOCKED`** → § 8.8.18）

**上一批（第十八批）：** 2026-11-06（**六个 TS 套件 976 个用例全绿**，以及 `08a-typecheck` 抓出并修掉的一个**基线遗留的类型坑** —— 维护者代跑后 `01-protocol-test` **215/215**、`02-transport-test` **211/211**（Phase G 的 12 条全绿）、`03-agent-test` **148/148**（Phase F 的 17 条全绿）、`04-storage-test` **165/165**、`05-matching-test` **86/86**、**`06-desktop-test` 151/151（桌面端套件第一次真跑）**、`07-connectview` **连跑 5 遍全绿**；gate 停在 **`08a-typecheck` EXIT=2** —— **1 条 TS 错误**：`SocialProfile.interests` 在基线里被写成了 `SocialIntent[] \| string[]`（**数组类型的联合**），TypeScript 在它上面**取不到可用的 `push` 签名**，撞上了 Phase B 那条"出站副本是深拷贝"的用例。**全仓库没有任何一处往 `interests` 里放过 `SocialIntent`**（装 intent 的是 `socialIntent` 字段），线上校验器 `validation.ts:249` 一直要求它是**字符串数组** → **真值就是 `string[]`**，已收窄（**接受的值集合完全没变**，运行时校验一条没动，**一条断言都没改**）。顺带查出**第二个缺口**：`.cache/verify.sh` 的步骤表里**从来没有 `packages/llm`** —— 这就是 Phase E 的套件从实施到今天一次都没被执行过的**真实原因**，已补 `04b-llm-test`。⚠️ **B / D / E / F / G 仍是 `IMPLEMENTED`，不是 `VERIFIED`** —— 它们的**测试行已全绿**，但**工具链行 `08a` / `08b` / `08c` 还没绿**（按 Phase D 早就定下的先例："验收要看的几行里还有哪一行没绿 → 一律 `IMPLEMENTED`"）→ § 8.8.17）
**执行纪律：** 分阶段推进；每项任务在 `docs/REMEDIATION_PROGRESS.md` 中记录状态；`IMPLEMENTED` 不等于 `VERIFIED`。

> **当前进度一览（2026-11-06，第二十三批订正后）：**
>
> | 阶段                                       | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
> | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Phase 0（基线）                            | `IN_PROGRESS` —— 0.1 / 0.2 / 0.3 / 0.4 / 0.6 / 0.7 / 0.8 均 `VERIFIED`；**0.5 两侧都出结果了**（`pnpm audit` **46 条**，全在 devDependency 链上；`pnpm outdated -r` **25 个落后包**；`cargo update --dry-run` **68 个落后 crate**）—— **一个都没升级**（第 149 行）；⚠️ **`cargo audit` 连续两次因网络取不到 RustSec 库而没扫成 → 仍记 `NOT_RUN`**（**`EXIT=1` 在这一步有两种含义：有漏洞表 = 真扫了，只有 fetch 报错 = 根本没扫**）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
> | Phase A（身份 / 密钥 / 通信安全）          | `IMPLEMENTED` —— ⚠️ **第二十三批（2026-11-06）由 `VERIFIED` 改回**：任务书第 1121 行要求真实双设备验收通过才能把 LAN 核心流程标为 `VERIFIED`，H3 仍 `BLOCKED`；A-1 / A-2 / A-5 / A-8 / A-10 / A-14 仍是未决项。**A1–A4 的条目级 `VERIFIED` 保留**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
> | Phase B（隐私授权 / Profile / 黑名单）     | `IMPLEMENTED` —— **B1 / B2 / B3 三条都已改完；测试行已全绿**（`01-protocol-test` ✅ **215/215**、`03-agent-test` ✅ **148/148**、`04-storage-test` ✅ **168/168**、`05-matching-test` ✅ **86/86**、`06-desktop-test` ✅ **151/151**）；⚠️ **工具链行 `08a` / `08b` / `08c` 第二十一批已转绿**（**8 处类型修复全部生效**）；⚠️ **第二十二批：`04-storage-test` 从 165/165 变成 168/168 —— 第二十批新增的那 3 条回归用例此前从未被执行过，本批补跑并全过**。**仍不是 `VERIFIED`** —— **H3 真实双设备验收仍 `BLOCKED`** → § 8.7 / § 8.8.11 / § 8.8.12 / § 8.8.17 / § 8.8.19 / § 8.8.20 / § 8.8.21                                                                                                                                                                                                                                                                                                                                                   |
> | Phase C（LAN 可靠性）                      | `IMPLEMENTED` —— ⚠️ **第二十三批（2026-11-06）由 `VERIFIED` 改回**：Phase C 就是任务书第 1121 行说的「**LAN 核心流程**」，H3 仍 `BLOCKED`；**收尾项还剩 `MAX_FRAME_BYTES` 16 MiB → 1 MiB 的人工确认**（归 I1）。**C1 / C2 / C3 / C-3a 的条目级 `VERIFIED` 保留**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
> | Phase D（数据持久化 / 本地数据管理）       | `IMPLEMENTED` —— **D1 / D2 都已改完；存储层 `04-storage-test` ✅ 168/168**；⚠️ **`08a` / `08b` / `08c` 第二十一批已转绿**（**Phase D 自己的两个桌面端文件那 5 条类型错误已修并确认消失**）；⚠️ **第二十二批：`04-storage-test` 从 165/165 变成 168/168 —— 那 3 条第二十批新增的回归用例此前从未被执行过，本批补跑并全过**。**仍不是 `VERIFIED`** —— **CI 里没有真实 SQLite**（**SQL 语句从未被真实 SQLite 执行过**）、打包应用里的四条重启验证（D-3）未做 → § 8.8 / § 8.8.10 / § 8.8.11 / § 8.8.12 / § 8.8.17 / § 8.8.19 / § 8.8.20 / § 8.8.21                                                                                                                                                                                                                                                                                                                                                                                                    |
> | Phase E（LLM Provider 可靠性）             | `IMPLEMENTED` —— **E1 / E2 都已改完**（E1：新增 `errors.ts` + `http.ts`，**三个 Provider 走同一份传输层**，请求格式一个字节没动；E2：独立 live 测试文件，**两道开关**（`KINDORA_LLM_LIVE=1` + 必填 `BASE_URL`/`MODEL`/`KEY`），无凭据时 `skipIf` → **跳过而不是假通过**）；**`packages/llm` 套件 ✅ EXIT=0 —— 56 通过 + 8 跳过（64 条注册）**；⚠️ **`08a` / `08b` / `08c` 第二十一批已转绿**。**仍不是 `VERIFIED`** —— **E2 真实接口测试是 `NOT_RUN`**，没有凭据就永远是 `NOT_RUN`（任务书 § 八 E2 验收标准原文）；**仍欠真实 Provider 请求格式的实测记录** → § 8.8.13 / § 8.8.17 / § 8.8.19 / § 8.8.20                                                                                                                                                                                                                                                                                                                                           |
> | Phase F（Prompt Injection 与敏感信息防护） | `IMPLEMENTED` —— **F1 / F2 都已改完**（F1：`sensitive-field-guard.ts` 改成**宁可拒绝不可放过** —— 字段名统一规范化 + 5 类明确拒绝理由 + 超长字符串**扫全文** + 超深 / 超大 / 循环 / 不可验证**一律拒绝**，且 `assertNoSensitiveFields` **在 `transport.send()` 之前**跑；F2：`prompt-injection-guard.ts` + `context-builder.ts` 改成**结构优先、正则其次** —— 每一段外部内容进**显式分隔块**并**逐行转义**、**带来源标签**、超深 / 超大**丢弃并上报**（`UntrustedNotice`）、**正则不再是唯一判据**）。**✅ 全部 104 条实测通过**（`01-protocol-test` **215/215** + `03-agent-test` **148/148**）；⚠️ **`08a` / `08b` / `08c` 第二十一批已转绿**（**F 加的 `notices` 必填字段那条夹具过期已修并确认消失**）。**仍不是 `VERIFIED`** —— **仍欠真实对抗样本的实测记录**（目前只有静态用例）、**H3 仍 `BLOCKED`** → § 8.8.14 / § 8.8.16 / § 8.8.17 / § 8.8.19 / § 8.8.20                                                                               |
> | Phase G（WebRTC 状态整理）                 | `IMPLEMENTED` —— **G 已改完**（`webrtc-transport.ts` 重写为**显式的 `NOT_IMPLEMENTED` 桩**：类型化的 `WebRtcNotImplementedError` + **稳定错误码** `WEBRTC_NOT_IMPLEMENTED`；`connect()` / `send()` / `onMessage()` / `onClose()` **四个入口全部抛**，`disconnect()` **安全返回**；**代码里没有 resolve 分支** → 不可能出现虚假的“已连接”；新增 `WebRtcSignallingAdapter` / `WebRtcSignallingEvent` **后续实现的契约**；文件头写明**信令 / ICE / STUN-TURN 方案**、**与 LAN 共用同一套身份与消息安全层**、**不得成为绕过隐私授权的通道**）。**✅ 12 条实测通过**；⚠️ **`08a` / `08b` / `08c` 第二十一批已转绿**（`packages/transport` 的 `tsc` 干净，211/211 全绿）。G 的验收标准「README、UI 和能力声明均不再将 WebRTC 描述为已实现功能」——**第二十一批在 `README` / `ROADMAP` / `docs/ARCHITECTURE.md` / `SECURITY.md` 四处逐条核过，一致**。**仍不是 `VERIFIED`** —— **H3 仍 `BLOCKED`** → § 8.8.15 / § 8.8.16 / § 8.8.17 / § 8.8.19 / § 8.8.20 |
> | Phase H（CI 与完整测试）                   | `IN_PROGRESS` —— **H1（`.github/workflows/ci.yml` 重写，十项要求全覆盖）**：⚠️ **第二十一批实测把六条门禁第一次跑成绿**（`08a` / `08b` / `08c` / `09d` / `09e` / **`09f` —— Tauri 生产构建第一次跑通，`Kindora.app` + `.dmg` 都出来了**）；🔴 **唯一还红的是 `08d-format-check` —— 111 个文件**（**81 个基线就有 + 30 个整改期新增**，已用 `git ls-tree` 比对 + `git show HEAD:<file>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | npx prettier --check`抽查三个基线文件核实 → **历史状态，不是回归**）。**修法是`pnpm format`，不是往 `.prettierignore`里加`docs/`** —— 后者是 § 2.2 明令禁止的“屏蔽检查来制造 PASS”；**这一步由维护者执行**（全仓重排会碰到用户未提交的修改与任务书本身）。**CI 里这一步被故意挪到 `build`job 的最后**（**仍然是阻断的** —— 没有`continue-on-error`、没有 ` |     | true`，**只是挪了位置**），这样**一个红的格式检查不会把前面九项检查的结果一起盖住**。H2（**13 个安全场景 → 用例台账** `docs/phase16/lan-security-coverage.md`，**13/13 都有可重复的自动化测试**，**新增 0 条用例**；**靠 Rust 那一半的 7 个场景 48/48 全绿**）；**H3 因需两台真机而 `BLOCKED`**；⚠️ **第二十二批：查出并堵上一处证据缺口 —— 第二十批新增的 3 条回归用例此前从未被执行过**（第二十一批复跑从 `08a-typecheck` 开始，`01`~`07` 七个 TS 套件全被跳过；**`profile-store.test.ts`的 mtime（15:17:44）晚于`04-storage-test`的运行时刻（14:08:38）** —— **靠时间戳对出来的，不是靠记忆**）。✅ **本批从`01-protocol-test` 整条重跑**：`01`~`07` **全 EXIT=0**、**`packages/storage` 165/165 → 168/168（那 3 条新用例全过）**、`apps/desktop` **151/151**、**`07` 连跑 5 次每次 151/151**、`08a`/`08b`/`08c` **EXIT=0**、**`pnpm -r test`EXIT=0 —— 合计 1035 条 TypeScript 用例全绿**。✅ **Rust 侧不重跑**（**所有`*.rs` 最新 mtime 2026-11-05 14:11:21 早于四套件的运行时刻 2026-11-06 20:01~20:02 → 源文件一个字节没动** → **48/48 的证据依然成立**，**查过才敢跳过**）。🔧 **顺带修掉一处假的复现命令**（`git grep -E`是 POSIX ERE、**不支持`\s`** → 正确写法 `[[:space:]]`；**一个会让人以为"基线是 0 条用例"的假命令，比没有命令更坏**）。⚠️ **本批没有让任何阶段前进一格** —— **补齐证据 ≠ 前进阶段** → § 8.8.18 / § 8.8.19 / § 8.8.20 / § 8.8.21 |
> | Phase I（文档与发布准备）                  | `IMPLEMENTED` —— **第二十一批实施**：任务书**十二项要求逐条落到文件上**（① 当前真实状态 ② 安全架构 ③ 密钥算法 ④ 密钥存储机制 ⑤ LAN 通信加密机制 ⑥ **隐私授权流程** ⑦ 数据库结构 ⑧ WebRTC 状态 ⑨ 已知限制 ⑩ 安装和运行方式 ⑪ **区分自动化测试和真实设备测试** ⑫ **不允许把计划中的功能写成已完成**）；落在 `SECURITY.md`（**新增「Privacy and consent」一节**）、`docs/ARCHITECTURE.md`、`ROADMAP.md`、`docs/AUDIT_V0.1_PHASE14.md`、`docs/phase16/manual-lan-e2e.md`、`README.md`、`docs/DEVELOPMENT_STATUS.md`。⚠️ **不是 `VERIFIED`** —— **文档改动没有测试覆盖**，只能靠人工逐条核对代码；**发布状态统一（版本号 / tag / installer）尚未做** → § 8.8.20                                                                                                                                                                                                                                                                                        |
>
> **逐条证据见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.10（第四批）、**§ 8.4.11（第五批）**、
> **§ 8.4.12（第六批）**、**§ 8.4.13（第七批）**、**§ 8.4.14（第八批）**、
> **§ 8.7（第九批 —— Phase B 实施记录；⚠️ 该节没有任何 `EXIT=` 数字，命令全是 `NOT_RUN`）**、
> **§ 8.8（第十批 —— Phase D 实施记录；⚠️ 同样没有任何 `EXIT=` 数字，命令全是 `NOT_RUN`）**、
> **§ 8.8.10（第十一批 —— Phase D 第一次真跑；⚠️ `04-storage-test` `EXIT=1`，2 条失败已修）**、
> **§ 8.8.11（第十二批 —— `04-storage-test` `EXIT=0`（165/165 全绿）；`05-matching-test` `EXIT=1`，1 条超时已修）**、
> **§ 8.8.12（第十三批 —— `06-desktop-test` 的静态预审；⚠️ 没有任何 `EXIT=` 数字，是只读走查）**、
> **§ 8.8.13（第十四批 —— Phase E 的实施；⚠️ 同样没有任何 `EXIT=` 数字，命令全是 `NOT_RUN`）**、
> **§ 8.8.14（第十五批 —— Phase F 的实施；⚠️ 同样没有任何 `EXIT=` 数字，命令全是 `NOT_RUN`）**、
> **§ 8.8.15（第十六批 —— Phase G 的实施；⚠️ 同样没有任何 `EXIT=` 数字，命令全是 `NOT_RUN`）**、
> **§ 8.8.16（第十七批 —— 第一批真实运行证据；`01-protocol-test` EXIT=0 / 215/215、`02-transport-test` EXIT=1 / 1 failed + 210 passed）**、
> **§ 8.8.17（第十八批 —— 六个 TS 套件 **976 个用例全绿** + `08a-typecheck` 抓出的类型坑已修；`04b-llm-test` 补进脚本）**、
> **§ 8.8.18（第十九批 —— Phase H：H1 的 CI 重写 + H2 的安全测试台账；⚠️ 本批全部 `NOT_RUN`，没有一行代码被运行过）**、
> **§ 8.8.19（第二十批 —— 复跑实测：TypeScript **1032 条通过 + 8 条跳过**、Rust **48/48 全绿**、两条 Rust 门禁转绿；🔴 类型检查抓出 **8 个类型缺陷**（已修、**待复跑**）；依赖审计出了结果，**`cargo audit` 因网络故障仍 `NOT_RUN`**）**。
> **§ 8.8.20（第二十一批 —— 类型门禁转绿、Tauri 生产构建跑通、依赖清单出齐、Phase I 文档对齐：✅ `08a-typecheck` **EXIT=0**（第二十批那 8 处类型修复全部生效，`packages/matching` 与 `apps/desktop` **第一次被类型检查**、无新错误）、`08b-build-packages` **EXIT=0**、`08c-lint` **EXIT=0**（ESLint 第一次整树跑绿）、`09a`~`09c2` **48/48**、`09d`/`09e` **EXIT=0**、**`09f-tauri-build` EXIT=0（Tauri 生产构建第一次跑通 —— `Kindora.app` 6.52 MiB + `Kindora_0.1.0_aarch64.dmg` 3.25 MiB）**；🔴 **`08d-format-check` 仍红 —— 111 个文件 = 81 个基线就有 + 30 个整改期新增**（已用 `git ls-tree` + `git show HEAD:<file> | npx prettier --check` 核实 → **历史状态不是回归**），**修法是 `pnpm format`，不是往 `.prettierignore` 加 `docs/`**（§ 2.2 禁止屏蔽检查制造 PASS），**`.prettierignore` 一行没动**；**CI 里这一步被挪到 `build` job 最后但仍然阻断**（无 `continue-on-error`、无 `|| true`）—— **挪位置，不是削弱**；✅ 依赖清单两侧都出结果：`pnpm audit` **46 条（全在 devDependency 链）**、`pnpm outdated -r` **25 个落后包**（`npm_config_registry` 写法生效，**这次是真结果不是用法错误**）、`cargo update --dry-run` **68 个落后 crate**（`Cargo.lock` 一行未动）—— **都没升级**（第 149 行）；⚠️ **`cargo audit` 连续第二次因网络取不到 RustSec 库 → 仍记 `NOT_RUN`**；📄 **Phase I 实施完成 → `IMPLEMENTED`**（任务书十二项要求逐条落到 `SECURITY.md` / `docs/ARCHITECTURE.md` / `ROADMAP.md` / `docs/AUDIT_V0.1_PHASE14.md` / `docs/phase16/manual-lan-e2e.md`）；⚠️ **一个阶段都没升到 `VERIFIED`** —— **「自动化测试全绿」和「这个阶段可以验收」是两件事**）**。
> **§ 8.8.21（第二十二批 —— 补跑第二十批新增的 3 条回归用例：**靠时间戳查出一处证据缺口** —— 第二十批新增的 3 条回归用例**从未被执行过**（第二十一批从 `08a` 复跑，`01`~`07` 全被跳过；`profile-store.test.ts` 的 mtime **15:17:44** 晚于 `04-storage-test` 的 **14:08:38**）；✅ **本批从 `01-protocol-test` 整条重跑**，`01`~`07` **全 EXIT=0**、**`packages/storage` 165→168/168（那 3 条新用例全过）**、`apps/desktop` **151/151**、`07` 连跑 5 次全绿、`pnpm -r test` **EXIT=0 —— 合计 1035 条全绿**；**Rust 侧不重跑**（`*.rs` 最新 mtime 早于四套件的运行时刻 —— **查过才敢跳过**）；🔧 **修掉一处假的复现命令**（`git grep -E` 不支持 `\s`，正确写法是 `[[:space:]]`）；⚠️ **本批没有让任何阶段前进一格** —— **补齐证据 ≠ 前进阶段**）**。
> **§ 8.8.22（第二十三批 —— 把 Phase A / Phase C 的**阶段级**状态从 `VERIFIED` 改回 `IMPLEMENTED`：** 一处**文档自相矛盾**的订正 —— 第五批把两个阶段的阶段级单元格填成了 `VERIFIED`，但任务书第 1121 行写明「真实双设备完整流程全部通过，才能将 LAN 核心流程标记为 VERIFIED」（H3 仍 `BLOCKED`），§ 2.2 最后一条写明「不允许将未实现功能标记为 VERIFIED」（A-1 的 Rust 侧 `agent_sign` **至今未实现** —— 全树 `grep` 返回空，而四个 `agent_key_*` command 都在）；而本仓库**自己的规则**早已对 B / D / E / F / G 用过同一条判据（「仍不是 `VERIFIED` —— H3 仍 `BLOCKED`」/「CI 里没有真 SQLite」）—— **A 与 C 是仅有的两个例外**。**条目级（A1–A4 / C1–C3 / C-3a）的 `VERIFIED` 一个没动**；**第四批 / 第五批的历史记录一字未改**；**本批没有改任何产品代码、没有新增用例、没有删任何测试**）**。
>
> **第五批的实测结论（2026-11-04）：**
> TypeScript **685 个用例全绿**（protocol 137 / transport 199 / agent 129 / storage 32 / matching 61 / desktop 127）、
> Rust **48 个用例全绿**（lib 13 / lan_e2e 18 / lan_protocol_e2e 13 / lan_limits 4）、
> `pnpm -r typecheck` / `pnpm lint` / 六个包 `tsc -p` / Tauri 构建 / **`cargo fmt --check`** 全部 `EXIT=0`。
> **上一批欠的四件事销了三件** —— `lan_protocol_e2e` 13/13、`cargo fmt` 转绿、`protocol` 的 137 条纳入同批。
> **只剩两项收尾**：clippy 再复跑一次、`cargo audit`（工具未装）。
>
> **第六批的实测结论（2026-11-04）：**
> `cargo clippy --all-targets --all-features -- -D warnings` → **`EXIT=0`，0 error**。
> clippy 的收敛链是 **基线 10 → 第四批 12 → 第五批 11（旧文档 lint）→ 第六批 0**。
> **至此只剩 `cargo audit` 一项** —— `cargo-audit` 工具**已由维护者装好**，只差再跑一次 `09h`。
>
> **第七批的实测结论（2026-11-04）：**
> `cargo audit` **仍未真正运行** —— `09h` 以**退出码 2** 结束，日志是
> `error: unexpected argument '--manifest-path' found`。
> **退出码 2 是 clap 的命令行用法错误，不是"发现了漏洞"**：
> `cargo audit` 审计的是 **`Cargo.lock`**（参数 `--file`），**不接受 `--manifest-path`**。
> **脚本已修**（`--file apps/desktop/src-tauri/Cargo.lock` + "进 crate 目录跑"的退路）。
> **A-12 / 0.5 仍记 `NOT_RUN`** —— 在拿到 `EXIT=0`（干净）或 `EXIT=1`（扫到东西）之前，
> **不能说"扫过了"**。详见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.13。
>
> **第八批的实测结论（2026-11-05）：**
> `cargo audit` **终于真的跑起来了** —— `09h-cargo-audit` **`EXIT=1`**
> （cargo-audit 的"发现了漏洞"语义，**不是脚本失败**），扫描 **521 个 crate**、
> 载入 **1403 条 advisory**，结果是 **1 条 vulnerability + 3 条 allowed warnings**：
>
> - **`rsa` 0.9.10** —— RUSTSEC-2023-0071（Marvin Attack 时序侧信道），**5.9 / medium**，
>   依赖链 `kindora-desktop → tauri-plugin-sql → sqlx → sqlx-mysql → rsa`。
>   **可达性判定：不可达** —— 产品代码零处引用 `sqlx`/`mysql`/`postgres`；
>   SQL 插件虽注册，但**未向前端暴露任何 `sqlite_*` 命令**（`src/lib.rs:12-13`），前端亦零引用。
>   ⚠️ **第十批（Phase D）之后这个前提变了**：前端**开始**用这个插件了（只走写死的 `sqlite:` 连接串），
>   **结论仍是"不可达"** —— 理由换成"连接串写死 + 全部参数化绑定，**没有 MySQL 的注入口**" ——
>   逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.14.3 的追加说明。
> - `proc-macro-error` / `glib` —— gtk 栈（**仅 Linux 编译**）的 unmaintained / unsound warning。
> - `tokio` 1.53.2 —— RUSTSEC-2026-0386（`AsyncFd` 违反 I/O safety）；
>   tokio **确有使用**，但全仓库 **`AsyncFd` 零命中**。
>
> **按任务书第 149 行：只记录、不在本阶段批量升级。**
> **0.5a（依赖漏洞）→ `VERIFIED`**（两侧审计都取得了真实结果、都已记录、都没有升级）；
> **A-12 扫描层面已消解**，**漏洞本身的修复归 Phase H**。
> **0.5b（过期依赖清单）仍 `NOT_RUN`** —— 第 149 行那句"记录依赖漏洞**和过期依赖**"的
> 后一半还没跑（脚本已补 `09i-pnpm-outdated` / `09j-cargo-outdated` 两步）。
> 详见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.14。
>
> **第九批（2026-11-05）—— Phase B 实施完成，但用例一条都没跑过。**
> B1 / B2 / B3 **由 `NOT_STARTED` 升为 `IMPLEMENTED`**（**不是 `VERIFIED`**）。
> 本轮的执行通道被安全分类器持续拒绝
> （`claude-sonnet-5[1M] is temporarily unavailable, so auto mode cannot determine the safety of Bash right now`），
> 只读命令正常、**所有执行型命令被拒** —— 因此
> **本批没有任何一个 `EXIT=` 数字，Phase B 的每一条测试命令一律记 `NOT_RUN`。**
> **净增 61 条用例**（protocol **+26** / desktop **+17** / matching **+14** / storage **+2** / agent **+2**；
> 六个被整改的包合计 **685 → 746**）。改写 9 个测试文件，其中的 **135 条**用例都要一并跑过。
> 详见 `docs/REMEDIATION_TEST_REPORT.md` § 8.7。
>
> **第十批（2026-11-05）—— Phase D 实施完成，但用例同样一条都没跑过。**
> D1 / D2 **由 `NOT_STARTED` 升为 `IMPLEMENTED`**（**不是 `VERIFIED`**）。
> 本轮的执行通道依旧被安全分类器持续拒绝
> （`claude-sonnet-5[1M] is temporarily unavailable, so auto mode cannot determine the safety of Bash right now`），
> **因此本批同样没有任何一个 `EXIT=` 数字，Phase D 的每一条测试命令一律记 `NOT_RUN`。**
> **净增 145 条用例**（storage **+127** / matching **+11** / desktop **+7**；
> 六个被整改的包合计 **746 → 891** —— ⚠️ 这个口径**不含 `packages/llm` 的 19 条**；
> **全工作区统一口径 = 76 个测试文件 / 910 条**，基线 `020b15d` 是 56 / 567，
> 见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8.6 的清点说明）。
> **Phase D 这一轮做了什么（摘要）：**
> 新增真正的本地业务数据库（`packages/storage/src/sql-migrations.ts` 的 6 张业务表 +
> `schema_migrations` 记账表 + 版本号 `SCHEMA_VERSION = 1`）与迁移器
> （`runMigrations` / `assertDatabaseHealthy`）；
> 桌面端通过**本来就在依赖里的 `tauri-plugin-sql`** 直接调
> `plugin:sql|load|execute|select` —— **没有新增任何 npm 依赖，Phase D 没有动
> `pnpm-lock.yaml`**，CI 的 `pnpm install --frozen-lockfile` 不受影响；
> 旧 localStorage 数据有一次性迁移（`migrateLegacyLocalStorage`，**写库成功之后才删旧副本**）；
> 聊天记录经 `ChatRepository` 落库，经 `@kindora/matching` 定义的 **`ChatPersistence` 端口**
> 接入（**用端口而不是加依赖** —— 同样是为了不动 lockfile）。
> **已知缺口（如实记录）**：CI 里没有真正的 SQLite，**SQL 语句本身没有被真实 SQLite 执行过** ——
> 用例钉的是「端口语义」+「SQL 契约」+「DDL↔DML 列名静态一致性」三层。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8。
>
> **第十批附带的文档更正（同一轮做掉）**：Phase D 让几处「现状描述」变成了假的 ——
> `docs/DEVELOPMENT_STATUS.md` 的「Not implemented」里那三行
> （「SQLite persistence」「Chat history persistence」「Block-list management screen」）
> 说的是 Phase D **之前**的世界，Phase D 之后它们全是假的；同一份文档里还有一批
> 早就过期的数字（用例表写 61 文件 / 656 条、实测基线是 56 / 567、现在是 76 / 914；
> Rust 表写 `--lib` 3 条 / 合计 34 条、实测是 13 / 48），以及一句「Phase A 的用例没跑过」
> —— **Phase A / C 在 2026-11-04/05 真的跑过、全绿**。
> `apps/desktop/src-tauri/src/lib.rs` 的模块注释（说「SQL 插件未向前端暴露命令」）、
> `docs/ARCHITECTURE.md` 的存储描述同理；`docs/GITHUB_GROWTH_AUDIT.md` 是一份
> **时点快照**，给它补了一条 2026-11-05 的「后续变化」注，**没有改写历史正文**。
> 这些一并纠正，逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8.4 的「Phase D 让几处现状描述变成了假的」。
>
> **第十一批（2026-11-05）—— Phase D 的第一次真跑，2 条失败，已修，等复跑。**
> 维护者跑了 `KINDORA_START_AT=01-protocol-test bash /Users/jiang/development/Kindora/.cache/verify.sh`：
> `01-protocol-test` **EXIT=0**、`02-transport-test` **EXIT=0**、`03-agent-test` **EXIT=0**、
> **`04-storage-test` EXIT=1（159/161，2 条失败）**。
> （`00-install` / `00b-typecheck` 因为从 `01` 起跑而 **SKIPPED** —— **`08a-typecheck` 这一次仍然没跑**。）
>
> **这是 Phase D 那 145 条净增用例第一次被真正执行** —— 也是整个整改里
> **第一次由运行、而不是由阅读**给出的信号。两条失败：
>
> | #   | 位置                                                         | 根因                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 改法                                                                                                                                                                                   |
> | --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 1   | `packages/storage/src/__tests__/sql-migrator.test.ts:184`    | **实现有缺陷。**`runMigrations` 里**建记账表**那一句没有 try/catch，而用例的 `failWhen` 谓词 `/CREATE TABLE IF NOT EXISTS/i` **正好也匹配它** —— 失败以驱动原生的 `Error` 逃出去，违反 `DatabaseError` 注释里那句 _"Never let a raw driver error reach the UI"_ 和 `apps/desktop/src/lib/database.ts:23` 的 _"Every failure here is a `DatabaseError`"_。**真实后果不是"少了个类型"，而是"报错报错了地方"** —— `apps/desktop/src/App.tsx:161-175` 只把 `DatabaseError` 送去「数据库坏了」那一屏，**其它错误一律当成"私钥取不回来了"** | **改实现**：`runMigrations` 的**建记账表 / 读已应用版本 / 写版本行**三处驱动调用**全部包进 try/catch**，失败一律变成 `DatabaseError`；`readSchemaVersion` 同样包。**断言一个字没动。** |
> | 2   | `packages/storage/src/__tests__/sqlite-database.test.ts:551` | **夹具写错了。**用例调用 `listMessages`（发 `FROM messages WHERE session_id = ?`），夹具却把行登记在 `FROM messages WHERE message_id = ?` 上 —— **替身匹配不上，返回空行**，`stored[0]` 是 `undefined`。**实现本身没错。**                                                                                                                                                                                                                                                                                                            | **改夹具**：正则改成 `FROM messages WHERE session_id = \?`，**并加一条 `expect(stored).toHaveLength(1)`**。**五条断言一条没删、一条没放宽。**                                          |
>
> **补了 4 条回归用例**（`sql-migrator.test.ts` 18 → 22）：记账表建不出来 / 读不出已应用版本 /
> 版本行写不进去 / `readSchemaVersion` 读不出来 —— **四条都是 `DatabaseError`**。
> **`packages/storage` 161 → 165 条，全工作区 910 → 914 条（测试文件数 76 不变）。**
>
> ⚠️ **由此更正第十批的一处不实陈述**：第十批写的
> 「写用例的过程中当场读出并修掉了 3 处必然失败的写法」**是假的** ——
> 第 3 处（`failWhen` 谓词）**当时并没有被发现，也没有被修掉**，
> **是这次真跑才暴露的**；**同批还暴露了第 4 处**（夹具登记错了语句）。
> **教训：写的时候"读出并修掉 N 处"这句话，本身也是需要被证伪的。**
>
> **Phase D 仍然是 `IMPLEMENTED`，不是 `VERIFIED`** —— 修完还没复跑。
> **必须复跑**（至少要看到 `04-storage-test` 的 `EXIT=0`）：
>
> ```bash
> # 最快：只跑 Phase D 验收要的那六行（04 → 05 → 06 → 08a → 08b → 08c）
> KINDORA_START_AT=04-storage-test bash /Users/jiang/development/Kindora/.cache/verify.sh
> cat /tmp/kindora-verify/summary.txt
> ```
>
> **全量复跑**（从 `01` 起）用 `KINDORA_START_AT=01-protocol-test` ——
> **0.5b 还欠着**（`09i-pnpm-outdated` / `09j-cargo-outdated`），**只有全量跑才会走到那两步**。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8.10。
>
> **第十二批（2026-11-05）—— 存储层复跑变绿，匹配层暴露 1 条超时。**
> 维护者跑了 `KINDORA_START_AT=04-storage-test bash /Users/jiang/development/Kindora/.cache/verify.sh`：
> **`04-storage-test` EXIT=0（165/165 全绿）**、**`05-matching-test` EXIT=1（85/86，1 条超时）**。
> （`05` 也是 gate 步骤 —— 它不过脚本就停，**`06` / `08a` / `08b` / `08c` 这一次仍然没跑**。）
>
> **① 第十一批修的两处确认生效** —— 一处是实现缺陷、一处是夹具缺陷，
> **Phase D 净增的 149 条用例第一次拿到全绿**。
> **但 Phase D 仍然是 `IMPLEMENTED`** —— 验收要看的六行里还有五行没绿。
>
> **② 匹配层那条超时是 Phase B 的同意门用例**：
> `packages/matching/src/__tests__/match-orchestrator.test.ts` 的
> 「nothing but the public card is sent before the consent」。
>
> | 环节     | 事实                                                                                                                                                                                                                                                                                                                                                |
> | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 根因     | **在用例的等待窗口，不在实现。** `exchangeAndMatch` 的第 2 步是**硬门** —— **对方的 `consent_accept` 必须真的在线上**（任务书 § 五 B2「双方同意」）；这条用例里对方从不回同意，实现等 `peerConsentTimeoutMs` 之后抛 `ConsentRequiredError('peer-timeout')`。**生产默认窗口是 60 秒（人是决定方）**，而 **vitest 的单条用例上限是 5 秒** —— 于是超时 |
> | 改法     | 给被测的 orchestrator 配上**它本来就有的** `peerConsentTimeoutMs: 200`（**同一个文件里另外两条用例早就在用这个开关**）。**断言一条没删、一条没放宽，还加了一条更严的** —— 现在还断言 `reason === 'peer-timeout'`。**生产默认值一个字没动**                                                                                                          |
> | 顺带查过 | **产品链路是通的** —— `ConsentOrchestrator` 在用户点同意时**自己就发** `consent_accept`（`consent-orchestrator.ts:277`）；`MatchOrchestrator` 的 `SessionQueue` **跨两个阶段存活**（`orchestrator.ts:424-432`），对方那句信封在同意界面亮着时就进了缓冲区；`PairingSession.onMessage` 的 handler 是 **`Set`**，两个 orchestrator **不会互相顶掉**   |
>
> **Phase B 仍然是 `IMPLEMENTED`** —— 匹配层 61 条 Phase B 用例**第一次被真正执行**（85/86），
> 暴露了 1 条**用例等待窗口**问题，已修；**`06-desktop-test` 一次都没跑过。**
> **必须复跑**（至少要看到 `05-matching-test` 的 `EXIT=0`）：
>
> ```bash
> # 最快：从匹配层起跑（存储层已经全绿）
> KINDORA_START_AT=05-matching-test bash /Users/jiang/development/Kindora/.cache/verify.sh
> cat /tmp/kindora-verify/summary.txt
> ```
>
> **全量复跑**（从 `01` 起）用 `KINDORA_START_AT=01-protocol-test` ——
> **0.5b 还欠着**（`09i-pnpm-outdated` / `09j-cargo-outdated`），**只有全量跑才会走到那两步**。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8.11。
>
> **第十三批（2026-11-06）—— `06-desktop-test` 的静态预审：77 条用例逐条走查，没有发现实现缺陷。**
> ⚠️ **这一批没有任何运行结果。** 前两批的信号都来自**运行**（`EXIT=0` / `EXIT=1`），
> 这一批的信号来自**阅读** —— **静态走查不等于运行**，`06-desktop-test` **依旧是 `NOT_RUN`**。
>
> **为什么先做这件事** —— 自第四批（2026-11-04，桌面端 `127/127` 全绿）之后，
> Phase B / D 又动过 7 个桌面端测试文件（**新增 2 个、改写 4 个、另有 1 个未改动**），
> **它们一次都没有被跑过**；而 Phase B / D 的验收**都要看 `06` 这一行**。
> 第十一批 / 第十二批两次栽过的地方，正是**"用例本身写错了"和"实现跑起来不对"混在一起** ——
> 与其猜，不如**先用眼睛把这 7 个文件看一遍**，好让复跑失败时能立刻分清是哪一种。
>
> | 走查范围                           | 内容                                                                                                                                                                                                                                           |
> | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 7 个桌面端测试文件 / **77 条用例** | `privacy-boundaries.test.tsx`（13）、`ConsentView.test.tsx`（17）、`chat-persistence.test.ts`（7）、`ConnectView.test.tsx`（14）、`MatchView.test.tsx`（13）、`profile-flow.test.tsx`（5）、`ConnectionStatus.test.tsx`（8，未改动）           |
> | 桌面端合计                         | **16 个测试文件 / 151 条用例**（逐文件数过）                                                                                                                                                                                                   |
> | 跨包类型契约（4 组）               | `MatchOutcome`（**已经没有 `peerRefused` 了** —— 匹配层那条用例的夹具删掉它**是必须的**，不是可选）、`ConsentOutcome`（9 个字段）、`SocialProfile` / `SocialBoundaries`（哪些字段必填、哪些可选）、`LanStartInput`（`signer` / `fingerprint`） |
>
> **结论：没有发现实现缺陷。** 桌面端的测试文件**在 `tsconfig` 的 `include` 里**，
> 所以 `08a-typecheck` **会**查它们 —— 上表那 4 组契约是手工对过的。
>
> **记下一处脆弱点（不是缺陷，先记着）** —— `ConsentView` 里那条「轮到你了」的断言，
> 之所以成立，是因为 RTL 的 `waitFor` 会**先同步跑一次** `checkCallback()`（对着初始渲染），
> **早于** `start()` 的 promise 兑现；一旦 `finalOutcome` 有值，`terminal` 就变真，
> `consent-status` **不再渲染**。**将来这条断言若失败，不要直接读成「组件坏了」。**
>
> **Phase B / Phase D 仍然是 `IMPLEMENTED`，不是 `VERIFIED`** —— 静态走查给不了 `EXIT=0`。
> **必须复跑**（命令一个字没变）：
>
> ```bash
> KINDORA_START_AT=05-matching-test bash /Users/jiang/development/Kindora/.cache/verify.sh
> cat /tmp/kindora-verify/summary.txt
> ```
>
> 这一次要看到的是 `05`（改完之后）、`06`（桌面端 151 条）、`08a` / `08b` / `08c` 全绿。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8.12。
>
> **第十四批（2026-11-06）—— Phase E 的实施：E1 统一错误模型 / 超时 / 取消 / 有限退避 + E2 独立 live 测试文件。**
> ⚠️ **这一批没有任何运行结果。** `pnpm -C packages/llm test` 被执行通道（Bash 安全分类器）拒绝 ——
> **代码写完了，但一条都没跑过**，所以 **Phase E 是 `IMPLEMENTED`，不是 `VERIFIED`**。
>
> **为什么把传输层抽成一份** —— 任务书 E1 列了 11 条要求。
> 按 Provider 逐条实现 = **三份**超时 + **三份**错误映射 + **三份**重试策略，三个 Provider 迟早漂移；
> 而 E1 的验收标准原文是**"所有 Provider 具有一致的超时、错误和取消行为"** —— "一致"就要求**只有一份实现**。
> 于是新增 `packages/llm/src/errors.ts`（错误模型 + 脱敏）与 `packages/llm/src/http.ts`（超时 / 取消 / 退避 / 状态映射），
> 三个 Provider 改成走这一层，**请求格式一个字节没动**。
>
> **本轮最关键的一个判断**：任务书第 10 条「避免重复发送付费请求」**决定了超时不能重试** ——
> 超时只意味着"我们不再等了"，**不意味着"Provider 没跑"**（很可能已经跑完并**计费**了）。
> 所以 `TIMEOUT_ERROR` / `INVALID_RESPONSE` **不重试**；只有"没送达"的 `NETWORK_ERROR` 和 429 / 5xx 才重试。
> **这个区分写成了测试**（超时场景下断言 `fetch` 只被调用 **1** 次）。
>
> | 改动        | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                      |
> | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 新增 5 个   | `packages/llm/src/{errors,http}.ts`、`packages/llm/src/__tests__/{provider-errors,provider-timeout,providers.live}.test.ts`                                                                                                                                                                                                                                                                                                               |
> | 改写 6 个   | `packages/llm/src/providers/{openai-compatible,anthropic,ollama}.ts`、`packages/llm/src/index.ts`、`packages/llm/src/__tests__/providers.test.ts`（429 / 529 两条 Mock 改成"每次一份新 `Response`"，**并加**断言；原有断言**没删、没放宽**）、`apps/desktop/src/lib/llm-service.ts`                                                                                                                                                       |
> | 桌面端 3 个 | `apps/desktop/src/views/Settings.tsx`（错误码 → 用户语言的一句话 + Provider 原文）、`apps/desktop/src/i18n/dictionaries/{en,zh}.ts`（各 7 个 `llm.error.*` 键）                                                                                                                                                                                                                                                                           |
> | 用例        | `packages/llm` 套件 **18 条 → 4 个文件 / 55 条会跑 + 8 条无凭据时跳过 = 63 条注册**（**口径**：这是 **Phase E 动过的 4 个文件**；整个包还有 1 个 Phase E 之前就有的 `index.test.ts`，所以**整包**是 **5 个文件 / 44 条声明 / 64 条注册（56 会跑 + 8 跳过）**）；桌面端**净增 0 条**                                                                                                                                                       |
> | E2 的做法   | **独立文件** `providers.live.test.ts`；**两道开关**（`KINDORA_LLM_LIVE=1` 总开关 + 每个 provider **必须显式给出** `BASE_URL` / `MODEL` /（需要时）`KEY`）；**无凭据时 `describe.skipIf` → 跳过而不是假通过**；密钥**从不打印**；**不制造真实 429**（滥用共享服务 + 花钱）、**不对真实 Provider 制造超时**（可能已计费）—— 这两条路径由 mock 套件和**真实 socket**（`provider-timeout.test.ts`，**不需要 key、不需要外网、永远会跑**）覆盖 |
>
> **顺带修掉三个真问题**：
> ① 第一版测试用了 `mockResolvedValue(new Response(...))` ——
> **同一个 `Response` 的正文只能读一次**；加了重试之后第二次尝试会抛 "body is unusable"，
> **错误类型会从"500"变成"网络错误"，测试会假绿**。已改成每次调用一份新 `Response`。
> ② `net.Server.closeAllConnections()` **运行时存在，但 `@types/node@22.19.15` 的 `net.d.ts` 里没有**
> （只有 `http.Server` 有）—— **会让 `08a-typecheck` 直接编译失败**。已改成自己跟踪 socket 并 `destroy()`。
> ③ Ollama 的 live 套件**本来会在没有任何环境变量时自己跑起来**，去连一个不存在的 `localhost:11434`
> —— **在 CI 上必然失败**。已改成上面那两道开关。
>
> **这三个问题只有在真跑起来之后才会暴露。** 这一轮能查到，是因为**只读通道是通的** ——
> 去翻了实际安装的 `@vitest/spy@2.1.9` / `@vitest/runner@2.1.9` / `@types/node@22.19.15` 的 `.d.ts`。
> **但这仍然不能代替 `tsc`。**
>
> **Phase E 仍然是 `IMPLEMENTED`，不是 `VERIFIED`** —— **必须复跑**（命令一个字没变）：
>
> ```bash
> KINDORA_START_AT=05-matching-test bash /Users/jiang/development/Kindora/.cache/verify.sh
> cat /tmp/kindora-verify/summary.txt
> ```
>
> 这一次要看到的是：`packages/llm` 那 **55 条**全绿 + `05` + `06`（桌面端 151 条）+
> `08a` / `08b` / `08c` 全绿。
> **E2 的真实接口测试是 `NOT_RUN`** —— 需要 `KINDORA_LLM_LIVE=1` **加上**该 provider 的
> `BASE_URL` / `MODEL`（和 `KEY`），**没有凭据就永远是 `NOT_RUN`**。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8.13。

---

## 状态词定义

| 状态          | 含义                       |
| ------------- | -------------------------- |
| `NOT_STARTED` | 尚未开始                   |
| `IN_PROGRESS` | 进行中                     |
| `BLOCKED`     | 存在未解决的依赖或环境问题 |
| `IMPLEMENTED` | 代码已修改，尚未完成验收   |
| `VERIFIED`    | 代码修改及对应测试均已通过 |

**不允许把 `IMPLEMENTED` 写成 `VERIFIED`。**

---

## Phase 0 — 建立当前版本基线（P0）

| 编号 | 任务                                                | 状态          | 交付物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | --------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1  | 核对仓库状态、工具链版本、包管理结构                | `VERIFIED`    | `docs/REMEDIATION_TEST_REPORT.md` § 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0.2  | 复核历史审计结论（逐条给出 CONFIRMED / CHANGED）    | `VERIFIED`    | `docs/REMEDIATION_TEST_REPORT.md` § 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0.3  | 运行 lint / typecheck / unit test / Rust test 基线  | `VERIFIED`    | `docs/REMEDIATION_TEST_REPORT.md` § 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0.4  | 检查 Tauri 桌面端构建                               | `VERIFIED`    | 第四批 `09f-tauri-build` `EXIT=0` → `docs/REMEDIATION_TEST_REPORT.md` § 8.4.10                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 0.5  | 记录依赖漏洞与过期依赖                              | `IN_PROGRESS` | **依赖漏洞（0.5a）已完成 → `VERIFIED`**：`pnpm audit` **47 条**（1 low / 21 moderate / 21 high / 4 critical，**全部 devDependency**）；`cargo audit` **1 条 vulnerability**（`rsa` RUSTSEC-2023-0071，**5.9 / medium**，**可达性判定：不可达**）+ **3 条 allowed warnings**（**第八批**，`EXIT=1`）。两侧**都记录、都未升级**（任务书第 149 行）→ § 8.4.14。<br>**过期依赖（0.5b）仍 `NOT_RUN`** —— 第 149 行那句"记录依赖漏洞**和过期依赖**"的后一半还没跑：需要 `pnpm outdated -r` 与 `cargo update --dry-run` 的真实清单（脚本已补 `09i` / `09j` 两步） |
| 0.6  | 建立三份跟踪文档                                    | `VERIFIED`    | 本文件 + PROGRESS + TEST_REPORT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 0.7  | 修复基线暴露的 D8 缺陷（删除 API Key 无界面反馈）   | `VERIFIED`    | `apps/desktop/src/views/Settings.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0.8  | 修复 Tauri 打包失败（`bundle.category` 非法枚举值） | `VERIFIED`    | `apps/desktop/src-tauri/tauri.conf.json` —— 第四批 `tauri build` `EXIT=0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Phase 0 的实测结论（2026-11-02）：**

| 维度                       | 结果                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust 测试                  | **全绿** —— `cargo test --lib` 3/3、`lan_e2e` 18/18、`lan_protocol_e2e` 13/13，共 34 个用例，零 flaky                                                    |
| TypeScript 测试            | 7 个包全部跑到，441+ 个用例中**仅 1 个失败**（ConnectView 取消竞态，根因已定位 → Phase C / C-3a），该失败为**历史失败**，与本轮改动无关                  |
| `pnpm lint`                | **PASS**（零告警）                                                                                                                                       |
| 类型检查                   | **PASS**（`pnpm -r build` 每步即 `tsc`）                                                                                                                 |
| `pnpm format:check`        | **FAIL —— 76 个文件**，仓库级历史状态（ESLint 从未接入 prettier）。Phase H1 前须先定策略                                                                 |
| `cargo fmt --check`        | **FAIL —— 7 个文件**，纯格式                                                                                                                             |
| `cargo clippy -D warnings` | **FAIL —— 10 个 error**，其中 3 个在 `secrets.rs`（与 A1 重叠）、`lan.rs:831 never_loop` 是**有意的单 peer 不变量**（应加 `#[allow]`，不得"修"成真循环） |
| Tauri 构建                 | Rust release 编译**成功**，**打包阶段**因 `bundle.category: "Social"` 非法失败 → 已修为 `SocialNetworking`（0.8），**待复跑**                            |

**尚未取得结果的命令（记 `NOT_RUN`，不得记为 PASS）：**
`pnpm -C apps/desktop tauri build`（0.8 修复后复跑）、`pnpm audit`（当前 registry `registry.npmmirror.com`
无 audit 端点，需加 `--registry=https://registry.npmjs.org`）、`cargo audit`
（**第八批已跑**：`EXIT=1`，**1 条 vulnerability + 3 条 allowed warnings**，已记录、未升级 —— 见 § 8.4.14）、
`packages/agent` 的用例计数行（被终端截断）、ConnectView 连跑 5 次（区分 flaky / 稳定失败）。

> **⚠️ 2026-11-04 更新：上面这张基线表与"尚未取得结果的命令"清单已被第四批取代。**
> 第四批（`docs/REMEDIATION_TEST_REPORT.md` § 8.4.10）实际结果：
> `pnpm -C apps/desktop tauri build` **PASS**、`pnpm audit` **已取得**（47 条 advisory，
> **全部 devDependency**，按任务书第 149 行只记录不升级）、`packages/agent` **129 条**、
> ConnectView 连跑 5 次 **全 OK**、`cargo test --lib` **13/13**、`lan_e2e` **18/18**、
> `lan_limits` **4/4**、`pnpm lint` / `pnpm -r typecheck` / 六个包 `tsc -p` 全部 `EXIT=0`。
> **仍然 `NOT_RUN` 的只剩**：`cargo audit`（**第六批工具已由维护者装好**，**第七批脚本传错了参数**
> —— `cargo audit` 不接受 `--manifest-path`，`EXIT=2` 是 clap 用法错误；脚本已改用 `--file <Cargo.lock>`，
> **待再跑一次**；见 § 8.4.13）。
> **基线表的另外两行需要更正**（基线时的结论被第四批证伪）：
>
> - `cargo clippy -D warnings` —— 基线记"10 个 error，其中 `lan.rs:831 never_loop`
>   是有意的单 peer 不变量（应加 `#[allow]`，不得'修'成真循环）"。
>   **第四批实测：`never_loop` 自己消失了** —— 因为 Phase C 把 `accept_loop`
>   改成了真正的循环（不再第一次 accept 后 `break`，见 C3-3），它本来就该是 `loop`。
>   **基线那句"不得修成真循环"的建议已经过时**，本轮也**没有**为它加任何 `#[allow]`。
>   第四批实际报的是 **12 个**（lib 目标 10 + lib test 目标 12），已全部手修。
> - `cargo fmt --check` —— 仍是**同样那 7 个文件**的纯格式差异，**不是** Phase C 引入的。
>
> **⚠️ 2026-11-04 第五批更新（§ 8.4.11）：**
>
> - `cargo fmt --check` —— **已归一化**：`KINDORA_FMT_WRITE=1` 写模式跑过一次后，
>   `09d-cargo-fmt` **从红转绿 —— `EXIT=0`**。**只重排、不改语义**。
> - `cargo clippy -D warnings` —— **第四批那 12 个已确认修好**（第五批 lib 目标**零 error**）；
>   但复跑暴露出 **11 个 `doc_overindented_list_items`**（`tests/lan_protocol_e2e.rs` 的
>   `//!` 文档注释）—— **旧问题**，因为此前 lib 编译失败、test 目标根本没被检查到。
>   **已按 clippy 建议逐字改好（纯注释重排），待再复跑一次**。
> - `cargo audit` —— **仍然 `NOT_RUN`**。第五批实跑确认 **`cargo-audit` 工具本机没装**
>   （日志：`error: no such command: \`audit\``）。**这是"工具缺失"，不是"扫描通过"。**
补齐：`cargo install cargo-audit --locked`。
**⚠️ 2026-11-04 后续更新：工具已于第六批装好**；第七批又因脚本传错参数（`EXIT=2`）
**仍然没跑起来**。**结论不变：仍 `NOT_RUN`**。见 § 8.4.12.3 / § 8.4.13。
> - `packages/protocol` 的 **137 条**已在第五批纳入同一批证据（第四批该项被 SKIPPED）。
>
> **⚠️ 2026-11-04 第六批更新（§ 8.4.12）：**
>
> - `cargo clippy -D warnings` —— ✅ **`EXIT=0`，0 error**。收敛链：
>   基线 10 → 第四批 12（全部结构性手修）→ 第五批 lib 0 + 11 个旧
>   `doc_overindented_list_items`（8→7 空格重排）→ **第六批 0**。
> - `cargo audit` —— **工具已由维护者装好**（`cargo install cargo-audit --locked` 成功）；
>   第六批的 `09h` 跑在装工具之前，仍是 `no such command: audit`，
>   **再跑一次 `09h` 即可拿到真实清单**。**在那之前仍是 `NOT_RUN`** ——
>   **工具已就位 ≠ 扫描已通过**。
>
> **⚠️ 2026-11-04 第七批更新（§ 8.4.13）：**
>
> - `cargo audit` —— **仍然没跑起来**，但原因又换了一个：**脚本传错了参数**。
>   `cargo audit` **不接受 `--manifest-path`**（那是 `cargo build`/`test`/`clippy`
>   那一族的参数；`cargo audit` 审计的是 `Cargo.lock`，参数是 `--file`），
>   于是以**退出码 2**（clap 的用法错误）结束 —— **一条漏洞信息都没有**。
>   **脚本已修**：`cargo audit --file apps/desktop/src-tauri/Cargo.lock`
>   （并保留"进到 crate 目录里跑"的退路，因为仓库根**没有** `Cargo.lock`）。
>   **在拿到 `EXIT=0`（干净）或 `EXIT=1`（扫到东西）之前，A-12 仍是 `NOT_RUN`。**
>
> **✅ 2026-11-05 第八批更新（§ 8.4.14）：这个欠账销掉了 —— 真的扫到了东西。**
> `09h-cargo-audit` **`EXIT=1`**（cargo-audit 的"发现了漏洞"语义，不是脚本失败），
> 扫描 **521 个 crate**、载入 **1403 条 advisory**：
> **1 条 vulnerability**（`rsa` 0.9.10 / RUSTSEC-2023-0071 / Marvin Attack / **5.9 medium**，
> 依赖链 `kindora-desktop → tauri-plugin-sql → sqlx → sqlx-mysql → rsa`，
> **可达性判定：不可达** —— 产品代码零处引用 `sqlx`/`mysql`/`postgres`，
> SQL 插件虽注册但**未向前端暴露任何 `sqlite_*` 命令**（`src/lib.rs:12-13`），前端亦零引用）
> ⚠️ **第十批（Phase D）之后这个前提变了**：前端**开始**用这个插件了（只走写死的 `sqlite:` 连接串），
> **结论仍是"不可达"** —— 见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.14.3 的追加说明。
> **+ 3 条 allowed warnings**（`proc-macro-error` unmaintained、`glib` unsound、
> `tokio` unsound —— 全都不可达或非运行时）。
> **按任务书第 149 行：只记录、不在本阶段批量升级**。
> **0.5 → `VERIFIED`**；**A-12 扫描层面消解**，**修复本身归 Phase H**。

---

## Phase A — 身份安全、密钥保护与通信安全（P0，最高）

前置条件：Phase 0。

| 编号 | 任务                                              | 状态       | 优先级 | 关键文件                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | 修复 Agent 私钥明文存储 + 迁移机制 + 无静默降级   | `VERIFIED` | P0     | `packages/agent/src/identity.ts`、`packages/storage/src/profile-store.ts`、`packages/storage/src/browser-store.ts`、`apps/desktop/src/lib/agent-service.ts`、`apps/desktop/src-tauri/src/secrets.rs`、`apps/desktop/src-tauri/src/lib.rs`                                                                                                                 |
| A2   | 统一身份签名与消息验签                            | `VERIFIED` | P0     | `packages/protocol/src/{signature,canonical-json,crypto,base64}.ts`（新建）、`packages/agent/src/signer.ts`（新建）、`packages/protocol/src/{envelope,validation,serialization}.ts`、`packages/transport/src/pairing-session.ts`                                                                                                                          |
| A3   | 实现真正的 LAN 加密通信（握手 + 密钥协商 + AEAD） | `VERIFIED` | P0     | `packages/transport/src/session-crypto.ts`（新建）、`packages/transport/src/pairing-fingerprint.ts`（新建）、`packages/transport/src/pairing-session.ts`（含 **A3.8 入站重放守卫**：接入 `packages/protocol/src/replay-protection.ts` 的 `ReplayGuard`）、`packages/transport/src/{lan,loopback}-transport.ts`（Rust 侧**零改动**——配对码是不透明字符串） |
| A4   | 修正能力声明（`supportsEncryption` 等）           | `VERIFIED` | P0     | `packages/agent/src/identity.ts`（`buildRuntimeCapabilities`）、`packages/protocol/src/index.ts`、`packages/protocol/src/validation.ts`                                                                                                                                                                                                                   |

**依赖关系：** A2 → A3 → A4。A1 可与 A2 并行（A1 提供 A2 需要的签名密钥存储）。

> **⚠️ 2026-11-04 更新：A1–A4 的状态由 `IMPLEMENTED` 升为 `VERIFIED`**（第四、第五批实测）。
> 原文写的是"A1–A4 均为 `IMPLEMENTED`，不是 `VERIFIED`"，
> 理由是第一批有 3 个回归未复跑、"transport / agent / storage / matching / desktop
> 在 protocol 修好之前从未被类型检查过"。**第四批全部跑掉了**：
> `packages/transport` **199/199**、`packages/agent` **129/129**、`packages/storage` **32/32**、
> `packages/matching` **61/61**、`apps/desktop` **127/127**（`ConnectView` 连跑 5 次全 OK）、
> `pnpm -r typecheck` **全工作区 `EXIT=0`**、`pnpm lint` **`EXIT=0`**、
> 六个包自身 `tsc -p` **`EXIT=0`**、Tauri 构建 **`EXIT=0`**、Rust 三套件 **13 + 18 + 4 全绿**。
> **第五批补上最后一块**：`packages/protocol` **137/137** + `--test lan_protocol_e2e` **13/13**
>
> - `cargo fmt --check` **`EXIT=0`** → **合计 685 个 TS 用例 + 48 个 Rust 用例全绿**。
>   详见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.10 / § 8.4.11。
>
> **但 `VERIFIED` 的边界必须说清楚**（不因为测试全绿而消失）：
>
> 1. **真实双设备验收 H3 仍 `BLOCKED`** —— A3 的握手测试全部在同一个 JS 进程内
>    经 `LoopbackHub` 完成，**没有在两台真机上验证过**。
> 2. **A1–A4 的已知实现缺口仍在**：A-1（Rust 侧 `agent_sign` 未实现，私钥仍穿
>    webview 边界）、A-2（浏览器 dev 模式仍把私钥放 `localStorage`）、
>    A-3（RFC 8785 排序规则待对照原文）、A-5、A-8、A-10、A-14 ——
>    见 `docs/REMEDIATION_TEST_REPORT.md` § 8.5。
> 3. **`cargo audit` 已于第八批跑过**（`EXIT=1`）—— Rust 侧依赖漏洞状况**不再是"未知"**：
>    **1 条不可达的 medium**（`rsa` RUSTSEC-2023-0071）+ **3 条不可达/非运行时的 warning**，
>    已记录、未升级（第 149 行），**修复归 Phase H** → § 8.4.14。
>
> **第一批真实执行结果（维护者代跑，2026-11-03）：**
> `packages/transport` **169 / 169 全绿**；`packages/protocol` / `agent` / `storage` **PASS**；
> `pnpm -r typecheck` **FAIL**（`packages/protocol/src/crypto.ts(235,5)` TS2322）、
> `packages/matching` **FAIL（1 个用例）**、`apps/desktop` **FAIL（9 个用例）**——
> 后两者是 **Phase A 自己引入的回归**。
> **三个回归都已定位并修复**（`docs/REMEDIATION_PROGRESS.md` 的「任务编号：A-0」），
> **第三 / 四批均已复跑通过**。
> 详见 `docs/REMEDIATION_PROGRESS.md` 的 Phase A 章节
> 与 `docs/REMEDIATION_TEST_REPORT.md` § 8.4 / § 8.4.5 / § 8.4.6 / § 8.4.7 / § 8.4.10。

---

## Phase B — 隐私边界与用户授权（P0）

前置条件：A2、A3。

| 编号 | 任务                                         | 状态          | 关键文件                                                                                                                                                                                                                        |
| ---- | -------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | 隐私边界成为真正可操作的用户设置             | `IMPLEMENTED` | `apps/desktop/src/views/CreateAgentForm.tsx`、`apps/desktop/src/views/Settings.tsx`、`packages/agent/src/profile.ts`、`packages/protocol/src/index.ts`（默认值）、`packages/storage/src/browser-store.ts`（存储边界补齐旧记录） |
| B2   | 调整 Profile Exchange 流程（字段级授权过滤） | `IMPLEMENTED` | `packages/matching/src/orchestrator.ts`、`packages/matching/src/consent-orchestrator.ts`、**新增** `packages/protocol/src/profile-privacy-filter.ts`                                                                            |
| B3   | 完善黑名单机制（UI + 交换前强制检查）        | `IMPLEMENTED` | `packages/storage/src/blocked-agents-store.ts`、`apps/desktop/src/lib/connect-service.ts`、`apps/desktop/src/views/`（新增黑名单视图）                                                                                          |

> **⚠️ 2026-11-05 更新（第九批 —— Phase B 实施；⚠️ 用例一条都没跑过）：**
> B1 / B2 / B3 **由 `NOT_STARTED` 升为 `IMPLEMENTED`** —— **不是 `VERIFIED`**。
>
> - **B1** —— `CreateAgentForm` 新增「Privacy」卡片（4 个行为级 + 6 个字段级开关），
>   每个开关带说明与 `Shared` / `Private` 徽章；开关值随 `SocialProfile.boundaries` 持久化。
>   默认值按用户拍板改为**最小必要**：**兴趣开，其余关**。
> - **B2** —— 新增 `packages/protocol/src/profile-privacy-filter.ts`（字段授权规则表 /
>   公开名片 / 出站过滤 / 发送前断言）；`MatchOrchestrator` 拆成
>   `identify()`（**只发公开名片**）+ `exchangeAndMatch()`（**没有双方同意的 consent 就拒绝发送**），
>   **`start()` 已被删除** —— 单入口意味着可以跳过同意。
>   桌面端流程重排为 `连接 → 识别 → 同意 → 匹配 → 破冰 → 聊天`。
> - **B3** —— 新增 `BlockedAgentsView`（列表 / 屏蔽时间 / 原因 / 解除屏蔽）；
>   守卫**直接读 store**（旧的内存快照机制已删除），**LAN 路径原本完全没有守卫**，现在两条路径一致；
>   守卫跑在匹配层（受信任层），**绕过 UI 也绕不过它**。
>
> **净增 61 条用例**（protocol **+26** / desktop **+17** / matching **+14** / storage **+2** / agent **+2**；
> 六个被整改的包合计 **685 → 746**）。改写 9 个测试文件，其中的 **135 条**用例都要一并跑过。
> **但本轮执行通道被安全分类器拒绝，一条都没跑过** —— 全部记 `NOT_RUN`。
> **📌 后续：第十一批 / 第十二批已经跑过一部分** —— `01-protocol-test` ✅ 163/163、
> `03-agent-test` ✅ 131/131、`05-matching-test` ❌ 85/86（1 条超时，已修，等复跑），
> **`06-desktop-test` 一次都没跑过** → 见本文件开头的第十二批记录与 § 8.8.11。
> **第十三批已把这 7 个变动过的桌面端测试文件逐条静态走查了一遍（没有发现实现缺陷，
> 但静态走查不是运行）** → 见本文件开头的第十三批记录与 § 8.8.12。
> **第十四批把 Phase E（E1 + E2）也写完了 —— 但同样一条都没跑过**：
> `packages/llm` 套件从 18 条变成 **55 条会跑 + 8 条无凭据时跳过**，
> **全部 `NOT_RUN`** → 见本文件开头的第十四批记录与 § 8.8.13。
> **阶段验收 = 复跑表的前八行全部 `EXIT=0`**
> （`01` / `03` / `04` / `05` / `06` / `08a` / `08b` / `08c`），
> 详见 `docs/REMEDIATION_TEST_REPORT.md` § 8.7。
>
> **另有两轮人工复核（§ 8.7.5.1）**：因为跑不了，把每一条断言逐条对着实现源码读。
> **第一轮读出并修掉了 3 处"必然失败"的用例写法**（3 条匹配用例原本会挂 30 秒 ——
> `exchangeAndMatch()` 等对方 `match_response` 的上限是 30 秒，而那几条只让一侧跑第二阶段；
> 1 条桌面端用例原本会撞 testing-library 的"命中两个节点"；
> 2 条 agent 用例原本把渲染的空格排版写死进了断言）。
> **第二轮又读出 1 处更危险的问题**：Phase B 改了共享常量 `DEFAULT_SOCIAL_BOUNDARIES`，
> 把**一条既有的**默认值断言打坏了（`packages/protocol/src/__tests__/index.test.ts`）——
> 修完的断言**从钉 5 个键变成钉 10 个键，变强了**；
> 同时补上了 **1 处覆盖缺口**（存储层补齐旧记录的那段逻辑本来一条用例都没有，补了 2 条）。
> **断言一条都没有被放宽，也没有跳过任何一条。**
> 但读代码读不出只有运行才会暴露的问题 ——
> **所以复跑仍然是必经一步，Phase B 仍停在 `IMPLEMENTED`。**

---

## Phase C — LAN 通信可靠性（P1）

前置条件：Phase 0（A3 会改变 C1 的设计边界）。

| 编号     | 任务                                                      | 状态       | 关键文件                                                                                                                              |
| -------- | --------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| C1       | 有界帧大小、有界队列、背压、连接/速率上限                 | `VERIFIED` | `apps/desktop/src-tauri/src/lan.rs`、`packages/transport/src/lan-transport.ts`                                                        |
| C2       | 非法 UTF-8 / 异常退出状态一致性                           | `VERIFIED` | `apps/desktop/src-tauri/src/lan.rs`                                                                                                   |
| C3       | 连接生命周期与重连（**大部分已由 Phase 16.5/16.6 完成**） | `VERIFIED` | `packages/transport/src/lan-transport.ts`、`packages/transport/src/pairing-session.ts`、`apps/desktop/src/lib/lan-connect-service.ts` |
| **C-3a** | **「取消配对」在 UDP 发现阶段的竞态（基线新发现）**       | `VERIFIED` | `apps/desktop/src/views/ConnectView.tsx`、`apps/desktop/src/lib/lan-connect-service.ts`                                               |

> **⚠️ 2026-11-04 更新：C1 / C2 / C3 / C-3a 的状态由 `NOT_STARTED` 升为 `VERIFIED`**（第四、第五批实测）。
>
> - **C1** —— `cargo test --lib` **13/13**、`--test lan_limits` **4/4**
>   （`oversized_frame_is_rejected_and_drops_the_link` /
>   `flooding_past_the_rate_limit_drops_the_link` /
>   `host_accepts_a_new_peer_after_the_first_one_leaves` / `invalid_utf8_body_marks_the_peer_closed`）。
> - **C2** —— `cargo test --lib` 的 `peer_close_guard_*` /
>   `close_reason_maps_to_the_matching_error` /
>   `the_close_reason_is_present_whenever_the_peer_closed_flag_is_set` 全通过；
>   TS 侧 `packages/transport` **199/199**。
> - **C3** —— Rust `--test lan_e2e` **18/18**、`--test lan_limits` **4/4**、
>   **`--test lan_protocol_e2e` 13/13**（第五批，含 `two_instance_reconnect_after_tcp_drop`）；
>   TS 侧新增 **35 条** C3 用例（状态机 8 / 会话重连 9 / 传输层 6 / 视图 8 / 服务 4）**全通过**。
> - **C-3a** —— `ConnectView.test.tsx` **14/14**，且**连跑 5 次全 OK**（无 flaky）；
>   R-4 / R-5 两处修复**没有放宽断言**。
>
> **仍欠的收尾项**：`MAX_FRAME_BYTES` 16 MiB → 1 MiB 这个**行为变更**的人工确认（归入 I1）。
> `cargo fmt` 已在第五批**归一化**（`cargo fmt --check` **`EXIT=0`**）；
> `cargo clippy` 已在**第六批复跑转绿 —— `EXIT=0`，0 error**
> （收敛链：基线 10 → 第四批 12 → 第五批 11 → **0**）；
> `cargo audit` 已在**第八批真的跑起来**（`EXIT=1`：**1 条不可达的 medium + 3 条不可达/非运行时的
> warning**，按第 149 行**只记录、不升级**，修复归 Phase H）。
> 详见 `docs/REMEDIATION_TEST_REPORT.md` § 8.4.10 / § 8.4.11 / § 8.4.12 / § 8.4.14 / § 8.6。

---

## Phase D — 数据持久化与本地数据管理（P1）

前置条件：Phase 0。

| 编号 | 任务                                      | 状态          | 关键文件                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 建立真正的本地业务数据库（SQLite + 迁移） | `IMPLEMENTED` | `packages/storage/src/{sql-migrations,sql-migrator,database,sqlite-database,memory-database,database-stores,sql-executor,legacy-migration}.ts`、`apps/desktop/src/lib/{database,runtime-stores,tauri-sql-executor,agent-keychain-migration}.ts` |
| D2   | 完善聊天记录管理（ChatRepository）        | `IMPLEMENTED` | `packages/storage/src/chat-repository.ts`、`packages/matching/src/{chat-persistence,chat-orchestrator}.ts`、`apps/desktop/src/lib/{chat-persistence,chat-history}.ts`、`apps/desktop/src/views/ChatHistoryView.tsx`                             |

> **第十批（2026-11-05）：D1 / D2 由 `NOT_STARTED` 升为 `IMPLEMENTED` —— 不是 `VERIFIED`。**
> 实施与用例都写完了，但**一条都没跑过**（执行通道被安全分类器拒绝）。
> **已知缺口**：CI 里没有真正的 SQLite，**SQL 语句没有被真实 SQLite 执行过**；
> 用例钉的是「端口语义」「SQL 契约」「DDL↔DML 列名静态一致性」三层。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` § 8.8。
>
> **第十一批（2026-11-05）：Phase D 的用例第一次真跑 —— `04-storage-test` `EXIT=1`，159/161，2 条失败。**
> **一处是实现缺陷**（`runMigrations` 的三处驱动调用没包 try/catch），
> **一处是用例夹具登记错了语句**；**两处都已修，各补了回归用例（+4 条）**，
> **但还没有复跑 —— D1 / D2 仍然是 `IMPLEMENTED`。**
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` **§ 8.8.10**。
>
> **第十二批（2026-11-05）：存储层复跑变绿 —— `04-storage-test` `EXIT=0`（165/165 全绿）。**
> **第十一批修的两处（一处实现缺陷 + 一处夹具缺陷）都验证生效了。**
> **但 D1 / D2 仍然是 `IMPLEMENTED`** —— 验收要看的六行里
> **还有 `05` / `06` / `08a` / `08b` / `08c` 没绿**；
> **同一批跑出来的 `05-matching-test` 是 85/86，1 条超时**（Phase B 的同意门用例 ——
> **用例没设 60 秒的等待窗口**，已修，等复跑）。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` **§ 8.8.11**。
>
> **第十三批（2026-11-06）：`06-desktop-test` 的静态预审 —— 7 个桌面端测试文件 / 77 条用例逐条走查。**
> **没有发现实现缺陷**，但**静态走查不是运行** —— `06-desktop-test` 依旧是 `NOT_RUN`，
> **D1 / D2 仍然是 `IMPLEMENTED`**（验收要看的六行里，`05` / `06` / `08a` / `08b` / `08c` 还是没绿）。
> 逐条见 `docs/REMEDIATION_TEST_REPORT.md` **§ 8.8.12**。

---

## Phase E — LLM Provider 可靠性（P1）

前置条件：Phase 0。

| 编号 | 任务                                                    | 状态          | 关键文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | 统一 Provider 错误模型、超时、取消、重试                | `IMPLEMENTED` | **新增** `packages/llm/src/errors.ts`（`LLMError` + 7 个错误码 + 三层密钥脱敏）、`packages/llm/src/http.ts`（**一份**传输层：超时 / 取消 / 有限退避 / `Retry-After` / HTTP 状态映射）；**改写** `packages/llm/src/providers/*.ts`（**请求格式一个字节没动**）、`packages/llm/src/index.ts`、`apps/desktop/src/lib/llm-service.ts`、`apps/desktop/src/views/Settings.tsx`、`apps/desktop/src/i18n/dictionaries/{en,zh}.ts`。静态复核（读实际安装的 `.d.ts`）又查出并**修掉 3 个真缺陷**：① `providers.test.ts` 里 429/529 的 mock **复用了同一个 `Response`**，body 被读空 → 改为每次新建；② `net.Server` **没有** `closeAllConnections()`（`@types/node@22.19.15` 只有 `http.Server` 声明了它）→ 改为显式 `socket.destroy()`；③ Ollama 的 live 组因为"不需要 key"会**在 CI 上自动尝试 `localhost:11434`** → 改为必须显式给 `BASE_URL` 才启用。⚠️ **套件仍然没跑过 —— 而这一批查出了它为什么一直没跑**：**`.cache/verify.sh` 的步骤表里从来没有 `packages/llm`**（只有 protocol / transport / agent / storage / matching / desktop 六步），所以 Phase E 的套件**从实施到今天一次都没被执行过**；CI 用的是 `pnpm -r test`（覆盖全部包）所以 CI 里没这个问题。**已补 `step 04b-llm-test`**（编号用 `04b` 是为了不打乱维护者用过的 `KINDORA_START_AT` 取值）→ 下一次复跑才第一次真正跑到它。**4 个文件 / 63 条注册 = 55 条会跑 + 8 条跳过** |
| E2   | Provider 真实接口兼容测试（可选，密钥缺失时 `NOT_RUN`） | `IMPLEMENTED` | `packages/llm/src/__tests__/providers.live.test.ts`（**新增，独立文件**；四个 Provider 的**真实请求格式记录在文件头**；**两道开关**：`KINDORA_LLM_LIVE=1` 总开关 + 每个 provider **必须显式给出** `BASE_URL` / `MODEL` /（需要时）`KEY`；无凭据时 `describe.skipIf` → **跳过而不是假通过**）。**真实 socket 的超时用例拆到独立文件** `packages/llm/src/__tests__/provider-timeout.test.ts`（**不需要 key、不需要外网、永远会跑**）。⚠️ **`NOT_RUN`** —— 需要真实凭据，**没有凭据就永远是 `NOT_RUN`，不是 `VERIFIED`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## Phase F — Prompt Injection 与敏感信息防护（P1）

前置条件：Phase 0。

| 编号 | 任务                                             | 状态          | 关键文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | 修复敏感信息过滤边界（超长/超深不得静默放行）    | `IMPLEMENTED` | `packages/protocol/src/sensitive-field-guard.ts`（**517 行**）：字段名**统一规范化**（`normaliseFieldName` + `wordSegments`，`apiKey` / `API_KEY` / `Api-Key` 归一）、**明确的拒绝规则表**（精确名 + 词对 + 单词）、**公开字段白名单**（`publicKey` / `sessionKeyExchange` 等 —— 但**值照样扫**）、**超长字符串按 128 字符重叠滑窗扫全文**（不再跳过）、超深 → `max-depth-exceeded`、超节点 / 超字符 → `payload-too-large`、函数 / symbol / bigint / NaN / 非普通对象 / 循环引用 → `unverifiable-value`（**共 5 类 `SensitiveFieldReason`**）、`formatSensitiveFieldError` **只给路径不给值**。**发送前执行**：`packages/transport/src/pairing-session.ts:667-669` 在 `transport.send()` **之前**调用（默认开启）—— 任务书 F1 第 9 条 ✅。测试 `packages/protocol/src/__tests__/sensitive-field-guard.test.ts`（**30 条**，含任务书 F1 的 9 类用例；**其中 2 条 Phase 11 用例的断言被改正** —— 原断言的是"长字符串会被跳过"这个缺陷本身，改成"不跳过"，**不是删除**）。✅ **2026-11-06 实测全绿**（`01-protocol-test` EXIT=0，`215 passed (215)`，其中本文件 **30 条全过**）—— **不再是 `NOT_RUN`**                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F2   | 改进 Prompt Injection 防护（纵深防御，非单正则） | `IMPLEMENTED` | `packages/protocol/src/prompt-injection-guard.ts`（**477 行**）：新增 `buildUntrustedBlock` / `renderUntrustedBlock` / `UNTRUSTED_BLOCK_MARKER` / `UNTRUSTED_BLOCK_WARNING` / `UNTRUSTED_DROPPED` / `UNTRUSTED_PLACEHOLDER`；**超深不再返回原始数据**（改为丢弃 + 计数 + notes）；**正则降级为纵深防御的第二层**。`packages/agent/src/context-builder.ts`（**807 行**）：**每一段外部内容进显式分隔块**（`peer-profile` / `match-hints` / `match-report` / `topic-hints` / `chat-history`）、块内**逐行转义**（尖括号 + 控制字符）→ 外部内容**无法伪造块边界、无法自己起一行**、**本地资料与用户提问留在所有块之外**、**hints 改用净化后的 peer profile 计算**（堵上"对端字符串绕过净化器"那个洞）、净化后的 payload 再做**结构化规范化**、超限部分**带内说明**、新增 `UntrustedNotice` / `UntrustedSource` / `RenderedUserMessage` / `BuildContextResult` 四个类型并由 `generateIcebreaker` / `generateChatAssist` **透传给调用方**。测试：`packages/protocol/src/__tests__/prompt-injection-guard.test.ts`（**57 条** = Phase 11 的 21 条**原样保留** + 新增 36 条）、`packages/agent/src/__tests__/untrusted-context.test.ts`（**17 条**，新建 —— 断言**结构**而不是"某个短语不在"，含一条**能区分改前 / 改后**的判别性用例）。✅ **104 条全部实测通过（2026-11-06 第十七批）** —— 协议层 57 条（`01-protocol-test` EXIT=0 / `215 passed (215)`；含 HEAD 的 21 条 Phase-11 旧用例，**一条没丢**）+ agent 层 17 条（`03-agent-test` EXIT=0 / `148 passed (148)`）**全绿**；⚠️ **仍不是 `VERIFIED`** —— 工具链行 `08a` / `08b` / `08c` 还没绿 → § 8.8.17 |

---

## Phase G — WebRTC 功能状态与未来扩展（P2）

前置条件：Phase A。

| 编号 | 任务                                                   | 状态          | 关键文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1   | 明确 NOT_IMPLEMENTED，建立接口契约，修正能力声明与文档 | `IMPLEMENTED` | `packages/transport/src/webrtc-transport.ts`（**284 行**）：**显式的 `NOT_IMPLEMENTED` 桩** —— `WEBRTC_NOT_IMPLEMENTED_CODE` + `WebRtcNotImplementedError`（**带稳定错误码**，UI 按码分支而不是按文案分支）；`connect()` / `send()` / `onMessage()` / `onClose()` **四个入口全部抛**（**代码里没有 resolve 分支** → 不可能出现虚假的"已连接"），`disconnect()` **安全返回**（不抛第二个错）；新增 `WebRtcSignallingAdapter` / `WebRtcSignallingEvent` **后续实现的接口契约**（手动信令 Mode B 与服务器信令 Mode C **共用同一套事件形状**）与 `WebRtcTransportOptions`（`iceServers` / `localOffer` / `signalling` / `sessionCipher`）；文件头三节写明**后续需要的信令 / ICE / STUN-TURN / 可靠有序 DataChannel 方案**、**与 LAN 共用同一套身份与消息安全层**（**DTLS 认证的是通道不是 agent** → 同一把 ES256 签名键 + 配对指纹里钉住的对端公钥 + 同一套 ECDH/HKDF/AES-GCM 会话密码 + `PairingSession` 原样复用）、**不得成为绕过隐私授权的通道**（四道闸门一条都不许松）。**桩刻意不实现 `setSessionCipher`** → `PairingSession` **失败关闭**（拒绝在它上面完成加密握手），将来不会有"悄悄明文"的 WebRTC 会话。`packages/transport/src/index.ts`：导出新符号。**能力声明与文档本来就诚实**（`supportsWebRtc: false` 三处；README / ARCHITECTURE / DEVELOPMENT_STATUS / ROADMAP / UI 原本就写的是 stub）—— 复核确认，**无改动**。测试 `packages/transport/src/__tests__/webrtc-transport.test.ts`（**12 条**，新建 —— 覆盖任务书 G 的 3 条测试用例，含一条**跨包**用例把"能力声明"与"真实实现"钉在一起）。✅ **12 条全部实测通过（2026-11-06 第十七批）** —— 首轮 `02-transport-test` **EXIT=1**、唯一红的 `accepts the follow-up signalling contract…` **是用例缺陷**（它假设桩会去驱动 `signalling.onRemote(...)`，**而桩本来就不驱动** —— 桩的全部职责就是拒绝一切）→ 改成断言契约真正保证的三件事（**带着适配器构造成功** + **`connect()` 仍抛类型化的错** + **直接驱动适配器验证事件形状**），**没有放宽断言、没有跳过用例、没有删掉任何东西** → **同一批复跑 EXIT=0，12 条全绿**，**14 个既有传输层文件 210 条仍然全过**。⚠️ **仍不是 `VERIFIED`** —— 工具链行 `08a` / `08b` / `08c` 还没绿 → § 8.8.17 |

---

## Phase H — CI、自动化测试与真实设备验收（P1）

| 编号 | 任务                                                          | 状态          | 关键文件                                                                              |
| ---- | ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| H1   | 完善 CI（lint / format / fmt / clippy / 依赖安全 / 阻断条件） | `IN_PROGRESS` | `.github/workflows/ci.yml`                                                            |
| H2   | 建立 LAN 安全测试（重放 / 篡改 / 伪造 / 超大帧 / 高频）       | `IN_PROGRESS` | `packages/transport/src/__tests__/`、`apps/desktop/src-tauri/tests/`、`docs/phase16/` |
| H3   | 真实双设备 GUI 测试                                           | `BLOCKED`     | `docs/phase16/manual-lan-e2e.md`（**需要两台真实设备，无法在本环境完成**）            |

> **H1（第十九批，2026-11-06）**：`.github/workflows/ci.yml` **重写**，任务书十项要求
> **全覆盖** —— typecheck ✅ / **ESLint** ✅ / **Prettier** ✅ / **cargo fmt --check** ✅ /
> **cargo clippy** ✅ / `cargo test --lib` ✅ / `pnpm -r test` ✅ /
> **Tauri 构建检查** ✅（独立 job `tauri-build`，`--no-bundle`）/
> **依赖安全检查** ✅（独立 job `dependency-audit`，**记录不阻断** —— 任务书第 149 行
> 「记录依赖漏洞和过期依赖，但不要在本阶段批量升级」）/ **关键检查全部阻断** ✅。
> `.cache/verify.sh` 同步补 `08d-format-check`（`gate pnpm format:check`）。
> ⚠️ **四条新门禁本地一次都没跑过 → CI 现在预期是红的** —— 这是任务书第 10 条
> 「关键检查失败时 CI 必须失败，不能只输出 warning」的直接后果，**不是**通过屏蔽 lint
> 制造 PASS（§ 2.2）。**把树改绿才是修法。**
>
> **H2（第十九批，2026-11-06）**：新增 `docs/phase16/lan-security-coverage.md` ——
> **13 个安全场景 → 具体用例的逐条台账**（层次 / 文件行号 / 用例名 / 断言内容 /
> 每条**证明不了什么**）。**13/13 都有可重复的自动化测试**，**新增 0 条用例**
> （台账映射的是 Phase A / B / C 产出的既有用例）。
> 核对时查出一件**容易搞错的事**，台账里写明了：**Rust 传输层本身不做认证**
> （字节管道，设计如此 —— 任何能连上 TCP 口的进程都能建链）；真正挡下"未知设备"的是
> **会话层的指纹钉住**（A3 握手把对端公钥钉进用户看到的指纹，指纹不符 →
> `peer-fingerprint-mismatch`，**一个字节的数据都没交换**）。
> ⚠️ 台账里靠 **Rust 那一半的 7 个场景，其用例自第四批之后没再跑过** → § 8.8.18。
>
> **H1 / H2 的实测（第二十批，2026-11-06）**：维护者代跑复跑脚本 ——
> **`01`~`07` 全绿**（TypeScript **1032 条通过 + 8 条跳过**）、
> **`09a`~`09c2` 全绿**（Rust **48/48**）、**`cargo fmt --check` 与 `cargo clippy` 两条 Rust 门禁第一次跑成绿**
> → **H2 台账里靠 Rust 那一半的 7 个场景从"没再跑过"变成有实测证据**。
> ⚠️ **但 `pnpm lint` 与 `pnpm format:check` 这两条 TS 门禁仍然一次都没跑过**（第一轮停在 `08a`）→ **CI 现在预期仍是红的**。
> 🔴 **类型检查一次性抓出 8 个类型缺陷**（`packages/storage` 1 条 + `apps/desktop` 7 条 —— **其中两条落在 Phase D 自己的文件里、一条是 Phase F 加的字段让夹具过期**；⚠️ **这 8 条里 `08a-typecheck` 自己只报了 1 条**，另外 7 条是 `09f-tauri-build` 的 `tsc -b` 报出来的）→ **已全部修好、补了 3 条回归用例，但修复本身 `NOT_RUN`**。
> ⚠️ **依赖审计第一次出结果**：`pnpm audit` **46 条 advisory（全部在 devDependency 链上）**、`cargo update --dry-run` **67 个落后 crate**，**都没升级**（任务书第 149 行）；**`cargo audit` 因网络取不到 RustSec 库没扫成，仍记 `NOT_RUN`**。
> 🔴 `09i-pnpm-outdated` 的失败是**用法错误**（pnpm 10 的 `outdated` 不接受 `--registry`），**不是"有落后版本"** → 脚本已改用 `npm_config_registry`。
> → § 8.8.19。

---

## Phase I — 文档和发布状态统一（P1）

前置条件：各阶段完成后更新。

| 编号 | 任务                                                                                       | 状态          | 关键文件 |
| ---- | ------------------------------------------------------------------------------------------ | ------------- | -------- |
| I1   | 同步 README / SECURITY / ARCHITECTURE / DEVELOPMENT_STATUS / ROADMAP / PROTOCOL 到真实实现 | `IN_PROGRESS` | 见左     |

> **I1 已提前做了一部分**：Phase A 落地后，`SECURITY.md`、`docs/PROTOCOL.md`、
> `docs/DEVELOPMENT_STATUS.md`、`README.md`、`docs/ARCHITECTURE.md` 里
> **因 Phase A 而失效的表述已被改正**（例如"LAN 流量未加密""私钥明文存储"
> "用配对码而非已验证密钥识别对端"）。
> 这**不等于** I1 完成：`ROADMAP.md` 与其余文档的全面对齐、以及最终发布状态的
> 统一，仍要在各阶段完成后做。

---

## 执行顺序

```
Phase 0 (基线)
   ↓
Phase A (A1 ∥ A2 → A3 → A4)
   ↓
Phase B (依赖 A2/A3)      Phase C ∥ Phase D ∥ Phase E ∥ Phase F   ← A 的设计确定后可分支
   ↓
Phase G (依赖 A)
   ↓
Phase H (随各阶段逐步接入测试)
   ↓
Phase I (反映最终实际实现)
```

---

## 最终交付

| 文件                               | 何时创建       | 状态          |
| ---------------------------------- | -------------- | ------------- |
| `docs/REMEDIATION_PLAN.md`         | Phase 0        | 已创建        |
| `docs/REMEDIATION_PROGRESS.md`     | Phase 0        | 已创建        |
| `docs/REMEDIATION_TEST_REPORT.md`  | Phase 0        | 已创建        |
| `docs/REMEDIATION_FINAL_REPORT.md` | 全部阶段完成后 | `NOT_STARTED` |

最终结论只能是 `READY_FOR_INTERNAL_TESTING` / `READY_FOR_LIMITED_BETA` / `NOT_READY` 三者之一。
