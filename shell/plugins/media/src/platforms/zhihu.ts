/**
 * 知乎专栏 adapter：托管浏览器 → 写作中心 → 填题/文（含本机配图逐张上传并插回原位）
 * → **置前交用户点「发布」**（半自动），随后在后台轮询已发布文章接口确认是否真发出。
 *
 * 三条实测硬约束（2026-10-19 在真实账号上探过 DOM/接口）：
 *
 * 1. **正文是 Draft.js**（`.public-DraftEditor-content[contenteditable=true]`），
 *    直接写 `innerHTML` 会被 React 的虚拟 DOM 覆盖——必须用 `DataTransfer` +
 *    `ClipboardEvent('paste')` 让编辑器自己转 block（标题/列表/加粗都能留住）。
 * 2. **图片控件是隐藏的 `input[type=file]`**：点工具栏「图片」**不触发** filechooser，
 *    要对 accept 含 `image/*` 的那个 input 直接 `setInputFiles`；上传完成看正文里
 *    「图片上传中」消失 + 图片数 +1。插入落在光标处，所以正文按「文本段 → 图片 → 文本段」
 *    逐段推进，图就落在原来的位置上。
 * 3. **编辑器页有「发布」按钮**，程序一律不得点：填完即 `awaiting-manual`，
 *    最终那一下由用户在窗口里点（与头条同一套红线）。
 *
 * 采集/确认走 `api/v4` 接口（前台 class 名常年变，接口稳定一个量级）。
 */
import * as nodePath from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { browserPool, restoreUserTab } from './browser.ts'
import { mdToHtml } from './markdown.ts'
import { probeLogin, waitForLogin, type LoginHooks } from './login.ts'
import { PublishError, type AdapterOptions, type PublishAdapter, type PublishJob, type PublishOutcome, type AccountProfile, type AccountWork } from './types.ts'
import { scrapeCount, parseCount } from './scrape.ts'

const HOME_URL = 'https://www.zhihu.com/'
const WRITE_URL = 'https://zhuanlan.zhihu.com/write'
const LOGIN_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 8_000

const TITLE_SELECTORS = [
  'textarea[placeholder*="标题"]',
  'input[placeholder*="标题"]',
  '.WriteIndex-titleInput textarea',
  '.WriteIndex-titleInput input',
  '#title',
]
const RISK_RE = /风控|安全验证|操作异常|环境异常|验证码/

/** 正文编辑器容器（Draft.js；实测 `.public-DraftEditor-content[contenteditable=true]`）。 */
const BODY_SEL = '.public-DraftEditor-content'
/** 编辑器根（数图片用，比正文容器稳）。 */
const EDITOR_ROOT_SEL = '.DraftEditor-root'
/** 编辑器自带的本机图片上传控件：accept 含 image/* 的那个（封面那个 class 是 UploadPicture-input，排除掉）。 */
const IMAGE_ACCEPT_RE = /image\//
const COVER_INPUT_CLASS_RE = /UploadPicture/
/** 编辑器状态条（实测文案形如「刚刚 · 草稿」）。 */
const DRAFT_TIP_SEL = '.DraftStatusTip'
/** 知乎标题框上限（实测 100 字内）。 */
const TITLE_MAX = 100
/** 单张本机图等待上传完成的时长（4MB 级实测走 S3 分片，十几秒起）。 */
const IMAGE_UPLOAD_TIMEOUT_MS = 120_000
/** 正文填完后给编辑器自动保存的时间（知乎的草稿是自动保存的，状态条会变「刚刚 · 草稿」）。 */
const AUTOSAVE_SETTLE_MS = 10_000
/** 半自动确认：轮询已发布文章接口的间隔 / 总时长。 */
const CONFIRM_INTERVAL_MS = 20_000
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000
/** 同题历史文章的排除窗口：接口返回的发布时间早于本次提交这么多就当作不是这一篇。 */
const SAME_TITLE_GRACE_MS = 6 * 3600_000

/** 本机素材图引用的地址前缀（`/api/media/asset?id=<articleId>%2F<filename>`）。 */
const ASSET_URL_PREFIX = '/api/media/asset?id='

/**
 * 站内 JSON 接口。知乎前台/创作中心的 class 名与 DOM 结构常年变动，
 * 而 api/v4 是它们自家前端在用的接口，稳定性高一个量级——所以**采集走接口，不解析页面**。
 */
const ME_API = 'https://www.zhihu.com/api/v4/me'
/**
 * 用户主页接口。**计数字段必须显式 include**——实测不带 include 时只有 26 个基础字段，
 * 粉丝/赞同/内容数一个都不返回（这条踩过坑：不带 include 会一路走到「读不到计数」的报错）。
 */
const memberApi = (token: string, include?: string[]): string => {
  const q = include && include.length > 0 ? `?include=${include.join(',')}` : ''
  return `https://www.zhihu.com/api/v4/members/${encodeURIComponent(token)}${q}`
}
/** 采集概况时要显式索取的计数。 */
const COUNTER_FIELDS = ['follower_count', 'voteup_count', 'articles_count', 'answer_count', 'thanked_count']

/** /api/v4/me 与 /api/v4/members/{token} 的字段（只声明我们用到的部分）。 */
interface ZhihuMe {
  id?: string
  url_token?: string
  name?: string
}
interface ZhihuMember {
  url_token?: string
  name?: string
  follower_count?: number
  voteup_count?: number
  articles_count?: number
  answer_count?: number
}
interface ZhihuListBody<T> {
  data?: T[]
}
/** 知乎 v4 的互动数据统一挂在 `reaction.statistics` 下（接口不返回 voteup_count / comment_count）。 */
interface ZhihuReaction {
  statistics?: { like_count?: number; favorites?: number }
}
interface ZhihuArticleItem {
  id?: string | number
  title?: string
  created?: number
  reaction?: ZhihuReaction
}

/**
 * 在**已登录的页面上下文里**发同源 fetch 取 JSON。
 *
 * 不用 `page.goto(接口URL)`：goto 到 JSON 会被 Chrome 的 JSON 查看器包成 HTML 文档，
 * 想拿原始数据还得反解析一遍；页面内 fetch 直接拿到文本，顺带自动带上 cookie 与 referer。
 */
async function zhihuApi<T>(page: Page, url: string): Promise<T> {
  const res = await page.evaluate(async (u: string) => {
    const r = await fetch(u, {
      credentials: 'include',
      // 知乎前端自己带的头；缺了容易被当爬虫 403/拦风控
      headers: { 'x-requested-with': 'fetch' },
    })
    return { status: r.status, text: await r.text() }
  }, url)
  if (res.status === 401 || res.status === 403) {
    throw new PublishError('LOGIN_EXPIRED', `知乎接口返回 ${res.status}，登录态已失效，请重新扫码`)
  }
  if (res.status !== 200) {
    throw new PublishError('DOM_CHANGED', `知乎接口返回 ${res.status}（${url}）`)
  }
  try {
    return JSON.parse(res.text) as T
  } catch {
    // 被 WAF 拦成 HTML 登录页时也是 200——报出来，别让上层把「被拦」当成「这账号没数据」
    const head = res.text.slice(0, 120).replace(/\s+/g, ' ')
    throw new PublishError('DOM_CHANGED', `知乎接口没返回 JSON（可能被风控拦了）：${head}`)
  }
}

/** 打开知乎并确认登录态（接口同样用浏览器里的 cookie，得先有正常会话）。 */
async function ensureZhihuSession(page: Page): Promise<void> {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(4000)
  const probe = await probeLogin('zhihu', page)
  if (!probe.loggedIn) {
    throw new PublishError('LOGIN_EXPIRED', `登录态失效，请重新扫码（${probe.reason}）`)
  }
}

/** 两个计数都缺 → undefined（不补 0 冒充）。 */
function sumCount(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

/** 毫秒时间戳 → `YYYY-MM-DD HH:mm`（与页面文案口径一致）。 */
function fmtTs(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 接口返回的发布时间是否是「这一次」的（排除同名历史文章）。
 * `created` 是**秒级**时间戳；字段缺省时**放行**——标题已足够特定，
 * 宁可放行也不漏检（漏检会让一次真发布被拖成「需人工」）。
 */
function freshEnough(created: number | undefined, since: number): boolean {
  if (created === undefined) return true
  return created * 1000 >= since - SAME_TITLE_GRACE_MS
}

/**
 * 点赞 / 收藏从 `reaction.statistics` 取（接口既不给 voteup_count 也不给 comment_count）。
 * 知乎公开接口没有阅读/展现口径，那两个字段留空，不补 0。
 */
function reactionOf(item: { reaction?: ZhihuReaction }): { likes?: number; collects?: number } {
  const st = item.reaction?.statistics
  return { likes: st?.like_count, collects: st?.favorites }
}

/** 专栏文章 → account_work 行（`url` 由 id 拼，接口给的是 api 地址不是网页地址）。 */
function toArticleWork(a: ZhihuArticleItem): AccountWork {
  const ts = a.created ? a.created * 1000 : undefined
  return {
    title: (a.title ?? '').trim(),
    kind: '文章',
    publishedAt: ts,
    publishedAtText: ts ? fmtTs(ts) : undefined,
    ...reactionOf(a),
    url: a.id === undefined ? undefined : `https://zhuanlan.zhihu.com/p/${a.id}`,
  }
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

/** 标题按平台上限截断，并告知是否截过。 */
function clipTitle(title: string): { text: string; clipped: boolean } {
  const chars = [...title.trim()]
  return { text: chars.slice(0, TITLE_MAX).join(''), clipped: chars.length > TITLE_MAX }
}

/**
 * 把一段 HTML 粘进 Draft.js 正文（**不能**直接写 innerHTML：React 下次渲染就把它抹了）。
 * 编辑器自己处理 paste，会转成它的 block 结构；插入点 = 当前光标，所以连续粘贴是追加。
 */
async function pasteHtml(page: Page, html: string, plain: string): Promise<void> {
  const sent = await page.evaluate(({ html, text }) => {
    const el = document.querySelector('.public-DraftEditor-content')
    if (!el) return false
    ;(el as HTMLElement).focus()
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  }, { html, text: plain })
  if (!sent) throw new PublishError('DOM_CHANGED', '知乎编辑器正文区域没出现（.public-DraftEditor-content）')
  await page.waitForTimeout(1500)
}

/**
 * 独占一行的本机图（非 http/https）——平台端打不开；**只在降级草稿包里用**：
 * 真发布时本机图由 `fillZhihuBody` 逐张上传并插回原位，不走这里。
 */
const LOCAL_IMG_LINE_RE = /^\s*!\[[^\]]*\]\((?!https?:\/\/)[^)\s]+\)\s*$/

function stripLocalImages(md: string): { md: string; dropped: number } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter(l => !LOCAL_IMG_LINE_RE.test(l))
  return { md: kept.join('\n'), dropped: lines.length - kept.length }
}

/** 编辑器内当前图片数 + 正文文字数（用来说明「到底填进去了没有」）。 */
async function readBodyStats(page: Page): Promise<{ chars: number; images: number }> {
  return page.evaluate((roots: string) => {
    const root = document.querySelector(roots) as HTMLElement | null
    if (!root) return { chars: 0, images: 0 }
    return {
      chars: (root.innerText ?? '').replace(/\s+/g, '').length,
      images: root.querySelectorAll('img').length,
    }
  }, `${EDITOR_ROOT_SEL}, ${BODY_SEL}`).catch(() => ({ chars: 0, images: 0 }))
}

/**
 * 编辑器自带的本机图片上传控件：取 accept 含 `image/*` 且不是封面那个
 * （封面 input 的 class 是 `UploadPicture-input`，accept 只有 .jpg/.jpeg/.png）。
 * 点工具栏「图片」**不会**弹 filechooser，只能直接对这个隐藏 input `setInputFiles`。
 */
async function imageInput(page: Page): Promise<Locator | null> {
  const inputs = page.locator('input[type=file]')
  const n = await inputs.count()
  for (let i = 0; i < n; i++) {
    const el = inputs.nth(i)
    const acc = (await el.getAttribute('accept').catch(() => null)) ?? ''
    const cls = (await el.getAttribute('class').catch(() => null)) ?? ''
    if (IMAGE_ACCEPT_RE.test(acc) && !COVER_INPUT_CLASS_RE.test(cls)) return el
  }
  return null
}

/**
 * 插一张本机图：塞进编辑器的图片控件 → 等它上传完（图片数 +1 且「图片上传中」消失）。
 * 失败**如实带原因**返回（不静默、不拿别的图凑），由调用方写进发布说明。
 */
async function insertImage(page: Page, filePath: string): Promise<{ ok: boolean; reason?: string }> {
  const input = await imageInput(page)
  if (!input) return { ok: false, reason: '编辑器里没找到本机图片上传控件' }
  const before = (await readBodyStats(page)).images
  try {
    await input.setInputFiles(filePath)
  } catch (err) {
    return { ok: false, reason: `把图片交给编辑器失败：${err instanceof Error ? err.message : String(err)}` }
  }
  await page.waitForTimeout(3000)
  const deadline = Date.now() + IMAGE_UPLOAD_TIMEOUT_MS
  while (Date.now() < deadline) {
    const st = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null
      return {
        images: (document.querySelector('.DraftEditor-root') as HTMLElement | null)?.querySelectorAll('img').length ?? 0,
        uploading: ((el?.innerText ?? '').includes('图片上传中')),
      }
    }, BODY_SEL).catch(() => ({ images: 0, uploading: true }))
    if (st.images > before && !st.uploading) return { ok: true }
    await page.waitForTimeout(1500)
  }
  return { ok: false, reason: `图片上传超时（${Math.round(IMAGE_UPLOAD_TIMEOUT_MS / 1000)}s 内没等到上传完成）` }
}

/** 独占一行的图片引用（`![图注](地址)`）——正文按它切段。 */
const IMG_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

/** 正文分段：图片段单独上传（控件一次只能塞一张），文本段按原顺序粘贴。 */
type BodySegment = { kind: 'text'; md: string } | { kind: 'image'; alt: string; url: string }

function splitBody(md: string): BodySegment[] {
  const segs: BodySegment[] = []
  let buf: string[] = []
  const flush = (): void => {
    if (buf.some(l => l.trim() !== '')) segs.push({ kind: 'text', md: buf.join('\n') })
    buf = []
  }
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const m = IMG_LINE_RE.exec(line.trim())
    if (m) {
      flush()
      segs.push({ kind: 'image', alt: m[1].trim(), url: m[2] })
    } else {
      buf.push(line)
    }
  }
  flush()
  return segs
}

/**
 * 把本机素材地址（`/api/media/asset?id=<articleId>%2F<filename>`）解析成本机文件路径。
 * 取不到一律**带原因** skip（gen: 占位、别的文章的素材、非本机地址、没设工作文件夹）。
 */
function resolveAssetFile(
  url: string,
  articleId: string,
  assetDir: string | undefined,
  reasons: string[],
): string | undefined {
  if (url.startsWith('gen:')) { reasons.push('有配图占位（gen:）没画成图，已跳过'); return undefined }
  if (!url.startsWith(ASSET_URL_PREFIX)) { reasons.push(`正文里有平台取不到的相对图片地址（${url}），已跳过`); return undefined }
  let idPart = ''
  try { idPart = decodeURIComponent(url.slice(ASSET_URL_PREFIX.length)) } catch { /* 拆不出来当失败 */ }
  const slash = idPart.indexOf('/')
  const ownerId = slash > 0 ? idPart.slice(0, slash) : ''
  const filename = slash > 0 ? idPart.slice(slash + 1) : ''
  if (ownerId !== articleId || filename === '') { reasons.push(`正文引用的是别的文章/取不到文件名的素材（${idPart || url}），已跳过`); return undefined }
  if (!assetDir) { reasons.push('未设置工作文件夹，读不到本机配图文件，已跳过'); return undefined }
  return nodePath.join(assetDir, filename)
}

interface ZhihuBodyResult {
  uploaded: number
  failed: number
  reasons: string[]
}

/**
 * 填正文：按「文本段 → 图片 → 文本段」逐段推进。
 * 文本段用 paste（保留结构），图片段塞进编辑器自带的上传控件（图就落在光标处，与原位置一致）。
 * 站外绝对地址（http/https）原样粘进 HTML（平台自己能取），失败/取不到的本机图如实报数。
 */
async function fillZhihuBody(
  page: Page,
  md: string,
  articleId: string,
  assetDir?: string,
): Promise<ZhihuBodyResult> {
  const reasons: string[] = []
  let uploaded = 0
  let failed = 0
  for (const seg of splitBody(md)) {
    if (seg.kind === 'text') {
      const html = mdToHtml(seg.md)
      if (html.trim() === '') continue
      await pasteHtml(page, html, seg.md.replace(/!\[[^\]]*\]\([^)\s]+\)/g, ''))
      continue
    }
    if (/^https?:\/\//i.test(seg.url)) {
      await pasteHtml(page, `<p><img src="${seg.url}" alt="${seg.alt}" /></p>`, seg.alt)
      continue
    }
    const file = resolveAssetFile(seg.url, articleId, assetDir, reasons)
    if (!file) { failed++; continue }
    const r = await insertImage(page, file)
    if (r.ok) uploaded++
    else { failed++; reasons.push(`${nodePath.basename(file)}：${r.reason ?? '未知原因'}`) }
  }
  return { uploaded, failed, reasons }
}

export const zhihuAdapter: PublishAdapter = {
  platform: 'zhihu',
  // 半自动发布（内容入编辑器、最终那一下由用户点）：与头条同一档，不是「草稿优先」
  autoPublish: true,

  async ensureLogin(account, opts: AdapterOptions, hooks?: LoginHooks) {
    hooks?.onProgress?.({ stage: 'launching', message: '正在拉起托管浏览器…' })
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      hooks?.onProgress?.({ stage: 'opened', message: '已打开知乎，请在浏览器窗口里扫码或用手机号登录', url: page.url() })
      const result = await waitForLogin('zhihu', page, LOGIN_TIMEOUT_MS, hooks)
      return { loggedIn: true, reason: result.reason }
    }, true)
  },

  async checkLogin(account, opts: AdapterOptions) {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      // 未登录会被 302 到 /signin，此时页面上没有「登录」链接，必须以 URL 为准
      return (await probeLogin('zhihu', page)).loggedIn
    })
  },

  /**
   * 采集账号概况。**纯只读**：只读 api/v4 的两个接口，不点任何按钮。
   *
   * 知乎公开接口没有「阅读量」口径，就不填 readsTotal——宁可缺字段，也不拿赞同数冒充阅读数。
   */
  async collectProfile(account, opts: AdapterOptions): Promise<AccountProfile> {
    return browserPool.withPage(account.id, opts, async (page) => {
      await ensureZhihuSession(page)
      const me = await zhihuApi<ZhihuMe>(page, ME_API)
      const token = me.url_token ?? me.id
      if (!token) {
        throw new PublishError('DOM_CHANGED', '知乎 /api/v4/me 没返回 url_token，无法继续取账号数据')
      }
      // 不带 include 的话这些计数一个都不会返回，必须显式要
      const m = await zhihuApi<ZhihuMember>(page, memberApi(String(token), COUNTER_FIELDS))
      // 四类计数一个都没读到 = 接口字段改了（账号真为 0 时接口给的是数字 0，不会走到这）
      if (m.follower_count === undefined && m.voteup_count === undefined
        && m.articles_count === undefined && m.answer_count === undefined) {
        throw new PublishError('DOM_CHANGED', '知乎账号接口没读到粉丝/赞同/内容数，接口字段可能已变更')
      }
      return {
        displayName: m.name ?? me.name,
        platformUserId: m.url_token ?? String(token),
        fansTotal: m.follower_count,
        likesTotal: m.voteup_count,
        worksCount: sumCount(m.articles_count, m.answer_count),
      }
    })
  },

  /**
   * 采集作品列表：**只取专栏文章**。
   * 回答也取得到，但知乎公开接口对回答不给任何指标（阅读/展现/评论全无），
   * 采出来只是一堆「日期 + 标题 + 空指标」的噪声行，不是用户要的东西，故不采集。
   * 只取接口首页（每页 20）——先把一页采准，再谈翻页。
   */
  async collectWorks(account, opts: AdapterOptions, limit = 50): Promise<AccountWork[]> {
    return browserPool.withPage(account.id, opts, async (page) => {
      await ensureZhihuSession(page)
      const me = await zhihuApi<ZhihuMe>(page, ME_API)
      const token = me.url_token ?? me.id
      if (!token) {
        throw new PublishError('DOM_CHANGED', '知乎 /api/v4/me 没返回 url_token，无法取作品列表')
      }
      const base = memberApi(String(token))

      const articles = await zhihuApi<ZhihuListBody<ZhihuArticleItem>>(page, `${base}/articles?limit=20&offset=0`)
      if (!Array.isArray(articles.data)) {
        throw new PublishError('DOM_CHANGED', '知乎文章接口没返回 data 数组，接口可能已变更')
      }
      const out = articles.data.filter(Boolean).map(toArticleWork).filter(w => w.title)
      // 有条目却一条标题都取不到 = 字段变了，别静默变成「这账号没作品」
      if (articles.data.length > 0 && out.length === 0) {
        throw new PublishError('DOM_CHANGED', '知乎文章接口返回了条目但都取不到标题，字段可能已变更')
      }
      // 新文章在前
      out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      return out.slice(0, limit)
    })
  },

  /**
   * 半自动发布：填题 → 逐段粘正文（本机图逐张上传、插回原位）→ 等自动保存
   * → **把窗口留给用户点「发布」**。与头条同一套红线：程序不点任何含「发布」的按钮，
   * 因此不报 success（那会把草稿/未发布当成已发布），如实在 `awaiting-manual` 停下，
   * 由 `confirmManualPublish` 在后台轮询已发布文章接口确认。
   *
   * 页面保持打开（withPage 的 keepOpen），最终那一下必须由人在浏览器里点。
   */
  async publish(job: PublishJob, opts: AdapterOptions): Promise<PublishOutcome> {
    const { account, article } = job
    const draftPackage = zhihuAdapter.draftExport(job)
    const { text: title, clipped } = clipTitle(article.title)
    const sourceMd = article.bodyMd || article.title
    // 诊断：正文到底带了几张图（「文章没插图」时靠这行定位）
    const imgRefs = (sourceMd.match(/!\[[^\]]*\]\(/g) ?? []).length
    console.info(`[media/zhihu] 编辑器正文：共 ${imgRefs} 个图片引用，逐张上传到知乎后插回原位`)

    return browserPool.withPage(account.id, opts, async (page: Page): Promise<PublishOutcome> => {
      try {
        // 1) 先落首页确认登录态（与登录流程同一套判定；编辑器页万一有「登录」字样也不会误判），
        //    再进写作中心编辑器
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(4000)
        const probe = await probeLogin('zhihu', page)
        if (!probe.loggedIn) {
          throw new PublishError('LOGIN_EXPIRED', `登录态失效，请重新扫码（${probe.reason}）`)
        }
        await page.goto(WRITE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(6000)
        if (await detectRisk(page)) {
          throw new PublishError('RISK_CONTROL', '平台要求安全验证，已暂停转人工')
        }

        // 2) 标题（平台上限 100 字）
        const titleLoc = await firstVisible(page, TITLE_SELECTORS)
        if (!titleLoc) throw new PublishError('DOM_CHANGED', '编辑器标题输入框未出现')
        await titleLoc.fill(title)
        await page.waitForTimeout(1500)

        // 3) 正文：文本段 paste（保留标题/列表/加粗），本机图逐张塞进编辑器自带上传控件
        //    插入点就是光标处 → 图落在正文原来的位置上
        const body = await fillZhihuBody(page, sourceMd, article.id, job.assetDir)
        console.info(`[media/zhihu] 正文配图：本机图上传成功 ${body.uploaded} 张，失败 ${body.failed} 张`)
        for (const r of body.reasons) console.warn(`[media/zhihu] 正文配图问题：${r}`)

        if (await detectRisk(page)) {
          throw new PublishError('RISK_CONTROL', '填正文过程中触发安全验证，转人工处理')
        }

        // 4) 等自动保存（编辑器没有「保存草稿」按钮，草稿是自动保存的）。
        //    状态条只作**证据**记进说明，不当门槛：真没保存住，用户点发布会立刻看到。
        await page.waitForTimeout(AUTOSAVE_SETTLE_MS)
        const stats = await readBodyStats(page)
        const tip = await page.locator(DRAFT_TIP_SEL).first().innerText().catch(() => '')

        const coverName = job.coverPath ? nodePath.basename(job.coverPath) : ''
        const coverInBody = coverName !== '' && sourceMd.includes(`${coverName})`)
        const notes = ['标题与正文已填入知乎编辑器，请在浏览器窗口里点「发布」完成发布']
        if (body.uploaded > 0) notes.push(`正文 ${body.uploaded} 张本机配图已上传到知乎并插回原位置`)
        if (body.failed > 0) {
          const head = body.reasons.slice(0, 3).join('；')
          notes.push(`正文 ${body.failed} 张本机配图没能上传（${head}${body.reasons.length > 3 ? ' 等' : ''}）`)
        }
        // 知乎的「文章封面」是**独立设置**（信息流展示用），实测弹层自动化不稳定，不代点；
        // 正文里那张 cover.* 会被当普通图片上传并落在原位。缺文件时如实说，不拿别的图凑。
        if (coverInBody) {
          notes.push('封面图已随正文上传并落在原位；信息流「文章封面」需在编辑器「发布设置 → 添加封面」里手动选一张')
        } else if (job.coverPath) {
          notes.push('本机有封面文件但正文里没有引用它，信息流「文章封面」需在编辑器「发布设置 → 添加封面」里手动选一张')
        } else {
          notes.push(`没有可用的本机封面文件（${job.coverMissingReason ?? '素材目录里没找到封面'}），需在编辑器里手动设置封面`)
        }
        notes.push(stats.chars === 0
          ? '注意：编辑器正文看起来是空的，请在窗口里确认内容是否填进去了'
          : `编辑器已填入正文（约 ${stats.chars} 字、${stats.images} 张图）`)
        if (tip) notes.push(`编辑器状态条：${tip.replace(/\s+/g, ' ').trim()}`)
        if (clipped) notes.push(`标题超 ${TITLE_MAX} 字已截断：${article.title} → ${title}`)
        notes.push(`程序会在后台每 ${CONFIRM_INTERVAL_MS / 1000} 秒核对一次已发布文章，确认发出后自动记录链接；${CONFIRM_TIMEOUT_MS / 60_000} 分钟内没等到就转人工回填`)
        return { state: 'awaiting-manual', expectedTitle: title, draftPackage, note: notes.join('；') }
      } catch (err) {
        // 抛错也带上降级草稿包（与头条一致：失败时用户手里得有可粘贴的东西）
        if (err instanceof PublishError && !err.draftPackage) {
          throw new PublishError(err.code, err.message, draftPackage)
        }
        throw err
      }
    }, true, true)
  },

  /**
   * 后台确认：轮询**已发布文章接口**（`api/v4/members/{token}/articles`），看《标题》是否真发出去了。
   * 走接口而不是解析创作中心 DOM：class 名常年变，接口稳定；且草稿不在这份列表里，
   * 天然不会把「刚自动保存的草稿」误判成「已发布」。
   * 检出返回 `{ url?, note? }`；超时/登录掉线/接口异常一律 null——由调用方保持「需人工」，不谎报。
   * 轮询的标签页在后台：**开标签后立刻把你原来那张换回前台，然后才导航**，
   * 用户点「发布」的视线不被打断（新标签一开就是活动标签，导航又要等几秒）。
   */
  async confirmManualPublish(account, opts, expected) {
    const context = await browserPool.contextFor(account.id, opts)
    const page = await context.newPage()
    try {
      // 先把用户的编辑器换回前台，再导航——否则这几秒里他眼前是凭空冒出的知乎首页
      await restoreUserTab(context, page, /zhihu\.com/)
      // 接口是同源 fetch，页面得先落在知乎域上
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(4000)

      const me = await zhihuApi<ZhihuMe>(page, ME_API)
      const token = me.url_token ?? me.id
      if (!token) {
        console.info('[media/zhihu] 确认轮询取不到 url_token，转人工')
        return null
      }
      const api = `${memberApi(String(token))}/articles?limit=20&offset=0`
      const deadline = Date.now() + CONFIRM_TIMEOUT_MS
      while (Date.now() < deadline) {
        try {
          const list = await zhihuApi<ZhihuListBody<ZhihuArticleItem>>(page, api)
          const hit = (list.data ?? []).find(a => (a.title ?? '').trim() === expected.title && freshEnough(a.created, expected.since))
          if (hit?.id !== undefined) {
            return { url: `https://zhuanlan.zhihu.com/p/${hit.id}`, note: `已发布文章接口检出《${expected.title}》，链接已记录` }
          }
        } catch (err) {
          // 登录态掉线：直接转人工，别再空转
          if (err instanceof PublishError && err.code === 'LOGIN_EXPIRED') {
            console.info('[media/zhihu] 确认轮询期间登录态失效，转人工')
            return null
          }
          console.info('[media/zhihu] 确认轮询取接口失败（继续等）：', err instanceof Error ? err.message : String(err))
        }
        await page.waitForTimeout(CONFIRM_INTERVAL_MS)
      }
      return null
    } catch (err) {
      console.info('[media/zhihu] 确认轮询异常，转人工:', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      await page.close().catch(() => {})
      // 轮询收尾把空闲计时交回去：用户离开后浏览器仍会自动关
      browserPool.touchIdle(account.id)
    }
  },

  draftExport(job: PublishJob) {
    const { text: title } = clipTitle(job.article.title)
    // 本机素材图（/api/media/asset?id=…）在知乎端打不开，粘贴版里整行去掉，免得贴出坏图
    const { md: bodyMd, dropped } = stripLocalImages(job.article.bodyMd || job.article.title)
    return {
      platform: 'zhihu',
      title,
      bodyMd,
      bodyHtml: mdToHtml(bodyMd),
      openUrl: WRITE_URL,
      hint: `在知乎写作中心把标题与正文（HTML）粘进去，草稿会自动保存。${dropped > 0 ? `本机配图 ${dropped} 张平台取不到，已从粘贴版里去掉，请在编辑器里手动补齐。` : ''}`,
    }
  },

  /**
   * M6：双路径抓数据。
   * 路径1（文章页）：抓阅读/点赞/评论/收藏。
   * 路径2（创作中心内容管理）：登录态进入内容管理列表，列表中每行有标题+阅读/赞同/评论。
   * 两路结果合并，字段缺失不算失败。
   */
  async fetchMetrics(account, publishUrl, opts) {
    return browserPool.withPage(account.id, opts, async (page) => {
      const result: Record<string, number | undefined> = {}

      // ---- 路径1：文章页 ----
      await page.goto(publishUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      const gone = await page.locator('body').innerText().catch(() => '')
      if (/文章不存在|已被删除|无法查看|404/.test(gone)) {
        throw new PublishError('DOM_CHANGED', '文章页不可访问（已删除或违规隐藏）')
      }
      const [reads, likes, comments, collected] = await Promise.all([
        scrapeCount(page, ['.ContentItem-time + span', '[class*="view"] .count', 'span:has-text("阅读")']),
        scrapeCount(page, ['.VoteButton--up', '.LikeButton .count', 'button[aria-label*="赞同"]']),
        scrapeCount(page, ['.ContentItem-action:has-text("评论")', '[class*="comment"] .count']),
        scrapeCount(page, ['.ContentItem-action:has-text("收藏")', '[class*="collect"] .count']),
      ])
      result.reads = reads; result.likes = likes; result.comments = comments; result.collected = collected

      // ---- 路径2：创作中心内容管理（补充/验证） ----
      try {
        await page.goto('https://www.zhihu.com/creator/contents', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(3000)
        // 创作中心列表中数字通常是每行的统计
        const manageNums = await page.locator('.ContentItem-meta .NumberBoard-item, [class*="stat"] .count, td:has-text("阅读") + td').allInnerTexts().catch(() => [] as string[])
        for (const t of manageNums) {
          const n = parseCount(t)
          if (n !== undefined && n > 0 && !result.reads) { result.reads = n; break }
        }
      } catch { /* 后台路径失败不阻塞 */ }

      return result
    })
  },
}
