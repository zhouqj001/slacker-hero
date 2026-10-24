/**
 * 番茄小说作者后台接口封装（plan §5.3）：登录后的 writer 页面上下文里
 * 执行 page.evaluate(fetch)——Cookie 自动携带，CSRF 从 cookie/meta 提取
 * （拿不到不带头，提交失败 fail-closed）。
 *
 * 接口字段按社区验证链路（tomato-writer-mcp）预填，首次真实登录后逐字段
 * 实测校准；所有结构解析 fail-closed：非 200 / 非 JSON / code≠0 / 核心字段
 * 缺失 → PublishError('DOM_CHANGED') 并附原文片段，方便用户回报校准。
 */
import type { Page } from 'playwright-core'
import type { WriterConfig } from '../config.ts'

/** 作家专区入口（登录后落地工作台；API 与其同域）。 */
export const FANQIE_HOME = 'https://fanqienovel.com/writer/zone/'

/** 登录/通行证类 URL 特征（命中 = 未登录）。 */
const LOGIN_HINT_RE = /login|passport|sso/i

/** 平台公共参数（社区链路口径）。 */
const AID = '2503'
const APP_NAME = 'muye_novel'

/** 平台侧失败错误码。NETWORK = 打不开页面；LOGIN_EXPIRED = 登录态失效；DOM_CHANGED = 结构变更。 */
export type FanqieErrorCode = 'NETWORK' | 'LOGIN_EXPIRED' | 'DOM_CHANGED'

export class PublishError extends Error {
  constructor(
    readonly code: FanqieErrorCode,
    message: string,
    /** 原文片段（DOM_CHANGED 时给用户/日志用于校准）。 */
    readonly snippet?: string,
  ) {
    super(message)
    this.name = 'PublishError'
  }
}

/** 判定一个错误是否「登录态失效」（api 层据此写回账号状态）。 */
export function isLoginExpired(err: unknown): err is PublishError {
  return err instanceof PublishError && err.code === 'LOGIN_EXPIRED'
}

/** 浏览器启动参数（登录流程强制 headless:false，发布跟随配置）。 */
export function browserOpts(config: WriterConfig, headless?: boolean): { channel: string; headless: boolean } {
  return { channel: config.publish.browserChannel, headless: headless ?? config.publish.headless }
}

/**
 * 导航到作者后台并快速判定登录态（URL 重定向到登录页 → LOGIN_EXPIRED）。
 * 发布/检测类流程的统一前置。
 */
export async function gotoWriterHome(page: Page): Promise<void> {
  try {
    await page.goto(new URL('home', FANQIE_HOME).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
    throw new PublishError('NETWORK', `打不开番茄作者后台：${msg}`)
  }
  if (LOGIN_HINT_RE.test(page.url())) {
    throw new PublishError('LOGIN_EXPIRED', '登录态已失效，请重新扫码登录')
  }
}

// ------------------------------------------------------------------
// 页面内同源 fetch
// ------------------------------------------------------------------

interface RawApiResult {
  status: number
  /** 截断后的响应原文（外层解析与 fail-closed 片段用）。 */
  text: string
}

/**
 * 在页面上下文里发起同源 fetch。只回传 status + 文本，JSON 解析放外层
 * （fail-closed 判定与错误片段都在 Node 侧，便于统一报错）。
 */
async function fanqieApi<T>(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const raw = await page.evaluate(async (args: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<RawApiResult> => {
    try {
      const url = new URL(args.path, location.origin)
      url.searchParams.set('aid', '2503')
      url.searchParams.set('app_name', 'muye_novel')
      const headers: Record<string, string> = {}
      if (args.method === 'POST') headers['content-type'] = 'application/json'
      // CSRF：番茄风控 token（社区链路字段 X-Secsdk-Csrf-Token）。
      // 优先 cookie，其次 meta；都拿不到就不带头——风控拒绝时按 fail-closed 报错。
      const m = document.cookie.match(/X-Secsdk-Csrf-Token=([^;]+)/)
      if (m?.[1]) {
        headers['x-secsdk-csrf-token'] = decodeURIComponent(m[1])
      } else {
        const meta = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]')?.getAttribute('content')
        if (meta) headers['x-secsdk-csrf-token'] = meta
      }
      const res = await fetch(url.toString(), {
        method: args.method,
        headers,
        credentials: 'include',
        body: args.method === 'POST' && args.body != null ? JSON.stringify(args.body) : undefined,
      })
      return { status: res.status, text: (await res.text()).slice(0, 4000) }
    } catch (err) {
      return { status: -1, text: err instanceof Error ? err.message : String(err) }
    }
  }, { method, path, body })

  if (raw.status === -1) throw new PublishError('NETWORK', `页面内请求失败：${raw.text.slice(0, 200)}`)
  if (raw.status === 401 || raw.status === 403) {
    throw new PublishError('LOGIN_EXPIRED', `番茄要求重新登录（HTTP ${raw.status}）`, raw.text.slice(0, 300))
  }
  if (raw.status !== 200) {
    // 非 JSON 大概率是登录页 HTML
    if (/<html[\s>]/i.test(raw.text)) {
      throw new PublishError('LOGIN_EXPIRED', '接口返回登录页，登录态已失效')
    }
    throw new PublishError('DOM_CHANGED', `接口 HTTP ${raw.status}`, raw.text.slice(0, 300))
  }
  let parsed: { code?: unknown; message?: unknown; msg?: unknown; data?: unknown }
  try {
    parsed = JSON.parse(raw.text) as typeof parsed
  } catch {
    if (/<html[\s>]/i.test(raw.text)) {
      throw new PublishError('LOGIN_EXPIRED', '接口返回登录页，登录态已失效')
    }
    throw new PublishError('DOM_CHANGED', '接口返回非 JSON', raw.text.slice(0, 300))
  }
  if (parsed.code !== 0) {
    const msg = typeof parsed.message === 'string' ? parsed.message
      : typeof parsed.msg === 'string' ? parsed.msg : ''
    if (msg && /登录|login/i.test(msg)) {
      throw new PublishError('LOGIN_EXPIRED', `番茄要求重新登录：${msg}`)
    }
    throw new PublishError('DOM_CHANGED', `接口 code=${String(parsed.code)}${msg ? `（${msg}）` : ''}`, raw.text.slice(0, 300))
  }
  return parsed.data as T
}

/** 结构报错时的原文片段（data 序列化失败兜底空串）。 */
function snippetOf(data: unknown): string {
  try {
    return JSON.stringify(data)?.slice(0, 300) ?? ''
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------
// 业务接口（字段预填，登录后校准）
// ------------------------------------------------------------------

/** 平台书单条目（绑定 book ↔ fanqieBookId 用）。 */
export interface FanqieBook {
  bookId: string
  name: string
  wordNumber: number
  category: string
}

/** 书单：GET /api/author/book/book_list/v0。 */
export async function fetchBookList(page: Page): Promise<FanqieBook[]> {
  const data = await fanqieApi<Record<string, unknown>>(
    page, 'GET',
    '/api/author/book/book_list/v0?page_count=50&page_index=0&language_type=0',
  )
  const list = (data as { book_list?: unknown; books?: unknown }).book_list
    ?? (data as { books?: unknown }).books
  if (!Array.isArray(list)) {
    throw new PublishError('DOM_CHANGED', '书单结构变化（book_list 非数组）', snippetOf(data))
  }
  return list
    .map((raw): FanqieBook => {
      const r = raw as Record<string, unknown>
      return {
        bookId: String(r['book_id'] ?? ''),
        name: String(r['book_name'] ?? r['name'] ?? ''),
        wordNumber: Number(r['word_number'] ?? 0) || 0,
        category: String(r['category'] ?? r['category_name'] ?? ''),
      }
    })
    .filter(b => b.bookId !== '')
}

/** 平台分卷。 */
export interface FanqieVolume {
  volumeId: string
  title: string
  order: number
}

/** 分卷列表：GET /api/author/volume/volume_list/v1。 */
export async function fetchVolumes(page: Page, bookId: string): Promise<FanqieVolume[]> {
  const data = await fanqieApi<Record<string, unknown>>(
    page, 'GET',
    `/api/author/volume/volume_list/v1?book_id=${encodeURIComponent(bookId)}`,
  )
  const list = (data as { volume_list?: unknown; volumes?: unknown }).volume_list
    ?? (data as { volumes?: unknown }).volumes
  if (!Array.isArray(list)) {
    throw new PublishError('DOM_CHANGED', '分卷结构变化（volume_list 非数组）', snippetOf(data))
  }
  return list
    .map((raw): FanqieVolume => {
      const r = raw as Record<string, unknown>
      return {
        volumeId: String(r['volume_id'] ?? ''),
        title: String(r['volume_name'] ?? r['title'] ?? ''),
        order: Number(r['order'] ?? r['index'] ?? 0) || 0,
      }
    })
    .filter(v => v.volumeId !== '')
}

/** 平台章节条目（状态对账用）。 */
export interface FanqieChapter {
  itemId: string
  title: string
  volumeId: string
  words: number
}

/** 章节列表：GET /api/author/chapter/chapter_list/v1（对账/状态回查）。 */
export async function fetchChapterList(page: Page, bookId: string): Promise<FanqieChapter[]> {
  const data = await fanqieApi<Record<string, unknown>>(
    page, 'GET',
    `/api/author/chapter/chapter_list/v1?book_id=${encodeURIComponent(bookId)}`,
  )
  const list = (data as { chapter_list?: unknown; chapters?: unknown }).chapter_list
    ?? (data as { chapters?: unknown }).chapters
  if (!Array.isArray(list)) {
    throw new PublishError('DOM_CHANGED', '章节列表结构变化（chapter_list 非数组）', snippetOf(data))
  }
  return list
    .map((raw): FanqieChapter => {
      const r = raw as Record<string, unknown>
      return {
        itemId: String(r['item_id'] ?? r['chapter_id'] ?? ''),
        title: String(r['title'] ?? r['chapter_name'] ?? ''),
        volumeId: String(r['volume_id'] ?? ''),
        words: Number(r['word_number'] ?? r['words'] ?? 0) || 0,
      }
    })
    .filter(c => c.itemId !== '')
}

/** 建稿产物：item_id + 分卷（重试复用，不留空草稿排）。 */
export interface CreatedDraft {
  itemId: string
  volumeId: string
}

/**
 * 建稿：POST /api/author/article/new_article/v0 → item_id。
 * volumeId 缺省时取该书第一个分卷（「item_id + 默认分卷」口径）。
 */
export async function createArticle(page: Page, bookId: string, volumeId?: string): Promise<CreatedDraft> {
  const data = await fanqieApi<Record<string, unknown>>(
    page, 'POST', '/api/author/article/new_article/v0',
    volumeId ? { book_id: bookId, volume_id: volumeId } : { book_id: bookId },
  )
  const itemId = String((data as { item_id?: unknown })['item_id'] ?? '')
  if (itemId === '') {
    throw new PublishError('DOM_CHANGED', '建稿响应缺少 item_id', snippetOf(data))
  }
  let vol = String((data as { volume_id?: unknown })['volume_id'] ?? volumeId ?? '')
  if (vol === '') {
    const volumes = await fetchVolumes(page, bookId)
    vol = volumes[0]?.volumeId ?? ''
    if (vol === '') throw new PublishError('DOM_CHANGED', '作品没有可用分卷')
  }
  return { itemId, volumeId: vol }
}

/** 提交参数。一期 mode 只有 draft（存草稿箱）/ now（立即发布）。 */
export interface PublishInput {
  itemId: string
  volumeId: string
  no: number
  title: string
  content: string
  mode: 'draft' | 'now'
}

/**
 * 提交发布：POST /api/author/publish_article/v0。
 * timer_status=0 + publish_status=0 → 存草稿箱；publish_status=1 → 立即发布。
 */
export async function publishArticle(page: Page, input: PublishInput): Promise<void> {
  await fanqieApi<unknown>(
    page, 'POST', '/api/author/publish_article/v0',
    {
      item_id: input.itemId,
      volume_id: input.volumeId,
      title: chapterTitle(input.no, input.title),
      content: normalizeContent(input.content),
      timer_status: 0,
      publish_status: input.mode === 'now' ? 1 : 0,
    },
  )
}

/**
 * 章标题：平台口径「第X章 标题」（5–30 字），超长截断。
 */
export function chapterTitle(no: number, title: string): string {
  const full = `第${no}章 ${title.trim()}`
  return [...full].length > 30 ? [...full].slice(0, 30).join('') : full
}

/**
 * 提交前本地规范化（plan §5.3）：去 Markdown 语法、统一换行、去首尾空白。
 * 保守处理：只清理明确属于 Markdown 的痕迹，不动正文文字。
 */
export function normalizeContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line
      .replace(/^\s*[#>]+ ?/, '') // 标题/引用行首标记
      .replace(/\*\*([^*]*)\*\*/g, '$1') // 加粗
      .replace(/`([^`]*)`/g, '$1') // 行内代码
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接留文字
      .trimEnd())
    .join('\n')
    .trim()
}

// ------------------------------------------------------------------
// 登录态检测
// ------------------------------------------------------------------

/** 快速静默检测：进 home（URL 判定）→ 书单接口验证。返回是否已登录。 */
export async function probeLogin(page: Page): Promise<{ ok: boolean; fanqieUserId?: string }> {
  await gotoWriterHome(page)
  await fetchBookList(page) // LOGIN_EXPIRED / DOM_CHANGED 原样抛出
  return { ok: true, fanqieUserId: await probeUserId(page) }
}

/** 尝试读平台侧用户 id（探测性接口，读不到不阻塞登录判定）。 */
export async function probeUserId(page: Page): Promise<string | undefined> {
  for (const path of ['/api/author/user/info/v0', '/api/author/author/info/v0']) {
    try {
      const data = await fanqieApi<Record<string, unknown>>(page, 'GET', path)
      const r = data as Record<string, unknown>
      const uid = r['user_id'] ?? r['author_id'] ?? r['uid']
      if (uid != null && String(uid) !== '') return String(uid)
    } catch { /* 探测失败不阻塞 */ }
  }
  return undefined
}
