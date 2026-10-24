/**
 * 托管浏览器底座：playwright-core + 系统 Edge（channel: 'msedge'）。
 * - profile 按账号隔离在 $DSH_HOME/writer/browser/<accountId>/，首次扫码后永续；
 * - 浏览器进程惰性拉起，10 分钟空闲自动退出；
 * - playwright-core 保持 external（运行时从 profile node_modules 解析，
 *   其内置 driver 必须按真实安装路径寻址），且惰性 import——不发布时零开销。
 *
 * 与 media 的差别：小说工坊一期全部走页面内同源 fetch（无半自动发布），
 * 所以去掉 keepOpen / restoreUserTab，只保留 focus（扫码登录置前）。
 */
import { mkdirSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Browser, BrowserContext, Page } from 'playwright-core'

const IDLE_TIMEOUT_MS = 10 * 60 * 1000

interface PoolEntry {
  context: BrowserContext
  browser: Browser
  timer: NodeJS.Timeout | null
  /** 同账号操作串行（一个 persistent context 不并发页面写操作）。 */
  chain: Promise<unknown>
}

class BrowserPool {
  private entries = new Map<string, PoolEntry>()

  /** 账号浏览器 profile 目录（惰性创建）。 */
  profileDir(accountId: string): string {
    const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default'
    const dir = dshHomePath('writer', 'browser', safe)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 惰性加载 playwright-core（external 依赖）。 */
  private async load(): Promise<typeof import('playwright-core')> {
    try {
      return await import('playwright-core')
    } catch (err) {
      throw new Error(
        `playwright-core 不可用：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** 取得（或拉起）账号的 persistent context。 */
  private async acquire(
    accountId: string,
    opts: { channel: string; headless: boolean },
  ): Promise<PoolEntry> {
    const existing = this.entries.get(accountId)
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer)
      existing.timer = null
      return existing
    }
    const pw = await this.load()
    const userDataDir = this.profileDir(accountId)
    const context = await this.launch(pw, userDataDir, opts)
    const entry: PoolEntry = {
      context,
      browser: context.browser() as Browser,
      timer: null,
      chain: Promise.resolve(),
    }
    this.entries.set(accountId, entry)
    context.on('close', () => {
      if (entry.timer) clearTimeout(entry.timer)
      this.entries.delete(accountId)
    })
    return entry
  }

  /**
   * 拉起 persistent context：配置的 channel 不可用时按常见渠道回退
   * （本机若只有 google-chrome，配置默认 msedge 也能自动落到 chrome）。
   */
  private async launch(
    pw: typeof import('playwright-core'),
    userDataDir: string,
    opts: { channel: string; headless: boolean },
  ): Promise<BrowserContext> {
    const candidates = [opts.channel, 'chrome', 'msedge', 'chromium']
      .filter((c, i, arr): c is string => !!c && arr.indexOf(c) === i)
    const errors: string[] = []
    for (const channel of candidates) {
      try {
        const context = await pw.chromium.launchPersistentContext(userDataDir, {
          channel,
          headless: opts.headless,
          viewport: { width: 1280, height: 860 },
          args: ['--disable-blink-features=AutomationControlled'],
        })
        if (channel !== opts.channel) {
          console.info(`[writer/browser] channel=${opts.channel} 不可用，已回退到 ${channel}`)
        }
        return context
      } catch (err) {
        const first = (err instanceof Error ? err.message : String(err)).split('\n')[0]
        errors.push(`${channel}: ${first}`)
      }
    }
    throw new Error(`托管浏览器启动失败（尝试 ${candidates.join(' → ')}）：${errors.join('；')}`)
  }

  /**
   * 排到该账号的串行队列上执行；结束后重置空闲计时。
   * @param focus 需要用户操作的流程（扫码登录）传 true：复用窗口里那个空白首页签并置前，
   *              否则页面停在后台标签，用户只看到 about:blank。
   */
  async withPage<T>(
    accountId: string,
    opts: { channel: string; headless: boolean },
    fn: (page: Page, context: BrowserContext) => Promise<T>,
    focus = false,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const entry = await this.acquire(accountId, opts)
      // persistent context 启动时自带一个 about:blank 首页签；需要人工操作时用它，别再开新标签
      const blank = focus ? entry.context.pages().find(p => p.url() === 'about:blank') : undefined
      const page = blank ?? await entry.context.newPage()
      if (focus) {
        await page.bringToFront().catch(() => {})
      } else {
        // 后台任务：newPage 走 CDP Target.createTarget（无 background 标志）会抢焦点，
        // 立刻把用户原来那张标签置前还回去。
        const others = entry.context.pages().filter(p => p !== page)
        const target = others[others.length - 1]
        if (target) await target.bringToFront().catch(() => {})
      }
      try {
        return await fn(page, entry.context)
      } finally {
        await page.close().catch(() => {})
        this.touchIdle(accountId)
      }
    }
    const entry = this.entries.get(accountId)
    if (!entry) return run()
    const result = entry.chain.then(run, run)
    // 保持队列引用（吞掉 rejection，由 await result 传播）
    entry.chain = result.catch(() => {})
    return result
  }

  /**
   * 取账号的 persistent context（不存在则拉起），**不新建页面**。
   * 扫码登录流程用：登录页由流程自己管理生命周期（轮询 → 成功关窗）。
   */
  async contextFor(
    accountId: string,
    opts: { channel: string; headless: boolean },
  ): Promise<BrowserContext> {
    const entry = await this.acquire(accountId, opts)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    return entry.context
  }

  /** 重置空闲计时：闲置 IDLE_TIMEOUT_MS 后自动关闭该账号浏览器。 */
  touchIdle(accountId: string): void {
    const entry = this.entries.get(accountId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { void this.close(accountId) }, IDLE_TIMEOUT_MS)
  }

  /** 关闭账号浏览器。 */
  async close(accountId: string): Promise<void> {
    const entry = this.entries.get(accountId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(accountId)
    await entry.context.close().catch(() => {})
  }

  /** 关闭全部（插件卸载时）。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(id => this.close(id)))
  }
}

/** 进程级单例（插件模块只装一次）。 */
export const browserPool = new BrowserPool()
