/**
 * dsh-prompt 用户命令面（PRD 第 4 节 / US-1~US-4）：/prompt 命令族 8 件。
 *
 *   /prompt                     列表（无参数）
 *   /prompt show <名>           看全文；不存在 → 错误并列出可用名字
 *   /prompt add <名> <单行正文> 新增（多行正文引导走模型工具/编辑器，命令只收单行）
 *   /prompt edit <名>           返回 .md 路径，交给编辑器（改完即时生效，store mtime+size 失效）
 *   /prompt rm <名>             直接删（无回收站，PRD Q4）
 *   /prompt use <名> [补充语]   正文+补充语拼接为一条 user 消息 agent.followup 直发唤醒模型
 *                               （project-memory M2 实测原语），返回回显确认
 *   /prompt restore [名]        无参列种子；带参从包内种子恢复
 *   /prompt stats               本地 journal 汇总（无遥测）
 *
 * ⚠ 集成注意：本文件注册的命令名与 index.js 的 Spike 占位段同名（command "prompt"
 * is already registered 会抛错且整插件不激活）。实装落地后必须移除 index.js 占位段
 * （该文件不在本任务改动范围，由集成步骤处理）。
 *
 * store 契约（T2 交付）：
 * - use 的 journal('use', {name}) 埋点在命令层（store 未内置），followup 成功发出后调用；
 * - delete 埋点 store 已内置（remove 路径），命令层勿重复记；
 * - 错误 code PROMPT_EXISTS / PROMPT_NOT_FOUND / PROMPT_INVALID_NAME / PROMPT_SEED_NOT_FOUND
 *   透传为用户文案（PROMPT_EXISTS 的 store 文案含工具向 overwrite 参数，命令层改写）；
 * - 编辑器直改 .md 即时生效靠 store 的 mtime+size 缓存失效，命令层不加读缓存。
 *
 * 注册 API（2026-10-14 实测，dsh 0.2.0-rc.2，dsh-commands 源码）：
 * - ctx.commands.register({ name, description, input?: { hint }, handler })；
 *   重复名注册抛 `command "prompt" is already registered`；handler 可 async，
 *   返回 { kind:'success', text? } | { kind:'error', text }（error.text 非空）；
 * - invocation = { commandId, agent, rawInput（"/prompt" 之后的原文）, attachments, signal }；
 * - agent.followup({ id, role:'user', content:[{type:'text',text}], source }) 唤醒模型，
 *   fire-and-forget（同步异常 catch 转错误结果，不 await）。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createStore } from './store.js';

/** 事件展示顺序（stats）；未 listed 的事件并入「其他」。 */
const EVENT_ORDER = ['use', 'get', 'save', 'delete', 'restore'];

function err(text) {
  return { kind: 'error', text };
}

function ok(text) {
  return { kind: 'success', text };
}

/** store 错误 → 命令用户文案。错误码语义透传，文案保持命令面口径。 */
function errorText(e) {
  const message = e?.message ?? String(e);
  if (e?.code === 'PROMPT_EXISTS') {
    return `${message.split('。')[0]}。修改请用 /prompt edit <名>，或先 /prompt rm <名> 再 add。`;
  }
  return message; // PROMPT_NOT_FOUND / PROMPT_INVALID_NAME / PROMPT_SEED_NOT_FOUND 及兜底，直接透传
}

/** PROMPT_NOT_FOUND 时把可用名字附在错误文案后（PRD US-1/US-2 验收：列可用名字）。 */
async function withAvailableNames(e, store) {
  let names = [];
  try {
    names = (await store.list()).map((entry) => entry.name);
  } catch {
    /* 列不出来就不附加 */
  }
  return `${e.message.replace(/。$/, '')}。可用：${names.join('、') || '（库为空）'}`;
}

/** 子命令切分：首 token = 子命令，其余原样保留（add/use 的正文与补充语允许含空格）。 */
function splitInput(rawInput) {
  const rest = String(rawInput ?? '').trim();
  const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  return m ? { sub: m[1].toLowerCase(), args: m[2].trim() } : { sub: '', args: '' };
}

function shortDate(entry) {
  return (entry.updated ?? entry.mtimeIso ?? '').slice(0, 10) || '未知';
}

const USAGE = [
  '用法：/prompt <子命令> [参数]',
  '  /prompt                      列出全部提示词',
  '  /prompt show <名>            查看全文',
  '  /prompt add <名> <单行正文>  新增（同名拒绝）',
  '  /prompt edit <名>            返回文件路径，交给编辑器修改',
  '  /prompt rm <名>              删除',
  '  /prompt use <名> [补充语]    作为用户消息直发唤醒模型',
  '  /prompt restore [名]         从包内种子恢复；无参列出可用种子',
  '  /prompt stats                本地使用统计',
].join('\n');

async function cmdList(store) {
  const entries = await store.list();
  if (entries.length === 0) {
    const seeds = await store.listSeeds();
    return ok(`提示词库为空（${store.root}）。\n新建：/prompt add <名> <单行正文>\n可从包内种子恢复：${seeds.join('、') || '（无）'}`);
  }
  const lines = entries.map((e) => {
    const tags = e.tags.length ? ` [${e.tags.join(',')}]` : '';
    const bad = e.malformed ? ' ⚠解析失败' : '';
    return `- ${e.name}${e.source === 'seed' ? '（种子）' : ''}${tags}${bad} — ${e.description || '（无描述）'}（${shortDate(e)}）`;
  });
  return ok(`共 ${entries.length} 条提示词（${store.root}）：\n${lines.join('\n')}\n查看：/prompt show <名>；调用：/prompt use <名> [补充语]`);
}

async function cmdShow(store, name) {
  if (!name) return err(`/prompt show <名> — 缺少名字。${USAGE.split('\n')[0]}`);
  let entry;
  try {
    entry = await store.get(name);
  } catch (e) {
    if (e?.code === 'PROMPT_NOT_FOUND') return err(await withAvailableNames(e, store));
    return err(errorText(e));
  }
  const tags = entry.tags.length ? `\ntags: ${entry.tags.join(', ')}` : '';
  const bad = entry.malformed ? '\n⚠ frontmatter 解析失败，按纯正文展示' : '';
  return ok(`# ${entry.name}（${entry.source === 'seed' ? '种子' : '自建'}，更新 ${shortDate(entry)}）${tags}${bad}\n\n${entry.body}`);
}

async function cmdAdd(store, rest) {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(rest ?? '');
  if (!m || !m[2].trim()) return err(`用法：/prompt add <名> <单行正文>（多行正文请用编辑器或让模型调 prompt_save 工具）`);
  try {
    const r = await store.add({ name: m[1], body: m[2].trim() });
    return ok(`已新增「${r.name}」（${m[2].trim().length} 字符）→ ${r.file}\n修改：/prompt edit ${r.name}；调用：/prompt use ${r.name}`);
  } catch (e) {
    return err(errorText(e));
  }
}

async function cmdEdit(store, name) {
  if (!name) return err(`用法：/prompt edit <名>`);
  try {
    const r = await store.edit({ name });
    return ok(`请用编辑器打开（保存后即时生效）：\n${r.file}`);
  } catch (e) {
    return err(errorText(e));
  }
}

async function cmdRm(store, name) {
  if (!name) return err(`用法：/prompt rm <名>（直接删除，无回收站；种子可 /prompt restore <名> 找回）`);
  try {
    const r = await store.remove(name);
    return ok(`已删除「${r.name}」（${r.file}）。误删种子可 /prompt restore ${r.name} 找回。`);
  } catch (e) {
    return err(errorText(e));
  }
}

async function cmdUse(store, invocation, rest) {
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec((rest ?? '').trim());
  if (!m) return err(`用法：/prompt use <名> [补充语]`);
  let entry;
  try {
    entry = await store.get(m[1]);
  } catch (e) {
    if (e?.code === 'PROMPT_NOT_FOUND') return err(await withAvailableNames(e, store));
    return err(errorText(e));
  }
  const supplement = (m[2] ?? '').trim();
  const message = entry.body + (supplement ? `\n\n${supplement}` : '');
  let r;
  try {
    r = invocation.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: { kind: 'dsh-prompt', form: 'use' }, // PRD US-1：会话日志可见该消息且 source 标识 prompt 库来源
    });
  } catch (e) {
    return err(`唤醒失败（模型未被唤醒）：${errorText(e)}`);
  }
  // 宿主契约 fire-and-forget（不 await）；若返回 Promise 且异步失败，防御性吞掉避免 unhandledRejection
  // （同步异常已由上方 catch 转错误结果）。已知近似：异步失败时 journal 的 use 已记，stats 口径偏大。
  if (r && typeof r.catch === 'function') r.catch(() => {});
  await store.journal('use', { name: entry.name }); // T2 契约：use 埋点在命令层
  const preview = message.length > 120 ? `${message.slice(0, 120)}…` : message;
  return ok(
    `已用「${entry.name}」唤醒模型（正文 ${entry.body.length} 字${supplement ? ` + 补充语 ${supplement.length} 字` : ''}）。\n已发送内容预览：\n${preview}`,
  );
}

async function cmdRestore(store, name) {
  if (!name) {
    const seeds = await store.listSeeds();
    return ok(`可用包内种子：${seeds.join('、') || '（无）'}\n恢复：/prompt restore <名>（覆盖用户库同名条目为种子原文）`);
  }
  try {
    const r = await store.restore(name);
    return ok(`已从种子恢复「${r.name}」→ ${r.file}`);
  } catch (e) {
    return err(errorText(e)); // PROMPT_SEED_NOT_FOUND 文案已含可用种子清单
  }
}

/** 读 journal 全部事件（坏行跳过）。journal 目录不存在 = 无记录。 */
async function readJournalEvents(journalDir) {
  let files;
  try {
    files = (await fs.readdir(journalDir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const events = [];
  for (const f of files) {
    let text = '';
    try {
      text = await fs.readFile(path.join(journalDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {
        /* 坏行跳过：journal 是 best-effort 数据 */
      }
    }
  }
  return events;
}

async function cmdStats(store) {
  const events = await readJournalEvents(store.journalDir);
  if (events.length === 0) {
    return ok(`暂无使用记录（journal：${store.journalDir}）。`);
  }
  const byEvent = {};
  const useCount = {};
  let last = null;
  for (const ev of events) {
    byEvent[ev.event] = (byEvent[ev.event] ?? 0) + 1;
    if (ev.event === 'use' && ev.name) useCount[ev.name] = (useCount[ev.name] ?? 0) + 1;
    if (ev.ts && (!last || ev.ts > last.ts)) last = ev;
  }
  const eventLine = EVENT_ORDER.map((k) => `${k} ${byEvent[k] ?? 0}`).join('、')
    + (Object.keys(byEvent).some((k) => !EVENT_ORDER.includes(k))
      ? `、其他 ${Object.entries(byEvent).filter(([k]) => !EVENT_ORDER.includes(k)).reduce((s, [, v]) => s + v, 0)}`
      : '');
  const top = Object.entries(useCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, n]) => `${name} ×${n}`).join('、');
  return ok([
    `提示词库本地统计（journal：${store.journalDir}，仅本地无遥测）：`,
    `- 事件：${eventLine}（共 ${events.length} 条）`,
    top ? `- use 最常用：${top}` : '- use 最常用：（暂无 use 记录）',
    last ? `- 最近事件：${last.ts} ${last.event}${last.name ? ` ${last.name}` : ''}` : '',
  ].filter(Boolean).join('\n'));
}

/** /prompt 主分发。参数结构见文件头注释。 */
async function handlePrompt(invocation, store) {
  const { sub, args } = splitInput(invocation.rawInput);
  switch (sub) {
    case '':
      return cmdList(store);
    case 'list':
      return cmdList(store);
    case 'show':
      return cmdShow(store, args.split(/\s+/)[0] ?? '');
    case 'add':
      return cmdAdd(store, args);
    case 'edit':
      return cmdEdit(store, args.split(/\s+/)[0] ?? '');
    case 'rm':
    case 'remove':
      return cmdRm(store, args.split(/\s+/)[0] ?? '');
    case 'use':
      return cmdUse(store, invocation, args);
    case 'restore':
      return cmdRestore(store, args.split(/\s+/)[0] ?? '');
    case 'stats':
      return cmdStats(store);
    default:
      return err(`未知子命令「${sub}」。${USAGE}`);
  }
}

/**
 * 注册 /prompt 命令族。真实宿主由 index.js 调用（registerCommands(ctx)）；
 * 单测传 options.store 注入临时目录 store，避免触碰真实 ~/.dsh/prompts。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{store?: ReturnType<import('./store.js').createStore>}} [options]
 */
export function registerCommands(ctx, options = {}) {
  const store = options.store ?? createStore();
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'prompt',
        description: '用户提示词库（dsh-prompt）：列表/查看/新增/编辑/删除/直发/种子恢复/本地统计。',
        input: {
          hint: 'use <名> [补充语] | show <名> | add <名> <单行正文> | edit <名> | rm <名> | restore [名] | stats（无参数=列表）',
        },
        handler(invocation) {
          return handlePrompt(invocation, store);
        },
      }),
    'dsh-prompt.register(command:prompt)',
  );
}
