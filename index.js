/**
 * dsh-prompt — DSH 用户自定义提示词库（Host bundle，PRD v0.1 Approved，M1 T5 集成收口）。
 *
 * 激活流程（顺序敏感）：
 * 1. createStore() 一个共享实例：命令面与工具面同库，共享 mtime+size 缓存与 journal；
 * 2. await store.seedCopy() 恰好一次 —— cordis 对 async apply 全程等待
 *    （cordis/lib/index.js _execute：promise → effect.then(safeCollect)，Fiber 启动 await）。
 *    首次激活把包内 seeds/ 缺失条目复制进 ~/.dsh/prompts/ 并写 <root>/.seeded 标记；
 *    此后激活永久短路：升级永不回写用户库、删除不复活（US-3 的实现机制，勿改成每次补缺失）。
 *    seedCopy 异常仅告警不阻断激活（HOME 异常时插件仍可用，下次激活再补）。
 * 3. registerCommands(ctx, {store}) + registerTools(ctx, {store}) 注册命令族/工具族。
 *
 * Spike 清理（T5）：no-op /prompt 占位命令与 prompt_ping 内联工具段已移除，
 * 由 src/commands.js（/prompt 8 子命令）与 src/tools.js（prompt_list/get/save/delete）实装取代。
 * ⚠ 不可回填任何同名占位注册：NamedEntries 唯一性会抛
 * `command "prompt" is already registered` 且整插件不激活。
 *
 * 零宿主 import（同 project-memory 惯例）：inject 以入口模块命名导出声明——
 * cordis 用 `Inject.resolve(plugin.inject)` 读模块的 `inject` 导出构造 Fiber，
 * package.json 不参与 inject 解析，缺此导出激活即报
 * `cannot get property "tools" without inject` 且整个插件不激活。
 */
import { createStore } from './src/store.js';
import { registerCommands } from './src/commands.js';
import { registerTools } from './src/tools.js';

export const inject = ['tools', 'commands'];

export async function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console;
  const store = createStore();

  let seeded = { copied: [], skipped: [], alreadySeeded: false };
  try {
    seeded = await store.seedCopy();
  } catch (e) {
    logger.warn?.(`[dsh-prompt] seedCopy 失败（不阻断激活，下次激活再补）：${e?.message ?? e}`);
  }
  logger.info?.(
    `[dsh-prompt] 激活：库根 ${store.root}；seedCopy copied=[${seeded.copied.join(',')}] skipped=${seeded.skipped.length} alreadySeeded=${seeded.alreadySeeded}`,
  );

  registerCommands(ctx, { store });
  registerTools(ctx, { store });
}
