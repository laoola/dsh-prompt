/**
 * 模型工具面单测（node --test 显式列文件运行）。
 * 经 buildPromptTools(store) 直接驱动 execute()，store 注入临时 root，
 * 不碰真实 HOME（~/.dsh/prompts 零接触）。
 * 验证点：四件签名同构（output schema + render + timeoutMs 10s）、
 * CRUD 语义（save 同名拒绝/overwrite）、store 错误 code 透传、journal 落账、注册接线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { buildPromptTools, registerTools } from '../src/tools.js';

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), 'dsh-prompt-tools-test-'));
}

async function toolsWithTempRoot() {
  const root = await tempRoot();
  const store = createStore({ root });
  const [list, get, save, del] = buildPromptTools(store);
  return { root, store, list, get, save, del };
}

// ---------- 签名同构 ----------

test('工具四件：名称、output schema、render、timeoutMs 10s、parameters 同构 project-memory 形态', async () => {
  const { list, get, save, del } = await toolsWithTempRoot();
  const defs = [list, get, save, del];

  assert.deepEqual(defs.map((d) => d.name), ['prompt_list', 'prompt_get', 'prompt_save', 'prompt_delete']);
  for (const def of defs) {
    assert.equal(def.timeoutMs, 10_000, `${def.name}.timeoutMs 应为 10s`);
    assert.equal(typeof def.execute, 'function');
    assert.equal(def.parameters.type, 'object');
    assert.equal(def.parameters.additionalProperties, false);
    assert.equal(def.output.schema.type, 'object');
    assert.deepEqual(def.output.schema.required, ['ok', 'text']);
    assert.equal(def.output.schema.additionalProperties, false);
    const rendered = def.output.render({}, { ok: true, text: '渲染文本' });
    assert.deepEqual(rendered, [{ type: 'text', text: '渲染文本' }]);
  }
  // 参数面：list 无参；get/delete 仅 name 必填；save 需 name+body 且带 overwrite
  assert.deepEqual(Object.keys(list.parameters.properties), []);
  for (const def of [get, del]) {
    assert.deepEqual(def.parameters.required, ['name']);
    assert.deepEqual(Object.keys(def.parameters.properties), ['name']);
  }
  assert.deepEqual(save.parameters.required, ['name', 'body']);
  assert.equal(save.parameters.properties.overwrite.type, 'boolean');
});

// ---------- prompt_list ----------

test('prompt_list：空库提示为空；保存后列名字/描述/来源且不含正文', async () => {
  const { store, list } = await toolsWithTempRoot();

  const empty = await list.execute({});
  assert.equal(empty.ok, true);
  assert.match(empty.text, /空/);

  await store.add({ name: 'demo', description: 'demo 描述', tags: ['t1'], body: 'SECRET-BODY' });
  const r = await list.execute({});
  assert.equal(r.ok, true);
  assert.match(r.text, /demo/);
  assert.match(r.text, /demo 描述/);
  assert.match(r.text, /\[user/); // 来源标记
  assert.ok(!r.text.includes('SECRET-BODY'), '列表不得携带正文');
});

// ---------- prompt_save ----------

test('prompt_save：新建落盘 frontmatter；同名无 overwrite 拒绝 [PROMPT_EXISTS]；overwrite:true 覆盖', async () => {
  const { store, save } = await toolsWithTempRoot();

  const s1 = await save.execute({ name: 'x', body: 'V1', description: 'd1', tags: ['a', 'b'] });
  assert.equal(s1.ok, true);
  assert.match(s1.text, /已保存「x」/);
  const entry = await store.get('x');
  assert.equal(entry.body, 'V1');
  assert.equal(entry.description, 'd1');
  assert.deepEqual(entry.tags, ['a', 'b']);
  assert.equal(entry.source, 'user');

  const s2 = await save.execute({ name: 'x', body: 'V2' });
  assert.equal(s2.ok, false);
  assert.ok(s2.text.startsWith('[PROMPT_EXISTS]'), '同名拒绝须透传 store 的 PROMPT_EXISTS');
  assert.match(s2.text, /overwrite/);

  const s3 = await save.execute({ name: 'x', body: 'V2', overwrite: true });
  assert.equal(s3.ok, true);
  assert.match(s3.text, /已覆盖「x」/);
  assert.equal((await store.get('x')).body, 'V2');
});

test('prompt_save：路径穿越输入被净化不逃逸；净化后为空透传 [PROMPT_INVALID_NAME]；缺 name/body 抛 TypeError', async () => {
  const { store, save } = await toolsWithTempRoot();

  // store 契约：sanitize 而非拒绝——'../evil' 净化为 'evil'，永不逃逸库目录
  const tricky = await save.execute({ name: '../evil', body: 'b' });
  assert.equal(tricky.ok, true);
  assert.deepEqual((await store.list()).map((e) => e.name), ['evil']);

  const bad = await save.execute({ name: '///', body: 'b' });
  assert.equal(bad.ok, false);
  assert.ok(bad.text.startsWith('[PROMPT_INVALID_NAME]'), '净化后为空的名字透传 store 的 INVALID_NAME');

  await assert.rejects(() => save.execute({ body: 'no name' }), TypeError);
  await assert.rejects(() => save.execute({ name: '  ', body: 'blank' }), TypeError);
  await assert.rejects(() => save.execute({ name: 'no body' }), TypeError);
});

// ---------- prompt_get ----------

test('prompt_get：返回元信息+全文；NOT_FOUND → [PROMPT_NOT_FOUND] 并附可用名；缺 name 抛 TypeError', async () => {
  const { store, get } = await toolsWithTempRoot();
  await store.add({ name: 'g1', description: 'g 描述', tags: ['t'], body: 'GBODY' });

  const r = await get.execute({ name: 'g1' });
  assert.equal(r.ok, true);
  assert.match(r.text, /# g1/);
  assert.match(r.text, /g 描述/);
  assert.match(r.text, /来源：user/);
  assert.match(r.text, /GBODY/);

  const miss = await get.execute({ name: 'nope' });
  assert.equal(miss.ok, false);
  assert.ok(miss.text.startsWith('[PROMPT_NOT_FOUND]'));
  assert.match(miss.text, /g1/, 'NOT_FOUND 应列可用名帮模型纠错');

  await assert.rejects(() => get.execute({}), TypeError);
});

// ---------- prompt_delete ----------

test('prompt_delete：删除后不可见；重复删除 → [PROMPT_NOT_FOUND]；缺 name 抛 TypeError', async () => {
  const { store, get, del } = await toolsWithTempRoot();
  await store.add({ name: 'd1', description: '', tags: [], body: 'B' });

  const r = await del.execute({ name: 'd1' });
  assert.equal(r.ok, true);
  assert.match(r.text, /已删除「d1」/);
  assert.equal((await store.list()).length, 0);

  const again = await del.execute({ name: 'd1' });
  assert.equal(again.ok, false);
  assert.ok(again.text.startsWith('[PROMPT_NOT_FOUND]'));

  await assert.rejects(() => del.execute({}), TypeError);
});

// ---------- journal（经工具的操作全部落账，工具层不重复记） ----------

test('journal：经工具的 save/get/delete 逐条落 YYYY-MM.jsonl，无重复无多余事件', async () => {
  const { root, store, get, save, del } = await toolsWithTempRoot();
  await save.execute({ name: 'j1', body: 'B' });
  await get.execute({ name: 'j1' });
  await del.execute({ name: 'j1' });

  const journalDir = path.join(root, 'journal');
  const files = await readdir(journalDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}\.jsonl$/);
  const lines = (await readFile(path.join(journalDir, files[0]), 'utf8')).trim().split('\n');
  const events = lines.map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.event), ['save', 'get', 'delete']);
  assert.ok(events.every((e) => e.name === 'j1'), '事件携带条目名');
});

// ---------- 注册接线 ----------

test('registerTools(ctx, {root})：逐件经 ctx.effect 注册到 ctx.tools.register；不传 options 用默认库', async () => {
  const root = await tempRoot();
  const defs = [];
  const labels = [];
  const ctx = {
    effect(fn, label) {
      labels.push(label);
      fn(); // 立即执行 effect 回调，模拟 cordis 激活
    },
    tools: { register(def) { defs.push(def); } },
  };

  registerTools(ctx, { root });
  assert.deepEqual(defs.map((d) => d.name), ['prompt_list', 'prompt_get', 'prompt_save', 'prompt_delete']);
  assert.deepEqual(
    labels,
    ['prompt_list', 'prompt_get', 'prompt_save', 'prompt_delete'].map((n) => `dsh-prompt.register(${n})`),
  );

  // index.js 现状：registerTools(ctx) 无 options —— 建默认 store（纯路径计算，零 IO），注册不触盘
  const defs2 = [];
  registerTools({ effect: (fn) => fn(), tools: { register: (d) => defs2.push(d) } });
  assert.equal(defs2.length, 4);
});
