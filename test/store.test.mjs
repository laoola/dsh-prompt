/**
 * store 核心单测（node --test 显式列文件运行）。
 * 全部用临时目录注入 root，不碰真实 HOME（~/.dsh/prompts 零接触）。
 * 种子相关用例直接使用包内真实 seeds/，顺带验证种子文案可被解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore, defaultRoot, defaultSeedsDir, parseFrontmatter, sanitizeName } from '../src/store.js';

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), 'dsh-prompt-test-'));
}

// ---------- frontmatter 解析 ----------

test('parseFrontmatter：标准字段与 tags 的 inline/块列表两种写法', () => {
  const doc = [
    '---',
    'name: a',
    'description: 一行描述',
    'tags: [review, quality]',
    'created: 2026-10-14T00:00:00.000Z',
    'updated: 2026-10-14T00:00:00.000Z',
    'source: seed',
    '---',
    '正文第一行',
    '',
  ].join('\n');
  const r = parseFrontmatter(doc);
  assert.equal(r.malformed, false);
  assert.equal(r.data.name, 'a');
  assert.deepEqual(r.data.tags, ['review', 'quality']);
  assert.equal(r.body, '正文第一行\n');

  const r2 = parseFrontmatter('---\ntags:\n  - alpha\n  - beta\n---\nX');
  assert.equal(r2.malformed, false);
  assert.deepEqual(r2.data.tags, ['alpha', 'beta']);

  // 含 ": " 的描述写出侧会加引号，解析侧要能剥掉
  const r3 = parseFrontmatter('---\ndescription: "评审: 先正确性"\n---\nB');
  assert.equal(r3.data.description, '评审: 先正确性');
});

test('parseFrontmatter 容错：无 frontmatter / 无闭合 / 坏行均不崩溃，坏行不吞字段', () => {
  const noFm = parseFrontmatter('就是正文');
  assert.equal(noFm.malformed, false);
  assert.equal(noFm.body, '就是正文');

  const unclosed = parseFrontmatter('---\nname: a\n没有闭合');
  assert.equal(unclosed.malformed, true);
  assert.equal(unclosed.body, '---\nname: a\n没有闭合'); // 整文按正文兜底

  const badLine = parseFrontmatter('---\nname: keep\ndescription: 还在\n@@@ 坏行\n---\nB');
  assert.equal(badLine.malformed, true);
  assert.equal(badLine.data.name, 'keep');
  assert.equal(badLine.data.description, '还在');
});

test('sanitizeName：路径分隔符/控制字符剥离，空白压缩为 -', () => {
  assert.equal(sanitizeName(' code review '), 'code-review');
  assert.equal(sanitizeName('a/b\\c:d'), 'a-b-c-d');
  assert.equal(sanitizeName('代码 评审'), '代码-评审');
  assert.equal(sanitizeName('///'), '');
  assert.equal(sanitizeName(''), '');
});

test('defaultRoot/defaultSeedsDir：默认路径形态正确（不触发 IO）', () => {
  assert.equal(path.basename(defaultRoot()), 'prompts');
  assert.equal(path.basename(path.dirname(defaultRoot())), '.dsh');
  assert.ok(defaultSeedsDir().endsWith('seeds'));
});

// ---------- 种子复制（copy-on-first-run） ----------

test('seedCopy：首次缺失即复制且 source=seed；此后激活永久短路（升级永不回写，删除不复活）', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  const seeds = await store.listSeeds();
  assert.ok(seeds.length >= 2, '包内至少 2 条占位种子');

  const r1 = await store.seedCopy();
  assert.equal(r1.alreadySeeded, false);
  assert.deepEqual([...r1.copied].sort(), seeds);
  assert.deepEqual(r1.skipped, []);
  const entries = await store.list();
  assert.equal(entries.length, seeds.length);
  assert.ok(entries.every((e) => e.source === 'seed' && e.malformed === false), '种子条目 source=seed 且可正常解析');
  await assert.doesNotReject(() => readFile(path.join(root, '.seeded'), 'utf8'), '首次播种后落标记文件');

  const r2 = await store.seedCopy();
  assert.deepEqual(r2.copied, [], '标记存在：再次激活（重启/升级）不再回写');
  assert.equal(r2.alreadySeeded, true);

  await store.remove(seeds[0]);
  const r3 = await store.seedCopy();
  assert.deepEqual(r3.copied, [], '用户删除后种子不复活');
  assert.equal((await store.list()).length, seeds.length - 1);
});

// ---------- CRUD ----------

test('add：落盘 frontmatter 完整；同名默认拒绝；overwrite 覆盖且保留 created', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  const r1 = await store.add({ name: 'my-prompt', description: '测试条目', tags: ['t1'], body: '正文内容' });
  assert.equal(r1.action, 'created');
  assert.equal(r1.file, path.join(root, 'my-prompt.md'));
  const raw = await readFile(r1.file, 'utf8');
  assert.match(raw, /^---\r?\n/);
  assert.match(raw, /name: my-prompt/);
  assert.match(raw, /source: user/);

  const e1 = await store.get('my-prompt');
  assert.equal(e1.description, '测试条目');
  assert.deepEqual(e1.tags, ['t1']);
  assert.equal(e1.body, '正文内容');

  await assert.rejects(() => store.add({ name: 'my-prompt', body: 'x' }), (e) => e.code === 'PROMPT_EXISTS');
  const r2 = await store.add({ name: 'my-prompt', description: '覆盖版', body: '新正文', overwrite: true });
  assert.equal(r2.action, 'overwritten');
  const e2 = await store.get('my-prompt');
  assert.equal(e2.body, '新正文');
  assert.equal(e2.created, e1.created, '覆盖保留原 created');

  await assert.rejects(() => store.add({ name: '', body: 'x' }), (e) => e.code === 'PROMPT_INVALID_NAME');
});

test('list：空库返回 []；条目含名字/一行描述/来源/更新时间，且不携带正文', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  assert.deepEqual(await store.list(), []);

  await store.add({ name: 'b-entry', description: '乙', body: 'x' });
  await store.add({ name: 'a-entry', description: '甲', source: 'seed', body: 'y' });
  const list = await store.list();
  assert.deepEqual(list.map((e) => e.name), ['a-entry', 'b-entry'], '按名字排序');
  const a = list[0];
  assert.equal(a.description, '甲');
  assert.equal(a.source, 'seed');
  assert.ok(a.mtimeMs > 0);
  assert.match(a.mtimeIso, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!('body' in a), 'list 不携带正文');
});

test('edit：部分字段更新、created 保留、tags 未给则保留、返回文件路径', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  await store.add({ name: 'ep', description: '旧描述', tags: ['原标签'], body: '旧正文' });
  const before = await store.get('ep');

  const r = await store.edit({ name: 'ep', description: '新描述', body: '新正文' });
  assert.equal(r.file, path.join(root, 'ep.md'));
  assert.ok(await readFile(r.file, 'utf8'), '返回路径上确实有文件');

  const after = await store.get('ep');
  assert.equal(after.description, '新描述');
  assert.equal(after.body, '新正文');
  assert.deepEqual(after.tags, ['原标签']);
  assert.equal(after.created, before.created, 'created 保留');
  assert.match(after.updated, /^\d{4}-\d{2}-\d{2}T/);

  await assert.rejects(() => store.edit({ name: 'ghost', body: 'x' }), (e) => e.code === 'PROMPT_NOT_FOUND');
});

test('remove：删除后不可见；重复删除与 get 报 NOT_FOUND', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  await store.add({ name: 'gone', body: 'x' });
  await store.remove('gone');
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.get('gone'), (e) => e.code === 'PROMPT_NOT_FOUND');
  await assert.rejects(() => store.remove('gone'), (e) => e.code === 'PROMPT_NOT_FOUND');
});

test('restore：从包内种子恢复指定条（内容与种子一致）；种子缺失报 SEED_NOT_FOUND', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  await store.seedCopy();
  const seedName = (await store.listSeeds())[0];
  const seedRaw = await readFile(path.join(store.seedsDir, `${seedName}.md`), 'utf8');

  await store.remove(seedName);
  const r = await store.restore(seedName);
  assert.equal(r.action, 'restored');
  const e = await store.get(seedName);
  const seedEntry = parseFrontmatter(seedRaw);
  assert.equal(e.body, seedEntry.body.trim(), '恢复内容 = 种子原文');
  assert.equal(e.description, String(seedEntry.data.description ?? '').trim());
  assert.equal(e.source, 'seed');

  await assert.rejects(() => store.restore('no-such-seed'), (err) => err.code === 'PROMPT_SEED_NOT_FOUND');
});

// ---------- mtime 缓存失效 ----------

test('mtime 缓存：外部编辑器直接改 .md，list/get 即时生效', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  const { file } = await store.add({ name: 'hot', description: '旧描述', body: '旧正文' });
  const before = await store.get('hot'); // 进缓存
  assert.equal(before.description, '旧描述');

  // 模拟编辑器保存：外部直接写文件 + 显式推进 mtime（规避同毫秒内 mtime/size 未变）
  const future = new Date(Date.now() + 5000);
  await writeFile(
    file,
    '---\nname: hot\ndescription: 新描述\ntags: [edit]\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nsource: user\n---\n新正文\n',
    'utf8',
  );
  await utimes(file, future, future);

  const after = await store.get('hot');
  assert.equal(after.description, '新描述');
  assert.equal(after.body, '新正文');
  const list = await store.list();
  assert.equal(list.find((e) => e.name === 'hot').description, '新描述');
});

// ---------- journal ----------

test('journal：save/get/use/delete/restore 追加进 YYYY-MM.jsonl，行可解析；失败不影响主流程', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  await store.add({ name: 'j', body: 'b' }); // save
  await store.get('j'); // get
  await store.journal('use', { name: 'j', suffix: '补语' }); // use（命令层 /prompt use 调用）
  await store.seedCopy();
  const s0 = (await store.listSeeds())[0];
  await store.remove(s0); // delete
  await store.restore(s0); // restore

  const journalDir = path.join(root, 'journal');
  const files = await readdir(journalDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}\.jsonl$/);
  const lines = (await readFile(path.join(journalDir, files[0]), 'utf8')).trim().split('\n');
  const events = lines.map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.event), ['save', 'get', 'use', 'delete', 'restore']);
  assert.ok(events.every((e) => typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts))));
  assert.equal(events.find((e) => e.event === 'use').suffix, '补语', '附加字段原样落盘');
});

// ---------- malformed 条目不吞 ----------

test('malformed 条目不吞：list 可见并带标记，get 可取到兜底正文', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'broken.md'), '---\nname: broken\n没有闭合\n', 'utf8');
  const list = await store.list();
  assert.equal(list.length, 1, '解析失败不吞条目');
  assert.equal(list[0].name, 'broken');
  assert.equal(list[0].malformed, true);
  const e = await store.get('broken');
  assert.equal(e.malformed, true);
  assert.ok(e.body.includes('没有闭合'));
});

// ---------- 审计修复回归（2026-10-14）：Windows 保留设备名 ----------

test('sanitizeName：Windows 保留设备名判无效（大小写不敏感、含带扩展名形式），非保留名不误伤', async () => {
  for (const n of ['CON', 'con', 'Nul', 'nul', 'com1', 'LPT9', 'aux', 'CON.md', 'nul.txt']) {
    assert.equal(sanitizeName(n), '', `${n} 应命中保留名归零`);
  }
  assert.equal(sanitizeName('constant'), 'constant', '前缀撞车不算保留名');
  assert.equal(sanitizeName('console-log'), 'console-log');
  assert.equal(sanitizeName('null-check'), 'null-check');

  const root = await tempRoot();
  const store = createStore({ root });
  await assert.rejects(() => store.add({ name: 'CON', body: 'x' }), (e) => e.code === 'PROMPT_INVALID_NAME');
  await assert.rejects(() => store.get('nul'), (e) => e.code === 'PROMPT_INVALID_NAME');
  await assert.rejects(() => store.remove('com1'), (e) => e.code === 'PROMPT_INVALID_NAME');
});

// ---------- 审计修复回归（2026-10-14）：frontmatter 写读对称 ----------

test('frontmatter 写读对称：值含双引号 round-trip 不损坏（unquote 对 JSON.stringify 转义反转义）', async () => {
  const root = await tempRoot();
  const store = createStore({ root });
  const desc = '说 "你好" 时要转义';
  await store.add({ name: 'quoted', description: desc, tags: ['tag "x"'], body: '正文' });

  // 落盘形态：写出侧确为 JSON.stringify 的 \" 形式（而非裸引号歧义串）
  const raw = await readFile(path.join(root, 'quoted.md'), 'utf8');
  assert.match(raw, /description: "说 \\"你好\\" 时要转义"/);

  const e = await store.get('quoted');
  assert.equal(e.description, desc, 'description round-trip 一致');
  assert.deepEqual(e.tags, ['tag "x"'], 'tags round-trip 一致');

  // 手工编辑出的非 JSON 引号串：剥外层兜底，不炸
  const r2 = parseFrontmatter('---\ndescription: "手工写的非"JSON"串"\n---\nB');
  assert.equal(r2.data.description, '手工写的非"JSON"串');
});
