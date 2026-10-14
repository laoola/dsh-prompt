/**
 * dsh-prompt 模型工具面（M1 T3）：prompt_list / prompt_get / prompt_save / prompt_delete。
 *
 * 形态与 project-memory 工具同构（output schema + render，timeoutMs 10s）：
 * - buildPromptTools(store)：工具定义工厂，store 由 src/store.js 提供（测试注入临时 root）；
 * - registerTools(ctx, options)：逐件 ctx.effect(() => ctx.tools.register(def), label) 注册；
 *   options 缺省时用默认库根（~/.dsh/prompts），供 index.js 激活接线（T5）直接调用。
 *
 * store 契约（T2 已定，工具层必须遵守）：
 * - 全部操作走 store CRUD；journal 埋点在 store 内置（save/get/delete），工具层不重复记；
 * - 错误透传 store 的 code（PROMPT_EXISTS / PROMPT_NOT_FOUND / PROMPT_INVALID_NAME /
 *   PROMPT_SEED_NOT_FOUND），输出为 { ok:false, text: '[CODE] …' }，不另造错误码；
 * - prompt_save 无独立 update 工具：同名默认拒绝，overwrite: true 即更新。
 */

import { createStore } from './store.js';

/** 统一输出 schema：{ ok, text }，render 输出纯文本块（模型读 text）。 */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: '是否成功' },
      text: { type: 'string', description: '给模型看的完整结果文本' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
};

/** store 域错误（带 PROMPT_* code）→ {ok:false} 透传；意外错误原样上抛交宿主处理。 */
async function softCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (typeof err?.code === 'string' && err.code.startsWith('PROMPT_')) {
      return { ok: false, text: `[${err.code}] ${err.message}` };
    }
    throw err;
  }
}

/** 必填 name 守卫：缺省/非字符串直接抛 TypeError（宿主 schema 校验前兜底）。 */
function requireName(args, tool) {
  const name = args?.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError(`prompt_${tool} 需要非空字符串参数 name`);
  }
  return name;
}

/** NOT_FOUND 时附上当前可用名，帮模型自助纠错。 */
async function notFoundWithHint(err, store) {
  const entries = await store.list();
  return {
    ok: false,
    text: `[${err.code}] ${err.message}\n可用提示词：${entries.map((e) => e.name).join('、') || '（空库）'}`,
  };
}

/**
 * @param {ReturnType<import('./store.js').createStore>} store
 * @returns {Array<object>} 4 个工具定义（{ name, description, parameters, output, timeoutMs, execute }）
 */
export function buildPromptTools(store) {
  const promptList = {
    name: 'prompt_list',
    description:
      '列出用户提示词库（~/.dsh/prompts/*.md）：名字 + 一行描述 + 来源（seed/user）+ 更新时间。不含正文，看全文用 prompt_get。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUTPUT,
    timeoutMs: 10_000,
    async execute() {
      const entries = await store.list();
      if (!entries.length) {
        return { ok: true, text: '提示词库为空（0 条）。可用 prompt_save 保存第一条。' };
      }
      const lines = entries.map((e) => {
        const flag = e.malformed ? ' ⚠️malformed' : '';
        return `- ${e.name} — ${e.description || '（无描述）'} [${e.source}${flag}，更新 ${e.mtimeIso.slice(0, 10)}]`;
      });
      return {
        ok: true,
        text: `提示词库共 ${entries.length} 条：\n${lines.join('\n')}\n\nprompt_get name 看全文；prompt_save 保存；prompt_delete 删除。`,
      };
    },
  };

  const promptGet = {
    name: 'prompt_get',
    description: '读取一条用户提示词的全文（含 frontmatter 元信息与正文）。读取会记入 journal（get 事件）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '提示词名' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 10_000,
    async execute(args) {
      const id = requireName(args, 'get');
      try {
        const entry = await store.get(id); // store 内置 journal('get')，工具层勿重复记
        const tags = Array.isArray(entry.tags) && entry.tags.length ? entry.tags.join('、') : '（无）';
        const warn = entry.malformed ? '\n⚠️ 该文件 frontmatter 无法解析（malformed），以下为兜底内容：' : '';
        return {
          ok: true,
          text: `# ${entry.name}\n${entry.description || '（无描述）'}\n来源：${entry.source} ｜ 更新：${entry.mtimeIso} ｜ 标签：${tags}${warn}\n\n${entry.body}`,
        };
      } catch (err) {
        if (err?.code === 'PROMPT_NOT_FOUND') return notFoundWithHint(err, store);
        if (typeof err?.code === 'string' && err.code.startsWith('PROMPT_')) {
          return { ok: false, text: `[${err.code}] ${err.message}` };
        }
        throw err;
      }
    },
  };

  const promptSave = {
    name: 'prompt_save',
    description:
      '保存/新建一条用户提示词（.md + YAML frontmatter，落 ~/.dsh/prompts/）。同名默认拒绝，需显式 overwrite: true 覆盖更新（无独立 update 工具，save+overwrite 即更新）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '提示词名（作为文件名，不含 .md 扩展名）' },
        body: { type: 'string', description: '提示词正文（Markdown）' },
        description: { type: 'string', description: '一行描述，写入 frontmatter' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组，可选' },
        overwrite: { type: 'boolean', description: '同名时显式覆盖；缺省 false＝拒绝保存' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 10_000,
    async execute(args) {
      const name = requireName(args, 'save');
      if (typeof args?.body !== 'string' || !args.body.trim()) {
        throw new TypeError('prompt_save 需要非空字符串参数 body');
      }
      return softCall(async () => {
        const result = await store.add({
          name,
          description: typeof args.description === 'string' ? args.description : '',
          tags: Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [],
          body: args.body,
          overwrite: args.overwrite === true, // store 契约：显式覆盖才允许同名更新
        });
        const suffix = result.action === 'overwritten' ? '（overwrite: true）' : '';
        return { ok: true, text: `已${result.action === 'overwritten' ? '覆盖' : '保存'}「${result.name}」${suffix}→ ${result.file}` };
      });
    },
  };

  const promptDelete = {
    name: 'prompt_delete',
    description:
      '从用户提示词库删除一条（永久删除，不进回收站；seed 来源条目日后可用 /prompt restore 命令从包内种子恢复）。删除会记入 journal（delete 事件）。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要删除的提示词名' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: OUTPUT,
    timeoutMs: 10_000,
    async execute(args) {
      const id = requireName(args, 'delete');
      try {
        await store.remove(id); // store 内置 journal('delete')
        return { ok: true, text: `已删除「${id}」。` };
      } catch (err) {
        if (err?.code === 'PROMPT_NOT_FOUND') return notFoundWithHint(err, store);
        throw err;
      }
    },
  };

  return [promptList, promptGet, promptSave, promptDelete];
}

/**
 * 注册工具族到宿主。options 同 createStore({root, seedsDir, journalDir})，或直接传 {store}。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{root?: string, seedsDir?: string, journalDir?: string, store?: object}} [options]
 */
export function registerTools(ctx, options = {}) {
  const store = options.store ?? createStore(options);
  for (const definition of buildPromptTools(store)) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-prompt.register(${definition.name})`);
  }
}
