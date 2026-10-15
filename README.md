# dsh-prompt

DSH 用户自定义提示词库（Host bundle）。把常用的提示词（代码评审口径、commit message 规范、翻译风格、总结模板……）沉淀为本机的 Markdown 文件库，`/prompt use <名字>` 一键发给模型，模型也可经 `prompt_*` 工具代劳存取。**库完全属于你**：任何条目（含内置种子）可删可改，删除永不复活。无云端、无遥测。

设计规格见 [PRD.md](PRD.md)（v0.1 Approved）。当前交付 **M2**（功能闭环 + 12 条种子 + composer 可视化选择器，40/40 测试）。

## 安装

```powershell
# 分发安装（git 仓库直装）
dsh plugin --profile web add github:laoola/dsh-prompt

# 本地开发安装（link 模式：安装即开发，同一份代码）
dsh plugin --profile web add D:\GitCode\dshplugin\dsh-prompt
```

验证：`dsh --profile web --dump-config` 输出中应出现 `dsh-prompt`（仅证明进入合成树）；**激活成败以 `dsh web` 启动日志为准**——出现 `entries did not activate` 且列出本插件即为失败。host 侧改动需重启 DSH 宿主生效；client 侧（选择器）改动**刷新页面即生效**。首次激活时包内 12 条种子自动复制进用户库，此后插件升级**永不回写**用户库。

## 命令

| 命令 | 行为 |
|---|---|
| `/prompt` | 列出全部条目（名字、描述、来源 seed/user、更新时间） |
| `/prompt show <名>` | 查看某条全文（加 `--json` 输出机器可读 JSON） |
| `/prompt add <名> <单行正文>` | 新增一条 |
| `/prompt edit <名>` | 返回 `.md` 文件路径，用编辑器直接改 |
| `/prompt rm <名>` | 删除（含种子副本，删除即永久删除） |
| `/prompt use <名> [补充语]` | 提示词正文 + 补充语拼接后直接发给模型 |
| `/prompt restore [名]` | 从包内种子恢复（误删急救） |
| `/prompt stats` | 本地 journal 使用统计 |

## 模型工具

| 工具 | 行为 |
|---|---|
| `prompt_list` | 列出库中全部条目元信息 |
| `prompt_get` | 读某条全文（对话中说"用 code-review 的口径看这段"时模型会调用） |
| `prompt_save` | 保存新条目（同名默认拒绝，需 `overwrite: true`）——对话中说"把这段存为提示词 xxx"时模型代劳 |
| `prompt_delete` | 删除条目 |

## 可视化选择器（推荐）

composer 输入框工具行的**提示词库**按钮：点开面板 → 按名称/描述/标签过滤 → 点选条目 → 正文填入输入框，**不自动发送**，确认或改写后再发。适合「取其意、改其文」；`/prompt use` 则适合确认过口径直接发。面板支持 Esc / 点击面板外关闭，解析失败的条目置灰禁点。

搜索框下方列出库内全部标签（按使用条数排序），点击即按标签过滤、再点取消，与文本过滤叠加生效；条目为紧凑两行布局（名称+标签 / 描述），同屏可见更多条目。种子标签为中文（专有名词如 `git` 保留），自建提示词可随意用中文标签。

## 存储

```
~/.dsh/prompts/
├── <名字>.md          # 每条一个文件：YAML frontmatter（name/description/tags/created/updated/source）+ 正文
└── journal/           # 本地使用日志 JSONL（use/get/save/delete/restore 事件），仅本机文件
```

- 正文即提示词全文，编辑器直接改，git 可版本化，单文件复制即分享；
- `source: seed` 与 `source: user` 仅用于展示，**行为完全同权**；
- frontmatter 解析手写实现，零依赖。

## 内置种子（12 条）

首次激活自动复制进用户库；此后包内种子仅作 `restore` 源，升级不回写。

| 名称 | 用途 |
|---|---|
| code-review | 代码评审口径：先正确性后可读性，意见带依据与改法 |
| unit-test | 生成单元测试：成功/失败/边界全覆盖，mock 外部依赖 |
| refactor-safe | 行为保持重构：小步可交付，公共 API 不动，疑似 bug 只标记 |
| explain-code | 代码讲解：输入输出、关键步骤、设计意图、坑与改进 |
| security-review | 安全审计：信任边界追踪、鉴权与认证分开查、按严重度给攻击路径 |
| root-cause | 根因定位：候选排序、含非代码因素、二分策略与证伪证据 |
| docs-api | 接口文档生成：请求/响应/错误条件/示例用法 |
| commit-msg | 提交信息撰写 |
| summarize | 长文总结：三句结论 → 分节要点 → 开放问题 |
| translate-cn | 中英互译 |
| bug-report | 缺陷报告结构化 |
| regex-explain | 正则解读 |
| req-clarify | 需求澄清：复述结构化 → 标注模糊/缺失 → 批量追问带默认建议，确认后才动工 |

## 兼容性

- 宿主 peer：`@deepseek-ai/dsh ^0.2.0-rc.0`（实测 0.2.0-rc.2 / Node 24 / Windows）；
- 零依赖、无构建；安装闸提示需要 allowBuilds 时按 `dsh plugin add` 报错中的精确键加入 profile 的 `pnpm-workspace.yaml` 即可；
- 卸载：`dsh plugin --profile web remove dsh-prompt`。用户库 `~/.dsh/prompts/` 独立于插件存在，卸载不删数据。

## FAQ

**删除的种子提示词升级后会复活吗？**
不会。种子复制是 once-copy-on-first-run：首次激活复制后，包升级只更新包内种子文件、永不回写用户库。误删可用 `/prompt restore <名>` 从包内种子手动恢复。

**为什么提示词不自动注入每个会话？**
提示词库与记忆库相反，是**按需拉取**的资产——自动注入等于为"可能用"付每会话上下文成本（token 税）。`/prompt use` 与 `prompt_get` 都是显式拉取。

## 测试

```powershell
node --test   # 40/40（store / tools / commands）
```

## License

[MIT](LICENSE)
