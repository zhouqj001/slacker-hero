/**
 * @slacker/media host half: opens the `media` storage domain and mounts the
 * /api/media/* routes consumed by the browser half (settings panel + future
 * studio UI). LLM, publish automation, and media generation join in later
 * milestones on the same route table.
 * @module @slacker/media
 */
import type { Context } from '@deepseek-ai/cordis'
import { mediaDomain } from './domain.ts'
import { mediaRoutes, runSchedulerOnce, schedulerState } from './api.ts'
import { registerMediaTools } from './tools.ts'
import { Config, type MediaConfig } from './config.ts'
import { browserPool } from './platforms/browser.ts'

/** Services required by the media host half (provided by dsh base bundles). */
export const inject = ['storageDomain', 'connection', 'llm', 'tools', 'sessionController']

/** zod Config schema（cordis StandardSchemaV1），见 config.ts。 */
export { Config }

/**
 * Mount the media domain and its API routes.
 * @param ctx - Host context carrying storageDomain + connection.
 * @param config - Validated plugin config (defaults applied).
 */
export async function apply(ctx: Context, config: MediaConfig): Promise<void> {
  const domain = await ctx.storageDomain.open(mediaDomain)

  ctx.effect(
    () => () => { void domain.close() },
    'media: domain lifecycle',
  )

  // 插件卸载时关闭全部托管浏览器（playwright-core 惰性拉起，未用过时为 no-op）。
  ctx.effect(
    () => () => { void browserPool.closeAll() },
    'media: browser pool lifecycle',
  )

  ctx.effect(
    () => {
      const disposers = mediaRoutes(domain, ctx, config).map(route => ctx.connection.fetch.register(route))
      return () => Promise.all(disposers.map(dispose => dispose()))
    },
    'media: api routes',
  )

  // 工具集：注册给 dsh agent 调用（第一阶段只读：查账号/人设/选题/历史）。
  // 写操作工具留待后续阶段，并以「先预览后提交」两段式开放。
  ctx.effect(
    () => registerMediaTools(ctx, domain),
    'media: agent tools',
  )

  // 定时发布调度器：默认关闭；开关可在「设置」页运行期切换（存 media domain global，
  // 因为壳每次启动会用模板覆盖 profile 配置文件，配置文件的改动不持久）。
  // 基础轮询 15s，按有效 tickSeconds 节流；只有 autoRun 为真时才真正执行。
  // 巡检核心在 api.ts#runSchedulerOnce（/scheduler/tick 手动触发也走它）。
  ctx.effect(
    () => {
      const BASE_TICK_MS = 15_000
      const timer = setInterval(() => {
        void (async () => {
          schedulerState.timerTicks += 1
          const g = domain.global.get() as Record<string, unknown>
          const autoRun = typeof g['scheduler:autoRun'] === 'boolean'
            ? g['scheduler:autoRun'] as boolean
            : config.publish.autoRun
          if (schedulerState.running || !autoRun) return
          const tickSeconds = Math.max(
            15,
            typeof g['scheduler:tickSeconds'] === 'number'
              ? g['scheduler:tickSeconds'] as number
              : config.publish.tickSeconds,
          )
          const now = Date.now()
          if (now - schedulerState.lastTickAt < tickSeconds * 1000) return
          schedulerState.lastTickAt = now
          schedulerState.running = true
          try {
            await runSchedulerOnce(domain, config)
          } catch (err) {
            console.warn('[media/scheduler] 轮询异常:', err instanceof Error ? err.message : String(err))
          } finally {
            schedulerState.running = false
          }
        })()
      }, BASE_TICK_MS)
      console.info('[media/scheduler] 定时发布调度器就绪（设置页可开关）')
      return () => clearInterval(timer)
    },
    'media: publish scheduler',
  )
}
