/**
 * /prompt 命令族单测（handler 层 mock invocation，node --test 显式列文件运行）。
 * store 全部注入临时目录（root/seedsDir/journalDir 分离），不碰真实 ~/.dsh/prompts。
 * 默认 mock agent 的 followup 一被调用即抛错 —— 用作「非 use 命令不得唤醒模型」的哨兵。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerCommands } from '../src/commands.js';
import { createStore } from '../src/store.js';

const cleanupDirs = [];
test.after(async () => {
  await Promise.all(cleanupDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function seedDoc(name, body) {
  return [
    '---',
    `name: ${name}`,
    `description: 种子 ${name}`,
    'created: 2026-10-14T00:00:00.000Z',
    'updated: 2026-10-14T00:00:00.000Z',
    'source: seed',
    '---',
    body,
    '',
  ].join('\n');
}

async function makeStore() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-prompt-cmd-'));
  cleanupDirs.push(base);
  const root = path.join(base, 'prompts');
  const seedsDir = path.join(base, 'seeds');
  const journalDir = path.join(base, 'journal');
  await mkdir(seedsDir, { recursive: true });
  await writeFile(path.join(seedsDir, 'alpha.md'), seedDoc('alpha', 'alpha 种子正文'), 'utf8');
  await writeFile(path.join(seedsDir, 'beta.md'), seedDoc('beta', 'beta 种子正文'), 'utf8');
  return { store: createStore({ root, seedsDir, journalDir }), root, seedsDir, journalDir };
}

/** mock 宿主 ctx：捕获注册的 CommandDefinition；ctx.effect 立即执行。 */
function makeCtx() {
  const registered = [];
  return {
    registered,
    ctx: {
      commands: {
        register(def) {
          registered.push(def);
          return () => {};
        },
        list: () => [],
      },
      effect(fn, _label) {
        return fn();
      },
    },
  };
}

async function harness() {
  const made = await makeStore();
  const store = made.store;
  const { ctx, registered } = makeCtx();
  registerCommands(ctx, { store });
  assert.equal(registered.length, 1);
  const def = registered[0];
  assert.equal(def.name, 'prompt');
  assert.ok(def.description.trim().length > 0);
  assert.equal(typeof def.handler, 'function');
  /** call(rawInput)：默认 agent 的 followup 被调用即测试失败（哨兵）。 */
  const call = (rawInput, agent) =>
    def.handler({
      commandId: 'test-cmd',
      agent: agent ?? {
        followup() {
          throw new Error('哨兵：该命令不应唤醒模型');
        },
      },
      rawInput,
      attachments: Object.freeze([]),
      signal: undefined,
    });
  return { def, call, store, root: made.root, journalDir: made.journalDir };
}

async function journalLines(journalDir) {
  const events = [];
  for (const f of (await readdir(journalDir)).filter((f) => f.endsWith('.jsonl'))) {
    const text = await readFile(path.join(journalDir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

function countingAgent() {
  const calls = [];
  return {
    calls,
    followup(msg) {
      calls.push(msg);
    },
  };
}

// ---------- 注册与分发 ----------

test('registerCommands：注册名为 prompt 的命令，携带 hint 与 handler', async () => {
  await harness(); // 断言在 harness 内：name/description/handler
});

test('未知子命令返回错误并给用法；/prompt help 亦然', async () => {
  const { call } = await harness();
  const r = await call(' nope');
  assert.equal(r.kind, 'error');
  assert.match(r.text, /未知子命令/);
  assert.match(r.text, /用法/);
});

// ---------- 列表 ----------

test('空库 /prompt：提示库为空并列出可用种子，不唤醒模型', async () => {
  const { call } = await harness();
  const r = await call('');
  assert.equal(r.kind, 'success');
  assert.match(r.text, /库为空/);
  assert.match(r.text, /alpha、beta/); // 种子清单
});

test('/prompt（list）：列出全部条目，含种子标记与名字排序', async () => {
  const { call, store } = await harness();
  await store.add({ name: 'zzz', body: 'z 正文' });
  await store.add({ name: 'aaa', body: 'a 正文' });
  await store.restore('alpha');
  const r = await call('');
  assert.equal(r.kind, 'success');
  const ia = r.text.indexOf('aaa');
  const ialpha = r.text.indexOf('alpha（种子）');
  const izzz = r.text.indexOf('zzz');
  assert.ok(ia >= 0 && izzz >= 0 && ialpha >= 0);
  assert.ok(ia < ialpha && ialpha < izzz, '列表按名字排序');
});

// ---------- add ----------

test('add：成功新增，回显名字与路径，正文可被 store 读回', async () => {
  const { call, store } = await harness();
  const r = await call(' add demo 你好 世界');
  assert.equal(r.kind, 'success');
  assert.match(r.text, /已新增「demo」/);
  const entry = await store.get('demo');
  assert.equal(entry.body, '你好 世界'); // 单行正文保留内部空格
  assert.match(r.text, /demo\.md/);
});

test('add：缺正文报用法错误；重名报已存在且文案指向 edit（不含工具向 overwrite 参数）', async () => {
  const { call, store } = await harness();
  const r1 = await call(' add only-name');
  assert.equal(r1.kind, 'error');
  assert.match(r1.text, /用法：\/prompt add/);
  await store.add({ name: 'demo', body: 'v1' });
  const r2 = await call(' add demo v2');
  assert.equal(r2.kind, 'error');
  assert.match(r2.text, /已存在/);
  assert.match(r2.text, /edit/);
  assert.doesNotMatch(r2.text, /overwrite/);
});

// ---------- show ----------

test('show：输出全文与来源；名字不存在报错并列出可用名字（PRD US-2 验收）', async () => {
  const { call, store } = await harness();
  await store.add({ name: 'demo', body: '正文第一行\n正文第二行' });
  const r = await call(' show demo');
  assert.equal(r.kind, 'success');
  assert.match(r.text, /# demo/);
  assert.match(r.text, /正文第二行/);
  assert.match(r.text, /自建/);

  const r2 = await call(' show nope');
  assert.equal(r2.kind, 'error');
  assert.match(r2.text, /「nope」不存在/);
  assert.match(r2.text, /可用：demo/); // 列出可用名字
});

// ---------- edit ----------

test('edit：返回 .md 绝对路径；正文不变；缺名字报用法', async () => {
  const { call, store, root } = await harness();
  await store.add({ name: 'demo', body: '保持不变' });
  const r = await call(' edit demo');
  assert.equal(r.kind, 'success');
  assert.ok(r.text.includes(path.join(root, 'demo.md')), `应含完整路径：${r.text}`);
  assert.match(r.text, /即时生效/);
  const entry = await store.get('demo');
  assert.equal(entry.body, '保持不变');

  const r2 = await call(' edit');
  assert.equal(r2.kind, 'error');
  assert.match(r2.text, /用法：\/prompt edit/);
});

// ---------- rm ----------

test('rm：删除成功；再 show 报不存在；journal 恰有一条 delete（store 内置埋点，命令层不重复记）', async () => {
  const { call, store, journalDir } = await harness();
  await store.add({ name: 'demo', body: 'x' });
  const r = await call(' rm demo');
  assert.equal(r.kind, 'success');
  assert.match(r.text, /已删除「demo」/);
  const r2 = await call(' show demo');
  assert.equal(r2.kind, 'error');
  const events = await journalLines(journalDir);
  assert.equal(events.filter((e) => e.event === 'delete').length, 1);
  assert.equal(events.filter((e) => e.event === 'delete')[0].name, 'demo');

  const r3 = await call(' rm nope');
  assert.equal(r3.kind, 'error');
  assert.match(r3.text, /不存在/);
});

// ---------- use ----------

test('use：正文+补充语拼接为一条 user 消息 followup 直发，source 标识来源；journal 记 use（命令层埋点）', async () => {
  const h = await harness();
  await h.store.add({ name: 'demo', body: '请评审以下代码', description: '评审' });
  const agent = countingAgent();
  const r = await h.call(' use demo 重点看内存泄漏', agent);
  assert.equal(r.kind, 'success');
  assert.match(r.text, /已用「demo」唤醒模型/);
  assert.equal(agent.calls.length, 1, 'followup 恰一次');
  const msg = agent.calls[0];
  assert.equal(msg.role, 'user');
  assert.equal(msg.content.length, 1);
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[0].text, '请评审以下代码\n\n重点看内存泄漏'); // 正文 + 空行 + 补充语
  assert.equal(msg.source?.kind, 'dsh-prompt'); // PRD US-1：source 标识 prompt 库来源
  assert.ok(msg.id, 'followup 消息带 id');
  const events = await journalLines(h.journalDir);
  const useEvents = events.filter((e) => e.event === 'use');
  assert.equal(useEvents.length, 1);
  assert.equal(useEvents[0].name, 'demo');
});

test('use：无补充语时消息即正文本身；回显确认含预览', async () => {
  const h = await harness();
  await h.store.add({ name: 'solo', body: '只有正文' });
  const agent = countingAgent();
  const r = await h.call(' use solo', agent);
  assert.equal(r.kind, 'success');
  assert.equal(agent.calls[0].content[0].text, '只有正文');
  assert.match(r.text, /只有正文/); // 回显预览
});

test('use：名字不存在 → 错误并列出可用名字，模型不被唤醒', async () => {
  const h = await harness();
  await h.store.add({ name: 'real', body: 'x' });
  const agent = countingAgent();
  const r = await h.call(' use ghost 加点料', agent);
  assert.equal(r.kind, 'error');
  assert.match(r.text, /「ghost」不存在/);
  assert.match(r.text, /可用：real/);
  assert.equal(agent.calls.length, 0, 'PRD US-1：模型不被唤醒');
});

test('use：followup 返回 rejected Promise 不炸（审计修复：防御性吞掉，不 unhandledRejection），回显成功且 journal 记 use', async () => {
  const h = await harness();
  await h.store.add({ name: 'demo', body: '正文' });
  const r = await h.call(' use demo', {
    followup() {
      return Promise.reject(new Error('宿主异步失败'));
    },
  });
  await new Promise((resolve) => setImmediate(resolve)); // 给事件循环一拍：若拒绝逃逸，node --test 会以 unhandledRejection 判失败
  assert.equal(r.kind, 'success');
  const events = await journalLines(h.journalDir);
  assert.ok(events.some((e) => e.event === 'use' && e.name === 'demo'), 'use 埋点照记（口径偏大为已知近似）');
});

// ---------- restore ----------

test('restore：无参列出可用种子；带参恢复为种子原文；非种子名报错（PROMPT_SEED_NOT_FOUND 文案透传）', async () => {
  const { call, store, root } = await harness();
  const r0 = await call(' restore');
  assert.equal(r0.kind, 'success');
  assert.match(r0.text, /alpha、beta/);

  await store.add({ name: 'alpha', body: '被我改坏了' });
  const r = await call(' restore alpha');
  assert.equal(r.kind, 'success');
  assert.match(r.text, /已从种子恢复「alpha」/);
  const onDisk = await readFile(path.join(root, 'alpha.md'), 'utf8');
  assert.match(onDisk, /alpha 种子正文/); // 恢复为种子原文
  const entry = await store.get('alpha');
  assert.equal(entry.source, 'seed');

  const r2 = await call(' restore not-a-seed');
  assert.equal(r2.kind, 'error');
  assert.match(r2.text, /种子/);
  assert.match(r2.text, /alpha、beta/); // 错误文案含可用种子清单
});

// ---------- stats ----------

test('stats：空 journal 提示暂无记录；有事件后给出分类计数与 use 最常用', async () => {
  const { call, store } = await harness();
  const r0 = await call(' stats');
  assert.equal(r0.kind, 'success');
  assert.match(r0.text, /暂无使用记录/);

  await store.add({ name: 'a', body: 'A' });
  await store.add({ name: 'b', body: 'B' });
  const agent = countingAgent();
  await call(' use a', agent);
  await call(' use a', agent);
  await call(' use b', agent);
  await call(' rm b', agent);
  const r = await call(' stats');
  assert.equal(r.kind, 'success');
  assert.match(r.text, /use 3/);
  assert.match(r.text, /save 2/); // add×2
  assert.match(r.text, /delete 1/);
  assert.match(r.text, /a ×2/); // use 最常用
  assert.match(r.text, /无遥测|仅本地/);
});

test('stats：容忍坏行与未知事件类型（journal 是 best-effort 数据）', async () => {
  const { journalDir } = await makeStore();
  await mkdir(journalDir, { recursive: true });
  await writeFile(
    path.join(journalDir, '2026-10.jsonl'),
    [
      JSON.stringify({ ts: '2026-10-01T00:00:00.000Z', event: 'use', name: 'x' }),
      '不是 JSON 的一行',
      JSON.stringify({ ts: '2026-10-02T00:00:00.000Z', event: 'mystery' }),
      '',
    ].join('\n'),
    'utf8',
  );
  const { ctx, registered } = makeCtx();
  registerCommands(ctx, { store: createStore({ journalDir }) });
  const r = await registered[0].handler({ rawInput: 'stats', agent: { followup() {} } });
  assert.equal(r.kind, 'success');
  assert.match(r.text, /use 1/);
  assert.match(r.text, /其他 1/); // 未知事件计入「其他」
  assert.doesNotMatch(r.text, /undefined/);
});

test('--json：list/show 机器可读输出（client 选择器面板契约；--json 传给其它子命令不误伤）', async () => {
  const { call, store } = await harness();
  await store.add({ name: 'demo', description: '描述 "quoted"', tags: ['t1', 't2'], body: '正文ABC' });

  // list --json：纯 JSON 数组，字段集稳定契约，不含正文
  const rl = await call(' list --json');
  assert.equal(rl.kind, 'success');
  const arr = JSON.parse(rl.text);
  const demo = arr.find((e) => e.name === 'demo');
  assert.ok(demo, 'list --json 含 demo');
  assert.equal(demo.description, '描述 "quoted"');
  assert.deepEqual(demo.tags, ['t1', 't2']);
  assert.equal(demo.source, 'user');
  assert.ok(!('body' in demo), 'list --json 不含正文');

  // show --json：含正文对象
  const rs = await call(' show demo --json');
  assert.equal(rs.kind, 'success');
  const obj = JSON.parse(rs.text);
  assert.equal(obj.name, 'demo');
  assert.equal(obj.body, '正文ABC');
  assert.deepEqual(obj.tags, ['t1', 't2']);

  // show 不存在 --json：错误仍 {kind:'error', text}，不变成 JSON
  const re = await call(' show ghost --json');
  assert.equal(re.kind, 'error');
  assert.match(re.text, /ghost/);
  assert.throws(() => JSON.parse(re.text));

  // 名字含 "--json" 子串不受误伤：takeJsonFlag 按整词匹配，rm "x--jsony" 仍按名字处理
  await store.add({ name: 'x--jsony', body: 'b' });
  const rx = await call(' rm x--jsony');
  assert.equal(rx.kind, 'success');

  // 空库 list --json：输出 []（不是人读指引文案）
  const { store: emptyStore } = await makeStore();
  const { ctx, registered } = makeCtx();
  registerCommands(ctx, { store: emptyStore });
  const re2 = await registered[0].handler({ rawInput: 'list --json', agent: { followup() {} } });
  assert.equal(re2.kind, 'success');
  assert.deepEqual(JSON.parse(re2.text), []);
});
