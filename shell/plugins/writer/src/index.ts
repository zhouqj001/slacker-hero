/**
 * @slacker/writer host half: opens the `writer` storage domain and mounts the
 * /api/writer/* routes consumed by the browser half (书架 / 作品工作台 /
 * 逐章生成 / 番茄发布). Phase 1 scope per docs/writer-plugin-plan.md §9.
 * @module @slacker/writer
 */
import type { Context } from '@deepseek-ai/cordis'
import { writerDomain } from './domain.ts'
import { writerRoutes } from './api.ts'
import { Config, type WriterConfig } from './config.ts'
import { browserPool } from './platforms/browser.ts'

/** Services required by the writer host half (provided by dsh base bundles). */
export const inject = ['storageDomain', 'connection', 'sessionController']

/** zod Config schema（cordis StandardSchemaV1），见 config.ts。 */
export { Config }

/**
 * Mount the writer domain and its API routes.
 * @param ctx - Host context carrying storageDomain + connection + sessionController.
 * @param config - Validated plugin config (defaults applied).
 */
export async function apply(ctx: Context, config: WriterConfig): Promise<void> {
  const domain = await ctx.storageDomain.open(writerDomain)

  ctx.effect(
    () => () => { void domain.close() },
    'writer: domain lifecycle',
  )

  // 插件卸载时关闭全部托管浏览器（playwright-core 惰性拉起，未用过时为 no-op）。
  ctx.effect(
    () => () => { void browserPool.closeAll() },
    'writer: browser pool lifecycle',
  )

  ctx.effect(
    () => {
      const disposers = writerRoutes(domain, ctx, config).map(route => ctx.connection.fetch.register(route))
      return () => Promise.all(disposers.map(dispose => dispose()))
    },
    'writer: api routes',
  )
}
