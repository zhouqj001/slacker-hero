/**
 * 登录态探测与等待 —— 三个平台共用同一套判定与进度回调。
 *
 * 判定原则：**URL 跳转优先，DOM 文案补充；判不准一律当作未登录**。
 * 反例（知乎）：未登录访问首页会被 302 到 `/signin?next=…`，该页面上不存在首页那个
 * 「登录」链接，只看 DOM 会把「未登录」误判成「已登录」，于是调度器以为登录态正常、
 * 直接进入发布，最后以一个莫名其妙的 DOM_CHANGED 收场。
 * 反例（头条）：`goto` 刚发出时页面还没跳到 `/auth/page/login`，此刻 URL 不含 login，
 * 只看「URL 不像登录页」就会把「还没跳」误判成「已登录」——所以探测一律 fail-closed：
 * 必须**认得**后台页面长什么样才放行。
 *
 * 探测结果带 `reason`，用于 SSE 进度回显——让「到底在等什么」对用户可见。
 */
import type { Page } from 'playwright-core'
import { PublishError } from './types.ts'

/** 一次探测的结论。 */
export interface LoginProbeResult {
  loggedIn: boolean
  /** 人类可读理由（等待中提示「请扫码」/ 已登录说明）。 */
  reason: string
}

/** 登录过程进度回调（由路由层接到 SSE 上）。 */
export interface LoginHooks {
  onProgress?: (p: LoginProgress) => void
  /** 取消信号：用户点了「取消登录」。 */
  signal?: AbortSignal
}

/** 进度事件。 */
export interface LoginProgress {
  stage: 'launching' | 'opened' | 'waiting' | 'verifying'
  message: string
  /** 当前页面 URL（便于用户自己找到浏览器窗口）。 */
  url?: string
  /** 已等待秒数。 */
  elapsed?: number
}

/** 微信公众平台：登录成功后跳 `/cgi-bin/home`；未登录停在首页并显示「扫一扫」。 */
async function probeWechat(page: Page): Promise<LoginProbeResult> {
  const url = page.url()
  if (/\/cgi-bin\/home/.test(url)) return { loggedIn: true, reason: '已进入公众号后台首页' }
  // 多公众号账号时扫码后会停在「选择账号」页，需要人工点一下
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500)
  if (/选择.{0,6}账号|请选择要登录的账号/.test(text)) {
    return { loggedIn: false, reason: '请在浏览器窗口里选择要登录的公众号（可能有多个）' }
  }
  return { loggedIn: false, reason: '等待微信「扫一扫」扫码' }
}

/** 今日头条：未登录跳 `/auth/page/login?redirect_url=…`；登录后停在 `/profile_v4`。 */
async function probeToutiao(page: Page): Promise<LoginProbeResult> {
  const url = page.url()
  if (/\/auth\/page\/login|\/login/i.test(url)) {
    return { loggedIn: false, reason: '等待今日头条 App 扫码（或切验证码登录）' }
  }
  // 认不出后台页面 = 还没跳完（首屏 / 跳转中），不能当成已登录
  if (!/\/profile_v4|\/profile\b|\/index\b|\/home\b/i.test(url)) {
    return { loggedIn: false, reason: '等待跳转进头条号后台…' }
  }
  return { loggedIn: true, reason: '已进入头条号后台' }
}

/** 知乎：未登录跳 `/signin`（必须看 URL，页面上不一定有「登录」链接）。 */
async function probeZhihu(page: Page): Promise<LoginProbeResult> {
  const url = page.url()
  if (/\/signin|\/login/i.test(url)) {
    return { loggedIn: false, reason: '等待知乎 App 扫码（或用验证码登录）' }
  }
  // 首页兜底：仍显示「登录」入口说明未登录
  const hasLogin = await page.locator('a:has-text("登录")').first().isVisible().catch(() => false)
  if (hasLogin) return { loggedIn: false, reason: '首页仍显示「登录」入口' }
  return { loggedIn: true, reason: '已进入知乎' }
}

/**
 * 小红书创作中心：未登录访问会被 302 到 `/login`（App 扫码页）；
 * 登录后停在 `creator.xiaohongshu.com` 的后台路径。
 */
async function probeXiaohongshu(page: Page): Promise<LoginProbeResult> {
  const url = page.url()
  if (/\/login(\?|#|$)/i.test(url)) {
    return { loggedIn: false, reason: '等待小红书 App 扫码登录' }
  }
  // 只认创作中心后台域；被跳去别处（判不准）一律当未登录
  if (!/creator\.xiaohongshu\.com/.test(url)) {
    return { loggedIn: false, reason: '等待跳转进小红书创作中心…' }
  }
  return { loggedIn: true, reason: '已进入小红书创作中心' }
}

const PROBES: Record<string, (page: Page) => Promise<LoginProbeResult>> = {
  wechat: probeWechat,
  toutiao: probeToutiao,
  zhihu: probeZhihu,
  xiaohongshu: probeXiaohongshu,
  // 草稿优先平台无登录态概念，统一按「已登录」处理（publish 本就直抛草稿包）
  douyin: async () => ({ loggedIn: true, reason: '抖音为草稿优先平台，无需登录态' }),
}

/** 取平台探测器；未知平台只认「URL 明确不是登录页」，认不出就当未登录。 */
function probeOf(platform: string): (page: Page) => Promise<LoginProbeResult> {
  return PROBES[platform] ?? (async (page: Page) => {
    const url = page.url()
    return /\/signin|\/login/i.test(url)
      ? { loggedIn: false, reason: '等待扫码' }
      : { loggedIn: false, reason: '该平台登录态无法确认，请手动检查后重试' }
  })
}

/** 单次探测。 */
export function probeLogin(platform: string, page: Page): Promise<LoginProbeResult> {
  return probeOf(platform)(page)
}

/**
 * 轮询等待登录完成。
 * - 每 1.5s 探测一次；`onProgress` 收到 waiting（含 elapsed 与 reason）；
 * - `signal` 触发即抛 LOGIN_CANCELLED（不等满超时）；
 * - 超时抛 LOGIN_EXPIRED，带最后一次的等待理由。
 */
export async function waitForLogin(
  platform: string,
  page: Page,
  timeoutMs: number,
  hooks: LoginHooks = {},
): Promise<LoginProbeResult> {
  const started = Date.now()
  let lastReason = ''
  let lastBeat = 0
  // 首屏跳转还没落定就开探，URL 仍是跳转前的旧值（头条实测 12s 就误判成已登录）。
  // 等 domcontentloaded + 一个静默期，再进循环。
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1500).catch(() => {})
  while (Date.now() - started < timeoutMs) {
    if (hooks.signal?.aborted) {
      throw new PublishError('LOGIN_CANCELLED', '已取消登录')
    }
    let result: LoginProbeResult
    try {
      result = await probeLogin(platform, page)
    } catch (err) {
      result = { loggedIn: false, reason: `页面探测失败：${err instanceof Error ? err.message : String(err)}` }
    }
    if (result.loggedIn) return result
    const elapsed = Math.round((Date.now() - started) / 1000)
    // reason 变化时立刻回显；否则每 5s 心跳一次，让 UI 上的等待秒数是活的
    if (result.reason !== lastReason || elapsed - lastBeat >= 5) {
      const reasonChanged = result.reason !== lastReason
      lastReason = result.reason
      lastBeat = elapsed
      hooks.onProgress?.({
        stage: 'waiting',
        message: result.reason,
        url: page.url(),
        elapsed,
        ...(reasonChanged ? {} : { message: `${result.reason}（已等待 ${elapsed}s）` }),
      })
    }
    await page.waitForTimeout(1500).catch(() => {})
  }
  throw new PublishError('LOGIN_EXPIRED', lastReason ? `扫码登录超时（${lastReason}）` : '扫码登录超时')
}