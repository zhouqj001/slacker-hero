/**
 * 小红书 adapter：托管浏览器 → 创作中心发布器（上传图文）→ 上传本机配图、
 * 填标题/正文 → **置前交用户点「发布」**（半自动），随后在后台轮询笔记管理
 * 列表确认是否真发出。
 *
 * 平台硬约束：
 * 1. 图文笔记**至少 1 张图**：正文素材图 + 封面一张都没有时，发布器编辑区
 *    大概率锁死——填不进去就如实抛错带草稿包，不假装能发。
 * 2. 标题上限 20 字；正文上限 1000 字，**纯文本**（不支持 HTML 混排、
 *    不支持在正文里插图片节点），所以正文按纯文本化后一次粘贴。
 * 3. 话题必须从下拉里选中才会成为真话题，纯文本 `#xx` 发布后只是普通文字——
 *    程序不代选，把话题建议放进发布说明，由用户手动加。
 * 4. 「发布」按钮程序一律不点：填完即 `awaiting-manual`（与知乎/头条同一套红线）。
 *
 * 采集/确认：**DOM 候选表 + 全 fail-closed**——创作中心是自家 SPA，没有在真实
 * 账号上实测过接口路径，不猜接口；抓不到就如实报 DOM_CHANGED，待实测后修正。
 */
import * as nodePath from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { browserPool, restoreUserTab } from './browser.ts'
import { mdToHtml } from './markdown.ts'
import { probeLogin, waitForLogin, type LoginHooks } from './login.ts'
import {
  PublishError,
  type AdapterOptions,
  type DraftPackage,
  type PublishAdapter,
  type PublishJob,
  type PublishOutcome,
  type AccountProfile,
  type AccountWork,
} from './types.ts'
import { parseCount } from './scrape.ts'

const HOME_URL = 'https://creator.xiaohongshu.com/'
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official'
/** 笔记管理列表（采集作品 + 半自动确认都看这里）。 */
const NOTES_URL = 'https://creator.xiaohongshu.com/publish/record?source=official&tab=note_management'
const LOGIN_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 8_000

/** 小红书标题上限 20 字（平台侧硬限制）。 */
const TITLE_MAX = 20
/** 小红书正文上限 1000 字（平台侧硬限制）。 */
const BODY_MAX = 1000
/** 发布器加载后给 SPA 渲染的时间。 */
const PUBLISH_SETTLE_MS = 5_000
/** 单次图片上传（可多张）等待完成的时长。 */
const IMAGE_UPLOAD_TIMEOUT_MS = 120_000
/** 半自动确认：轮询笔记管理列表的间隔 / 总时长。 */
const CONFIRM_INTERVAL_MS = 20_000
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000

/** 风控/验证文案（创作中心的滑块/验证码弹层）。 */
const RISK_RE = /安全验证|验证码|滑块/

/** 标题输入框候选（placeholder 文案相对稳，class 名不稳）。 */
const TITLE_SELECTORS = [
  'input[placeholder*="标题"]',
  'textarea[placeholder*="标题"]',
  '[class*="title"] input',
  '[class*="title"] textarea',
]
/** 正文编辑器候选（小红书发布器用 Quill：.ql-editor；后两个是兜底）。 */
const BODY_SELECTORS = [
  '.ql-editor[contenteditable="true"]',
  '.ql-editor',
  'div[contenteditable="true"][data-placeholder]',
  'div[contenteditable="true"]',
]
/** 笔记详情链接特征（管理列表里的条目；排菜单/标签页链接）。 */
const NOTE_LINK_SELECTOR = [
  'a[href*="/explore/"]',
  'a[href*="/search_result/"]',
  'a[href*="xhslink"]',
  'a[href*="note_id"]',
].join(', ')

/** 本机素材图引用的地址前缀（`/api/media/asset?id=<articleId>%2F<filename>`）。 */
const ASSET_URL_PREFIX = '/api/media/asset?id='

/** 标题按平台上限截断，并告知是否截过。 */
function clipTitle(title: string): { text: string; clipped: boolean } {
  const chars = [...title.trim()]
  return { text: chars.slice(0, TITLE_MAX).join(''), clipped: chars.length > TITLE_MAX }
}

/** 正文纯文本按上限截断。 */
function clipBody(text: string): { text: string; clipped: boolean } {
  const chars = [...text]
  return { text: chars.slice(0, BODY_MAX).join(''), clipped: chars.length > BODY_MAX }
}

/**
 * markdown → 小红书正文可用的纯文本：图片行去掉（图走上传）、
 * 去常见标记、链接保留文字，保留换行结构。
 */
function mdToPlain(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    // 独占一行的图片引用：图会上传，不进正文
    if (/^\s*!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line)) continue
    out.push(line
      .replace(/^#{1,6}\s+/, '')                    // 标题
      .replace(/^\s*[-*+]\s+/, '· ')                // 列表
      .replace(/^\s*>\s?/, '')                      // 引用
      .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, '$1')   // 行内图片 → 图注文字
      .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')    // 链接 → 链接文本
      .replace(/(\*\*|__)(.*?)\1/g, '$2')           // 加粗
      .replace(/(\*|_)(.*?)\1/g, '$2')              // 斜体
      .replace(/`([^`]+)`/g, '$1'))                 // 行内代码
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 从标题里粗提话题（去停用词 + 长度过滤），最多 5 个——只进草稿包/发布说明，不代填。 */
function suggestTopics(title: string): string {
  const stop = new Set(['的', '了', '和', '与', '在', '是', '有', '个', '我', '你'])
  const parts = title
    .split(/[\s，。、：:；;！!？?（）()【】\[\]「」·|—\-]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !stop.has(w))
  const picked = parts.slice(0, 5)
  return picked.map(w => `#${w}`).join(' ') || '#好物分享'
}

/**
 * 收集要上传的本机图：正文素材引用（按出现顺序、去重）+ 失败原因如实记录；
 * 正文一张图都没有时用封面补位（小红书必须有图）。
 */
function collectImageFiles(job: PublishJob): { files: string[]; reasons: string[] } {
  const files: string[] = []
  const reasons: string[] = []
  const seen = new Set<string>()
  const md = job.article.bodyMd || job.article.title
  const imgRe = /!\[[^\]]*\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = imgRe.exec(md)) !== null) {
    const url = m[1]
    if (/^https?:\/\//i.test(url)) { reasons.push(`站外图片平台取不到，需手动上传（${url}）`); continue }
    if (url.startsWith('gen:')) { reasons.push('有配图占位（gen:）没画成图，已跳过'); continue }
    if (!url.startsWith(ASSET_URL_PREFIX)) { reasons.push(`正文里有平台取不到的图片地址（${url}），已跳过`); continue }
    let idPart = ''
    try { idPart = decodeURIComponent(url.slice(ASSET_URL_PREFIX.length)) } catch { /* 拆不出来当失败 */ }
    const slash = idPart.indexOf('/')
    const ownerId = slash > 0 ? idPart.slice(0, slash) : ''
    const filename = slash > 0 ? idPart.slice(slash + 1) : ''
    if (ownerId !== job.article.id || filename === '') { reasons.push(`正文引用的是别的文章/取不到文件名的素材（${idPart || url}），已跳过`); continue }
    if (!job.assetDir) { reasons.push('未设置工作文件夹，读不到本机配图文件，已跳过'); continue }
    const file = nodePath.join(job.assetDir, filename)
    if (seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
  if (files.length === 0 && job.coverPath) files.push(job.coverPath)
  return { files, reasons }
}

async function firstVisible(page: Page, selectors: string[], timeout = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  for (const sel of selectors) {
    const remain = deadline - Date.now()
    if (remain <= 0) break
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout: Math.min(remain, 3000) })
      return loc
    } catch { /* try next */ }
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

/** 发布器里的图片上传控件：accept 含 image 的 file input。 */
async function imageInput(page: Page): Promise<Locator | null> {
  const inputs = page.locator('input[type=file]')
  const n = await inputs.count()
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i)
    const acc = (await el.getAttribute('accept').catch(() => null)) ?? ''
    if (/image\//.test(acc)) return el
  }
  return null
}

/**
 * 一次把多张图塞进上传控件，等上传完成。
 * 完成证据（候选链）：预览 img 数量增长，或页面出现「封面/重新上传/删除」——
 * DOM 未实测，证据链宁松勿断（传没传上，用户点发布前一眼就能看到）。
 */
async function uploadImages(page: Page, files: string[]): Promise<{ ok: boolean; reason?: string }> {
  const before = await page.evaluate(() => document.querySelectorAll('img').length).catch(() => 0)
  const input = await imageInput(page)
  if (!input) return { ok: false, reason: '发布器里没找到图片上传控件（input[type=file] accept=image）' }
  try {
    await input.setInputFiles(files)
  } catch (err) {
    return { ok: false, reason: `把图片交给发布器失败：${err instanceof Error ? err.message : String(err)}` }
  }
  await page.waitForTimeout(3000)
  const deadline = Date.now() + IMAGE_UPLOAD_TIMEOUT_MS
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const text = document.body?.innerText ?? ''
      return {
        uploading: /上传中|正在上传/.test(text),
        failed: /上传失败/.test(text),
        done: /封面|重新上传|删除/.test(text),
        imgs: document.querySelectorAll('img').length,
      }
    }).catch(() => ({ uploading: true, failed: false, done: false, imgs: before }))
    if (!st.uploading && (st.imgs > before || st.done)) return { ok: true }
    if (!st.uploading && st.failed) return { ok: false, reason: '发布器显示「上传失败」，请检查图片格式/大小后重试' }
    await page.waitForTimeout(2000)
  }
  return { ok: false, reason: `图片上传超时（${Math.round(IMAGE_UPLOAD_TIMEOUT_MS / 1000)}s 内没等到上传完成）` }
}

/** 把纯文本粘进 contenteditable 正文（用 paste 事件，编辑器自己消化）。 */
async function pastePlainText(page: Page, selector: string, text: string): Promise<void> {
  const sent = await page.evaluate(({ selector, text }) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return false
    el.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  }, { selector, text })
  if (!sent) throw new PublishError('DOM_CHANGED', `正文编辑器没找到（${selector}）`)
  await page.waitForTimeout(1000)
}

/** 整页文本里按「标签 → 数字」提取计数（创作中心首页的数据卡文案相对稳）。 */
function textCount(text: string, labelRe: RegExp): number | undefined {
  const re = new RegExp(`${labelRe.source}[^\\d\\n]{0,12}([\\d,，.]+\\s*[万亿]?\\+?)`)
  const m = re.exec(text)
  if (!m) return undefined
  return parseCount(m[1])
}

/** 确认登录态后打开笔记管理页并抓条目（采集与确认共用）。 */
async function openNotesAndScrape(page: Page): Promise<{ title: string; url?: string }[]> {
  await page.goto(NOTES_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(5_000)
  const probe = await probeLogin('xiaohongshu', page)
  if (!probe.loggedIn) {
    throw new PublishError('LOGIN_EXPIRED', `登录态失效，请重新扫码（${probe.reason}）`)
  }
  const items = await page.evaluate((sel: string) => {
    const out: { title: string; url?: string }[] = []
    const seen = new Set<string>()
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>(sel))) {
      const title = (a.innerText || a.title || a.getAttribute('aria-label') || '').trim()
      if (title.length < 2) continue
      const key = title
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ title, url: a.href || undefined })
    }
    return out
  }, NOTE_LINK_SELECTOR).catch(() => [])
  return items
}

export const xiaohongshuAdapter: PublishAdapter = {
  platform: 'xiaohongshu',
  // 半自动发布（内容入发布器、最终那一下由用户点）：与知乎/头条同一档，不是「草稿优先」
  autoPublish: true,

  async ensureLogin(account, opts: AdapterOptions, hooks?: LoginHooks) {
    hooks?.onProgress?.({ stage: 'launching', message: '正在拉起托管浏览器…' })
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      hooks?.onProgress?.({ stage: 'opened', message: '已打开小红书创作中心，请在浏览器窗口里用小红书 App 扫码登录', url: page.url() })
      const result = await waitForLogin('xiaohongshu', page, LOGIN_TIMEOUT_MS, hooks)
      return { loggedIn: true, reason: result.reason }
    }, true)
  },

  async checkLogin(account, opts: AdapterOptions) {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      // 未登录会被 302 到 /login，必须以 URL 为准
      return (await probeLogin('xiaohongshu', page)).loggedIn
    })
  },

  /**
   * 采集账号概况：创作中心首页的数据卡文案（粉丝/获赞与收藏/笔记数）。
   * **纯只读**：只读页面文本，不点任何按钮。三类计数一个都没读到 = 页面结构
   * 可能已变更，报 DOM_CHANGED（带页面文本开头，便于定位）；抓到几个算几个。
   */
  async collectProfile(account, opts: AdapterOptions): Promise<AccountProfile> {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(5_000)
      const probe = await probeLogin('xiaohongshu', page)
      if (!probe.loggedIn) {
        throw new PublishError('LOGIN_EXPIRED', `登录态失效，请重新扫码（${probe.reason}）`)
      }
      const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000)
      const fans = textCount(text, /粉丝(?:数|总量)?/)
      const likes = textCount(text, /获赞(?:与|和)收藏/)
      const works = textCount(text, /笔记(?:数|总量)?/)
      if (fans === undefined && likes === undefined && works === undefined) {
        const head = text.replace(/\s+/g, ' ').slice(0, 140)
        throw new PublishError('DOM_CHANGED', `创作中心首页没读到粉丝/获赞/笔记数，页面结构可能已变更：${head}`)
      }
      const nameM = /你好[，,]\s*([^\n，,。]{1,40})/.exec(text)
      return {
        displayName: nameM?.[1]?.trim(),
        fansTotal: fans,
        likesTotal: likes,
        worksCount: works,
      }
    })
  },

  /**
   * 采集作品列表：笔记管理页的条目标题 + 详情链接。
   * 行内的浏览/点赞等计数 DOM 结构未实测，抓了也是猜——第一版**不填计数**，
   * 宁可缺字段也不拿噪声数冒充。一条都抓不到时如实报 DOM_CHANGED。
   */
  async collectWorks(account, opts: AdapterOptions, limit = 50): Promise<AccountWork[]> {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
      const items = await openNotesAndScrape(page)
      if (items.length === 0) {
        const head = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
        throw new PublishError('DOM_CHANGED', `笔记管理页没抓到任何笔记条目，页面结构可能已变更：${head}`)
      }
      return items.slice(0, limit).map(w => ({
        title: w.title,
        kind: '笔记',
        url: w.url,
      }))
    })
  },

  /**
   * 半自动发布：先传图（小红书必须有图）→ 填标题（≤20 字）→ 纯文本正文（≤1000 字）
   * → **把窗口留给用户点「发布」**。程序不点任何含「发布」的按钮，
   * 如实在 `awaiting-manual` 停下，由 `confirmManualPublish` 后台轮询笔记管理确认。
   *
   * 页面保持打开（keepOpen）且置前（foreground）：最终那一下必须由人在浏览器里点。
   */
  async publish(job: PublishJob, opts: AdapterOptions): Promise<PublishOutcome> {
    const { account, article } = job
    const draftPackage = xiaohongshuAdapter.draftExport(job)
    const { text: title, clipped } = clipTitle(article.title)
    const plainSrc = mdToPlain(article.bodyMd || article.title)
    const { text: bodyText, clipped: bodyClipped } = clipBody(plainSrc)
    const imgs = collectImageFiles(job)
    console.info(`[media/xiaohongshu] 发布器正文：纯文本 ${[...bodyText].length}/${BODY_MAX} 字，待上传本机图 ${imgs.files.length} 张`)

    return browserPool.withPage(account.id, opts, async (page: Page): Promise<PublishOutcome> => {
      try {
        // 1) 先落创作中心确认登录态（同一套 URL 判定），再进发布器
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(4_000)
        const probe = await probeLogin('xiaohongshu', page)
        if (!probe.loggedIn) {
          throw new PublishError('LOGIN_EXPIRED', `登录态失效，请重新扫码（${probe.reason}）`)
        }
        await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(PUBLISH_SETTLE_MS)
        if (await detectRisk(page)) {
          throw new PublishError('RISK_CONTROL', '平台要求安全验证，已暂停转人工')
        }

        // 2) 先传图（发布器通常要先有图，标题/正文编辑区才可用）
        let uploaded = 0
        let uploadFailReason: string | undefined
        if (imgs.files.length > 0) {
          const r = await uploadImages(page, imgs.files)
          if (r.ok) {
            uploaded = imgs.files.length
            console.info(`[media/xiaohongshu] 配图上传成功 ${uploaded} 张`)
          } else {
            uploadFailReason = r.reason
            console.warn(`[media/xiaohongshu] 配图上传失败：${r.reason}`)
          }
        }
        for (const r of imgs.reasons) console.warn(`[media/xiaohongshu] 配图问题：${r}`)
        if (await detectRisk(page)) {
          throw new PublishError('RISK_CONTROL', '上传图片过程中触发安全验证，转人工处理')
        }

        // 3) 标题（≤20 字）
        const titleLoc = await firstVisible(page, TITLE_SELECTORS)
        let titleOk = false
        if (titleLoc) {
          await titleLoc.fill(title)
          await page.waitForTimeout(800)
          titleOk = true
        }

        // 4) 正文（纯文本一次粘贴；超 1000 字已在本地截断）
        let bodyOk = false
        const bodyLoc = await firstVisible(page, BODY_SELECTORS)
        if (bodyLoc) {
          await bodyLoc.click().catch(() => {})
          const sel = await (bodyLoc as Locator).evaluate(el => {
            if (el.className && typeof el.className === 'string' && el.className.includes('ql-editor')) return '.ql-editor'
            const cls = (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).filter(Boolean)[0] : ''
            return cls ? `.${cls}` : 'div[contenteditable="true"]'
          })
          await pastePlainText(page, sel, bodyText)
          bodyOk = true
        }

        // 编辑区一个都没填进去 = 大概率没传图锁死了编辑区 / DOM 变了
        if (!titleOk && !bodyOk) {
          throw new PublishError(
            'DOM_CHANGED',
            uploaded === 0 && imgs.files.length === 0
              ? '小红书图文笔记至少需要 1 张图片，本机没有可上传的配图，发布器编辑区也没能填写；请先为文章配图，或按草稿包手动发布'
              : `发布器标题/正文输入框都没找到${uploadFailReason ? `（配图上传也失败：${uploadFailReason}）` : ''}，页面结构可能已变更`,
            draftPackage,
          )
        }

        // 5) awaiting-manual：发布说明把「到底填了什么、还差什么」讲清楚
        const notes = ['标题与正文已填入小红书发布器，请在浏览器窗口里点「发布」完成发布']
        if (uploaded > 0) notes.push(`${uploaded} 张本机配图已上传`)
        if (imgs.files.length > 0 && uploaded === 0) {
          notes.push(`注意：配图没有上传成功（${uploadFailReason ?? '未知原因'}），小红书笔记至少需要 1 张图，请在窗口里手动上传`)
        }
        if (imgs.files.length === 0) {
          const head = imgs.reasons.slice(0, 2).join('；')
          notes.push(`注意：本机没有可用配图（${head || '正文未引用素材图、也没有封面'}），请在窗口里手动上传至少 1 张图`)
        }
        const topics = suggestTopics(article.title)
        notes.push(`话题建议（需在正文末尾输入 # 从下拉中选中才算真话题）：${topics}`)
        notes.push(bodyOk
          ? (bodyClipped
            ? `正文超 ${BODY_MAX} 字已截断为 ${[...bodyText].length} 字（原 ${[...plainSrc].length} 字）`
            : `正文已填入（约 ${[...bodyText].length} 字）`)
          : '注意：正文没能填入发布器，请从草稿包手动粘贴')
        if (!titleOk) notes.push('注意：标题没能填入发布器，请从草稿包手动粘贴')
        if (clipped) notes.push(`标题超 ${TITLE_MAX} 字已截断：${article.title} → ${title}`)
        notes.push(`程序会在后台每 ${CONFIRM_INTERVAL_MS / 1000} 秒核对一次笔记管理列表，确认发出后自动记录；${CONFIRM_TIMEOUT_MS / 60_000} 分钟内没等到就转人工回填`)
        return { state: 'awaiting-manual', expectedTitle: title, draftPackage, note: notes.join('；') }
      } catch (err) {
        // 抛错也带上降级草稿包（与知乎/头条一致：失败时用户手里得有可粘贴的东西）
        if (err instanceof PublishError && !err.draftPackage) {
          throw new PublishError(err.code, err.message, draftPackage)
        }
        throw err
      }
    }, true, true)
  },

  /**
   * 后台确认：轮询**笔记管理列表**，看《标题》是否真发出去了。
   * 列表里只有已发布的笔记（草稿在另一个 tab），天然不会把「没点发布」误判成已发出。
   * DOM 里取不到发布时间 → 放行（与知乎 freshEnough 的缺省放行一致：宁可放行不漏检）。
   * 超时/登录掉线一律 null——由调用方保持「需人工」，不谎报。
   */
  async confirmManualPublish(account, opts, expected) {
    const context = await browserPool.contextFor(account.id, opts)
    const page = await context.newPage()
    try {
      // 先把用户的发布器换回前台，再导航——用户点「发布」的视线不被打断
      await restoreUserTab(context, page, /xiaohongshu\.com/)
      const deadline = Date.now() + CONFIRM_TIMEOUT_MS
      while (Date.now() < deadline) {
        try {
          const items = await openNotesAndScrape(page)
          const hit = items.find(w => w.title === expected.title)
          if (hit) {
            return {
              url: hit.url,
              note: `笔记管理列表检出《${expected.title}》${hit.url ? '，链接已记录' : '（详情链接没取到，请到创作中心核对）'}`,
            }
          }
        } catch (err) {
          if (err instanceof PublishError && err.code === 'LOGIN_EXPIRED') {
            console.info('[media/xiaohongshu] 确认轮询期间登录态失效，转人工')
            return null
          }
          console.info('[media/xiaohongshu] 确认轮询取列表失败（继续等）：', err instanceof Error ? err.message : String(err))
        }
        await page.waitForTimeout(CONFIRM_INTERVAL_MS)
      }
      return null
    } catch (err) {
      console.info('[media/xiaohongshu] 确认轮询异常，转人工:', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      await page.close().catch(() => {})
      // 轮询收尾把空闲计时交回去：用户离开后浏览器仍会自动关
      browserPool.touchIdle(account.id)
    }
  },

  draftExport(job: PublishJob): DraftPackage {
    const { text: title } = clipTitle(job.article.title)
    const version = job.article.platformVersions[job.plan.platform] ?? job.article.bodyMd
    return {
      platform: 'xiaohongshu',
      title,
      bodyMd: version,
      bodyHtml: mdToHtml(version || job.article.title),
      topics: suggestTopics(job.article.title),
      openUrl: PUBLISH_URL,
      hint: '打开小红书创作中心发布器 → 上传图文：先传至少 1 张图片，标题粘贴「标题」（≤20 字）、正文粘贴「正文（HTML）」（≤1000 字，平台只认纯文本）；话题需在正文输入 # 从下拉中选中。',
    }
  },
}
