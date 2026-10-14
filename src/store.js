/**
 * dsh-prompt 库核心（PRD 第 4/6 节）：~/.dsh/prompts/ 全局单库的 Markdown 文件 CRUD。
 *
 * - 决策 2：每条一个 .md（手写 YAML frontmatter + 正文=提示词全文），零依赖，frontmatter 解析约 30 行。
 * - 决策 1：种子 copy-on-first-run —— 包内 seeds/ 缺失即复制进用户库（source: seed），
 *   此后升级永不回写用户库；删除即永久删除，restore 手动从种子恢复。
 * - 容错（PRD 风险表）：frontmatter 解析失败条目标记 malformed，不崩溃不吞条目。
 * - mtime+size 缓存：编辑器直接改 .md 即时生效（文件没变才复用解析结果）。
 * - journal：~/.dsh/prompts/journal/YYYY-MM.jsonl 追加 use/get/save/delete/restore 事件，best-effort，无遥测。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 用户库默认位置：~/.dsh/prompts/。 */
export function defaultRoot() {
  return path.join(homedir(), '.dsh', 'prompts');
}

/** 首次播种标记（库内隐藏文件）：存在 = 种子复制已执行过，此后激活/升级永不回写用户库（PRD 决策 1 + US-3）。 */
export const SEED_MARKER = '.seeded';

/** 包内只读种子目录（<pkg>/seeds/，随包升级，永不写回用户库）。 */
export function defaultSeedsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seeds');
}

/**
 * 名字即文件名：去掉路径分隔符/控制字符，空白压缩为 -，限 80 字符
 * （对齐 project-memory 的 sanitizeTopic 约定）。中文名合法。
 * Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，大小写不敏感，含带扩展名形式）
 * 命中即返回空串 → 上层判 PROMPT_INVALID_NAME（Win32 会把 CON.md 解析为设备而非文件）。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeName(name) {
  const s = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (WINDOWS_RESERVED.test(s)) return '';
  return s.slice(0, 80);
}

/**
 * 引号包裹值剥引号。写出侧 yamlScalar 用 JSON.stringify 转义（值含 `"` 时落盘为 \" 形式），
 * 读回侧对双引号包裹值先试 JSON.parse 对称反转义；失败（手工编辑出的非 JSON 引号串）再剥外层。
 */
function unquote(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * 手写 YAML frontmatter 解析（零依赖）。只认本库用到的平铺标量与 tags 两种写法
 * （inline `tags: [a, b]` / 块列表 `- item`）。容错承诺：任何解析失败都不抛错、不吞条目——
 *   - 无 frontmatter：整文按正文；
 *   - 有 `---` 开头无闭合 / 个别行解析不了：malformed=true，已解析到的字段照常返回。
 * @returns {{data: Record<string, string|string[]>, body: string, malformed: boolean}}
 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const out = { data: {}, body: text, malformed: false };
  if (!/^---[ \t]*\r?\n/.test(text)) return out; // 无 frontmatter：正文即全部
  const closed = /^---[ \t]*\r?\n([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (!closed) {
    out.malformed = true; // 有头无闭：整文按正文兜底
    return out;
  }
  out.body = text.slice(closed[0].length).replace(/^\r?\n/, '');
  let key = null;
  for (const line of closed[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue; // 空行/注释容忍
    const item = /^[ \t]+-[ \t]*(.*)$/.exec(line);
    if (item) {
      if (!key) {
        out.malformed = true; // 悬空列表项
        continue;
      }
      const list = Array.isArray(out.data[key])
        ? out.data[key]
        : [out.data[key]].filter((v) => v !== '' && v != null);
      const val = unquote(item[1].trim());
      if (val !== '') list.push(val);
      out.data[key] = list;
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(trimmed);
    if (!kv) {
      out.malformed = true; // 非常规行：标记但不中断，其余字段照常
      continue;
    }
    key = kv[1];
    const val = kv[2].trim();
    if (/^\[.*\]$/.test(val)) {
      out.data[key] = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter((s) => s !== '');
    } else {
      out.data[key] = unquote(val);
    }
  }
  return out;
}

/** 标量写出：含 YAML 易歧义序列（`: `、` #`、引号、方括号、裸布尔/数字等）时加双引号，解析侧 unquote 对应。 */
function yamlScalar(value) {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim();
  const risky =
    v === '' ||
    /^[\s&*!|>%@`{}[\]]/.test(v) ||
    /:(\s|$)/.test(v) ||
    /(^|\s)#/.test(v) ||
    /["']/.test(v) ||
    /^(true|false|null|~|-?\d[\d.]*)$/i.test(v);
  return risky ? JSON.stringify(v) : v;
}

/** 组装 .md 文档：frontmatter + 空行 + 正文（正文去尾空白后保证以单个 \n 收尾）。 */
function renderPromptDoc(fields, body) {
  const lines = [
    '---',
    `name: ${yamlScalar(fields.name)}`,
    `description: ${yamlScalar(fields.description ?? '')}`,
  ];
  if (fields.tags?.length) lines.push(`tags: [${fields.tags.map((t) => yamlScalar(t)).join(', ')}]`);
  lines.push(
    `created: ${yamlScalar(fields.created)}`,
    `updated: ${yamlScalar(fields.updated)}`,
    `source: ${yamlScalar(fields.source)}`,
    '---',
    '',
    String(body ?? '').replace(/\s+$/, ''),
    '',
  );
  return lines.join('\n');
}

function strOrNull(v) {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}

/** frontmatter 数据 + 文件事实 → 条目对象。name 以文件名（去 .md 尾）为准，fm.name 仅参考。 */
function toEntry({ name, data, body, malformed, mtimeMs }) {
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t) => String(t)).filter(Boolean)
    : data.tags != null && data.tags !== ''
      ? [String(data.tags)]
      : [];
  const source = String(data.source ?? '').trim().toLowerCase() === 'seed' ? 'seed' : 'user';
  return {
    name,
    description: String(data.description ?? '').trim(),
    tags,
    created: strOrNull(data.created),
    updated: strOrNull(data.updated),
    source, // 仅展示用，与 user 条目同权可删可改（PRD 第 7 节）
    malformed,
    mtimeMs,
    mtimeIso: new Date(mtimeMs).toISOString(),
    body: String(body ?? '').trim(),
  };
}

function isFile(p) {
  return fs.stat(p).then((st) => st.isFile()).catch(() => false);
}

function invalidName(raw) {
  const err = new Error(
    `提示词名字无效：${JSON.stringify(raw)}（需为非空合法文件名，不含路径分隔符与 Windows 保留设备名 CON/NUL/COM1 等）`,
  );
  err.code = 'PROMPT_INVALID_NAME';
  return err;
}

function notFound(id) {
  const err = new Error(`提示词「${id}」不存在。`);
  err.code = 'PROMPT_NOT_FOUND';
  return err;
}

function existsErr(id) {
  const err = new Error(`提示词「${id}」已存在。要覆盖请显式传 overwrite: true。`);
  err.code = 'PROMPT_EXISTS';
  return err;
}

/**
 * 创建库操作句柄。root/seedsDir/journalDir 均可注入（单测用临时目录隔离，不碰真实 HOME）。
 * @param {{root?: string, seedsDir?: string, journalDir?: string}} [options]
 */
export function createStore(options = {}) {
  const root = options.root ?? defaultRoot();
  const seedsDir = options.seedsDir ?? defaultSeedsDir();
  const journalDir = options.journalDir ?? path.join(root, 'journal');
  /** name -> {key: `${mtimeMs}:${size}`, entry}；任何写操作后失效，外部改动靠 mtime/size 变化失效。 */
  const cache = new Map();

  /** journal 月度文件路径：<journalDir>/YYYY-MM.jsonl（本地月份）。 */
  function journalFile(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return path.join(journalDir, `${y}-${m}.jsonl`);
  }

  /** 追加一行事件（best-effort：任何失败静默吞掉，绝不影响主流程；仅本地，无遥测）。 */
  async function journal(event, fields = {}) {
    try {
      await fs.mkdir(journalDir, { recursive: true });
      const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`;
      await fs.appendFile(journalFile(), line, 'utf8');
    } catch {
      /* journal 永不致命 */
    }
  }

  /** 读取并解析单个条目（mtime+size 缓存：文件没变复用解析结果，编辑器改动即时失效）。 */
  async function readEntry(file) {
    const name = path.basename(file, '.md');
    const st = await fs.stat(file);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(name);
    if (hit && hit.key === key) return hit.entry;
    const parsed = parseFrontmatter(await fs.readFile(file, 'utf8'));
    const entry = toEntry({ name, ...parsed, mtimeMs: st.mtimeMs });
    cache.set(name, { key, entry });
    return entry;
  }

  /**
   * 列出全部条目（不含正文）：名字 + 一行描述 + 来源(seed/user) + 更新时间 + malformed 标记。
   * 目录不存在 = 空库。解析失败的条目照常出现并标 malformed。
   */
  async function list() {
    let names;
    try {
      names = (await fs.readdir(root)).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch {
      return [];
    }
    names.sort((a, b) => a.localeCompare(b));
    const entries = [];
    for (const f of names) {
      try {
        const { body, ...rest } = await readEntry(path.join(root, f));
        entries.push(rest);
      } catch {
        /* readdir 与读取之间的竞态（文件刚被删等）：跳过该条 */
      }
    }
    return entries;
  }

  /** 取单条全文（含正文）。不存在抛 PROMPT_NOT_FOUND。成功记 journal 事件 get。 */
  async function get(name) {
    const id = sanitizeName(name);
    if (!id) throw invalidName(name);
    const file = path.join(root, `${id}.md`);
    let entry;
    try {
      entry = await readEntry(file);
    } catch (e) {
      if (e?.code === 'ENOENT') throw notFound(id);
      throw e;
    }
    await journal('get', { name: id });
    return entry;
  }

  /**
   * 新增条目。同名默认拒绝（PRD US-2），显式 overwrite 才覆盖（保留原 created）。
   * @returns {Promise<{ok: true, name: string, file: string, action: 'created'|'overwritten'}>}
   * @throws PROMPT_INVALID_NAME / PROMPT_EXISTS
   */
  async function add({ name, description = '', tags = [], body = '', overwrite = false, source = 'user' }) {
    const id = sanitizeName(name);
    if (!id) throw invalidName(name);
    const file = path.join(root, `${id}.md`);
    const exists = await isFile(file);
    if (exists && !overwrite) throw existsErr(id);
    const now = new Date().toISOString();
    let created = now;
    if (exists) {
      try {
        created = (await readEntry(file)).created ?? now; // 覆盖保留原 created
      } catch {
        created = now;
      }
    }
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(file, renderPromptDoc({ name: id, description, tags, created, updated: now, source }, body), 'utf8');
    cache.delete(id);
    await journal('save', { name: id, action: exists ? 'overwrite' : 'create' });
    return { ok: true, name: id, file, action: exists ? 'overwritten' : 'created' };
  }

  /**
   * 编辑条目：给什么改什么（description/tags/body 可选），created 保留、updated 刷新。
   * @returns {Promise<{ok: true, name: string, file: string}>} —— /prompt edit 直接把 file 路径交给用户
   * @throws PROMPT_INVALID_NAME / PROMPT_NOT_FOUND
   */
  async function edit({ name, description, tags, body }) {
    const id = sanitizeName(name);
    if (!id) throw invalidName(name);
    const file = path.join(root, `${id}.md`);
    let prev;
    try {
      prev = await readEntry(file);
    } catch (e) {
      if (e?.code === 'ENOENT') throw notFound(id);
      throw e;
    }
    const now = new Date().toISOString();
    const doc = renderPromptDoc(
      {
        name: id,
        description: description ?? prev.description,
        tags: tags ?? prev.tags,
        created: prev.created ?? now,
        updated: now,
        source: prev.source,
      },
      body ?? prev.body,
    );
    await fs.writeFile(file, doc, 'utf8');
    cache.delete(id);
    await journal('save', { name: id, action: 'edit' });
    return { ok: true, name: id, file };
  }

  /** 删除条目（直接删，无回收站——PRD Q4 拍板）。不存在抛 PROMPT_NOT_FOUND。 */
  async function remove(name) {
    const id = sanitizeName(name);
    if (!id) throw invalidName(name);
    const file = path.join(root, `${id}.md`);
    try {
      await fs.unlink(file);
    } catch (e) {
      if (e?.code === 'ENOENT') throw notFound(id);
      throw e;
    }
    cache.delete(id);
    await journal('delete', { name: id });
    return { ok: true, name: id, file };
  }

  /** 包内种子名列表（/prompt restore 无参时的可恢复清单）。 */
  async function listSeeds() {
    let files;
    try {
      files = await fs.readdir(seedsDir);
    } catch {
      return [];
    }
    return files
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .map((f) => path.basename(f, '.md'))
      .sort();
  }

  /**
   * 从包内种子恢复指定条（误删/改坏后重置为种子原文）。种子库没有该条抛 PROMPT_SEED_NOT_FOUND。
   * @returns {Promise<{ok: true, name: string, file: string, action: 'restored'}>}
   */
  async function restore(name) {
    const id = sanitizeName(name);
    if (!id) throw invalidName(name);
    const src = path.join(seedsDir, `${id}.md`);
    if (!(await isFile(src))) {
      const err = new Error(`包内种子没有「${id}」，无法恢复。可用种子：${(await listSeeds()).join('、') || '（无）'}`);
      err.code = 'PROMPT_SEED_NOT_FOUND';
      throw err;
    }
    await fs.mkdir(root, { recursive: true });
    const dest = path.join(root, `${id}.md`);
    await fs.copyFile(src, dest);
    cache.delete(id);
    await journal('restore', { name: id });
    return { ok: true, name: id, file: dest, action: 'restored' };
  }

  /**
   * copy-on-first-run（PRD 决策 1 / US-3）：仅首次激活把包内 seeds/*.md 中用户库缺失的条目复制进用户库，
   * 并写 `.seeded` 标记；标记存在后本函数永久短路——升级/重装/重启都不回写用户库，
   * 用户删除的种子不复活，种子文案改进也不自动到达（restore 手动恢复）。
   * @returns {Promise<{copied: string[], skipped: string[], alreadySeeded: boolean}>}
   */
  async function seedCopy() {
    const seeds = await listSeeds();
    const markerPath = path.join(root, SEED_MARKER);
    if (await isFile(markerPath)) {
      return { copied: [], skipped: [...seeds], alreadySeeded: true };
    }
    const copied = [];
    const skipped = [];
    for (const seedName of seeds) {
      const dest = path.join(root, `${seedName}.md`);
      if (await isFile(dest)) {
        skipped.push(seedName); // 用户已有同名条目（含自建）：绝不覆盖
        continue;
      }
      await fs.mkdir(root, { recursive: true });
      await fs.copyFile(path.join(seedsDir, `${seedName}.md`), dest);
      cache.delete(seedName);
      copied.push(seedName);
    }
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(markerPath, `${JSON.stringify({ at: new Date().toISOString(), seeds, copied, skipped })}\n`, 'utf8');
    } catch {
      /* 标记写失败不阻塞主流程：下次激活最多再补一次缺失 */
    }
    return { copied, skipped, alreadySeeded: false };
  }

  return { root, seedsDir, journalDir, list, get, add, edit, remove, restore, seedCopy, listSeeds, journal };
}
