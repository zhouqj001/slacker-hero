/**
 * client 侧共享：API 类型、fetch 封装、样式类（M3 页签共用）。
 */
import s from './styles.module.css'

/** 设计系统类名表（styles.module.css 编译产物，类名带 hash 前缀）。 */
export { s }

/** 与 Node 半侧 schema 对齐的记录类型。 */
export interface Persona {
  id: string
  name: string
  positioning: string
  tone: string
  audience: string
  taboos: string[]
  tags: string[]
  order?: number
  /** 绑定的发布账号（1:1）。缺省 = 通用人设。 */
  accountId?: string
  updatedAt: number
}

/** 单个人设视角下的契合度评分。 */
export interface PersonaFit {
  score: number
  reason: string
  scoredAt: number
}

/** 账号 → 人设视角表（GET /api/media/hotspots meta.accounts）。 */
export interface HotspotAccountMeta {
  id: string
  displayName: string
  status: Account['status']
  /** 该账号绑定的人设 id；未绑 = '_default'（通用人设）。 */
  personaId: string
  personaName: string
  /** 该账号的内容方向（账号管理页规划而来）。 */
  pillars: string[]
}

export interface Hotspot {
  id: string
  source: 'fetch' | 'manual' | 'evergreen'
  title: string
  summary?: string
  heat?: number
  url?: string
  fetchedAt: number
  /** 旧版单值评分（通用人设视角），旧数据兼容读。 */
  personaFit?: PersonaFit
  /** 每个账号人设一份的评分（personaId → fit）。 */
  personaFits?: Record<string, PersonaFit>
  state: 'pending' | 'adopted' | 'rejected' | 'used'
  linkedArticleId?: string
  /** 归属账号：这条选题进该账号的选题池。空 = 公共池。 */
  accountId?: string
}

export interface Article {
  id: string
  title: string
  bodyMd: string
  status: 'draft' | 'generating' | 'generated' | 'editing' | 'approved' | 'failed'
  topic: { hotspotId?: string; evergreenId?: string; manual?: boolean }
  platformVersions: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface Plan {
  id: string
  /** null = 待排档期（还没选文章的时段占位），发布节奏里等用户选文章填充。 */
  articleId: string | null
  platform: string
  accountId: string
  scheduledAt: number
  state: 'planned' | 'pending-review' | 'approved' | 'publishing' | 'published' | 'failed' | 'degraded' | 'skipped'
  reviewNote?: string
  createdAt: number
}

export interface AccountProfile {
  capturedAt: number
  platformUserId?: string
  displayName?: string
  operator?: string
  fansTotal?: number
  fansGainedYesterday?: number
  fansLostYesterday?: number
  fansActiveYesterday?: number
  fansActiveRatio?: number
  fansRegions?: { name: string; ratio: number }[]
  readsTotal?: number
  readsYesterday?: number
  showsYesterday?: number
  likesYesterday?: number
  commentsYesterday?: number
  /** 累计获得的赞同/点赞总数。 */
  likesTotal?: number
  /** 平台侧已发内容总数。 */
  worksCount?: number
  incomeYesterday?: number
  income30d?: number
  incomeMonth?: number
  incomeTotal?: number
  withdrawable?: number
  creditScore?: number
  securityScore?: number
  certifyStatus?: string
  warnings?: string[]
}

export interface Account {
  id: string
  platform: string
  displayName: string
  status: 'active' | 'expired' | 'disabled'
  /** 自设风控：一我们自己放行几篇。不是平台配额，UI 别写成「剩余可发」。 */
  dailyLimit: number
  dailyLimitSelf?: number
  /** 今天已成功发布几篇（我们自己的计数）。 */
  sentToday?: number
  /** 历史成功发布总条数。0 = 从没通过本工作台发过。 */
  publishTotal?: number
  /** 最近一次成功发布时间。 */
  lastPublishedAt?: number | null
  /** 登录正常 + 平台适配器支持自动发布，才谈得上能发。 */
  canPublish?: boolean
  lastLoginCheckAt: number | null
  createdAt: number
  /** 最近一次从平台后台采集到的概况；undefined = 从没采集过。 */
  profile?: AccountProfile
  /** 发布目标：周期 + 篇数 + 偏好时段（HH:mm）。undefined = 没定目标。 */
  cadence?: { period: 'week' | 'month'; target: number; slots: string[] }
  /** 内容方向（题材栏目）。 */
  pillars?: string[]
  /** 当前周期标签（本周 / 本月），由后端按 cadence.period 给出。 */
  periodLabel?: string
  /** 本期真实成功发布篇数（只算 publish 表 success 记录）。 */
  periodPublished?: number
  /** 本期已排但未发布的计划数（planned/pending-review/approved/publishing）。 */
  periodPlanned?: number
  /** 上面这些计划的 scheduledAt（用于避开已被占用的时段）。 */
  periodPlannedAt?: number[]
}

/** account_work 表的一行：平台后台作品列表采集而来。 */
export interface AccountWork {
  id: string
  accountId: string
  platform: string
  title: string
  kind?: string
  publishedAt?: number
  publishedAtText?: string
  shows?: number
  reads?: number
  likes?: number
  comments?: number
  collects?: number
  url?: string
  capturedAt: number
}

/** 单账号采集汇总（与后端 AccountStats 对齐）。 */
export interface AccountStats {
  id: string
  platform: string
  displayName: string
  status: 'active' | 'expired' | 'disabled'
  collected: boolean
  capturedAt?: number
  platformUserId?: string
  fansTotal?: number
  fansGainedYesterday?: number
  fansLostYesterday?: number
  fansActiveYesterday?: number
  fansActiveRatio?: number
  readsTotal?: number
  readsYesterday?: number
  showsYesterday?: number
  likesYesterday?: number
  commentsYesterday?: number
  incomeYesterday?: number
  income30d?: number
  incomeMonth?: number
  incomeTotal?: number
  withdrawable?: number
  creditScore?: number
  securityScore?: number
  certifyStatus?: string
  workCount: number
  workShows: number
  workReads: number
  workLikes: number
  workComments: number
  topWorks: AccountWork[]
  warnings: string[]
}

/** 降级草稿包（plan/run 返回）。 */
export interface DraftPackage {
  platform: string
  title: string
  bodyMd: string
  bodyHtml: string
  openUrl: string
  hint?: string
}

export interface Review {
  id: string
  publishId: string
  articleId: string
  platform: string
  metrics: { reads?: number; likes?: number; comments?: number; shares?: number; collected?: number }
  capturedAt: number
  manual: boolean
  note?: string
}

export interface MetricsAgg {
  count: number
  reads: number
  likes: number
  comments: number
  shares: number
  avgReads: number
}

export interface StatsPayload {
  total: { articles: number; plans: number; reviews: number; accounts: number; works: number }
  bySource: Record<string, MetricsAgg>
  byPlatform: Record<string, MetricsAgg>
  /** 账号维度：平台后台采集的真实数据 */
  accounts: AccountStats[]
  collectedCount: number
}

/**
 * 发布记录（publish 表；降级记录 publishedAt 为 null）。
 * `awaiting-manual` = 半自动：内容已填进平台编辑器、等用户点最终发布，后台仍在核对。
 */
export interface PublishRecord {
  id: string
  planId: string
  platform: string
  accountId: string
  state: 'success' | 'failed' | 'degraded-manual' | 'awaiting-manual'
  url?: string
  error?: string
  /** 人类可读说明（半自动的待办提示 / 确认到之后的检出状态）。 */
  note?: string
  draftPackage?: Record<string, string>
  publishedAt: number | null
}

/** 工作台动态流卡片（与后端 api.ts 的 FeedItem 对齐）。 */
export type FeedItem =
  | { kind: 'brief'; id: string; at: number; hotspots: Hotspot[]; total: number }
  | { kind: 'draft'; id: string; at: number; article: Article; plans: Plan[] }
  | { kind: 'receipt'; id: string; at: number; publish: PublishRecord; article?: Article; plan?: Plan }
  | { kind: 'metrics'; id: string; at: number; review: Review; article?: Article }
  | { kind: 'event'; id: string; at: number; accountId: string; platform: string; displayName: string }

/** GET /api/media/feed 响应。 */
export interface FeedPayload {
  items: FeedItem[]
  pendingHotspots: number
}

/** NL 派活解析结果（personaId 由服务端把人设名匹配本地记录后附加）。 */
export interface DispatchParsed {
  topic: string
  platforms: string[]
  persona: string | null
  personaId?: string | null
}

/** POST /api/media/dispatch 响应（parsed:null 时前端降级开确认弹窗）。 */
export interface DispatchPayload {
  parsed: DispatchParsed | null
  reason: 'OK' | 'NO_LLM' | 'LLM_ERROR' | 'UNPARSABLE'
  /** dsh 会话句柄：每条派活指令传回，全部落在同一个会话里（不再每句新开）。 */
  sessionId?: string | null
  baseline?: number
}

/** 支持的平台 id → 中文名（与后端 PLATFORM_OPTIONS 对齐）。 */
export const PLATFORM_LABEL: Record<string, string> = {
  wechat: '微信公众号',
  toutiao: '今日头条',
  zhihu: '知乎专栏',
  xiaohongshu: '小红书',
  douyin: '抖音',
}

/** 账号登录态 id → 中文名（与 domain.ts AccountSchema.status 对齐）。 */
export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  active: '正常',
  expired: '登录过期',
  disabled: '已停用',
}

export const PLATFORM_IDS = ['wechat', 'toutiao', 'zhihu', 'xiaohongshu', 'douyin'] as const

/* ── 发布目标 → 本期排期推算（纯推算，不写库） ───────────────────── */

/** 本地时区周期区间 [from, to)：周 = 本周一 00:00 起；月 = 本月 1 日 00:00 起。 */
export function periodRange(period: 'week' | 'month', now = new Date()): { from: number; to: number } {
  if (period === 'month') {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
    }
  }
  const dow = (now.getDay() + 6) % 7 // 周一 = 0
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).getTime()
  return { from, to: from + 7 * 86400_000 }
}

/** 槽位比对键：同一「日期 + 时:分」视为同一时段。 */
function slotKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`
}

/** 槽位显示：`10/21 20:30`。 */
export function fmtSlot(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface SlotPlan {
  /** 本期还差几篇 = 目标 − 已发 − 本期已排未发布（负数取 0）。 */
  needed: number
  /** 建议时段（已排除被现有计划占用的时段），最多 needed 个。 */
  slots: number[]
  /** 本期剩余可用时段总数（含已被占用的），用于判断「剩下的时段排不下目标」。 */
  capacity: number
}

/**
 * 由发布目标推算本期排期：还差几篇 + 可用的偏好时段。
 * 纯推算、不写库；没设周期目标/偏好时段时 `slots` 为空，UI 据此如实提示，
 * 不编造时段、也不拿别的账号的排期顶上。
 */
export function planSlots(
  cadence: { period: 'week' | 'month'; target: number; slots: string[] } | undefined,
  published: number,
  plannedAt: number[],
  now = new Date(),
): SlotPlan {
  if (!cadence) return { needed: 0, slots: [], capacity: 0 }
  const needed = Math.max(0, cadence.target - published - plannedAt.length)
  const { from, to } = periodRange(cadence.period, now)
  const occupied = new Set(plannedAt.map(slotKey))
  const mins = cadence.slots
    .map(s => {
      const [h, m] = s.split(':').map(Number)
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined
    })
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b)
  const free: number[] = []
  let capacity = 0
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (; day.getTime() < to; day.setDate(day.getDate() + 1)) {
    for (const m of mins) {
      const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m).getTime()
      if (ts <= now.getTime() || ts < from) continue
      capacity++
      if (!occupied.has(slotKey(ts))) free.push(ts)
    }
  }
  return { needed, slots: free.slice(0, needed), capacity }
}

/** 业务错误（携带稳定 code，UI 可区分 LOGIN_EXPIRED 等）。 */
export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** GET 封装：解 envelope，失败抛 ApiError。 */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const data = await res.json() as { ok: boolean; data?: T; message?: string; code?: string }
  if (!data.ok) throw new ApiError(data.code ?? 'HTTP_ERROR', data.message ?? `HTTP ${res.status}`)
  return data.data as T
}

/** POST 封装：解 envelope，失败抛 ApiError。 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as { ok: boolean; data?: T; message?: string; code?: string }
  if (!data.ok) throw new ApiError(data.code ?? 'HTTP_ERROR', data.message ?? `HTTP ${res.status}`)
  return data.data as T
}

/** POST 原样返回 envelope（用于「成功但需降级处理」的端点，如 plan/run）。 */
export async function apiPostRaw<T>(path: string, body: unknown): Promise<{
  ok: boolean
  data?: T
  code?: string
  message?: string
}> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

/* ── 工作文件夹 ─────────────────────────────────────────────────── */

/** Shape of Tauri's global invoke（shell 内 via withGlobalTauri）。 */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** Tauri invoke 桥；壳外（纯浏览器 dev）返回 undefined。 */
export function shellInvoke(): Invoke | undefined {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke }
  }
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke
}

/**
 * 原生「选择文件夹」对话框选媒体工作文件夹；用户取消返回 null。
 * 壳外（纯浏览器 dev）或 IPC 被 ACL 拒绝时抛错 —— 静默返回 null 会让
 * 「点了没反应」无从排查。
 */
export async function pickWorkspaceDir(): Promise<string | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) throw new Error('当前不在壳内（浏览器直连），无法调起原生选择框，请手动填入路径')
  return (await invoke('slacker_media_pick_dir')) as string | null
}
