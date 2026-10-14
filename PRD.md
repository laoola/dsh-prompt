# PRD：dsh-prompt — DSH 用户自定义提示词库插件

**Status**: Approved（2026-10-14 第 9 节开放问题已拍板，见该节拍板记录）
**Author**: Alex（PM）  **Last Updated**: 2026-10-14  **Version**: 0.1
**Stakeholders**: 用户本人（唯一决策人）、后续使用者（分发对象）

> 继承仓库级默认约束（`D:\GitCode\dshplugin\PRD-TEMPLATE.md` 头部，2026-10-13 已拍板）：
> ① 分发定位——他机可安装、可复现，文档与 DSH peer 兼容为必答题；② 成功信号 = 30 天使用频率，跨机器计数来源在第 3 节落实。

---

## 1. 问题陈述（为什么做）

以 DSH 做日常开发的用户，反复手敲同一批提示词（代码评审口径、commit message 规范、翻译风格、总结模板等）。这些常用语料今天散落在三个地方，各有硬伤：

- **AGENTS.md / CLAUDE.md**：全文常驻每个会话上下文——为了偶尔用一段话，付出每会话的 token 成本；
- **skills（`~/.agents/skills`）**：模型按语义自主匹配加载，用户**无法主动点名调用**，且 SKILL.md 是"任务说明书"定位，塞常用提示词会稀释技能触发的准确性；
- **`dsh-persona` / system prompt 配置**：全局只有一个 persona 槽，改一句话要动 `cordis.patch.yml` 并重启，且对每次请求生效——不适合"这次用一下"的一次性提示。

不解决的代价：常用提示词要么付上下文税，要么散在笔记里靠翻找，重复劳动每天发生；第三方工具的内置提示词库则普遍"删不掉、删了升级又回来、改了被覆盖"，用户对库没有完全所有权。

**证据**：
- 行为数据：本机 `~/.agents/skills` 已沉淀 110 个技能、全局/项目 AGENTS.md 多份定制约定（ECC 规则库按需读取、记忆罗盘行为契约等）——用户有强烈的"常用指令沉淀为可复用文本"习惯，但没有一个轻量的"随取随用"出口；
- 直接需求（n=1，用户本人）：2026-10-14 明确提出本插件立项，核心诉求原话要点——"不内置提示词，或内置提示词支持删除和编辑（用户可完全自定义提示词库）"；
- 现有机制缺口：DSH 合成树中 `commands`/`ui-commands`/`tools` 均已就位但无任何提示词库 bundle（`dsh --profile web --dump-config` 查证，2026-10-14），生态位空缺。

## 2. 目标用户与核心场景

| 项 | 内容 |
|---|---|
| 目标用户 | 首要：本机唯一用户（`dsh web`/`dsh acp` 日常开发者本人）；次要：分发后同样以 DSH 为日常开发环境的开发者 |
| 核心场景 | ①（高频）会话中想用某段常用提示词：敲 `/prompt use code-review Fix store.js 的内存泄漏` → 提示词正文拼上补充语直接发给模型，模型按既定口径干活；②（中频）沉淀新提示词：对模型说"把刚才这段保存为提示词 xxx"或 `/prompt add` → 落入库；③（低频）整理库：`/prompt` 列清单、`/prompt rm` 删掉不用的、直接用编辑器改 `.md` 文件 |
| 明确不支持 | V1 不做：提示词市场/在线分享、多人协作、自动注入会话上下文、系统提示词（persona）替换、移动端 |

### 用户故事与验收标准

**US-1（调用）**: 作为用户，我想要 `/prompt use <名字> [补充语]` 一键把提示词发给模型，以便不重复手敲常用指令。

- [ ] Given 库中存在 `code-review.md`，When `/prompt use code-review Fix the leak`，Then 该提示词正文与补充语拼接后作为一条用户消息唤醒一轮模型响应（会话日志可见该消息，source 标识 prompt 库来源）
- [ ] Given 名字不存在，When `/prompt use nope`，Then 命令返回错误文本并列出可用名字，模型不被唤醒
- [ ] 性能：命令返回确认 < 1s（P95，本地文件读取）

**US-2（沉淀）**: 作为用户，我想要模型代劳保存提示词，以便对话不中断。

- [ ] Given 会话中产出了一段满意提示词，When 用户说"把这段保存为提示词 named-x"，Then 模型调用 `prompt_save` 工具，返回落盘路径，`~/.dsh/prompts/named-x.md` 存在且 frontmatter 完整
- [ ] Given 同名已存在，When 再次保存，Then 默认拒绝并要求 `overwrite: true` 显式覆盖

**US-3（完全所有权：删除/编辑）**: 作为用户，我想要删除或编辑任何提示词（含初始内置的），且删除永不复活，以便库完全属于我。

- [ ] Given 全新安装后种子已复制进用户库，When `/prompt rm commit-msg` 后重启 DSH、升级插件、重启机器，Then `commit-msg.md` 保持不存在（升级只更新包内种子，不回写用户库）
- [ ] Given 任意条目（含种子副本），When 用编辑器直接修改其 `.md` 文件，Then 下次 `/prompt` 列表与调用即时反映修改（无缓存或缓存按 mtime 失效）
- [ ] Given 误删，When `/prompt restore commit-msg`，Then 从包内种子恢复该条

**US-4（管理）**: 作为用户，我想要 `/prompt` 一条命令看清库的全貌，以便决定用/删/改。

- [ ] Given 库中有 N 条，When `/prompt`，Then 输出每条的名字、一行描述、来源（seed/user）、更新时间；空库输出引导文案
- [ ] 分发验收：Given 一台全新机器（仅装 DSH），When 按 README 执行 `dsh plugin --profile web add <包路径>` 并重启，Then `dsh --profile web --dump-config` 可见本插件、`dsh web` 启动日志无 "entries did not activate"、`/prompt` 可用

## 3. 成功指标（上线后怎么判断成败）

| 指标 | 基线 | 目标 | 度量窗口 | 数据来源 |
|---|---|---|---|---|
| 周提示词调用次数（`use` + 模型 `prompt_get`） | 0 | ≥ 10 次/周 | 上线后 30 天 | 本地 journal JSONL（`~/.dsh/prompts/journal/*.jsonl`，无遥测）+ `/prompt stats` 本地汇总 |
| 库条目数（沉淀行为） | 0 | ≥ 8 条且 ≥3 条为自建（非种子） | 上线后 30 天 | 同上（`save`/`add` 事件） |
| 分发后价值确认 | — | 至少 1 台他机安装且 journal 有调用记录 | 首次分发后 30 天 | 用户向使用者索要 `/prompt stats` 输出回传（插件无遥测，人工回传是唯一跨机器通道——按仓库红线在此落实） |

> 30 天未达标（周调用 < 3 且自建条目 = 0）→ 按第 8 节决定改造或下线，不默认续命。

## 4. 第一版（MVP）范围

- [ ] **库核心**：`~/.dsh/prompts/` 全局单库；每条一个 `.md`（YAML frontmatter：`name`/`description`/`tags`/`created`/`updated`/`source` + 正文=提示词全文）；CRUD 全量（含 `overwrite` 保护和 `restore`）。（边界：不做项目级库、不做嵌套目录/命名空间）
- [ ] **种子复制（copy-on-first-run）**：包内 `seeds/` 携带 5–8 条通用种子；首次激活时缺失即复制进用户库（`source: seed`），此后包升级**永不回写**用户库；`/prompt restore <名>` 可从包内种子恢复任意条。（边界：不做"常驻内置+覆盖层"双层机制）
- [ ] **用户命令集**：`/prompt`（列表）、`/prompt show <名>`、`/prompt add <名> <单行正文>`、`/prompt edit <名>`（返回文件路径）、`/prompt rm <名>`、`/prompt use <名> [补充语]`、`/prompt restore [名]`、`/prompt stats`。（边界：多行正文录入引导走模型工具或编辑器，命令只收单行）
- [ ] **模型工具集**：`prompt_list` / `prompt_get` / `prompt_save` / `prompt_delete` 四件（签名与 `project-memory` 工具同构：output schema + render，`timeoutMs` 10s）。（边界：不做 `prompt_update`——save+overwrite 覆盖）
- [ ] **本地 journal**：`~/.dsh/prompts/journal/YYYY-MM.jsonl` 记录 `use/get/save/delete/restore` 事件，供第 3 节指标与 `/prompt stats`。（边界：无遥测、无上报）

## 5. 暂缓事项（V1 明确不做）

| 事项 | 来源 | 暂缓原因 | 重新考虑条件 |
|---|---|---|---|
| 项目级库（per-project `.dsh/prompts/`） | 自己提出 | 提示词天然是跨项目资产；全局库已覆盖核心场景 | 出现"这段提示词只想在某项目生效"的真实用例 |
| 模板变量（`{{input}}` 填充交互） | 自己提出 | 需要输入 UI 或多轮确认，MVP 复杂度翻倍；原样发送+用户补充已够用 | `/prompt use` 高频使用者提出占位符诉求 |
| Web UI 管理面板 | 模板惯例 | client UI 插件成本高；文件即界面（编辑器改 .md）已满足 | 30 天指标达标且条目 > 30 出现管理痛点 |
| 导入导出/分享包 | 自己提出 | 单文件 `.md` 天然可分享（复制文件即导入） | 出现批量分享/市场诉求 |
| 与 skills 互通（一个文件既是 skill 又是 prompt） | 自己提出 | 两者触发模型不同（语义匹配 vs 点名调用），强绑互相污染 | DSH 官方统一资产机制出现 |

## 6. 方案概述与关键决策

一个 Host bundle 插件（与 `project-memory` 同形态）：激活时注册一组用户 slash 命令 + 一组模型工具，操作 `~/.dsh/prompts/` 下的 Markdown 文件库。无自动注入——提示词库与记忆库相反，它是**按需拉取**的资产，不该为"可能用"付每会话上下文成本。

**决策 1：内置策略选"种子复制"，弃"常驻内置 + 用户覆盖层"。** 用户诉求是"内置提示词可删可编辑"。覆盖层方案（内置只读 + 用户层 diff）要求删除/编辑逻辑处理双层合并，且升级重装内置项时会"删了又回来"——这正是用户痛点的来源。种子复制让用户库成为唯一事实源：首次激活把包内 `seeds/*.md` 复制进用户库，之后包升级只更新包内种子文件、不碰用户库，删除即永久删除、编辑无合并冲突；代价是种子文案改进不会自动到达老用户（`restore` 手动恢复，可接受——提示词是个人资产，静默改动它反而是冒犯）。若用户最终拍板"完全不内置"，本方案退化为空种子目录，机制不变。

**决策 2：存储选"每条一个 .md（frontmatter+正文）"，弃单 JSON。** 用户可直接用编辑器看和改（US-3 的编辑路径因此零开发），git 可版本化，单文件复制即分享。代价是列表/校验要遍历目录——条目量级 <100，无性能问题。frontmatter 解析手写约 30 行，不引依赖（仓库零新增依赖惯例）。

**决策 3：交互选"命令 + 工具双面"，弃纯工具或纯命令。** `/prompt use` 是人肉高频动作，slash 命令比"请模型调用工具"少一轮推理、快且省 token；"把这段存为提示词"是模型上下文内的动作（正文在对话里），工具代劳最自然。两面共享同一 store 层。已查证：`ctx.commands` 为插件可用注册表（`@deepseek-ai/dsh-commands` 类型注释 "Plugin-owned human-command registry"），web profile 合成树已含 `commands`/`ui-commands`（2026-10-14 冒烟）。

**决策 4：`/prompt use` 的发送机制选 `agent.followup` 直发（MVP）。** 命令 handler 拿到 `invocation.agent` 后，以提示词正文+补充语构造 user 消息 followup 唤醒模型（该原语已在 `project-memory` M2 实测）。弃"填充输入框等用户确认"——需 client UI 插件能力，M1 Spike 不覆盖；代价是误触发即直发（靠 `/prompt show` 先看全文缓解）。见开放问题 Q2。

## 7. 技术考量（DSH 特有）

| 项 | 内容 |
|---|---|
| 插件形态 | **Host bundle**（随 profile 加载）。理由：需注册 host 侧 `tools` 与 `commands` 服务，纯 MCP/配置 overlay 无此能力；UI 面板已列入暂缓，不需要 client bundle。零宿主 import（同 `project-memory`；`inject` 以**入口模块命名导出**声明 `export const inject = ['tools', 'commands']`——M1 Spike 实测它不是 package.json 字段，缺导出插件不激活，见 API 笔记陷阱节） |
| 目标 profile | web（已冒烟确认 `commands`/`ui-commands` 在合成树）；acp/headless 的 slash 命令入口待 M1 Spike（工具面不受影响） |
| 接入方式 | `dsh plugin --profile web add <本地路径>`；`dsh.profile.bundles` 有序注册；升级/回滚为 pnpm 操作 + 重启 |
| 版本兼容 | peer 声明 `"@deepseek-ai/dsh": "^0.2.0-rc.0"`（M1 Spike 实测：检查器只评估 `@deepseek-ai/dsh` 名下的 peer，且 `0.2.0-rc.x` 字面范围 semver 不匹配 rc.2，必须用 `^0.2.0-rc.0`）；不匹配走 `version-exemptions` |
| 依赖 | **零新增**。frontmatter 手写解析；命令结果/工具输出复用 `project-memory` 的 OUTPUT schema 模式 |
| 存储 | `~/.dsh/prompts/*.md`（库）+ `seeds/*.md`（包内只读种子）+ `journal/YYYY-MM.jsonl`（日志）；`source` 字段区分 `seed`/`user`，仅用于展示，**不产生任何行为差异**（种子副本与自建条目同权可删可改） |

**风险**：

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| `commands` 服务在某些 profile 未装载导致激活失败 | Medium | High（`inject` 拿不到服务整个插件不激活） | M1 首个 Spike 即验证；激活失败从 `dsh web` 启动日志 "entries did not activate" 段确认；必要时 inject 改懒解析 |
| slash 命令在 acp 模式无入口 | Medium | Medium（acp 用户退化为纯工具面 + 模型代劳） | Spike 验证；文档写明各 profile 能力矩阵 |
| `/prompt use` 直发误触发 | Low | Medium | `use` 返回回显确认文本；后续版本考虑 confirm 参数 |
| frontmatter 手写解析对非常规格式的容错 | Low | Low | 解析失败该条目标记 `malformed` 并在 `/prompt` 列表提示，不崩溃不吞条目 |

**验证命令**（写入验收）：

```sh
dsh --profile web --dump-config     # 合成树可见 dsh-prompt（configRef 属 absent 预期）
dsh web                             # 启动日志无 "entries did not activate" 含本插件
node --test test/store.test.mjs test/tools.test.mjs test/commands.test.mjs   # 显式列文件（API 笔记陷阱）
# US-3 冒烟：rm 一条种子 → 重启 dsh web → /prompt 列表确认仍未复活
```

## 8. 发布与回滚

| 阶段 | 动作 | 通过标准（可观察） |
|---|---|---|
| M1 本机冒烟 | 安装→重启→`/prompt` 见种子→`use` 一次→`rm` 一条→重启→确认未复活 | 第 2 节 US-1/3/4 全勾 + journal 有对应事件行 |
| M2 分发 | README（安装/卸载/FAQ"删除会不会复活"）+ 他机安装演练 | 全新机器按 README 走通 US-4 分发验收 |
| 日常使用 | 指标累计（第 3 节） | 30 天窗口达标或触发改造/下线评审 |

**回滚**：`dsh plugin --profile web remove dsh-prompt`（pnpm link: 移除异常时手编 profile `package.json` + `pnpm install`，API 笔记已记录该坑）→ 重启。用户库 `~/.dsh/prompts/` 独立于插件存在，卸载不删数据。

**里程碑**：
- **M1（功能闭环，本机）**：库核心 + 种子复制 + 命令/工具双面 + journal + 单测 + 激活冒烟（含 commands Spike）。
- **M2（分发硬化）**：他机安装验收 + README + `/prompt stats` 汇总 + `/prompt use` 拼接规则打磨（长提示词截断策略、补充语拼接格式）+ **提示词选择器 UI**（composer decoration：库面板点选 → 填输入框，前置 client 桥 Spike——见第 9 节追加裁决）。〔进度 2026-10-14 M2 收口：种子扩至 **12 条**（原 6 条 + unit-test / refactor-safe / explain-code / security-review / root-cause / docs-api，来源：prompt-architects 35 条、dev.to 资深工程师 7 场景、苏三说技术中文 10 条综合提炼）；选择器 UI **实机全链路通过**（按钮/面板/过滤/点选填入不自动发送，client 经 `commands.execute(sid,line,[])` 三参签名走 `--json` 通道）；README 更新；独立 git 仓库 M2 提交 `f346aeb`（40/40 测试）。**仅剩他机安装演练**〕
- **V1.5 候选**：第 5 节暂缓池按 30 天指标决定。

## 9. 开放问题（2026-10-14 已拍板）

> **追加裁决（2026-10-14，M1 交付后）**：Q2 修订——用户要求 **composer 可视化提示词选择器**：库面板点选 → 正文填入输入框 → 用户补充/修改后手动发送；`/prompt` 命令族保留为备用入口。选择器列入 M2，前置 Spike：client UI 插件机制（decoration 四文件模板、`client.platform: web`）+ host↔client 读库通道（ui-commands 或桥接，待查证）。

> **拍板记录（2026-10-14，决策人=用户）**：Q1、Q2、Q4、Q5、Q6、Q7 **全部按 PM 建议通过**——Q1 内置 5–8 条通用种子（种子复制方案）；Q2 `/prompt use` MVP 直发；Q4 直接删（不建 .trash/）；Q5 git 仓库直装；Q6 包名 `dsh-prompt`；Q7 模板变量不进 MVP。**Q3 已由 M1 Spike 结案**：`/prompt` 无冲突（宿主内建仅 compact/feedback/goal/permission/plan/export），维持原名；`/prompts`、`/p` 空闲备选。M2 的「种子内容定稿」指具体条目文案，策略已定。

| # | 问题 | PM 建议 | 决策人 |
|---|---|---|---|
| Q1 | 种子集内容：内置哪几条、几条？（推荐 5–8 条通用高频：代码评审口径 / commit message / 中英翻译 / 长文总结 / bug 复现步骤提问模板 / 正则解释） | 种子复制方案，5–8 条，全部 `source: seed` | 用户 |
| Q2 | `/prompt use` 直发 vs 填输入框确认 | MVP 直发（followup，已实测原语）；输入框方案待查证 client UI 能力后作 V1.5 | 用户 |
| Q3 | 命令名 `/prompt` 是否与其他 profile 既有命令冲突 | Spike 时 `ctx.commands.list()` 查重；冲突则改 `/p` 或 `/prompts` | M1 Spike 结论 |
| Q4 | 删除保护：直接删（journal 可追溯）vs 移入 `.trash/` | 直接删——文件可 git 版本化者自会备份，回收站徒增状态复杂度 | 用户 |
| Q5 | 分发渠道：npm 发布 vs git 仓库直装（`pnpm add <git url>`） | 先 git 直装（零发布流程），有外部需求再上 npm | 用户 |
| Q6 | 包名/目录名终稿：`dsh-prompt`（建议，与 `dsh-project-memory` 命名对齐）vs 其他 | `dsh-prompt` | 用户 |
| Q7 | 模板变量是否压缩进 MVP | 不进（见第 5 节暂缓表） | 用户 |
