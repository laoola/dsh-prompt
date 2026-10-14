# dsh-prompt

DSH 用户自定义提示词库（Host bundle）。把常用的提示词（代码评审口径、commit message 规范、翻译风格、总结模板……）沉淀为本机的 Markdown 文件库，`/prompt use <名字>` 一键发给模型，模型也可经 `prompt_*` 工具代劳存取。**库完全属于你**：任何条目（含内置种子）可删可改，删除永不复活。无云端、无遥测。

设计规格见 [PRD.md](PRD.md)（v0.1 Approved）。当前交付 **M1**（功能闭环 + 6 条种子，39/39 测试）。

## 安装

```powershell
dsh plugin --profile web add github:laoola/dsh-prompt
```

验证：`dsh --profile web --dump-config` 输出中应出现 `dsh-prompt`（仅证明进入合成树）；**激活成败以 `dsh web` 启动日志为准**——出现 `entries did not activate` 且列出本插件即为失败。安装后需重启 DSH 宿主生效。首次激活时包内 6 条种子自动复制进用户库，此后插件升级**永不回写**用户库。

## 命令

| 命令 | 行为 |
|---|---|
| `/prompt` | 列出全部条目（名字、描述、来源 seed/user、更新时间） |
| `/prompt show <名>` | 查看某条全文 |
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

## 存储

```
~/.dsh/prompts/
├── <名字>.md          # 每条一个文件：YAML frontmatter（name/description/tags/created/updated/source）+ 正文
└── journal/           # 本地使用日志 JSONL（use/get/save/delete/restore 事件），仅本机文件
```

- 正文即提示词全文，编辑器直接改，git 可版本化，单文件复制即分享；
- `source: seed` 与 `source: user` 仅用于展示，**行为完全同权**；
- frontmatter 解析手写实现，零依赖。

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
node --test test/store.test.mjs test/tools.test.mjs test/commands.test.mjs
```

## License

[MIT](LICENSE)
