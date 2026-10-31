/**
 * client 侧共享：API 类型（与服务端 domain.ts / api.ts 输出对齐）、fetch 封装、
 * SSE 帧流读取、标签映射、格式化助手、样式类表。
 * @module @slacker/writer/client
 */
import s from './styles.module.css'

/** 设计系统类名表（styles.module.css 编译产物，类名带 hash 前缀）。 */
export { s }

/* ── 记录类型（对齐服务端 domain.ts schema）────────────────────── */

export interface WriterAccount {
  id: string
  name: string
  platform: 'fanqie'
  fanqieUserId?: string
  status: 'active' | 'expired' | 'disabled'
  lastLoginCheckAt: number | null
  createdAt: number
}

/** 章 beat（章纲条目）。 */
export interface Beat {
  no: number
  title: string
  beat: string
  hook: string
  /** 本章给读者的承诺（期待会发生什么）。 */
  promise?: string
  /** 本章新增的不确定点（信息差/反常/两难…）。 */
  uncertainty?: string
  /** 回收哪一章的 promise（章号）。 */
  payoffOf?: number
  isCool?: boolean
  isClimax?: boolean
  status: 'pending' | 'drafted' | 'finalized'
}

export interface WriterBook {
  id: string
  accountId: string
  name: string
  genre: string
  intro: string
  status: 'planning' | 'writing' | 'finished'
  fanqieBookId?: string
  fanqieVolumeId?: string
  chapterWords: number
  targetWords?: number
  /** 全书规划总章数（立项时定，一键成书默认写到这个数）。 */
  targetChapters?: number
  styleCard: string
  /** 风格原型 id（缺省 = 一期通用腔）。 */
  archetype?: string
  /** 叙述契约（人称/限知/时距/时态）。 */
  narrator?: string
  outline: {
    logline: string
    coreConflict: string
    volumes: { index: number; title: string; summary: string }[]
    beats: Beat[]
  }
  memorySummary: string
  createdAt: number
  updatedAt: number
}

/** 有向关系（kind=relation 专用）。 */
export interface SettingRelation {
  from: string
  to: string
  publicLabel: string
  realBond?: string
  fromKnows: string[]
  toKnows: string[]
}

export interface SettingRec {
  id: string
  bookId: string
  kind: 'character' | 'world' | 'item' | 'faction' | 'relation'
  name: string
  summary: string
  tags: string[]
  state?: string
  visibleFromVolume?: number
  relation?: SettingRelation
  /** 该角色知晓的关键事实清单（character 专用）。 */
  knownBy?: string[]
  /** 出处：提取自哪一章。 */
  sourceChapterNo?: number
  /** 出处原文摘录（≤60 字，待复核对照用）。 */
  quote?: string
  /** 失效标记：出处章节被重写/大改后置 true，人工复核前召回降级。 */
  stale?: boolean
  updatedAt: number
}

export interface ForeshadowRec {
  id: string
  bookId: string
  desc: string
  plantedAt: number
  suggestPayoffAt?: number
  paidAt?: number
  sourceChapterNo?: number
  quote?: string
  stale?: boolean
  createdAt: number
}

/** 定稿回写待确认条目。 */
export interface PendingRec {
  id: string
  bookId: string
  chapterNo: number
  kind: 'setting' | 'foreshadow' | 'state' | 'summary' | 'knowledge' | 'timeline'
  payload: Record<string, unknown>
  createdAt: number
}

/** 场景时间锚（相对表述，不编造日期）。 */
export interface TimelineAnchor {
  scene?: string
  start: string
  gap: string
  duration: string
  end: string
}

export interface ChapterSnapshot {
  content: string
  words: number
  savedAt: number
  reason: string
}

export interface Chapter {
  id: string
  bookId: string
  no: number
  title: string
  content: string
  words: number
  summary?: string
  summaryStale?: boolean
  snapshots: ChapterSnapshot[]
  publishState: 'local' | 'queued' | 'draft' | 'submitted' | 'live' | 'rejected'
  itemId?: string
  hookOk?: boolean
  quality?: Record<string, unknown>
  timeline?: TimelineAnchor[]
  createdAt: number
  updatedAt: number
}

/** 章列表项（GET /chapters 输出剥掉了 content，正文按章拉取）。 */
export type ChapterListItem = Omit<Chapter, 'content'>

/** 发布台账（按账号记账；quota/幂等全部由此聚合）。 */
export interface PublishLog {
  id: string
  accountId: string
  bookId: string
  chapterNo: number
  itemId?: string
  mode: 'draft' | 'now'
  targetDate?: string
  words: number
  status: 'success' | 'failed' | 'refunded'
  idempotencyKey: string
  error?: string
  ts: number
}

/* ── LLM / 质检 / 配额 / 平台类型（对齐服务端 llm.ts 等）────────── */

export interface WizardProposal {
  names: string[]
  intro: string
  protagonist: { name: string; summary: string; tags: string[] }
  outline: { logline: string; coreConflict: string }
  volume: { title: string; summary: string }
  /** 按题材推荐的风格原型 id（确认建书时落 book.archetype）。 */
  archetype?: string
  /** 全书规划总章数（立项规模，确认建书时落 book.targetChapters）。 */
  totalChapters?: number
  beats: {
    no: number
    title: string
    beat: string
    hook: string
    promise?: string
    uncertainty?: string
    payoffOf?: number
    isCool?: boolean
    isClimax?: boolean
  }[]
}

export interface BeatsProposal {
  volume?: { title: string; summary: string }
  beats: WizardProposal['beats']
}

export interface QualityIssue {
  level: 'block' | 'warn' | 'info'
  code: string
  message: string
}

/** 粗筛统计项（句长方差等；质检报告与审稿校准共用）。 */
export interface QualityStats {
  sentenceStd: number
  paraCv: number
  sublimationParas: number
  parallelismRuns: number
}

export interface QualityReport {
  words: number
  paragraphCount: number
  issues: QualityIssue[]
  stats: QualityStats
  hookOk?: boolean
  passed: boolean
  /** 质量分级（新稿有；旧稿缺省时按 passed 回退）。 */
  grade?: QualityGrade
  /** 0–100 仅用于展示/排序，不参与放行判定。 */
  score?: number
  /** LLM 审稿合并结果（/review 后挂上）。 */
  review?: ChapterReview
}

/** 质量分级：gold/silver 直接接受，bronze 定向重写，reject 跳过。 */
export type QualityGrade = 'gold' | 'silver' | 'bronze' | 'reject'

/** LLM 审稿 issue（evidence=原文依据 ≤60 字，suggestion=修改建议）。 */
export interface ReviewIssue extends QualityIssue {
  evidence?: string
  suggestion?: string
}

/** 不确定密度分窗（500 字一窗）。 */
export interface ReviewWindow {
  window: string
  hasNew: boolean
  note?: string
}

/** LLM 审稿合并结果（挂 chapter.quality.review）。 */
export interface ChapterReview {
  issues: ReviewIssue[]
  windows: ReviewWindow[]
  hookStrength?: 'ok' | 'bad'
  blockCount: number
  warnCount: number
  reviewedAt: number
}

/** 创作日志行（GET /logs）。 */
export interface WriterLog {
  id: string
  bookId: string
  no?: number
  stage: 'generate' | 'beats' | 'finalize' | 'review' | 'rewrite'
  ok: boolean
  ms: number
  issueCount?: number
  /** 质量分级（generate/rewrite 阶段）。 */
  grade?: string
  /** 本次调用模型（provider/model）。 */
  model?: string
  err?: string
  ts: number
}

/** 风格原型摘要（GET /archetypes）。 */
export interface ArchetypeSummary {
  id: string
  name: string
  lineage: string
  genres: string[]
}

export interface QuotaUsage {
  dailyWords: number
  monthlyWords: number
  updatedWorksToday: string[]
}

export interface QuotaLimits {
  dailyWordLimit: number
  monthlyWordLimit: number
  dailyUpdateWorksLimit: number
}

/** GET /quota 单行（带 accountId）或全账号列表行。 */
export interface QuotaRow {
  accountId: string
  name: string
  usage: QuotaUsage
  limits: QuotaLimits
}

/** 平台书单条目（GET /fanqie/works）。 */
export interface FanqieBook {
  bookId: string
  name: string
  wordNumber: number
  category: string
}

/** 作品详情（GET /book 一次拉全）。 */
export interface BookDetail {
  book: WriterBook
  settings: SettingRec[]
  foreshadows: ForeshadowRec[]
  pending: PendingRec[]
}

/** 与服务端 llm.ts DEFAULT_STYLE_CARD 保持一致的预填文风卡（client 不引服务端模块）。 */
export const DEFAULT_STYLE_CARD = [
  '【文风卡（最高优先级，全书一致）】',
  '- 网文正文腔：短句为主，动作与对话推进剧情，少用心理描写与静态描写。',
  '- 每段 1–3 行；段落之间空一行；禁止 Markdown 语法（番茄正文是纯文本）。',
  '- 禁止空洞形容词堆砌（如「无比强大」「恐怖如斯」连用）、禁止总结腔（如「这告诉我们」）、禁止排比抒情。',
  '- 对话要有信息量与性格，不写寒暄废话；数字与专有名词前后一致。',
  '- 视角：默认第三人称限制视角（跟随主角），不随意跳头。',
].join('\n')

/* ── fetch 封装 ──────────────────────────────────────────────── */

/** 业务错误（稳定 code + 附加字段如 quality/usage）。 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** envelope 顶层除 ok/data/code/message 外的附加字段。 */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface Envelope {
  ok: boolean
  code?: string
  message?: string
}

async function unwrap<T>(res: Response): Promise<T> {
  const data = await res.json() as Envelope & Record<string, unknown>
  if (!data.ok) {
    const { ok: _ok, code, message } = data
    const extra: Record<string, unknown> = { ...data }
    delete extra['ok']
    delete extra['code']
    delete extra['message']
    throw new ApiError(typeof code === 'string' ? code : 'HTTP_ERROR', typeof message === 'string' ? message : `HTTP ${res.status}`, extra)
  }
  return data.data as T
}

/** GET 封装：解 envelope，失败抛 ApiError。 */
export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path))
}

/** POST 封装：解 envelope，失败抛 ApiError。 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return unwrap<T>(res)
}

/* ── SSE 帧流（writer 服务端统一 `data: {...}\n\n`）────────────── */

export type SseFrame = Record<string, unknown>

/**
 * POST SSE：按 \n\n 分帧、解析 data: JSON 逐帧回调。
 * onFrame 返回 true 表示业务已结束（提前断流并 cancel reader）。
 * HTTP/网络层错误抛 ApiError；业务 error 帧由调用方按 type 字段处理。
 */
export async function postSse(
  path: string,
  body: unknown,
  onFrame: (frame: SseFrame) => boolean | void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  await readSse(res, onFrame)
}

/** GET SSE：接回常驻任务（刷新/断线后回放进度的场景用）。 */
export async function getSse(
  path: string,
  onFrame: (frame: SseFrame) => boolean | void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, { signal })
  await readSse(res, onFrame)
}

/** 逐帧读取 SSE 响应：按 \n\n 分帧，解析 data: JSON 后回调。 */
async function readSse(
  res: Response,
  onFrame: (frame: SseFrame) => boolean | void,
): Promise<void> {
  if (!res.ok || !res.body) throw new ApiError('HTTP_ERROR', `HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let stop = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      for (;;) {
        const idx = buf.indexOf('\n\n')
        if (idx < 0) break
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const m = chunk.match(/^data: (.+)$/m)
        if (!m) continue
        let frame: SseFrame
        try {
          frame = JSON.parse(m[1]) as SseFrame
        } catch {
          continue
        }
        if (onFrame(frame) === true) {
          stop = true
          break
        }
      }
      if (stop) break
    }
  } finally {
    if (stop) void reader.cancel().catch(() => {})
  }
}

/** 帧字符串字段（缺省 ''）。 */
export function frameStr(frame: SseFrame, key: string): string {
  const v = frame[key]
  return typeof v === 'string' ? v : ''
}

/** 帧数字字段（缺省 undefined）。 */
export function frameNum(frame: SseFrame, key: string): number | undefined {
  const v = frame[key]
  return typeof v === 'number' ? v : undefined
}

/** 帧对象字段。 */
export function frameObj<T>(frame: SseFrame, key: string): T | undefined {
  return frame[key] as T | undefined
}

/* ── 标签映射（与服务端枚举对齐）──────────────────────────────── */

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  active: '正常',
  expired: '登录过期',
  disabled: '已停用',
}

export const BOOK_STATUS_LABEL: Record<string, string> = {
  planning: '筹备中',
  writing: '写作中',
  finished: '已完结',
}

/** 章发布状态机标签。 */
export const PUBLISH_STATE_LABEL: Record<string, string> = {
  local: '本地稿',
  queued: '排队中',
  draft: '草稿箱',
  submitted: '已提交',
  live: '已上线',
  rejected: '被退回',
}

export const BEAT_STATUS_LABEL: Record<string, string> = {
  pending: '待写',
  drafted: '已出稿',
  finalized: '已定稿',
}

export const SETTING_KIND_LABEL: Record<string, string> = {
  character: '人物',
  world: '世界观',
  item: '物品',
  faction: '阵营',
  relation: '关系',
}

export const PENDING_KIND_LABEL: Record<string, string> = {
  setting: '新设定',
  foreshadow: '新伏笔',
  state: '人物状态',
  summary: '剧情摘要',
  knowledge: '角色知情',
  timeline: '时间锚',
}

/** 创作日志 stage 标签。 */
export const LOG_STAGE_LABEL: Record<string, string> = {
  generate: '逐章生成',
  beats: '大纲/续排',
  finalize: '定稿回写',
  review: 'LLM 审稿',
  rewrite: '改稿',
}

/** 审稿 issue 级别标签。 */
export const REVIEW_LEVEL_LABEL: Record<string, string> = {
  block: '必改',
  warn: '建议',
  info: '提示',
}

export const LOG_STATUS_LABEL: Record<string, string> = {
  success: '成功',
  failed: '失败',
  refunded: '已返还',
}

export const MODE_LABEL: Record<string, string> = {
  draft: '存草稿箱',
  now: '立即发布',
}

/** 番茄常用题材候选（向导 chips，可自由输入）。 */
export const FANQIE_GENRES = ['都市', '玄幻', '仙侠', '悬疑', '历史', '科幻', '游戏', '现实', '轻小说']

/* ── 格式化助手 ──────────────────────────────────────────────── */

/** `M/D HH:mm`；空值显示 —。 */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 字数展示：过万折算。 */
export function fmtWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`
}
