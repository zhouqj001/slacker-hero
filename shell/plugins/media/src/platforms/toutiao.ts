/**
 * 今日头条 adapter：托管浏览器 → 图文编辑器 → 填题/文 → **置前交用户点「预览并发布」**
 * （半自动发布），随后在后台轮询作品管理页确认是否真发出。
 *
 * 三条实测得来的硬约束（2026-10-16 在真实账号上探过 DOM）：
 *
 * 1. **没有「写文章」入口**。后台左侧导航只有 主页/文章/视频/微头条/音频，
 *    「文章」直接就是 `/profile_v4/graphic/publish`（图文编辑器）。所以本流程
 *    **直接 goto 编辑器 URL**，不去找任何入口按钮。
 * 2. **没有「存草稿」按钮**。编辑器上明写「草稿将自动保存」，页面按钮只有
 *    `添加至合集` / `预览` / `定时发布` / `预览并发布`。所以填完等自动保存即可，
 *    最终那一下由用户在窗口里点（平台侧发布动作不由程序执行）。
 * 3. **`button:has-text("发布")` 会同时命中「预览」和「预览并发布」**，
 *    后者一点就真发出去。因此本文件任何位置都不得出现对含「发布」按钮的 click；
 *    「程序零点击 + 人工点最终按钮」从结构上排除了这个风险，不要为了「省事」改回去。
 *
 * 「已发出」的判定看**作品管理页**里的卡片（实测卡片带 `已发布` 标签、
 * 标题 `<a href>` 指向 `https://www.toutiao.com/item/<gid>/`）：标题命中且不是草稿态
 * 才算数，且会用卡片上的时间过滤掉同名历史文章——宁可转人工，也不谎报「已发布」。
 */
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { browserPool, restoreUserTab } from './browser.ts'
import { mdToHtml } from './markdown.ts'
import { probeLogin, waitForLogin, type LoginHooks } from './login.ts'
import { PublishError, type AdapterOptions, type PublishAdapter, type PublishJob, type PublishOutcome, type AccountProfile, type AccountWork } from './types.ts'
import { scrapeCount, parseCount } from './scrape.ts'
import { numNear, pageText, parseNum, parseRegions, ratio, scrapeWorkCards } from './tt-parse.ts'

const HOME_URL = 'https://mp.toutiao.com/'
/** 图文（文章）编辑器：实测后台唯一的长文发文入口。 */
const EDITOR_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish'
const CONTENT_URL = 'https://mp.toutiao.com/profile_v4/manage/content/all'
/** 账号数据页（采集用，纯只读）。 */
const FANS_URL = 'https://mp.toutiao.com/profile_v4/analysis/fans/overview'
const WORKS_URL = 'https://mp.toutiao.com/profile_v4/analysis/works-overall/all'
const INCOME_URL = 'https://mp.toutiao.com/profile_v4/analysis/income-overview'
const INFO_URL = 'https://mp.toutiao.com/profile_v4/personal/info'
const LOGIN_TIMEOUT_MS = 180_000
/** 填完正文后给头条自动保存的时间（编辑器提示「草稿将自动保存」）。 */
const AUTOSAVE_SETTLE_MS = 12_000
/** 标题框 placeholder 实测为「请输入文章标题（2～30个字）」——平台硬上限 30。 */
const TITLE_MAX = 30
/** 半自动发布：后台核对作品管理页的间隔 / 总时长。 */
const CONFIRM_INTERVAL_MS = 20_000
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000
/** 页面渲染留白：SPA 列表刷新后要等一会儿 DOM 才齐。 */
const LIST_SETTLE_MS = 5_000
/** 同题历史文章的排除窗口：卡片时间早于本次提交这么多就当作不是这一篇。 */
const SAME_TITLE_GRACE_MS = 6 * 3600_000

/** 标题输入框候选（实测第一个就命中）。 */
const TITLE_SELECTORS = [
  'textarea[placeholder*="标题"]',
  '.publish-editor-title textarea',
  'input[placeholder*="标题"]',
]
/** 正文编辑器候选（实测 `.ProseMirror` contenteditable div，无 iframe）。 */
const BODY_SELECTORS = [
  '.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"]',
]
/** 风控/异常文案。 */
const RISK_RE = /风控|安全验证|操作异常|环境异常|验证码/

async function firstVisible(page: Page, selectors: string[], timeout = 8_000) {
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
 * 本地素材图（`/api/media/asset?id=…` 这类相对路径）在头条端打不开，
 * 原样塞进草稿包只会变成坏图；这里把独占一行的本地图整行去掉，并回报去掉了几张。
 * 站外绝对 URL（http/https）保留——平台能自己取。
 *
 * 注意：**只在降级草稿包里用**。真正发布时正文的本机配图由
 * `uploadAndReplaceLocalImages` 上传到头条并把引用换回原位（见下）。
 */
const LOCAL_IMG_LINE_RE = /^\s*!\[[^\]]*\]\((?!https?:\/\/)[^)\s]+\)\s*$/

function stripLocalImages(md: string): { md: string; dropped: number } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter(l => !LOCAL_IMG_LINE_RE.test(l))
  return { md: kept.join('\n'), dropped: lines.length - kept.length }
}

/** 编辑器「展示封面」区的虚线加号（点开封面弹层）。 */
const COVER_ADD_SEL = '.article-cover-add'
/**
 * 封面弹层里那个**隐藏的** `input[type=file]`（实测父容器 class 是 `.upload-handler`）。
 * 关键：点「本地上传」**不触发** filechooser 事件，必须直接对这个 input `setInputFiles`。
 */
const COVER_FILE_SELS = [
  '.upload-handler input[type=file]',
  '.upload-handler-drag input[type=file]',
  'input[type=file][accept*="image"]',
]
/**
 * 点「确定」按钮：从后往前找（弹层主按钮在弹层尾部）。
 * **只允许点这一处**——括号里不得出现「发布」字样，避免误伤「预览并发布」。
 */
const COVER_CONFIRM_SEL = 'button:has-text("确定"), [role="button"]:has-text("确定")'
/** 上传后等平台处理（实测十几秒才显示「已上传 1 张图片…」）。 */
const COVER_UPLOAD_SETTLE_MS = 15_000

/**
 * 把本机封面图**直接上传进编辑器的「展示封面」控件**（用户指定：控件在页面里，程序就能传）。
 *
 * 实测链路（2026-10-19 在真实账号上探过）：
 *   点 `.article-cover-add` → 封面弹层（tabs 上传图片/免费正版图片/热点图库/我的素材）
 *   → 对隐藏 `input[type=file]` `setInputFiles`（POST `/spice/image` 200）
 *   → 等十几秒 → 点弹层底部「确定」→ `.article-cover-images-wrap` 出现图片、文案变「编辑 替换」。
 *
 * 失败一律**如实返回原因**（不静默、不拿别的图凑），由调用方写进发布说明交用户处理。
 * 本函数不碰任何含「发布」的按钮，`确定` 是弹层自己那一个。
 */
async function setCover(page: Page, filePath: string): Promise<{ ok: boolean; reason: string }> {
  // 每一步都打日志：这条链路只在真实发布时跑，出问题必须能从 dsh stdout 日志里定位到卡在哪一步
  const fail = (reason: string): { ok: false; reason: string } => {
    console.warn(`[media/toutiao] 封面上传失败：${reason}`)
    return { ok: false, reason }
  }
  console.info(`[media/toutiao] 开始上传封面：${filePath}`)
  // 1) 打开封面弹层
  const add = page.locator(COVER_ADD_SEL).first()
  try {
    await add.waitFor({ state: 'visible', timeout: 8_000 })
  } catch {
    return fail('编辑器没显示封面加号（当前可能是「无封面」模式），请在编辑器里手动加封面')
  }
  await add.click().catch(() => {})
  console.info('[media/toutiao] 已点开封面加号，等待弹层里的上传控件…')

  // 2) 直接对弹层里的隐藏 file input 塞文件（点「本地上传」**不会**触发 filechooser）
  let input: Locator | null = null
  for (const sel of COVER_FILE_SELS) {
    const loc = page.locator(sel).first()
    try {
      await loc.waitFor({ state: 'attached', timeout: 4000 })
      input = loc
      break
    } catch { /* 试下一个 */ }
  }
  if (!input) return fail('封面弹层里没找到上传控件，头条可能改版了，请手动上传封面')
  await input.setInputFiles(filePath)
  console.info('[media/toutiao] 已把封面文件塞进上传控件，等平台收图…')

  // 3) 等平台把图收完（不是同步的，太快点「确定」会落空）
  await page.waitForTimeout(COVER_UPLOAD_SETTLE_MS)

  // 4) 点弹层底部「确定」
  const confirmBtn = page.locator(COVER_CONFIRM_SEL).last()
  try {
    await confirmBtn.waitFor({ state: 'visible', timeout: 8_000 })
    await confirmBtn.click()
    console.info('[media/toutiao] 已点弹层的「确定」，复核封面是否生效…')
  } catch {
    return fail('封面弹层没出现「确定」按钮，请在编辑器里手动确认封面')
  }

  // 5) 复核：封面区出现图片，或文案变成「编辑 替换 预览」
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const wrap = document.querySelector('.article-cover-images-wrap')
      if (wrap && wrap.querySelector('img')) return true
      const cover = document.querySelector('.article-cover')
      return !!cover && /编辑|替换/.test((cover as HTMLElement).innerText || '')
    }).catch(() => false)
    if (ok) {
      console.info('[media/toutiao] 封面已上传并生效')
      return { ok: true, reason: '封面已上传并生效' }
    }
    await page.waitForTimeout(1000)
  }
  return fail('封面已上传但没看到生效（可能是三图模式需人工选图），请在编辑器里确认')
}

/** 正文里的图片引用：`![图注](地址)`。 */
const IMG_TOKEN_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/** 本机素材图引用的地址前缀（`/api/media/asset?id=<articleId>%2F<filename>`）。 */
const ASSET_URL_PREFIX = '/api/media/asset?id='

/**
 * 头条图片上传接口（2026-10-19 在真实账号上探明）：
 * - 走**页面内 fetch**（同源 + 自带登录 cookie），multipart 字段名是 **`image`**；
 * - 用 `imageUrl` 传二进制会 `code:1053 无效图片数据`，别改字段名；
 * - 接口 HTTP **恒 200**，判成功**只看 `code === 0`**；
 * - CDN 地址在 `data.image_url`（`data.image_uri` 是站内 uri，不是可访问的图床地址）。
 */
const IMAGE_UPLOAD_URL = 'https://mp.toutiao.com/spice/image?upload_source=20020003&aid=1231&device_platform=web'

/** `page.evaluate` 里回传的原始结果（与浏览器内返回值同构）。 */
interface InlineUploadRaw {
  status: number
  code: number | null
  imageUrl: string | null
  message: string
}

/** 头条图床接口的响应体（只取用到的三个字段）。 */
interface ImageUploadBody {
  code?: unknown
  message?: unknown
  data?: { image_url?: unknown }
}

/**
 * 把一张本机图片上传到头条图床，成功返回可对外访问的 CDN 地址。
 * 失败一律**如实带原因**（不静默、不拿别的图凑），由调用方从正文里去掉并写进说明。
 */
async function uploadInlineImage(page: Page, filePath: string): Promise<{ url?: string; reason?: string }> {
  let buf: Buffer
  try {
    buf = await readFile(filePath)
  } catch (err) {
    return { reason: `读不到本机图片：${err instanceof Error ? err.message : String(err)}` }
  }
  const ext = nodePath.extname(filePath).slice(1).toLowerCase()
  const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'image/webp'
  const raw = await page
    .evaluate(async (arg: { url: string; b64: string; mime: string; name: string }): Promise<InlineUploadRaw> => {
      const bin = atob(arg.b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const fd = new FormData()
      fd.append('image', new Blob([bytes], { type: arg.mime }), arg.name)
      let res: Response
      try {
        res = await fetch(arg.url, {
          method: 'POST',
          body: fd,
          credentials: 'include',
          headers: { 'x-requested-with': 'fetch' },
        })
      } catch (err) {
        return { status: 0, code: null, imageUrl: null, message: `请求失败：${err instanceof Error ? err.message : String(err)}` }
      }
      let body: ImageUploadBody | null = null
      try {
        body = await res.json() as ImageUploadBody
      } catch {
        return { status: res.status, code: null, imageUrl: null, message: '响应不是 JSON' }
      }
      const code = typeof body?.code === 'number' ? body.code : null
      const u = body?.data?.image_url
      const imageUrl = typeof u === 'string' && u !== '' ? u : null
      return { status: res.status, code, imageUrl, message: typeof body?.message === 'string' ? body.message : '' }
    }, { url: IMAGE_UPLOAD_URL, b64: buf.toString('base64'), mime, name: nodePath.basename(filePath) })
    .catch((err: unknown): InlineUploadRaw => (
      { status: 0, code: null, imageUrl: null, message: err instanceof Error ? err.message : String(err) }
    ))
  if (raw.code === 0 && raw.imageUrl) return { url: raw.imageUrl }
  const bits = [raw.status > 0 ? `HTTP ${raw.status}` : '无响应']
  if (raw.code !== null) bits.push(`code=${raw.code}`)
  if (raw.message) bits.push(raw.message)
  return { reason: `头条收图失败（${bits.join('，')}）` }
}

/** 正文配图处理的汇总：替换后的 markdown + 成功/失败计数 + 失败原因（写进发布说明）。 */
interface LocalImageResult {
  md: string
  uploaded: number
  failed: number
  reasons: string[]
}

/** 单个图片引用 token 的处理结果：insert=替换成什么，op 决定是否计入成功/失败。 */
type TokenOutcome = { insert: string; op: 'ok' | 'drop' }

/**
 * 处理正文里的一个图片引用（非 http/https）：
 * - 本机素材（含封面那张 `cover.*`）上传到头条 → 换成 CDN 地址、**留在原位**（`ok`）；
 *   读不到 / 传失败 → 去掉（`drop`）；
 * - 未落盘的 `gen:` 占位在编辑器里是坏图 → 去掉（`drop`）。
 *
 * 注意：`cover.*` 这里**不再特殊处理**。工作台的「编辑/预览」渲染的就是整篇 bodyMd，
 * 封面那行是正文第一张图（用户看到的就是它），所以它同样要传到头条并留在原位；
 * 「展示封面」控件由 `setCover` 另行设置一次，两条路互不影响。
 */
async function resolveImageToken(
  page: Page,
  url: string,
  alt: string,
  articleId: string,
  assetDir: string | undefined,
  reasons: string[],
): Promise<TokenOutcome> {
  const drop = (reason: string): TokenOutcome => {
    reasons.push(reason)
    console.warn(`[media/toutiao] 正文配图去掉一张：${reason}`)
    return { insert: '', op: 'drop' }
  }
  if (url.startsWith('gen:')) return drop('有配图占位（gen:）没画成图')
  if (!url.startsWith(ASSET_URL_PREFIX)) return drop(`正文里有平台取不到的相对图片地址（${url}）`)

  let idPart = ''
  try {
    idPart = decodeURIComponent(url.slice(ASSET_URL_PREFIX.length))
  } catch { /* 拆不出来当失败 */ }
  const slash = idPart.indexOf('/')
  const ownerId = slash > 0 ? idPart.slice(0, slash) : ''
  const filename = slash > 0 ? idPart.slice(slash + 1) : ''
  if (ownerId !== articleId || filename === '') {
    return drop(`正文引用的是别的文章/取不到文件名的素材（${idPart || url}）`)
  }
  if (!assetDir) return drop('未设置工作文件夹，读不到本机配图文件')

  const up = await uploadInlineImage(page, nodePath.join(assetDir, filename))
  if (up.url) return { insert: `![${alt}](${up.url})`, op: 'ok' }
  return drop(`${filename} 上传失败（${up.reason ?? '未知原因'}）`)
}

/**
 * 把正文里的**本机素材图**（含开头那张封面图）逐张上传到头条，成功则把引用换回**原位置**，
 * 只有上传失败的那些才从正文里去掉（并如实报数，让用户知道少了什么）。
 *
 * 背景（用户 2026-10-19 明确定的需求）：文章里有配图时，图要跟着正文一起进头条
 * 并落在原来的位置上，不能像以前那样整篇把本地图全丢掉。工作台的「编辑/预览」渲染的
 * 就是这篇 bodyMd，用户看到的图就是这里要传的图。
 * 平台侧收不到本机地址（`/api/media/asset?id=…`），所以只能程序代传一次换 CDN 地址。
 *
 * 不碰任何含「发布」的按钮；本函数只发图床接口请求。
 */
async function uploadAndReplaceLocalImages(
  page: Page,
  md: string,
  articleId: string,
  assetDir?: string,
): Promise<LocalImageResult> {
  const reasons: string[] = []
  let uploaded = 0
  let failed = 0
  const out: string[] = []
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const tokens = [...line.matchAll(IMG_TOKEN_RE)]
    if (tokens.length === 0) {
      out.push(line)
      continue
    }
    let rebuilt = ''
    let cursor = 0
    for (const t of tokens) {
      rebuilt += line.slice(cursor, t.index ?? 0)
      cursor = (t.index ?? 0) + t[0].length
      const alt = (t[1] ?? '').trim()
      const url = t[2] ?? ''
      // 站外绝对地址平台自己会取，原样保留
      if (/^https?:\/\//i.test(url)) {
        rebuilt += t[0]
        continue
      }
      const r = await resolveImageToken(page, url, alt, articleId, assetDir, reasons)
      if (r.op === 'ok') uploaded++
      else if (r.op === 'drop') failed++
      rebuilt += r.insert
    }
    rebuilt += line.slice(cursor)
    // 整行只剩这张图且没传上去 → 这行不留空行
    if (rebuilt.trim() !== '') out.push(rebuilt)
  }
  return { md: out.join('\n'), uploaded, failed, reasons }
}

/**
 * 作品管理页的发布时间只给 `MM-DD HH:mm`（跨年文章会算错，标出来而不是装作准）。
 * 带年份的 `YYYY-MM-DD HH:mm` 按原样解析。
 */
function ttTimeToTs(text: string | undefined): number | undefined {
  if (!text) return undefined
  const full = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(text)
  if (full) return new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5]).getTime()
  const short = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/.exec(text)
  if (!short) return undefined
  // 按当前年份补；补出来的月日比现在晚 = 去年发的，回退一年
  const now = new Date()
  let t = new Date(now.getFullYear(), +short[1] - 1, +short[2], +short[3], +short[4]).getTime()
  if (t > now.getTime() + 86_400_000) t = new Date(now.getFullYear() - 1, +short[1] - 1, +short[2], +short[3], +short[4]).getTime()
  return t
}

/**
 * 在作品管理页里找「标题命中且**已经离开草稿态**」的卡片（单次核查，不做等待）。
 *
 * 三道判定，缺一不可：
 * 1. 卡片文案必须包含标题（我们填进去的就是截断后的标题，平台列表显示同一串）；
 * 2. 卡片必须带 `已发布/已推送/审核中` 之一，且不带 `草稿/未通过/已删除/仅我可见`
 *    —— 这条是防「把刚自动保存的草稿误判成已发出」；
 * 3. 卡片时间（`MM-DD HH:mm`）不得早于本次提交 6 小时以上 —— 防同名历史文章。
 *
 * 返回链接取标题 `<a href>`（实测 `https://www.toutiao.com/item/<gid>/`）；
 * 取不到就留空，不拿别的东西凑。时间解析不出时**放行**（宁可放行也不漏检），
 * 因为标题+状态两道已经足够严。
 */
async function findPublishedWork(
  page: Page,
  expected: { title: string; since: number },
): Promise<{ url?: string; note?: string } | null> {
  const hit = await page.evaluate(({ title }) => {
    const SEL = '[class*="content-item"], [class*="work-item"], [class*="card"]'
    const all = ([...document.querySelectorAll(SEL)] as HTMLElement[]).filter(el => (el.innerText || '').includes(title))
    // 只留最内层：外层会把多篇文案拼一起，标题会串台
    const leaf = all.filter(el => !all.some(other => other !== el && el.contains(other)))
    for (const el of leaf) {
      const text = (el.innerText || '').replace(/\s+/g, ' ')
      if (!/已发布|已推送|审核中|待审核/.test(text)) continue
      if (/草稿|未通过|已删除|仅我可见/.test(text)) continue
      const timeM = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})|(\d{2}-\d{2}\s+\d{2}:\d{2})/.exec(text)
      const a = el.querySelector('a[href*="/item/"]')
      return { text, timeText: timeM ? (timeM[1] ?? timeM[2]) : undefined, href: a?.getAttribute('href') ?? undefined }
    }
    return null
  }, { title: expected.title }).catch(() => null)
  if (!hit) return null

  const ts = ttTimeToTs(hit.timeText)
  if (ts !== undefined && ts < expected.since - SAME_TITLE_GRACE_MS) return null

  let url: string | undefined
  if (hit.href) {
    try {
      const u = new URL(hit.href, 'https://mp.toutiao.com')
      u.search = ''
      u.hash = ''
      url = u.toString()
    } catch { /* 链接畸形就留空 */ }
  }
  const status = /审核中|待审核/.test(hit.text) ? '审核中' : '已发布'
  return {
    url,
    note: `作品管理页已检出《${expected.title}》，状态 ${status}${hit.timeText ? `（平台显示 ${hit.timeText}）` : ''}`,
  }
}

export const toutiaoAdapter: PublishAdapter = {
  platform: 'toutiao',

  async ensureLogin(account, opts: AdapterOptions, hooks?: LoginHooks) {
    hooks?.onProgress?.({ stage: 'launching', message: '正在拉起托管浏览器…' })
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      hooks?.onProgress?.({ stage: 'opened', message: '已打开头条号后台，请在浏览器窗口里扫码登录', url: page.url() })
      const result = await waitForLogin('toutiao', page, LOGIN_TIMEOUT_MS, hooks)
      return { loggedIn: true, reason: result.reason }
    }, true)
  },

  async checkLogin(account, opts: AdapterOptions) {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      return (await probeLogin('toutiao', page)).loggedIn
    })
  },

  /**
   * 采集账号概况。**纯只读**：只 goto 五个数据页取文案，不点任何按钮。
   * 头条后台是 SPA 且 class 带 hash 会变，所以按「文案标签 + 附近数字」取值，
   * 取不到就留空——宁可少字段，也不编一个 0 上去。
   */
  async collectProfile(account, opts: AdapterOptions): Promise<AccountProfile> {
    return browserPool.withPage(account.id, opts, async (page) => {
      const warnings: string[] = []
      const visit = async (url: string): Promise<string> => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(5000)
        // 任何一页被重定向到登录页，都别把登录页文案当数据解析
        if (/\/auth\/page\/login|\/login/i.test(page.url())) {
          throw new PublishError('LOGIN_EXPIRED', '登录态失效，请重新扫码')
        }
        const text = await pageText(page)
        if (/风控|安全验证|操作异常|环境异常/.test(text.slice(0, 2000))) {
          warnings.push(`页面出现风控提示：${url}`)
        }
        return text
      }

      // ---- 首页：账号名 + 粉丝/阅读/收益三张总览卡 ----
      const home = await visit('https://mp.toutiao.com/profile_v4/index')
      const fansTotal = numNear(home, ['粉丝数', '昨日粉丝总数'])
      const readsTotal = numNear(home, ['总阅读(播放)量', '总阅读量'])
      const incomeTotal = numNear(home, ['累计收益'])

      // 账号名/信用分/认证状态只在**用户下拉菜单**里，那是隐藏节点，
      // body.innerText 读不到，得单独去问那几个元素。
      const headerText = await page.locator('[class*="user"], [class*="avatar"], [class*="account"]')
        .evaluateAll(els => els
          .map(e => ((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim())
          .filter(t => t && t.length < 160)
          .find(t => /成长|信用分|你好|问候/.test(t)) ?? '')
      // 文案形如「下午好，爱分享工坊查看成长权益信用分100分头条认证未认证…」
      const nameM = /(?:上午|下午|晚上|凌晨)?好[，,]?\s*(.{2,20}?)\s*查看成长/.exec(headerText)
      const displayName = nameM?.[1]
      const creditScore = numNear(headerText, ['信用分'])
      const certifyM = /头条认证\s*(未认证|已认证|[一-龥]{2,10}认证)/.exec(headerText)

      // ---- 粉丝页：昨日涨跌 / 活跃 / 地域 ----
      const fans = await visit(FANS_URL)
      const fansRegions = parseRegions(fans)
      const fansActiveRatio = ratio(
        /昨日活跃粉丝占比\s*([\d.]+%)/.exec(fans)?.[1],
      )

      // ---- 作品页：昨日展现/阅读/点赞/评论 ----
      const works = await visit(WORKS_URL)

      // ---- 收益页：昨日/近30日/本月/累计/可提现 ----
      const income = await visit(INCOME_URL)
      const withdrawM = /可提现金额\s*([\d.,]+)\s*元/.exec(income)

      // ---- 账号设置：头条号ID / 运营人 / 安全评分 ----
      const info = await visit(INFO_URL)
      const uidM = /头条号ID\s*(\d+)/.exec(info)
      // 实际文案：「运营人 周** (3*****7) 联系邮箱 无 …」——下一段可能隔了 60+ 字
      const opM = /运营人\s*(.{0,24}?)\s*联系邮箱/.exec(info)
      const securityScore = numNear(info, ['安全评分'])
      // 平台自己说的风险提示，收进 warnings，别自己下判断。
      // 只取「有风险 + 待优化项数」这个事实，后面那串待办清单（改密码/绑手机…）
      // 让用户自己去后台「安全中心」看，硬抄进来只会变成一大坨噪音。
      const riskM = /你的账号存在安全风险[，,]\s*建议优化以下\s*(\d+)\s*项/.exec(info)
      if (riskM) warnings.push(`你的账号存在安全风险，建议优化 ${riskM[1]} 项（详见后台「安全中心」）`)

      const profile: AccountProfile = {
        displayName,
        platformUserId: uidM?.[1],
        operator: opM?.[1]?.trim(),
        fansTotal,
        fansGainedYesterday: numNear(fans, ['涨粉数']),
        fansLostYesterday: numNear(fans, ['掉粉数']),
        fansActiveYesterday: numNear(fans, ['昨日活跃粉丝数']),
        fansActiveRatio,
        fansRegions: fansRegions.length > 0 ? fansRegions : undefined,
        readsTotal,
        readsYesterday: numNear(works, ['昨日阅读(播放)量']),
        showsYesterday: numNear(works, ['昨日展现量']),
        likesYesterday: numNear(works, ['昨日点赞量']),
        commentsYesterday: numNear(works, ['昨日评论量']),
        incomeYesterday: numNear(income, ['昨日收益']),
        income30d: numNear(income, ['近30日']),
        incomeMonth: numNear(income, ['本月收益']),
        incomeTotal,
        withdrawable: parseNum(withdrawM?.[1]),
        creditScore,
        securityScore,
        certifyStatus: certifyM?.[1],
        warnings: warnings.length > 0 ? warnings : undefined,
      }
      // 一个数都没读到 = 页面结构变了，别返回一堆 undefined 让上层以为「账号就是零」
      const got = Object.values(profile).filter(v => v !== undefined).length
      if (got === 0) {
        throw new PublishError('DOM_CHANGED', '头条后台五个数据页都没读到可用数字，可能改版了')
      }
      return profile
    })
  },

  /**
   * 采集作品列表。只读：打开作品管理首页读卡片，不翻页。
   * @param limit 目前只取首页（后台默认每页 10 条）；翻页前先确认第一页解析正确。
   */
  async collectWorks(account, opts: AdapterOptions, limit = 50): Promise<AccountWork[]> {
    return browserPool.withPage(account.id, opts, async (page) => {
      await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(6000)
      if (/\/auth\/page\/login|\/login/i.test(page.url())) {
        throw new PublishError('LOGIN_EXPIRED', '登录态失效，请重新扫码')
      }
      const raw = await scrapeWorkCards(page)
      if (raw.length === 0) {
        throw new PublishError('DOM_CHANGED', '作品管理页没解析出任何作品卡片，可能改版了')
      }
      return raw.slice(0, limit).map((w) => ({
        title: w.title,
        kind: w.kind,
        publishedAt: ttTimeToTs(w.publishedAtText),
        publishedAtText: w.publishedAtText,
        shows: w.shows,
        reads: w.reads,
        likes: w.likes,
        comments: w.comments,
        collects: w.collects,
        url: w.url ? new URL(w.url, 'https://mp.toutiao.com').toString() : undefined,
      }))
    })
  },

  /**
   * 半自动发布：填题 → 填文 → 等自动保存 → **把窗口留给用户点「预览并发布」**。
   *
   * 与旧实现的区别：不再跳去草稿箱核对（一跳走，编辑器里填好的内容就从用户眼前消失了），
   * 也**不再报 success**——那是把草稿当发布，会让计划被误标成「已发布」。
   * 现在如实在 `awaiting-manual` 上停下，由 `confirmManualPublish` 在后台轮询确认。
   * 页面保持打开（withPage 的 keepOpen），因为最终那一下必须由人在浏览器里点。
   */
  async publish(job: PublishJob, opts: AdapterOptions): Promise<PublishOutcome> {
    const { account, article } = job
    const draftPackage = toutiaoAdapter.draftExport(job)
    const { text: title, clipped } = clipTitle(article.title)
    const sourceMd = article.bodyMd || article.title
    // 诊断：正文到底带了几张图（「文章没插图」时靠这行定位）
    const imgRefs = (sourceMd.match(/!\[[^\]]*\]\(/g) ?? []).length
    console.info(`[media/toutiao] 编辑器正文：素材里共 ${imgRefs} 个图片引用，逐张上传到头条后插回原位`)

    return browserPool.withPage(account.id, opts, async (page: Page): Promise<PublishOutcome> => {
      // 1) 直接进图文编辑器（没有「写文章」入口可点）
      await page.goto(EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(5000)
      // 与登录态探测同一套判定：认不出后台页面就当登录态失效，不猜。
      const probe = await probeLogin('toutiao', page)
      if (!probe.loggedIn) {
        throw new PublishError('LOGIN_EXPIRED', `登录态失效，请重新扫码（${probe.reason}）`, draftPackage)
      }
      if (await detectRisk(page)) {
        throw new PublishError('RISK_CONTROL', '平台要求安全验证，已暂停转人工', draftPackage)
      }

      // 2) 标题（平台上限 30 字）
      const titleLoc = await firstVisible(page, TITLE_SELECTORS)
      if (!titleLoc) throw new PublishError('DOM_CHANGED', '编辑器标题输入框未出现', draftPackage)
      await titleLoc.fill(title)

      // 3) 正文配图：本机素材图（`/api/media/asset?id=…`）头条取不到，程序先逐张传上图床、
      //    把引用换成 CDN 地址——这样图会留在正文原来的位置上，而不是被整篇丢掉。
      //    只有上传失败的才去掉并如实报数（见 uploadAndReplaceLocalImages）。
      const img = await uploadAndReplaceLocalImages(page, sourceMd, article.id, job.assetDir)
      console.info(`[media/toutiao] 正文配图：本机图上传成功 ${img.uploaded} 张，失败 ${img.failed} 张`)
      for (const r of img.reasons) console.warn(`[media/toutiao] 正文配图问题：${r}`)

      // 4) 正文（ProseMirror contenteditable，无 iframe）
      await page.waitForTimeout(2000)
      const bodyLoc = await firstVisible(page, BODY_SELECTORS)
      if (!bodyLoc) throw new PublishError('DOM_CHANGED', '编辑器正文区域未出现', draftPackage)
      await bodyLoc.evaluate((el, value) => {
        el.innerHTML = value
        // ProseMirror 靠 input 事件收敛 state；补 change/blur 兜住只监听部分事件的实现
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('blur', { bubbles: true }))
      }, mdToHtml(img.md))

      // 5) 封面：程序直接把本机封面图上传进编辑器的「展示封面」控件
      //    （本地素材路径平台取不到，封面只能由程序代传一次；上传失败如实记录交人工）
      let coverNote: string
      if (job.coverPath) {
        const cover = await setCover(page, job.coverPath)
        coverNote = cover.ok
          ? '封面已由程序上传进编辑器「展示封面」'
          : `封面自动上传没成功（${cover.reason}）`
      } else {
        coverNote = `没有可用的本机封面文件（${job.coverMissingReason ?? '素材目录里没找到封面'}），需在编辑器里手动选一张`
        console.warn(`[media/toutiao] 跳过封面上传：${coverNote}`)
      }

      // 6) 等自动保存（编辑器上没有保存按钮）。保存状态只作**证据**记进说明，不当门槛：
      //    真没保存住，用户在窗口里点发布会立刻看到，比我们在后台猜更准。
      await page.waitForTimeout(AUTOSAVE_SETTLE_MS)
      if (await detectRisk(page)) {
        throw new PublishError('RISK_CONTROL', '保存过程中触发安全验证，转人工处理', draftPackage)
      }
      const editorText = await page.locator('body').innerText().catch(() => '')
      const saveM = /(草稿保存中[^\n]{0,12}|草稿已保存[^\n]{0,12}|已保存)/.exec(editorText)

      const notes = ['标题与正文已填入头条编辑器，请在浏览器窗口里点「预览并发布」完成发布']
      notes.push(coverNote)
      if (img.uploaded > 0) notes.push(`正文 ${img.uploaded} 张本机配图已上传到头条并插回原位置`)
      if (img.failed > 0) {
        const head = img.reasons.slice(0, 3).join('；')
        notes.push(`正文 ${img.failed} 张本机配图没能上传到头条，已从编辑器版里去掉${head ? `（${head}${img.reasons.length > 3 ? ' 等' : ''}）` : ''}`)
      }
      if (saveM) notes.push(`编辑器当前提示：${saveM[1].trim()}`)
      if (clipped) notes.push(`标题超 ${TITLE_MAX} 字已截断：${article.title} → ${title}`)
      notes.push(`程序会在后台每 ${CONFIRM_INTERVAL_MS / 1000} 秒核对一次作品管理页，确认发出后自动记录链接；${CONFIRM_TIMEOUT_MS / 60_000} 分钟内没等到就转人工回填`)
      return { state: 'awaiting-manual', expectedTitle: title, draftPackage, note: notes.join('；') }
    }, true, true)
  },

  /**
   * 后台确认：轮询作品管理页，看《标题》是否真的发出去了。
   * 检出返回 `{ url?, note? }`（链接尽力而为，取不到就不编）；超时/未检出返回 null。
   * 轮询的标签页在后台，每轮只 reload——**开标签后立刻把你原来那张换回前台，然后才导航**，
   * 不抢用户焦点。
   */
  async confirmManualPublish(account, opts, expected) {
    const context = await browserPool.contextFor(account.id, opts)
    const page = await context.newPage()
    try {
      // 先把用户的编辑器换回前台，再导航——新标签一开就是活动标签，导航期间会一直占着视线
      await restoreUserTab(context, page, /toutiao\.com/)
      await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })

      const deadline = Date.now() + CONFIRM_TIMEOUT_MS
      await page.waitForTimeout(LIST_SETTLE_MS)
      let hit = await findPublishedWork(page, expected)
      while (!hit && Date.now() < deadline) {
        if (/\/auth\/page\/login|\/login/i.test(page.url())) {
          console.info('[media/toutiao] 确认轮询期间登录态失效，转人工')
          return null
        }
        await page.waitForTimeout(CONFIRM_INTERVAL_MS)
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        await page.waitForTimeout(LIST_SETTLE_MS)
        hit = await findPublishedWork(page, expected)
      }
      return hit
    } catch (err) {
      console.info('[media/toutiao] 确认轮询异常，转人工:', err instanceof Error ? err.message : String(err))
      return null
    } finally {
      await page.close().catch(() => {})
      // 轮询收尾把空闲计时交回去：用户离开后浏览器仍会自动关
      browserPool.touchIdle(account.id)
    }
  },

  draftExport(job: PublishJob) {
    const { text: title } = clipTitle(job.article.title)
    // 本地素材图（/api/media/asset?id=…）在平台端打不开，草稿包同样不带上，免得贴出坏图
    const { md: bodyMd } = stripLocalImages(job.article.bodyMd || job.article.title)
    return {
      platform: 'toutiao',
      title,
      bodyMd,
      bodyHtml: mdToHtml(bodyMd),
      openUrl: EDITOR_URL,
      hint: '打开「文章」即图文编辑器；页面没有存草稿按钮，草稿靠自动保存。本地素材图平台取不到，粘贴前请先在编辑器里补齐图片/封面。',
    }
  },

  /**
   * M6：双路径抓数据。
   * 路径1（文章页）：抓阅读/点赞/评论。
   * 路径2（头条后台内容管理）：登录态进入内容管理列表，列表中每行有标题+阅读/评论/互动。
   * 两路结果合并，字段缺失不算失败。
   */
  async fetchMetrics(account, publishUrl, opts) {
    return browserPool.withPage(account.id, opts, async (page) => {
      const result: Record<string, number | undefined> = {}

      // ---- 路径1：文章页 ----
      await page.goto(publishUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3000)
      const gone = await page.locator('body').innerText().catch(() => '')
      if (/内容不存在|已被删除|无法查看/.test(gone)) {
        throw new PublishError('DOM_CHANGED', '文章页不可访问（已删除或违规隐藏）')
      }
      const [reads, likes, comments] = await Promise.all([
        scrapeCount(page, ['.read-count', '[class*="read"] .count', 'span:has-text("阅读") + span']),
        scrapeCount(page, ['.like-count', '[class*="digg"] .count', 'span:has-text("赞") + span']),
        scrapeCount(page, ['.comment-count', '[class*="comment"] .count', 'span:has-text("评论") + span']),
      ])
      result.reads = reads; result.likes = likes; result.comments = comments

      // ---- 路径2：头条后台内容管理（补充/验证）----
      try {
        await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(3000)
        // 内容管理列表中数字通常是每行的统计（无法精确匹配标题，取列表中首个有数字的行做补充）
        // 如果能看到“阅读”标签和对应数字
        const manageNums = await page.locator('.text\:has-text("阅读") + .number, [class*="read"] .number, td:has-text("阅读") + td').allInnerTexts().catch(() => [] as string[])
        for (const t of manageNums) {
          const n = parseCount(t)
          if (n !== undefined && n > 0 && !result.reads) { result.reads = n; break }
        }
      } catch { /* 后台路径失败不阻塞 */ }

      return result
    })
  },
}
