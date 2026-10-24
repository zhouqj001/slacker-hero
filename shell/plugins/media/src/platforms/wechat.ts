/**
 * 微信公众号 adapter（M4）：扫码登录永续 → 新建图文 → 填题/文 → 存草稿。
 * 默认绝不自动群发（config.publish.wechatDirectSend 仅影响提示，M4 不实现
 * 自动点群发——群发需封面+管理员确认）。
 *
 * selector 全部收敛为顶部候选表（DOM 改版只改这里）；任一关键节点
 * 找不到即抛 DOM_CHANGED，由路由层落降级链（草稿包 + 粘贴引导）。
 */
import type { BrowserContext, Frame, Locator, Page } from 'playwright-core'
import { browserPool } from './browser.ts'
import { mdToHtml } from './markdown.ts'
import { probeLogin, waitForLogin, type LoginHooks } from './login.ts'
import { PublishError, type AdapterOptions, type PublishAdapter, type PublishJob, type PublishOutcome } from './types.ts'
import { scrapeCount, parseCount } from './scrape.ts'

const HOME_URL = 'https://mp.weixin.qq.com/'
/** 扫码登录等待上限。 */
const LOGIN_TIMEOUT_MS = 180_000
/** 单节点等待上限。 */
const STEP_TIMEOUT_MS = 8_000

/** 标题输入框候选（新版/旧版编辑器）。 */
const TITLE_SELECTORS = ['textarea#title', 'input#title', '#title']
/** 正文 ueditor iframe 候选。 */
const FRAME_URL_RE = /ueditor|ueditor/i
/** 「保存草稿」按钮候选——绝不包含「发表/群发」。 */
const SAVE_DRAFT_SELECTORS = [
  '#js_submit_draft',
  'a:has-text("保存为草稿")',
  'button:has-text("保存为草稿")',
  'button:has-text("保存草稿")',
  'a:has-text("保存")',
  '.js_save_draft',
]
/** 风控/异常文案。 */
const RISK_RE = /风控|安全验证|操作异常|环境异常/

async function firstVisible(page: Page, selectors: string[], timeout = STEP_TIMEOUT_MS): Promise<Locator | null> {
  const deadline = Date.now() + timeout
  for (const sel of selectors) {
    const remain = deadline - Date.now()
    if (remain <= 0) break
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout: Math.min(remain, 3000) })
      return loc
    } catch { /* try next candidate */ }
  }
  return null
}

async function detectRisk(page: Page): Promise<boolean> {
  try {
    const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 4000)
    return RISK_RE.test(text)
  } catch {
    return false
  }
}

function extractToken(url: string): string | null {
  return /[?&]token=(\d+)/.exec(url)?.[1] ?? null
}

/** 轮询等待扫码后跳后台（发布前的短等待，失败即判定登录态失效）。 */
async function waitForLoggedIn(page: Page, timeoutMs: number): Promise<boolean> {
  const result = await waitForLogin('wechat', page, timeoutMs).catch(() => null)
  return result?.loggedIn ?? false
}

function editorFrame(page: Page): Frame | null {
  const byUrl = page.frames().find(f => FRAME_URL_RE.test(f.url()))
  if (byUrl) return byUrl
  // ueditor iframe 的 src 有时是 about:blank 后注入；退回找 contenteditable body 的子 frame
  return page.frames().find(f => f !== page.mainFrame()) ?? null
}

export const wechatAdapter: PublishAdapter = {
  platform: 'wechat',

  async ensureLogin(account, opts: AdapterOptions, hooks?: LoginHooks) {
    hooks?.onProgress?.({ stage: 'launching', message: '正在拉起托管浏览器…' })
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      hooks?.onProgress?.({ stage: 'opened', message: '已打开公众号后台，请在浏览器窗口里用微信「扫一扫」', url: page.url() })
      const result = await waitForLogin('wechat', page, LOGIN_TIMEOUT_MS, hooks)
      return { loggedIn: true, reason: result.reason }
    }, true)
  },

  async checkLogin(account, opts: AdapterOptions) {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      return (await probeLogin('wechat', page)).loggedIn
    })
  },

  async publish(job: PublishJob, opts: AdapterOptions): Promise<PublishOutcome> {
    const { account, article } = job
    const draftPackage = wechatAdapter.draftExport(job)

    return browserPool.withPage(account.id, opts, async (page: Page): Promise<PublishOutcome> => {
      // 1) 进后台拿 token
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      if (!(await waitForLoggedIn(page, 10_000))) {
        throw new PublishError('LOGIN_EXPIRED', '登录态失效，请重新扫码', draftPackage)
      }
      const token = extractToken(page.url())
      if (!token) throw new PublishError('DOM_CHANGED', '后台页面未找到 token，可能平台改版', draftPackage)

      // 2) 新建图文
      const editUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=0&token=${token}&lang=zh_CN`
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

      // 3) 标题
      const titleLoc = await firstVisible(page, TITLE_SELECTORS)
      if (!titleLoc) throw new PublishError('DOM_CHANGED', '编辑器标题输入框未出现，可能平台改版', draftPackage)
      await titleLoc.fill(article.title.slice(0, 64))

      // 4) 正文（ueditor iframe contenteditable body）
      await page.waitForTimeout(2000)
      const frame = editorFrame(page)
      if (!frame) throw new PublishError('DOM_CHANGED', '编辑器正文 iframe 未出现，可能平台改版', draftPackage)
      const html = mdToHtml(article.bodyMd || article.title)
      await frame.locator('body').evaluate((body, value) => {
        body.innerHTML = value
        body.dispatchEvent(new Event('input', { bubbles: true }))
        body.dispatchEvent(new Event('change', { bubbles: true }))
        body.dispatchEvent(new Event('blur', { bubbles: true }))
      }, html).catch(() => {})
      await page.waitForTimeout(500)

      if (await detectRisk(page)) {
        throw new PublishError('RISK_CONTROL', '平台要求安全验证，已暂停转人工', draftPackage)
      }

      // 5) 存草稿（M4 不自动群发）
      if (opts.wechatDirectSend) {
        // 即使开了直发，M4 也只到草稿，提示人工群发
        return saveDraft(page, draftPackage, true)
      }
      return saveDraft(page, draftPackage, false)
    })
  },

  draftExport(job: PublishJob) {
    return {
      platform: 'wechat',
      title: job.article.title,
      bodyMd: job.article.bodyMd,
      bodyHtml: mdToHtml(job.article.bodyMd || job.article.title),
      openUrl: HOME_URL,
      hint: '已在公众号后台打开时，新建图文后将标题与正文（HTML）粘贴进去，保存草稿。',
    }
  },

  /**
   * M6：双路径抓数据。
   * 路径1（文章页）：抓点赞/在看/评论（阅读数被微信 PC 页隐藏）。
   * 路径2（后台图文分析）：登录态打开内容分析列表，按标题匹配补阅读数。
   * 两路结果合并，字段缺失按「部分指标」落库不算失败。
   */
  async fetchMetrics(account, publishUrl, opts) {
    return browserPool.withPage(account.id, opts, async (page) => {
      const result: Record<string, number | undefined> = {}

      // ---- 路径1：文章页 ----
      await page.goto(publishUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      const gone = await page.locator('body').innerText().catch(() => '')
      if (/该内容已被发布者删除|此内容因违规无法查看|参数错误/.test(gone)) {
        throw new PublishError('DOM_CHANGED', '文章页不可访问（已删除或违规隐藏）')
      }
      const [likes, collected, comments] = await Promise.all([
        scrapeCount(page, ['#js_like_count', '.like_count', '#js_praise_num']),
        scrapeCount(page, ['#js_old_like_count', '.old_like_count']),
        scrapeCount(page, ['#js_comment_count', '.comment_count']),
      ])
      result.likes = likes
      result.collected = collected
      result.comments = comments

      // ---- 路径2：后台图文分析（补阅读数） ----
      try {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(4000)
        const token = extractToken(page.url())
        if (token) {
          const analysisUrl = `https://mp.weixin.qq.com/misc/appmsganalysis?action=all&token=${token}&lang=zh_CN`
          await page.goto(analysisUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await page.waitForTimeout(3000)
          // 尝试在图文分析列表中按标题匹配文章行
          const titleText = publishUrl.length > 30 ? publishUrl.slice(0, 30) : publishUrl
          // 候选：标题文本所在的行/卡片
          const rowLoc = page.locator(`text=${titleText.slice(0, 20)}`).first()
          if (await rowLoc.isVisible().catch(() => false)) {
            // 同行/同卡片内找数字（阅读数通常是第一个大数字）
            const card = rowLoc.locator('xpath=ancestor::tr[1] | ancestor::div[contains(@class,"item") or contains(@class,"card")][1]').first()
            const nums = await card.locator('text=/\\d+/').allInnerTexts().catch(() => [] as string[])
            for (const t of nums) {
              const n = parseCount(t)
              if (n !== undefined && n > 0 && !result.reads) { result.reads = n; break }
            }
          }
        }
      } catch { /* 后台路径失败不阻塞，文章页数据已保底 */ }

      return result
    })
  },
}

/** 点保存草稿并等待；点不到按钮 → DOM_CHANGED 降级。 */
async function saveDraft(
  page: Page,
  draftPackage: Record<string, string>,
  directSendEnabled: boolean,
): Promise<PublishOutcome> {
  const btn = await firstVisible(page, SAVE_DRAFT_SELECTORS)
  if (!btn) throw new PublishError('DOM_CHANGED', '未找到「保存草稿」按钮，可能平台改版', draftPackage)
  await btn.click()
  await page.waitForTimeout(5000)

  if (await detectRisk(page)) {
    throw new PublishError('RISK_CONTROL', '保存时触发安全验证，转人工处理', draftPackage)
  }
  return {
    state: 'success',
    note: directSendEnabled
      ? '已保存为草稿；直发开关已开但自动群发未启用，请到后台确认群发'
      : '已保存为公众号草稿，请到后台预览后群发',
  }
}

import { toutiaoAdapter } from './toutiao.ts'
import { zhihuAdapter } from './zhihu.ts'
import { douyinAdapter } from './social.ts'
import { xiaohongshuAdapter } from './xiaohongshu.ts'

/** 供路由层统一取 adapter；未支持平台返回 null。 */
export function getAdapter(platform: string): PublishAdapter | null {
  if (platform === 'wechat') return wechatAdapter
  if (platform === 'toutiao') return toutiaoAdapter
  if (platform === 'zhihu') return zhihuAdapter
  if (platform === 'xiaohongshu') return xiaohongshuAdapter
  if (platform === 'douyin') return douyinAdapter
  return null
}

export type { BrowserContext }
