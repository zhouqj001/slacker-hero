/**
 * 番茄扫码登录流程（plan §5.1）：打开**可见**窗口 → 用户扫码 → 轮询登录态
 * → 成功关窗（收尾 close；api 层失败/取消路径也会兜底关窗）。
 *
 * 轮询不开新标签：登录成功后页面自身会跳离登录页，我们直接在用户那张页面
 * 上跑同源书单接口验证——不打扰操作，也不抢焦点。
 */
import { browserPool } from './browser.ts'
import { FANQIE_HOME, fetchBookList, isLoginExpired, probeUserId } from './fanqie.ts'
import type { WriterConfig } from '../config.ts'

export type LoginStage = 'opening' | 'waiting' | 'verifying' | 'ok'

const LOGIN_TIMEOUT_MS = 3 * 60_000
const POLL_INTERVAL_MS = 3_000

/** 用户主动取消（SSE 断开 / AbortSignal）。 */
export class LoginCancelled extends Error {
  constructor() { super('登录已取消'); this.name = 'LoginCancelled' }
}

/** 超时未完成扫码。 */
export class LoginTimeout extends Error {
  constructor() { super('登录超时（3 分钟），请重试'); this.name = 'LoginTimeout' }
}

export interface LoginFlowArgs {
  accountId: string
  config: WriterConfig
  signal: AbortSignal
  stage: (stage: LoginStage, message: string) => void
}

export interface LoginFlowResult {
  fanqieUserId?: string
}

/** 中断性 sleep：等待期间 signal 触发立刻抛 LoginCancelled。 */
async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new LoginCancelled()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LoginCancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 跑一次扫码登录。成功返回平台用户 id（可能拿不到，undefined 不阻塞）；
 * 取消/超时抛对应异常；成功时**已关闭**该账号浏览器（plan：成功即关）。
 */
export async function runLoginFlow(args: LoginFlowArgs): Promise<LoginFlowResult> {
  const { accountId, config, signal, stage } = args
  // 登录必须可见窗口（扫码）
  const opts = { channel: config.publish.browserChannel, headless: false }

  stage('opening', '正在打开番茄作者后台…')
  const context = await browserPool.contextFor(accountId, opts)
  // 复用 persistent context 自带的 about:blank 首页签（不额外开标签）
  const page = context.pages().find(p => p.url() === 'about:blank') ?? await context.newPage()
  await page.bringToFront().catch(() => {})
  try {
    await page.goto(FANQIE_HOME, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  } catch (err) {
    throw new Error(`打不开番茄作者后台：${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
  }

  stage('waiting', '请在浏览器窗口中完成登录（3 分钟内）')
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    await abortableSleep(POLL_INTERVAL_MS, signal)
    stage('verifying', '检测登录态…')
    // 在用户那张页面（登录后已同源 home）上跑书单接口验证；页面跳转瞬间
    // evaluate 可能失败——按「本次未登录」继续轮询。
    try {
      // fetchBookList 正常返回（哪怕空书单）即登录成功
      await fetchBookList(page)
      stage('ok', '登录成功')
      // 关窗前顺手探测平台用户 id（校准项，读不到不阻塞）
      const fanqieUserId = await probeUserId(page).catch(() => undefined)
      await browserPool.close(accountId) // 成功即关窗
      return { fanqieUserId }
    } catch (err) {
      if (isLoginExpired(err)) continue // 预期内：还没登录
      // 其它错误（结构变更/网络抖动）：未登录时书单接口本就可能异常，继续轮询；
      // 若用户其实已登录但结构变更，后续 probeLogin/works 会再暴露 DOM_CHANGED。
      continue
    }
  }
  throw new LoginTimeout()
}
