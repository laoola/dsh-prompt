---
name: commit-msg
description: commit message 规范：type(scope) 祈使句摘要，正文讲动机
tags: [git, 提交]
created: 2026-10-14T00:00:00.000Z
updated: 2026-10-14T00:00:00.000Z
source: seed
---
根据当前暂存区改动（git diff --staged）写一条 commit message：

1. 标题：`type(scope): summary`，summary ≤ 50 字符、祈使句、结尾不加句号；
   type 从 feat / fix / refactor / docs / test / chore / perf 中选，scope 取最小受影响模块名。
2. 空一行后写正文：说明「为什么改」与影响面（不是逐文件复述改了什么），每行 ≤ 72 字符，最多 5 行。
3. 破坏性变更正文末尾加 `BREAKING CHANGE:` 说明；关闭 issue 加 `Closes #N`。
4. 只输出提交信息本身，不要解释、不要代码块包裹。
