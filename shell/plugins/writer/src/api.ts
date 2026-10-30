/**
 * /api/writer/* route table — registered on the shared /api channel through
 * `ctx.connection.fetch.register`. Routes match the FULL request pathname
 * (verified against the harness: `fetchRoutes.get(url.pathname)`), so paths
 * here include the `/api` prefix. The matcher is exact-pathname only →
 * 「路径参数」一律用 query/body 传（如 /chapter?bookId=&no=）。
 *
 * 错误契约（plan §6/§8，fail-closed）：业务错误一律 {ok:false, code, message}；
 * JSON 路由里 LLM 失败但需保留会话句柄时走 {ok:true, data:{fail, ...}}。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  chapterId,
  type WriterDomain,
} from './domain.ts'
import type { WriterConfig } from './config.ts'
import type { ModelRef } from './config.ts'
import {
  DEFAULT_STYLE_CARD,
  buildChapterPrompts,
  buildCompressSummaryPrompts,
  buildFinalizePrompts,
  buildMoreBeatsPrompts,
  buildNewVolumePrompts,
  buildReviewPrompts,
  buildWizardPrompts,
  parseArchetypeId,
  parseBeatsProposal,
  parseCompressSummary,
  parseFinalizeExtract,
  parseReviewResult,
  parseWizardProposal,
  resolveLlmError,
  stripHookMark,
  type BeatsProposal,
  type LlmErrorInfo,
  type WizardProposal,
} from './llm.ts'
import { GRADE_POLICIES, GRADE_RANK, analyzeChapter, countWords, goldenRuleFor, type QualityGrade, type QualityIssue } from './quality.ts'
import { buildChapterContext, buildReviewContext, type ContextBeat, type ContextForeshadow, type ContextSetting } from './context.ts'
import { archetypeSummaries, resolveArchetype } from './style.ts'
import { checkQuota, findLatestLog, findSuccessLog, idempotencyKey, quotaUsage } from './quota.ts'
import { browserPool } from './platforms/browser.ts'
import {
  PublishError,
  browserOpts,
  createArticle,
  fetchBookList,
  fetchChapterList,
  fetchVolumes,
  gotoWriterHome,
  isLoginExpired,
  probeLogin,
  publishArticle,
} from './platforms/fanqie.ts'
import { LoginCancelled, LoginTimeout, runLoginFlow } from './platforms/login.ts'

// ------------------------------------------------------------------
// dsh sessionController 最小结构面（复刻 media；运行时注入，不引入类型依赖）
// ------------------------------------------------------------------

interface WriterSessionController {
  create(request: { sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string }>
  /** 会话级模型选择（plan ③；dsh 真实服务提供，缺失时软降级为默认模型）。 */
  selectModel?(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ selected: unknown }>
  prompt(
    request: {
      requestId: string
      sessionId: string
      mode: 'queue' | 'steer'
      content: ReadonlyArray<{ type: 'text'; text: string }>
    },
    signal: AbortSignal,
  ): Promise<{ accepted: true }>
  follow(
    request: { address: { kind: 'session'; sessionId: string } },
    signal: AbortSignal,
  ): AsyncIterable<{
    type: string
    event?: { type: string; time?: unknown; data: unknown }
    records?: ReadonlyArray<{ type: string; event?: { type: string; time?: unknown; data: unknown } }>
  }>
}

/** 从 assistant/message 事件 data 提取正文（content 里 type=text 的块拼接）。 */
function assistantTextFromEvent(data: unknown): string {
  const content = (data as { message?: { content?: ReadonlyArray<{ type?: string; text?: string }> } }).message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
}

/** turn/end reason → 错误信息；completed/max-tokens 视为正常完成。 */
function turnEndFailure(reason: unknown): LlmErrorInfo | undefined {
  const r = reason as { kind?: string; error?: { code?: string; message?: string } } | undefined
  if (!r?.kind || r.kind === 'completed' || r.kind === 'max-tokens') return undefined
  if (r.kind === 'error' && r.error) {
    const info = resolveLlmError(r.error.code ?? 'SERVER')
    return { ...info, zh: r.error.message ? `${info.zh}：${r.error.message}` : info.zh }
  }
  if (r.kind === 'aborted') return resolveLlmError('ABORTED')
  if (r.kind === 'blocked') {
    return { code: 'BLOCKED', zh: '会话回合被阻塞', action: '可能在等待确认，请到 dsh 会话里处理后重试' }
  }
  return { code: 'SERVER', zh: `会话回合异常结束（${r.kind}）`, action: '请到 dsh 会话查看详情' }
}

/** follow 断线重连参数：退避间隔与总等待窗（超窗才放弃，正常回合几十秒内完成）。 */
const FOLLOW_RECONNECT_DELAY_MS = 600
const FOLLOW_RECONNECT_WINDOW_MS = 5 * 60_000

/** follow 帧里 event 自带的持久化时间戳（快照重放与直播都是完整事件记录）。 */
function eventTime(ev: { time?: unknown }): number | null {
  return typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : null
}

/** 可被 abort 提前唤醒的 sleep（唤醒后由调用方自行检查 signal）。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

/** 任务分类（plan ③）：正文/审稿/辅助各自可配模型。 */
type LlmTask = 'write' | 'review' | 'utility'

/** global KV 键：模型分工（优先于插件 config）。 */
const LLM_MODELS_KEY = 'writer:llmModels'

/** 宽松解析模型引用（provider/model 必须非空，其余可缺）。 */
function asModelRef(v: unknown): ModelRef | undefined {
  if (!v || typeof v !== 'object') return undefined
  const rec = v as Record<string, unknown>
  const provider = typeof rec['provider'] === 'string' ? rec['provider'].trim() : ''
  const model = typeof rec['model'] === 'string' ? rec['model'].trim() : ''
  if (!provider || !model) return undefined
  const effort = typeof rec['reasoningEffort'] === 'string' && rec['reasoningEffort'].trim() ? rec['reasoningEffort'].trim() : undefined
  return { provider, model, reasoningEffort: effort }
}

/** 当前模型分工：global KV 覆盖 > 插件 config > 未配置（沿用默认模型）。 */
function modelConfigOf(domain: WriterDomain, config: WriterConfig): Record<LlmTask, ModelRef | undefined> {
  const raw = (domain.global.get() as Record<string, unknown>)[LLM_MODELS_KEY]
  const store = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    write: asModelRef(store['write']) ?? asModelRef(config.llm.write),
    review: asModelRef(store['review']) ?? asModelRef(config.llm.review),
    utility: asModelRef(store['utility']) ?? asModelRef(config.llm.utility),
  }
}

function resolveModelRef(task: LlmTask, domain: WriterDomain, config: WriterConfig): ModelRef | undefined {
  return modelConfigOf(domain, config)[task]
}

function modelLabel(ref: ModelRef | undefined): string | undefined {
  return ref ? `${ref.provider}/${ref.model}` : undefined
}

/**
 * 会话派工（SSE 版）：建/续会话 → prompt → follow 循环。
 * 每个 assistant/message 事件发一帧 {type:'text', text:整段全文}（替换式；
 * dsh 的 message 事件本身不是增量），turn/end（本轮）结束循环。
 * 本轮判定：事件时间晚于本轮 prompt 受理时刻（快照重放的历史回合不采纳，
 * 兼容 baseline 口径）。follow 流可能被会话控制器的 history effect 卸载时
 * 静默关闭（generator 正常 done、无异常无 abort），而回合仍在会话里继续跑——
 * 因此只要还没见到本轮 turn/end 就退避重连 follow，快照重放会补发错过的
 * 正文帧并推进到本轮 turn/end；超过总等待窗才放弃。
 */
async function runSessionSse(
  ctrl: WriterSessionController,
  send: (data: object) => void,
  opts: {
    title: string
    prompt: string
    signal: AbortSignal
    sessionId?: string
    baseline?: number
    /** 任务分类与目标模型（未配置则沿用默认）。 */
    task?: LlmTask
    selection?: ModelRef
  },
): Promise<{ text: string; failure?: LlmErrorInfo; sessionId: string | null; baseline: number; model?: string }> {
  const base = opts.baseline ?? 0
  let sessionId = opts.sessionId ?? null
  let accepted = false
  let text = ''
  let failure: LlmErrorInfo | undefined
  let model: string | undefined
  try {
    if (sessionId === null) {
      const created = await ctrl.create({})
      sessionId = created.sessionId
      send({ type: 'session', sessionId, baseline: base })
      try {
        await ctrl.rename({ sessionId, title: opts.title })
      } catch { /* 命名失败不阻塞 */ }
      // 仅新建会话时选模型（重试复用同一会话，模型已持久在该会话上）
      if (opts.selection && ctrl.selectModel) {
        try {
          await ctrl.selectModel({
            sessionId,
            provider: opts.selection.provider,
            model: opts.selection.model,
            reasoningEffort: opts.selection.reasoningEffort,
          })
          model = modelLabel(opts.selection)
        } catch (err) {
          const msg = `模型切换失败，已沿用默认模型：${err instanceof Error ? err.message : String(err)}`
          console.warn(`[writer] ${msg}`)
          send({
            type: 'model/warn',
            task: opts.task ?? 'write',
            message: msg,
          })
        }
      }
    } else {
      send({ type: 'session', sessionId, baseline: base })
    }
    await ctrl.prompt({
      requestId: `writer-ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: opts.prompt }],
    }, opts.signal)
    accepted = true
    let endsSeen = 0
    let ended = false
    // 本轮判定基准：prompt 受理时刻。晚于它的 assistant/message / turn/end 才算本轮
    // （快照重放的历史回合一律跳过；缺时间戳的事件回退 baseline 计数口径）。
    const notBefore = Date.now()
    const reconnectDeadline = Date.now() + FOLLOW_RECONNECT_WINDOW_MS
    const handle = (evType: string, evTime: number | null, evData: unknown, live: boolean): boolean => {
      if (evType === 'assistant/message') {
        const t = assistantTextFromEvent(evData)
        if (t.trim() !== '') {
          const ours = live || (evTime !== null ? evTime > notBefore : endsSeen >= base)
          if (ours) {
            text = t
            send({ type: 'text', text: t })
          }
        }
        return false
      }
      if (evType === 'turn/end') {
        endsSeen++
        const historical = evTime !== null ? evTime <= notBefore : endsSeen <= base
        if (!live && historical) return false
        const info = turnEndFailure((evData as { reason?: unknown }).reason)
        if (info) failure ??= info
        return true
      }
      return false
    }
    while (!ended) {
      endsSeen = 0
      const frames = ctrl.follow({ address: { kind: 'session', sessionId } }, opts.signal)
      for await (const frame of frames) {
        if (frame.type === 'snapshot') {
          for (const rec of frame.records ?? []) {
            if (rec.type === 'event' && rec.event && handle(rec.event.type, eventTime(rec.event), rec.event.data, false)) {
              ended = true
              break
            }
          }
        } else if (frame.type === 'event' && frame.event) {
          if (handle(frame.event.type, eventTime(frame.event), frame.event.data, true)) ended = true
        }
        if (ended) break
      }
      if (ended) break
      // 流提前收场：取消视为中断；超窗才放弃；否则退避后重连（快照重放补帧）。
      if (opts.signal.aborted) {
        failure ??= resolveLlmError('ABORTED')
        break
      }
      if (Date.now() >= reconnectDeadline) {
        failure ??= {
          code: 'FOLLOW_LOST',
          zh: '与写作会话的连接反复中断，回合长时间未结束',
          action: '生成可能仍在会话里进行，可稍后重试或到 dsh 会话查看',
        }
        break
      }
      await sleep(FOLLOW_RECONNECT_DELAY_MS, opts.signal)
    }
  } catch (err) {
    if (opts.signal.aborted) {
      failure ??= resolveLlmError('ABORTED')
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      failure ??= { code: 'SERVER', zh: `会话派工失败：${msg}`, action: '请查看日志或稍后重试' }
    }
  }
  // 每成功派一个 prompt 就等于该会话多了一个回合（mode:'queue' 排队执行）
  return { text, failure, sessionId, baseline: base + (accepted ? 1 : 0), model }
}

/** 聚合版（JSON 路由用）：不转发 text 帧，直接要全文。 */
async function askSession(
  ctrl: WriterSessionController,
  opts: {
    title: string
    prompt: string
    signal: AbortSignal
    sessionId?: string
    baseline?: number
    task?: LlmTask
    selection?: ModelRef
  },
): Promise<{ text: string; failure?: LlmErrorInfo; sessionId: string | null; baseline: number; model?: string }> {
  return runSessionSse(ctrl, () => {}, opts)
}

// ------------------------------------------------------------------
// 通用 helpers
// ------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function fail(code: string, message: string, extra?: Record<string, unknown>): Response {
  return json({ ok: false, code, message, ...extra })
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T
  } catch {
    return null
  }
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  })
}

function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function queryOf(request: Request): URLSearchParams {
  return new URL(request.url).searchParams
}

/** 统一错误出口：PublishError / 带 statusCode·code 扩展的 Error / 常规 Error → {ok:false}。 */
function errorResponse(err: unknown): Response {
  if (err instanceof PublishError) {
    return fail(err.code, err.message, err.snippet ? { snippet: err.snippet } : undefined)
  }
  const message = err instanceof Error ? err.message : String(err)
  const ext = err as { statusCode?: unknown; code?: unknown }
  if (typeof ext?.statusCode === 'number') {
    return fail('INVALID_REQUEST', message)
  }
  if (typeof ext?.code === 'string' && ext.code !== '') {
    return fail(ext.code, message)
  }
  return fail('SERVER', message)
}

/** 包一层 try/catch 的 route 声明（buffered body）。 */
function route(
  path: string,
  methods: ReadonlyArray<'GET' | 'POST'>,
  handler: (request: Request) => Promise<Response>,
): ConnectionFetchRoute {
  return {
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      try {
        return await handler(request)
      } catch (err) {
        return errorResponse(err)
      }
    },
  }
}

// ------------------------------------------------------------------
// 查询 helpers（表扫描；记录量级：个人工作台，全表扫足够）
// ------------------------------------------------------------------

interface AccountRec {
  id: string
  name: string
  platform: 'fanqie'
  fanqieUserId?: string
  status: 'active' | 'expired' | 'disabled'
  lastLoginCheckAt: number | null
  createdAt: number
}

function getAccount(domain: WriterDomain, accountId: string): AccountRec | null {
  return domain.table('account').get(accountId) as AccountRec | null
}

function requireAccount(domain: WriterDomain, accountId: string | undefined | null): AccountRec {
  if (!accountId) throw Object.assign(new Error('缺少 accountId 参数'), { statusCode: 400 })
  const acc = getAccount(domain, accountId)
  if (!acc) throw Object.assign(new Error('账号不存在'), { statusCode: 400 })
  return acc
}

interface BookRec {
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
  styleCard: string
  /** 风格原型 id（style.ts；缺省 = 一期通用腔）。 */
  archetype?: string
  /** 叙述契约（人称/限知/时距/时态）。 */
  narrator?: string
  outline: {
    logline: string
    coreConflict: string
    volumes: { index: number; title: string; summary: string }[]
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
      status: 'pending' | 'drafted' | 'finalized'
    }[]
  }
  memorySummary: string
  /** 全局摘要压缩游标与状态（plan ②）。 */
  memoryThroughChapter?: number
  memoryCompressedAt?: number
  memorySummaryStale?: boolean
  createdAt: number
  updatedAt: number
}

function getBook(domain: WriterDomain, bookId: string | undefined | null): BookRec {
  if (!bookId) throw Object.assign(new Error('缺少 bookId 参数'), { statusCode: 400 })
  const book = domain.table('book').get(bookId) as BookRec | null
  if (!book) throw Object.assign(new Error('作品不存在'), { statusCode: 400 })
  return book
}

/** 设定种类白名单归一（请求里的非法值一律归 world）。 */
function settingKind(raw: string | undefined): 'character' | 'world' | 'item' | 'faction' {
  return raw === 'character' || raw === 'item' || raw === 'faction' ? raw : 'world'
}

function settingsOf(domain: WriterDomain, bookId: string): ContextSetting[] {
  return [...domain.table('setting').entries()]
    .map(([, v]) => v)
    .filter(s => s.bookId === bookId)
}

/** 本书全部伏笔（上下文检索输入）。 */
function foreshadowsOf(domain: WriterDomain, bookId: string): ContextForeshadow[] {
  return [...domain.table('foreshadow').entries()]
    .map(([, v]) => v)
    .filter(f => f.bookId === bookId)
}

/** 未回收伏笔行（prompt/续排用）。 */
function openForeshadowLines(domain: WriterDomain, bookId: string): string[] {
  return [...domain.table('foreshadow').entries()]
    .map(([, v]) => v)
    .filter(f => f.bookId === bookId && f.paidAt == null)
    .sort((a, b) => a.plantedAt - b.plantedAt)
    .map(f => `「${f.desc}」（第 ${f.plantedAt} 章埋设${f.suggestPayoffAt != null ? `，建议第 ${f.suggestPayoffAt} 章前后回收` : ''}）`)
}

/** 本章需回收伏笔行：已埋设、未回收、建议回收章 ≤ 本章。 */
function dueForeshadowLines(domain: WriterDomain, bookId: string, no: number): string[] {
  return [...domain.table('foreshadow').entries()]
    .map(([, v]) => v)
    .filter(f => f.bookId === bookId && f.paidAt == null && (f.suggestPayoffAt ?? Infinity) <= no)
    .map(f => `「${f.desc}」（第 ${f.plantedAt} 章埋设）`)
}

interface ChapterRec {
  id: string
  bookId: string
  no: number
  title: string
  content: string
  words: number
  summary?: string
  summaryStale?: boolean
  snapshots: { content: string; words: number; savedAt: number; reason: string }[]
  publishState: 'local' | 'queued' | 'draft' | 'submitted' | 'live' | 'rejected'
  itemId?: string
  hookOk?: boolean
  quality?: Record<string, unknown>
  /** 场景时间锚（定稿回写确认后覆盖；审稿时间连续性依据）。 */
  timeline?: { scene?: string; start: string; gap: string; duration: string; end: string }[]
  createdAt: number
  updatedAt: number
}

function getChapter(domain: WriterDomain, bookId: string, no: number): ChapterRec | null {
  return domain.table('chapter').get(chapterId(bookId, no)) as ChapterRec | null
}

/** 章题规范化：剥掉 LLM 自带的错误「第N章」前缀，统一补正确序号（无题兜底「第N章」）。 */
function normBeatTitle(title: string | undefined, no: number): string {
  const bare = (title ?? '').trim().replace(/^第[0-9〇零一二两三四五六七八九十百千]+章\s*/, '')
  return bare ? `第${no}章 ${bare}` : `第${no}章`
}

/** 启动自愈：补齐历史章纲/章节标题缺失的「第N章」前缀（幂等，改了才写）。 */
async function normalizeBeatTitles(domain: WriterDomain): Promise<void> {
  const books = domain.table('book')
  const chapters = domain.table('chapter')
  for (const [id, b] of [...books.entries()]) {
    let changed = false
    const beats = b.outline.beats.map(x => {
      const t = normBeatTitle(x.title, x.no)
      if (t !== x.title) { changed = true; return { ...x, title: t } }
      return x
    })
    if (changed) await books.update(id, v => ({ ...v, outline: { ...v.outline, beats } }))
    for (const x of beats) {
      const ch = getChapter(domain, b.id, x.no)
      if (!ch) continue
      const t = normBeatTitle(ch.title, x.no)
      if (t !== ch.title) await chapters.update(chapterId(b.id, x.no), v => ({ ...v, title: t }))
    }
  }
}

/** 发布台账记录（quota/发布路由用）。 */
interface PublishLogRec {
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

/** 定稿回写待确认条目。 */
interface PendingRec {
  id: string
  bookId: string
  chapterNo: number
  kind: 'setting' | 'foreshadow' | 'state' | 'summary' | 'knowledge' | 'timeline'
  payload: Record<string, unknown>
  createdAt: number
}

/** 旧稿压栈（保留最近 3 份，一层 undo）；空稿不压。 */
function pushSnapshot(ch: ChapterRec, reason: string): ChapterRec['snapshots'] {
  if (ch.content.trim() === '') return ch.snapshots
  return [...ch.snapshots, { content: ch.content, words: ch.words, savedAt: Date.now(), reason }].slice(-3)
}

/** 空章稿工厂（惰性建章 / 手动保存首次落稿）。 */
function blankChapter(bookId: string, no: number, title: string): ChapterRec {
  return {
    id: chapterId(bookId, no),
    bookId,
    no,
    title,
    content: '',
    words: 0,
    snapshots: [],
    publishState: 'local',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ------------------------------------------------------------------
// 二期支撑：作者档案 / 创作日志 / stale 失效闭环
// ------------------------------------------------------------------

/** 作者档案 global KV 键。 */
const AUTHOR_PROFILE_KEY = 'writer:authorProfile'

function authorProfileOf(domain: WriterDomain): string {
  const v = (domain.global.get() as Record<string, unknown>)[AUTHOR_PROFILE_KEY]
  return typeof v === 'string' ? v : ''
}

/** 创作日志落表（best-effort：日志失败绝不影响主流程）。 */
async function writeLog(
  domain: WriterDomain,
  entry: {
    bookId: string
    no?: number
    stage: 'generate' | 'beats' | 'finalize' | 'review' | 'rewrite'
    ok: boolean
    ms: number
    issueCount?: number
    /** 质量分级（generate/rewrite 阶段）。 */
    grade?: string
    /** 本次调用模型（provider/model，按任务分模型后可见）。 */
    model?: string
    /** prompt 上下文字符数（分层检索后的装配量）。 */
    ctxChars?: number
    err?: string
  },
): Promise<void> {
  try {
    const id = newId('wl')
    await domain.table('log').put(id, { id, ...entry, ts: Date.now() })
  } catch { /* 排障日志，吞错 */ }
}

/**
 * stale 失效闭环：出处章节被重新定稿 / 手动大改 / 删除后，
 * 该章提取的设定与伏笔条目标 stale:true（召回降级 + UI 待复核标记）。
 */
async function markStaleBySource(domain: WriterDomain, bookId: string, no: number): Promise<number> {
  let n = 0
  for (const [sid, s] of [...domain.table('setting').entries()]) {
    if (s.bookId === bookId && s.sourceChapterNo === no && s.stale !== true) {
      await domain.table('setting').put(sid, { ...s, stale: true, updatedAt: Date.now() })
      n++
    }
  }
  for (const [fid, f] of [...domain.table('foreshadow').entries()]) {
    if (f.bookId === bookId && f.sourceChapterNo === no && f.stale !== true) {
      await domain.table('foreshadow').put(fid, { ...f, stale: true })
      n++
    }
  }
  return n
}

/** 大改判定：词数波动超 30% 视为大改（触发 stale 闭环）。 */
function isMajorRewrite(oldContent: string, newContent: string): boolean {
  const oldWords = countWords(oldContent)
  if (oldWords < 200) return false // 短稿波动大，不触发
  return Math.abs(countWords(newContent) - oldWords) / oldWords > 0.3
}

/** 从第一层质检报告提取 AI 味命中词（供审稿 AI 校准，不重复报同位置）。 */
function flavorHitsOf(report: { issues: { code: string; message: string }[] }): string[] {
  return report.issues
    .filter(i => i.code === 'AI_FLAVOR')
    .flatMap(i => i.message.replace('去 AI 味粗筛命中：', '').split('；'))
    .filter(Boolean)
}

// ------------------------------------------------------------------
// 一键成书核心：单章生成 / 单章定稿 / 记忆入册（HTTP 路由与批量路由共用）
// ------------------------------------------------------------------

/** 一键成书任务（按 bookId 常驻：页面断线只取消订阅，不中断生成）。 */
interface BookJob {
  bookId: string
  /** 写到第几章（终点）。 */
  target: number
  /** 从第几章开始（起点，默认 1）。 */
  from: number
  autoMemory: boolean
  refs?: string[]
  signal: AbortController
  startedAt: number
  frames: Record<string, unknown>[]
  subscribers: Set<(frame: Record<string, unknown>) => void>
  done: boolean
}

/** 每本书只保留最近一个任务（含已结束的，供断线后补看结果）。 */
const bookJobs = new Map<string, BookJob>()
/** 帧缓冲上限：够一次重连回放即可，超出丢最旧的。 */
const BOOK_JOB_FRAME_LIMIT = 800

/** 写一帧进任务缓冲并广播给订阅者；done 帧落定后清空订阅。 */
function emitBookJob(job: BookJob, frame: Record<string, unknown>): void {
  if (job.done) return
  job.frames.push(frame)
  if (job.frames.length > BOOK_JOB_FRAME_LIMIT) job.frames.splice(0, job.frames.length - BOOK_JOB_FRAME_LIMIT)
  if (frame['type'] === 'done') job.done = true
  for (const sub of [...job.subscribers]) {
    try { sub(frame) } catch { job.subscribers.delete(sub) }
  }
  if (job.done) job.subscribers.clear()
}

/** 把一次 HTTP 请求接成任务的 SSE 订阅：回放已发生的帧，再实时追加。 */
function bookJobSse(job: BookJob, request: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      let closed = false
      const ping = setInterval(() => push({ type: 'ping', ts: Date.now() }), 15_000)
      function finish(): void {
        if (closed) return
        closed = true
        clearInterval(ping)
        job.subscribers.delete(push)
        try { controller.close() } catch { /* 已断开 */ }
      }
      function push(frame: Record<string, unknown>): void {
        if (closed) return
        try { controller.enqueue(enc.encode(sseEvent(frame))) } catch { closed = true }
        if (frame['type'] === 'done') finish()
      }
      for (const frame of job.frames) push(frame)
      if (job.done) {
        finish()
        return
      }
      job.subscribers.add(push)
      request.signal.addEventListener('abort', finish, { once: true })
    },
  })
  return sseResponse(stream)
}

/** 单章生成结果：ok = 成稿；error = LLM 硬失败/空响应（changed 表示已落部分稿）。 */
type GenerateChapterOutcome =
  | { status: 'ok'; chapter: ChapterRec; quality: ReturnType<typeof analyzeChapter>; sessionId: string | null; baseline: number }
  | { status: 'error'; info: LlmErrorInfo; changed: boolean; sessionId: string | null; baseline: number }

/**
 * 单章生成核心（plan §4.2 装配 + 质量闸）：前情装配 → LLM 生成 → 剥钩子标记
 * → 质检 → 落稿（快照旧稿）→ beat pending→drafted。generate/chapter 路由与
 * 一键成书共用；send 供文本流转发，批量模式传 no-op（askSession 同款）。
 */
async function generateChapterCore(opts: {
  domain: WriterDomain
  ctrl: WriterSessionController
  send: (data: object) => void
  signal: AbortSignal
  sessionId?: string
  baseline?: number
  bookId: string
  no: number
  refs?: string[]
  /** 上一稿质检问题（重写时定向修复）。 */
  repair?: { grade: QualityGrade; issues: QualityIssue[] }
  /** 正文任务模型（plan ③）。 */
  selection?: ModelRef
}): Promise<GenerateChapterOutcome> {
  const { domain, ctrl, send, signal, no } = opts
  const book = getBook(domain, opts.bookId)
  const beat = book.outline.beats.find(b => b.no === no)
  if (!beat) throw Object.assign(new Error(`大纲里没有第 ${no} 章的 beat，请先续排章纲`), { code: 'BEAT_MISSING' })
  const chapters = domain.table('chapter')
  let ch = getChapter(domain, book.id, no)
  if (!ch) {
    ch = blankChapter(book.id, no, beat.title)
    await chapters.put(ch.id, ch)
  }
  // 分层检索：P0 必读 / P1 相关 / P2 背景（context.ts），不再全量注入
  const prev = getChapter(domain, book.id, no - 1)
  const chapterSummaries = [...chapters.entries()].map(([, v]) => v)
    .filter(c => c.bookId === book.id && c.no < no && !!c.summary?.trim())
    .map(c => ({ no: c.no, summary: c.summary as string }))
  const archetype = resolveArchetype(book.archetype ?? '')
  const allSettings = settingsOf(domain, book.id)
  // 显式引用：编辑器「关联设定」标记（只保留真实存在的设定名）
  const knownNames = new Set(allSettings.map(s => s.name))
  const explicitRefs = [...new Set(opts.refs ?? [])].filter(r => typeof r === 'string' && knownNames.has(r))
  const beatCtx: ContextBeat = {
    no,
    title: beat.title,
    beat: beat.beat,
    hook: beat.hook,
    promise: beat.promise,
    uncertainty: beat.uncertainty,
    payoffOf: beat.payoffOf,
  }
  const context = buildChapterContext({
    book: { memorySummary: book.memorySummary, memoryThroughChapter: book.memoryThroughChapter },
    beat: beatCtx,
    settings: allSettings,
    foreshadows: foreshadowsOf(domain, book.id),
    chapterSummaries,
    prevTail: prev?.content ? prev.content.slice(-300) : '',
    explicitRefs,
  })
  const repairNotes = opts.repair?.issues.map(i => `[${i.level}] ${i.code}：${i.message}`)
  const prompt = buildChapterPrompts({
    styleCard: book.styleCard || DEFAULT_STYLE_CARD,
    archetype,
    authorProfile: authorProfileOf(domain),
    narrator: book.narrator ?? '',
    chapterNo: no,
    chapterTitle: ch.title || beat.title,
    beatText: beat.beat,
    hookText: beat.hook,
    promise: beat.promise ?? '',
    uncertainty: beat.uncertainty ?? '',
    isCool: beat.isCool === true,
    targetWords: book.chapterWords,
    goldenRule: goldenRuleFor(no),
    context,
    repairNotes,
  })
  const t0 = Date.now()
  const result = await runSessionSse(ctrl, send, {
    title: `第${no}章：${beat.title}`,
    prompt,
    signal,
    sessionId: opts.sessionId,
    baseline: opts.baseline,
    task: 'write',
    selection: opts.selection,
  })
  const stripped = stripHookMark(result.text)
  const report = analyzeChapter(stripped.content, {
    chapterNo: no,
    hookOk: stripped.hookOk,
    fingerprint: archetype?.fingerprint,
  })
  const info = result.failure
    ?? (stripped.content.trim() === '' ? resolveLlmError('EMPTY_RESPONSE') : undefined)
  const changed = stripped.content.trim() !== '' && stripped.content !== ch.content
  void writeLog(domain, {
    bookId: book.id,
    no,
    stage: 'generate',
    ok: !info,
    ms: Date.now() - t0,
    issueCount: report.issues.length,
    grade: report.grade,
    model: result.model ?? modelLabel(opts.selection),
    ctxChars: prompt.length,
    err: info?.code,
  })
  if (changed) {
    const next: ChapterRec = {
      ...ch,
      content: stripped.content,
      words: report.words,
      snapshots: pushSnapshot(ch, 'regenerate'),
      summaryStale: ch.summary ? true : ch.summaryStale,
      updatedAt: Date.now(),
    }
    if (!info) {
      next.hookOk = stripped.hookOk
      next.quality = report as unknown as Record<string, unknown>
    }
    await chapters.put(next.id, next)
    ch = next
  }
  if (info) return { status: 'error', info, changed, sessionId: result.sessionId, baseline: result.baseline }
  // beat pending → drafted（finalized/drafted 不回退）
  if (beat.status === 'pending') {
    await domain.table('book').update(book.id, b => ({
      ...b,
      outline: { ...b.outline, beats: b.outline.beats.map(x => x.no === no && x.status === 'pending' ? { ...x, status: 'drafted' } : x) },
    }))
  }
  return { status: 'ok', chapter: ch, quality: report, sessionId: result.sessionId, baseline: result.baseline }
}

/** 单章定稿结果：ok = 提取成功并入 pending；fail = LLM 失败/解析失败（保留会话句柄可重试）。 */
type FinalizeChapterOutcome =
  | { status: 'ok'; items: PendingRec[]; extract: NonNullable<ReturnType<typeof parseFinalizeExtract>>; sessionId: string | null; baseline: number }
  | { status: 'fail'; info: LlmErrorInfo; sessionId: string | null; baseline: number }

/**
 * 单章定稿核心：LLM 提取 → pending 待确认区（fail-closed，人工确认才入册）
 * → beat → finalized。chapter/finalize 路由与一键成书共用。
 */
async function finalizeChapterCore(opts: {
  domain: WriterDomain
  ctrl: WriterSessionController
  signal: AbortSignal
  sessionId?: string
  baseline?: number
  bookId: string
  no: number
  /** 辅助任务模型（提取/压缩等，plan ③）。 */
  selection?: ModelRef
}): Promise<FinalizeChapterOutcome> {
  const { domain, ctrl, signal, no } = opts
  const book = getBook(domain, opts.bookId)
  const ch = getChapter(domain, book.id, no)
  if (!ch || ch.content.trim() === '') throw Object.assign(new Error('本章还没有正文，无法定稿'), { code: 'CHAPTER_EMPTY' })
  const pendings = domain.table('pending')
  const prompt = buildFinalizePrompts({
    chapterNo: no,
    chapterTitle: ch.title,
    content: ch.content,
    knownSettings: settingsOf(domain, book.id).map(s => s.name),
  })
  const t0 = Date.now()
  const result = await askSession(ctrl, {
    title: `定稿回写：第${no}章`,
    prompt,
    signal,
    sessionId: opts.sessionId,
    baseline: opts.baseline,
    task: 'utility',
    selection: opts.selection,
  })
  const extract = result.failure ? null : parseFinalizeExtract(result.text)
  if (!extract) {
    const info = result.failure ?? resolveLlmError('MALFORMED_RESPONSE')
    void writeLog(domain, { bookId: book.id, no, stage: 'finalize', ok: false, ms: Date.now() - t0, model: result.model ?? modelLabel(opts.selection), err: info.code })
    return { status: 'fail', info, sessionId: result.sessionId, baseline: result.baseline }
  }
  // 重定稿：本章旧出处条目先失效（新条目确认后重新入册），再替换旧 pending
  await markStaleBySource(domain, book.id, no)
  for (const [pid, p] of [...pendings.entries()]) {
    if (p.bookId === book.id && p.chapterNo === no) await pendings.delete(pid)
  }
  const now = Date.now()
  const items: PendingRec[] = []
  if (extract.summary.trim()) {
    items.push({ id: newId('pd'), bookId: book.id, chapterNo: no, kind: 'summary', payload: { text: extract.summary }, createdAt: now })
  }
  for (const s of extract.characterStateChanges) {
    items.push({ id: newId('pd'), bookId: book.id, chapterNo: no, kind: 'state', payload: { name: s.name, state: s.state, quote: s.quote }, createdAt: now })
  }
  for (const s of extract.newSettings) {
    items.push({ id: newId('pd'), bookId: book.id, chapterNo: no, kind: 'setting', payload: { kind: s.kind, name: s.name, summary: s.summary, tags: s.tags, quote: s.quote }, createdAt: now })
  }
  for (const f of extract.newForeshadows) {
    items.push({ id: newId('pd'), bookId: book.id, chapterNo: no, kind: 'foreshadow', payload: { desc: f.desc, suggestPayoffAt: f.suggestPayoffAt, quote: f.quote }, createdAt: now })
  }
  // 二期：知情更新（入册并入 knownBy）与场景时间锚（入册覆盖 chapter.timeline）
  for (const k of extract.knowledgeUpdates) {
    items.push({ id: newId('pd'), bookId: book.id, chapterNo: no, kind: 'knowledge', payload: { name: k.name, fact: k.fact }, createdAt: now })
  }
  if (extract.timeline.length > 0) {
    items.push({ id: newId('pd'), bookId: book.id, chapterNo: no, kind: 'timeline', payload: { anchors: extract.timeline }, createdAt: now })
  }
  for (const item of items) await pendings.put(item.id, item)
  void writeLog(domain, { bookId: book.id, no, stage: 'finalize', ok: true, ms: Date.now() - t0, model: result.model ?? modelLabel(opts.selection) })
  // beat → finalized
  await domain.table('book').update(book.id, b => ({
    ...b,
    outline: { ...b.outline, beats: b.outline.beats.map(x => x.no === no ? { ...x, status: 'finalized' } : x) },
  }))
  return { status: 'ok', items, extract, sessionId: result.sessionId, baseline: result.baseline }
}

/** 单条待确认记忆入册（按 kind 落表；返回 skipped 原因，最后删除该条）。memory/confirm 路由与一键成书共用。 */
async function applyPendingRec(domain: WriterDomain, pending: PendingRec): Promise<string[]> {
  const skipped: string[] = []
  const books = domain.table('book')
  const settings = domain.table('setting')
  const foreshadows = domain.table('foreshadow')
  const chapters = domain.table('chapter')
  if (pending.kind === 'summary') {
    const text = typeof pending.payload['text'] === 'string' ? pending.payload['text'] : ''
    if (text) {
      // 章摘要落盘（近章召回/复审依据），同时保留 book.memorySummary 作为短期兜底
      const ch = getChapter(domain, pending.bookId, pending.chapterNo)
      if (ch) await chapters.put(ch.id, { ...ch, summary: text, summaryStale: false, updatedAt: Date.now() })
      await books.update(pending.bookId, b => ({ ...b, memorySummary: text, updatedAt: Date.now() }))
    } else {
      skipped.push('摘要内容为空，跳过')
    }
  } else if (pending.kind === 'state') {
    const name = String(pending.payload['name'] ?? '')
    const state = String(pending.payload['state'] ?? '')
    const hit = [...settings.entries()].find(([, s]) => s.bookId === pending.bookId && s.name === name)
    if (hit) {
      const [sid, srec] = hit
      // 出处入册：sourceChapterNo = 确认章号；quote 沿用提取摘录（旧 quote 兜底）
      const quote = typeof pending.payload['quote'] === 'string' && pending.payload['quote']
        ? pending.payload['quote'] : srec.quote
      await settings.put(sid, { ...srec, state, sourceChapterNo: pending.chapterNo, quote, updatedAt: Date.now() })
    } else {
      skipped.push(`设定「${name}」不存在，跳过状态更新`)
    }
  } else if (pending.kind === 'setting') {
    const name = String(pending.payload['name'] ?? '').trim()
    if (!name) {
      skipped.push('设定条目缺名字，跳过')
    } else if ([...settings.entries()].some(([, s]) => s.bookId === pending.bookId && s.name === name)) {
      skipped.push(`设定「${name}」已存在，跳过`)
    } else {
      const sid = newId('st')
      await settings.put(sid, {
        id: sid,
        bookId: pending.bookId,
        kind: settingKind(String(pending.payload['kind'] ?? 'world')),
        name,
        summary: String(pending.payload['summary'] ?? ''),
        tags: Array.isArray(pending.payload['tags']) ? pending.payload['tags'].filter((t): t is string => typeof t === 'string') : [],
        sourceChapterNo: pending.chapterNo,
        quote: typeof pending.payload['quote'] === 'string' && pending.payload['quote'] ? pending.payload['quote'] : undefined,
        updatedAt: Date.now(),
      })
    }
  } else if (pending.kind === 'foreshadow') {
    const desc = String(pending.payload['desc'] ?? '').trim()
    if (!desc) {
      skipped.push('伏笔描述为空，跳过')
    } else {
      const fid = newId('fs')
      await foreshadows.put(fid, {
        id: fid,
        bookId: pending.bookId,
        desc,
        plantedAt: pending.chapterNo,
        suggestPayoffAt: typeof pending.payload['suggestPayoffAt'] === 'number' ? pending.payload['suggestPayoffAt'] : undefined,
        sourceChapterNo: pending.chapterNo,
        quote: typeof pending.payload['quote'] === 'string' && pending.payload['quote'] ? pending.payload['quote'] : undefined,
        createdAt: Date.now(),
      })
    }
  } else if (pending.kind === 'knowledge') {
    // 知情更新：并入角色 knownBy（去重），审稿 KNOWLEDGE_LEAK 的边界依据
    const name = String(pending.payload['name'] ?? '').trim()
    const fact = String(pending.payload['fact'] ?? '').trim()
    const hit = [...settings.entries()].find(([, s]) => s.bookId === pending.bookId && s.name === name)
    if (!name || !fact) {
      skipped.push('知情条目缺角色或事实，跳过')
    } else if (!hit || hit[1].kind !== 'character') {
      skipped.push(`角色「${name}」不存在，跳过知情更新`)
    } else {
      const [sid, srec] = hit
      const knownBy = srec.knownBy ?? []
      if (!knownBy.includes(fact)) knownBy.push(fact)
      await settings.put(sid, { ...srec, knownBy, updatedAt: Date.now() })
    }
  } else if (pending.kind === 'timeline') {
    // 场景时间锚：整章覆盖写 chapter.timeline（start/end 缺失的锚点丢弃）
    const anchors = Array.isArray(pending.payload['anchors']) ? pending.payload['anchors'] : []
    const clean = anchors
      .map(a => a as Record<string, unknown>)
      .filter(a => typeof a['start'] === 'string' && a['start'].trim() && typeof a['end'] === 'string' && a['end'].trim())
      .map(a => ({
        scene: typeof a['scene'] === 'string' && a['scene'].trim() ? a['scene'] as string : undefined,
        start: a['start'] as string,
        gap: typeof a['gap'] === 'string' ? a['gap'] : '',
        duration: typeof a['duration'] === 'string' ? a['duration'] : '',
        end: a['end'] as string,
      }))
    const ch = getChapter(domain, pending.bookId, pending.chapterNo)
    if (!ch) {
      skipped.push('章不存在，跳过时间锚')
    } else {
      await chapters.put(ch.id, { ...ch, timeline: clean, updatedAt: Date.now() })
    }
  }
  await domain.table('pending').delete(pending.id)
  return skipped
}

/**
 * 记忆滚动压缩（plan ②）：memoryThroughChapter 之后累积 ≥5 章时，
 * 用 utility 模型把「旧摘要 + 新章摘要」压成 ≤300 字，写回 book.memorySummary
 * 并推进 memoryThroughChapter；失败 fail-soft（保留旧摘要 + 置 stale），不阻塞成书。
 */
async function compressMemory(opts: {
  domain: WriterDomain
  ctrl: WriterSessionController
  signal: AbortSignal
  bookId: string
  selection?: ModelRef
}): Promise<{ ok: boolean; throughNo: number }> {
  const { domain, ctrl, signal } = opts
  const book = getBook(domain, opts.bookId)
  const through = book.memoryThroughChapter ?? 0
  const pending = [...domain.table('chapter').entries()]
    .map(([, v]) => v as ChapterRec)
    .filter(c => c.bookId === book.id && c.no > through && !!c.summary?.trim())
    .sort((a, b) => a.no - b.no)
  const latestNo = pending.length > 0 ? pending[pending.length - 1].no : through
  if (latestNo - through < 5) return { ok: false, throughNo: through }
  const prompt = buildCompressSummaryPrompts({
    oldSummary: book.memorySummary,
    newSummary: pending.map(c => `第${c.no}章：${c.summary as string}`).join('\n'),
    throughNo: latestNo,
    targetChars: 300,
  })
  const t0 = Date.now()
  const result = await askSession(ctrl, {
    title: `记忆压缩：${book.name}`,
    prompt, signal, task: 'utility', selection: opts.selection,
  })
  const merged = result.failure ? null : parseCompressSummary(result.text)
  const books = domain.table('book')
  if (merged) {
    await books.update(book.id, b => ({
      ...b,
      memorySummary: merged,
      memoryThroughChapter: latestNo,
      memoryCompressedAt: Date.now(),
      memorySummaryStale: false,
      updatedAt: Date.now(),
    }))
  } else {
    await books.update(book.id, b => ({ ...b, memorySummaryStale: true, updatedAt: Date.now() }))
  }
  void writeLog(domain, {
    bookId: book.id, stage: 'finalize', ok: !!merged, ms: Date.now() - t0,
    model: result.model ?? modelLabel(opts.selection),
    err: merged ? undefined : (result.failure?.code ?? 'MALFORMED_RESPONSE'),
  })
  return { ok: !!merged, throughNo: latestNo }
}

// ------------------------------------------------------------------
// 路由表
// ------------------------------------------------------------------

/** 会话 SSE 公共 body。 */
interface SessionBody {
  sessionId?: string
  baseline?: number
}

export function writerRoutes(domain: WriterDomain, ctx: Context, config: WriterConfig): ConnectionFetchRoute[] {
  const sessionCtrl = (): WriterSessionController => {
    const ctrl = (ctx as unknown as { sessionController?: WriterSessionController }).sessionController
    if (!ctrl) throw Object.assign(new Error('dsh 会话服务未就绪'), { code: 'NO_SESSION' })
    return ctrl
  }

  const accounts = domain.table('account')
  const books = domain.table('book')
  const settings = domain.table('setting')
  const foreshadows = domain.table('foreshadow')
  const pendings = domain.table('pending')
  const chapters = domain.table('chapter')
  const publishLogs = domain.table('publish_log')

  // 历史数据自愈：补齐缺失的「第N章」标题前缀（幂等；后台跑不阻塞路由挂载）
  void normalizeBeatTitles(domain).catch(() => { /* 自愈失败不阻塞插件启动 */ })

  return [
    // ---------------- 账号 ----------------

    // dsh fetch 路由表按精确路径注册（同路径两条会 already registered），
    // 同路径多方法必须合并为一条，用 request.method 分流。
    route('/api/writer/accounts', ['GET', 'POST'], async (request) => {
      if (request.method === 'GET') {
        const list = [...accounts.entries()].map(([, v]) => v)
          .sort((a, b) => a.createdAt - b.createdAt)
        return json({ ok: true, data: list })
      }
      const body = await readJson<{ name?: string }>(request) ?? {}
      const count = [...accounts.entries()].length
      const account: AccountRec = {
        id: newId('acc'),
        name: body.name?.trim() || `番茄账号 ${count + 1}`,
        platform: 'fanqie',
        status: 'expired', // 未登录（扫码后回填 active）
        lastLoginCheckAt: null,
        createdAt: Date.now(),
      }
      await accounts.put(account.id, account)
      return json({ ok: true, data: account })
    }),

    route('/api/writer/accounts/remove', ['POST'], async (request) => {
      const body = await readJson<{ accountId?: string }>(request)
      const account = requireAccount(domain, body?.accountId)
      const writing = [...books.entries()].some(([, b]) => b.accountId === account.id && b.status === 'writing')
      if (writing) return fail('ACCOUNT_HAS_BOOKS', '该账号还有「写作中」的作品，请先完成或改状态后再移除')
      await browserPool.close(account.id)
      await accounts.delete(account.id)
      return json({ ok: true })
    }),

    // ---------------- 番茄：登录 / 书单 ----------------

    // 扫码登录（SSE）：stage 帧推进度 → done/error 帧。
    route('/api/writer/fanqie/login', ['POST'], async (request) => {
      const body = await readJson<{ accountId?: string }>(request)
      const account = requireAccount(domain, body?.accountId)
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          let closed = false
          const send = (data: object): void => {
            if (closed) return
            try {
              controller.enqueue(enc.encode(sseEvent(data)))
            } catch { /* 流已断 */ }
          }
          try {
            const result = await runLoginFlow({
              accountId: account.id,
              config,
              signal: request.signal,
              stage: (stage, message) => send({ type: 'stage', stage, message }),
            })
            await accounts.put(account.id, {
              ...account,
              status: 'active',
              fanqieUserId: result.fanqieUserId ?? account.fanqieUserId,
              lastLoginCheckAt: Date.now(),
            })
            send({ type: 'done' })
          } catch (err) {
            // 成功路径已在 runLoginFlow 内关窗；失败/取消/超时也关窗兜底
            await browserPool.close(account.id).catch(() => {})
            const isTimeout = err instanceof LoginTimeout
            const isCancel = err instanceof LoginCancelled || request.signal.aborted
            send({
              type: 'error',
              code: isCancel ? 'ABORTED' : isTimeout ? 'LOGIN_TIMEOUT' : 'LOGIN_FAILED',
              message: err instanceof Error ? err.message : String(err),
            })
          } finally {
            closed = true
            controller.close()
          }
        },
      })
      return sseResponse(stream)
    }),

    // 登录态检测：更新账号状态；结果本身是数据（loggedIn），不算错误。
    route('/api/writer/fanqie/login-status', ['GET'], async (request) => {
      const account = requireAccount(domain, queryOf(request).get('accountId'))
      try {
        const result = await browserPool.withPage(account.id, browserOpts(config), page => probeLogin(page))
        await accounts.put(account.id, {
          ...account,
          status: 'active',
          fanqieUserId: result.fanqieUserId ?? account.fanqieUserId,
          lastLoginCheckAt: Date.now(),
        })
        return json({ ok: true, data: { loggedIn: true } })
      } catch (err) {
        if (isLoginExpired(err)) {
          await accounts.put(account.id, { ...account, status: 'expired', lastLoginCheckAt: Date.now() })
          return json({ ok: true, data: { loggedIn: false } })
        }
        throw err
      }
    }),

    // 平台书单（绑定用）
    route('/api/writer/fanqie/works', ['GET'], async (request) => {
      const account = requireAccount(domain, queryOf(request).get('accountId'))
      const list = await browserPool.withPage(account.id, browserOpts(config), async page => {
        await gotoWriterHome(page)
        return fetchBookList(page)
      })
      return json({ ok: true, data: list })
    }),

    // ---------------- 作品 ----------------

    route('/api/writer/books', ['GET', 'POST'], async (request) => {
      if (request.method === 'GET') {
        const accountId = queryOf(request).get('accountId')
        const list = [...books.entries()].map(([, v]) => v)
          .filter(b => !accountId || b.accountId === accountId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
        return json({ ok: true, data: list })
      }
      const body = await readJson<{
        accountId?: string
        name?: string
        genre?: string
        intro?: string
        chapterWords?: number
        targetWords?: number
        styleCard?: string
        archetype?: string
        narrator?: string
        outline?: {
          logline?: string
          coreConflict?: string
          volumes?: { index: number; title: string; summary: string }[]
          beats?: {
            no: number
            title?: string
            beat?: string
            hook?: string
            promise?: string
            uncertainty?: string
            payoffOf?: number
            isCool?: boolean
            isClimax?: boolean
          }[]
        }
        settings?: { kind?: string; name?: string; summary?: string; tags?: string[] }[]
      }>(request) ?? {}
      const account = requireAccount(domain, body.accountId)
      if (!body.name?.trim() || !body.genre?.trim()) {
        return fail('INVALID_REQUEST', '书名与题材必填')
      }
      const now = Date.now()
      const book: BookRec = {
        id: newId('bk'),
        accountId: account.id,
        name: body.name.trim(),
        genre: body.genre.trim(),
        intro: body.intro?.trim() ?? '',
        status: 'planning',
        chapterWords: body.chapterWords && body.chapterWords > 0 ? Math.floor(body.chapterWords) : 2400,
        targetWords: body.targetWords && body.targetWords > 0 ? Math.floor(body.targetWords) : undefined,
        styleCard: body.styleCard?.trim() || DEFAULT_STYLE_CARD,
        archetype: parseArchetypeId(body.archetype),
        narrator: body.narrator?.trim() || undefined,
        outline: {
          logline: body.outline?.logline ?? '',
          coreConflict: body.outline?.coreConflict ?? '',
          volumes: body.outline?.volumes ?? [],
          // beats 一律从 pending 起（状态只能由生成/定稿流程推进，客户端不可伪造）
          beats: (body.outline?.beats ?? [])
            .filter(b => b && typeof b.no === 'number' && typeof b.beat === 'string')
            .map(b => ({
              no: b.no,
              title: b.title?.trim() || `第${b.no}章`,
              beat: b.beat as string,
              hook: b.hook?.trim() || '章末留钩子',
              promise: b.promise?.trim() || undefined,
              uncertainty: b.uncertainty?.trim() || undefined,
              payoffOf: typeof b.payoffOf === 'number' && b.payoffOf > 0 ? Math.floor(b.payoffOf) : undefined,
              isCool: b.isCool === true,
              isClimax: b.isClimax === true,
              status: 'pending' as const,
            }))
            .sort((a, b) => a.no - b.no),
        },
        memorySummary: '',
        createdAt: now,
        updatedAt: now,
      }
      await books.put(book.id, book)
      for (const s of body.settings ?? []) {
        if (!s?.name?.trim()) continue
        const sid = newId('st')
        await settings.put(sid, {
          id: sid,
          bookId: book.id,
          kind: settingKind(s.kind),
          name: s.name.trim(),
          summary: s.summary ?? '',
          tags: Array.isArray(s.tags) ? s.tags : [],
          updatedAt: now,
        })
      }
      return json({ ok: true, data: book })
    }),

    // 作品详情：book + settings + foreshadows + pending（工作台一次拉全）
    route('/api/writer/book', ['GET'], async (request) => {
      const book = getBook(domain, queryOf(request).get('id'))
      const setts = settingsOf(domain, book.id).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      const fores = [...foreshadows.entries()].map(([, v]) => v)
        .filter(f => f.bookId === book.id)
        .sort((a, b) => a.plantedAt - b.plantedAt)
      const pends = [...pendings.entries()].map(([, v]) => v)
        .filter(p => p.bookId === book.id)
        .sort((a, b) => a.createdAt - b.createdAt)
      return json({ ok: true, data: { book, settings: setts, foreshadows: fores, pending: pends } })
    }),

    // 作品更新：常规字段 patch + 续排确认（appendBeats）+ 开新卷确认（newVolume）
    route('/api/writer/book/update', ['POST'], async (request) => {
      const body = await readJson<{
        id?: string
        patch?: {
          name?: string
          genre?: string
          intro?: string
          status?: 'planning' | 'writing' | 'finished'
          chapterWords?: number
          targetWords?: number | null
          styleCard?: string
          archetype?: string | null
          narrator?: string
          fanqieBookId?: string | null
          fanqieVolumeId?: string
          memorySummary?: string
        }
        appendBeats?: {
          no: number
          title?: string
          beat?: string
          hook?: string
          promise?: string
          uncertainty?: string
          payoffOf?: number
          isCool?: boolean
          isClimax?: boolean
        }[]
        newVolume?: { title?: string; summary?: string }
      }>(request) ?? {}
      const book = getBook(domain, body.id)
      const patch = body.patch ?? {}
      const next: BookRec = { ...book, updatedAt: Date.now() }
      if (patch.name?.trim()) next.name = patch.name.trim()
      if (patch.genre?.trim()) next.genre = patch.genre.trim()
      if (patch.intro != null) next.intro = patch.intro
      if (patch.status) next.status = patch.status
      if (typeof patch.chapterWords === 'number' && patch.chapterWords > 0) next.chapterWords = Math.floor(patch.chapterWords)
      if (patch.targetWords === null) next.targetWords = undefined
      else if (typeof patch.targetWords === 'number' && patch.targetWords > 0) next.targetWords = Math.floor(patch.targetWords)
      if (patch.styleCard?.trim()) next.styleCard = patch.styleCard
      // 原型：null/'' 清除（回通用腔）；非法 id 忽略
      if (patch.archetype === null || patch.archetype === '') next.archetype = undefined
      else if (typeof patch.archetype === 'string') {
        const aid = parseArchetypeId(patch.archetype)
        if (aid) next.archetype = aid
      }
      if (patch.narrator != null) next.narrator = patch.narrator.trim() || undefined
      if (patch.memorySummary != null) next.memorySummary = patch.memorySummary
      if (patch.fanqieBookId != null) {
        const fbId = String(patch.fanqieBookId)
        if (fbId === '') {
          // 解绑同时清分卷
          next.fanqieBookId = undefined
          next.fanqieVolumeId = undefined
        } else {
          const taken = [...books.entries()].some(([, b]) =>
            b.id !== book.id && b.accountId === book.accountId && b.fanqieBookId === fbId)
          if (taken) return fail('BOOK_ID_TAKEN', '该平台书已绑定到本账号的另一部作品')
          next.fanqieBookId = fbId
        }
      }
      if (patch.fanqieVolumeId) next.fanqieVolumeId = patch.fanqieVolumeId
      // 续排确认：追加 beat（跳过已存在的 no，状态强制 pending）
      if (Array.isArray(body.appendBeats) && body.appendBeats.length > 0) {
        const existing = new Set(next.outline.beats.map(b => b.no))
        const addition = body.appendBeats
          .filter(b => b && typeof b.no === 'number' && typeof b.beat === 'string' && !existing.has(b.no))
          .map(b => ({
            no: b.no,
            title: b.title?.trim() || `第${b.no}章`,
            beat: b.beat as string,
            hook: b.hook?.trim() || '章末留钩子',
            promise: b.promise?.trim() || undefined,
            uncertainty: b.uncertainty?.trim() || undefined,
            payoffOf: typeof b.payoffOf === 'number' && b.payoffOf > 0 ? Math.floor(b.payoffOf) : undefined,
            isCool: b.isCool === true,
            isClimax: b.isClimax === true,
            status: 'pending' as const,
          }))
        next.outline = {
          ...next.outline,
          beats: [...next.outline.beats, ...addition].sort((a, b) => a.no - b.no),
        }
      }
      // 开新卷确认
      if (body.newVolume?.title?.trim()) {
        next.outline = {
          ...next.outline,
          volumes: [...next.outline.volumes, {
            index: next.outline.volumes.length + 1,
            title: body.newVolume.title.trim(),
            summary: body.newVolume.summary ?? '',
          }],
        }
      }
      await books.put(book.id, next)
      return json({ ok: true, data: next })
    }),

    // ---------------- 章节 ----------------

    // 章列表（不含正文，正文按章拉取）
    route('/api/writer/chapters', ['GET'], async (request) => {
      const bookId = queryOf(request).get('bookId')
      getBook(domain, bookId)
      const list = [...chapters.entries()].map(([, v]) => v)
        .filter(c => c.bookId === bookId)
        .sort((a, b) => a.no - b.no)
        .map(c => ({ ...c, content: undefined }))
      return json({ ok: true, data: list })
    }),

    route('/api/writer/chapter', ['GET'], async (request) => {
      const q = queryOf(request)
      const bookId = q.get('bookId')
      const no = Number(q.get('no'))
      if (!bookId || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'bookId 与 no 必填')
      getBook(domain, bookId)
      return json({ ok: true, data: getChapter(domain, bookId, no) })
    }),

    // 手动保存：旧稿压快照（manual，保留 3）；正文变化后旧摘要标 stale
    route('/api/writer/chapter/save', ['POST'], async (request) => {
      const body = await readJson<{ bookId?: string; no?: number; title?: string; content?: string }>(request) ?? {}
      const book = getBook(domain, body.bookId)
      const no = body.no
      if (typeof no !== 'number' || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'no 必填')
      const beat = book.outline.beats.find(b => b.no === no)
      const ch = getChapter(domain, book.id, no) ?? blankChapter(book.id, no, beat?.title ?? `第${no}章`)
      const next: ChapterRec = { ...ch, updatedAt: Date.now() }
      if (typeof body.title === 'string' && body.title.trim()) next.title = body.title.trim()
      if (typeof body.content === 'string' && body.content !== ch.content) {
        next.content = body.content
        next.words = countWords(body.content)
        next.snapshots = pushSnapshot(ch, 'manual')
        if (ch.summary) next.summaryStale = true
        // 大改（词数波动 >30%）→ 该章出处条目失效，待人工复核
        if (isMajorRewrite(ch.content, body.content)) await markStaleBySource(domain, book.id, no)
      }
      await chapters.put(next.id, next)
      return json({ ok: true, data: next })
    }),

    route('/api/writer/chapter/delete', ['POST'], async (request) => {
      const body = await readJson<{ bookId?: string; no?: number }>(request) ?? {}
      const book = getBook(domain, body.bookId)
      const no = body.no
      if (typeof no !== 'number' || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'no 必填')
      const ch = getChapter(domain, book.id, no)
      if (!ch) return json({ ok: true })
      if (ch.publishState !== 'local') return fail('CHAPTER_PUBLISHED', '该章已进入发布流程，不能删除')
      await chapters.delete(ch.id)
      // 该章出处的设定/伏笔条目失效（内容已不存在，待人工处理）
      await markStaleBySource(domain, book.id, no)
      // beat 回退 drafted → pending
      if (book.outline.beats.find(b => b.no === no)?.status === 'drafted') {
        await books.update(book.id, b => ({
          ...b,
          outline: { ...b.outline, beats: b.outline.beats.map(x => x.no === no && x.status === 'drafted' ? { ...x, status: 'pending' } : x) },
        }))
      }
      return json({ ok: true })
    }),

    // ---------------- LLM 生成（SSE）----------------

    // 大纲类：wizard（新书向导）/ more（卷内续排）/ volume（开新卷）。
    // 产出一律是「提案」：不落库，客户端确认后走 POST /books 或 /book/update。
    route('/api/writer/generate/outline', ['POST'], async (request) => {
      const body = await readJson<SessionBody & {
        kind?: 'wizard' | 'more' | 'volume'
        genre?: string
        idea?: string
        style?: string
        pace?: string
        bookId?: string
        startNo?: number
        count?: number
      }>(request) ?? {}
      const kind = body.kind ?? 'wizard'
      let title = '新书向导'
      let prompt = ''
      let withVolume = false
      if (kind === 'wizard') {
        if (!body.genre?.trim() || !body.idea?.trim()) return fail('INVALID_REQUEST', 'genre 与 idea 必填')
        title = `新书向导：${body.idea.trim().slice(0, 12)}`
        prompt = buildWizardPrompts({ genre: body.genre.trim(), idea: body.idea.trim(), style: body.style ?? '', pace: body.pace ?? '' })
      } else {
        const book = getBook(domain, body.bookId)
        const maxNo = book.outline.beats.reduce((m, b) => Math.max(m, b.no), 0)
        const startNo = typeof body.startNo === 'number' && body.startNo > 0 ? Math.floor(body.startNo) : maxNo + 1
        const count = Math.min(Math.max(Math.floor(body.count ?? 12), 1), 30)
        const opens = openForeshadowLines(domain, book.id)
        if (kind === 'more') {
          title = `续排章纲：${book.name}`
          prompt = buildMoreBeatsPrompts({
            bookName: book.name,
            genre: book.genre,
            logline: book.outline.logline,
            coreConflict: book.outline.coreConflict,
            memorySummary: book.memorySummary,
            recentBeats: book.outline.beats.slice(-5)
              .map(b => `- 第${b.no}章《${b.title}》：${b.beat}${b.status !== 'pending' ? '（已成稿）' : ''}`),
            openForeshadows: opens,
            startNo,
            count,
          })
        } else {
          withVolume = true
          title = `开新卷：${book.name}`
          prompt = buildNewVolumePrompts({
            bookName: book.name,
            genre: book.genre,
            logline: book.outline.logline,
            coreConflict: book.outline.coreConflict,
            memorySummary: book.memorySummary,
            recentBeats: [],
            openForeshadows: opens,
            startNo,
            count: 12,
            volumeIndex: book.outline.volumes.length + 1,
            finishedVolumes: book.outline.volumes.map(v => `第${v.index}卷《${v.title}》：${v.summary}`),
          })
        }
      }
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          let closed = false
          const send = (data: object): void => {
            if (closed) return
            try { controller.enqueue(enc.encode(sseEvent(data))) } catch { /* 流已断 */ }
          }
          try {
            const t0 = Date.now()
            const result = await runSessionSse(sessionCtrl(), send, {
              title, prompt, signal: request.signal, sessionId: body.sessionId, baseline: body.baseline,
              task: 'utility', selection: resolveModelRef('utility', domain, config),
            })
            const proposal: WizardProposal | BeatsProposal | null = kind === 'wizard'
              ? parseWizardProposal(result.text)
              : parseBeatsProposal(result.text, withVolume)
            if (result.failure || !proposal) {
              const info = result.failure ?? resolveLlmError('MALFORMED_RESPONSE')
              void writeLog(domain, { bookId: body.bookId ?? '', stage: 'beats', ok: false, ms: Date.now() - t0, err: info.code })
              send({ type: 'error', code: info.code, message: info.zh, action: info.action })
            } else {
              void writeLog(domain, { bookId: body.bookId ?? '', stage: 'beats', ok: true, ms: Date.now() - t0 })
              send({ type: 'done', proposal, sessionId: result.sessionId, baseline: result.baseline })
            }
          } catch (err) {
            const ext = err as { code?: unknown }
            send({
              type: 'error',
              code: typeof ext?.code === 'string' ? ext.code : 'SERVER',
              message: err instanceof Error ? err.message : String(err),
            })
          } finally {
            closed = true
            controller.close()
          }
        },
      })
      return sseResponse(stream)
    }),

    // 逐章生成（plan §4.2 装配 + 质量闸）：
    // 成功 → 快照旧稿、写新稿、beat pending→drafted、done{chapter,quality}；
    // 失败但有部分文本 → 同样落稿（可续写），发 error{partial:true}。
    route('/api/writer/generate/chapter', ['POST'], async (request) => {
      const body = await readJson<SessionBody & { bookId?: string; no?: number; refs?: string[] }>(request) ?? {}
      const book = getBook(domain, body.bookId)
      const no = body.no
      if (typeof no !== 'number' || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'no 必填')
      if (!book.outline.beats.some(b => b.no === no)) return fail('BEAT_MISSING', `大纲里没有第 ${no} 章的 beat，请先续排章纲`)
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          let closed = false
          const send = (data: object): void => {
            if (closed) return
            try { controller.enqueue(enc.encode(sseEvent(data))) } catch { /* 流已断 */ }
          }
          try {
            const out = await generateChapterCore({
              domain, ctrl: sessionCtrl(), send, signal: request.signal,
              sessionId: body.sessionId, baseline: body.baseline, bookId: book.id, no, refs: body.refs,
              selection: resolveModelRef('write', domain, config),
            })
            if (out.status === 'error') {
              send({ type: 'error', code: out.info.code, message: out.info.zh, action: out.info.action, partial: out.changed })
            } else {
              send({ type: 'done', chapter: out.chapter, quality: out.quality, sessionId: out.sessionId, baseline: out.baseline })
            }
          } catch (err) {
            const ext = err as { code?: unknown }
            send({
              type: 'error',
              code: typeof ext?.code === 'string' ? ext.code : 'SERVER',
              message: err instanceof Error ? err.message : String(err),
            })
          } finally {
            closed = true
            controller.close()
          }
        },
      })
      return sseResponse(stream)
    }),

    // ---------------- 一键成书（批量）----------------

    // 自动循环：续排章纲 → 逐章生成（词数/钩子不达标重试 1 次）→ 定稿回写
    // → 记忆自动入册。任务脱离页面常驻：断线只取消订阅，重进页面可接回进度；
    // 已 finalized 的章直接跳过 → 天然断点续跑。
    route('/api/writer/generate/book', ['POST'], async (request) => {
      const body = await readJson<{ bookId?: string; target?: number; from?: number; autoMemory?: boolean; refs?: string[] }>(request) ?? {}
      const book = getBook(domain, body.bookId)
      const target = Math.min(Math.max(Math.floor(body.target ?? 100), 1), 300)
      // 区间起点：默认 1；越界收敛到 [1, target]（from > target 时收为 target）
      const from = Math.min(Math.max(Math.floor(body.from ?? 1), 1), target)
      const autoMemory = body.autoMemory !== false
      // 同一本书已有任务在跑 → 直接接上（重复点击 / 刷新页面都幂等），不新开
      const current = bookJobs.get(book.id)
      let job: BookJob
      if (current && !current.done) {
        job = current
      } else {
        job = {
          bookId: book.id, target, from, autoMemory, refs: body.refs,
          signal: new AbortController(), startedAt: Date.now(),
          frames: [], subscribers: new Set(), done: false,
        }
        bookJobs.set(book.id, job)
        // 执行体脱离本次请求：页面断线只断开订阅，生成继续跑
        void (async () => {
          const request = { signal: job.signal.signal }
          const send = (data: object): void => emitBookJob(job, data as Record<string, unknown>)
          let generated = 0
          let skipped = 0
          let words = 0
          let failures = 0
          // 质量不达标跳过的章数（不计入 failStreak，避免文风问题误杀整卷任务）
          let qualityFailures = 0
          // 按任务分模型（plan ③）：正文 / 辅助；未配置则为 undefined（沿用默认模型）
          const writeRef = resolveModelRef('write', domain, config)
          const utilityRef = resolveModelRef('utility', domain, config)
          // 连续失败熔断：单章故障只跳过不计致命，连败 3 章大概率系统性问题（quota/服务），才终止
          const FAIL_STREAK_LIMIT = 3
          let failStreak = 0
          try {
            const already = getBook(domain, book.id).outline.beats
              .filter(b => b.no >= from && b.no <= target && b.status === 'finalized').length
            send({ type: 'plan', target, from, already })
            for (let no = from; no <= target; no++) {
              if (request.signal.aborted) break
              // 每轮取新书态（续纲会改 outline）
              let cur = getBook(domain, book.id)
              let beat = cur.outline.beats.find(b => b.no === no)
              // 缺纲：自动续排（复用 outline/more 的 prompt 与 appendBeats 合并语义）
              if (!beat) {
                const maxNo = cur.outline.beats.reduce((m, b) => Math.max(m, b.no), 0)
                const count = Math.min(Math.max(target - maxNo, 1), 30)
                send({ type: 'beats/start', from: maxNo + 1, count })
                const t0 = Date.now()
                const result = await askSession(sessionCtrl(), {
                  title: `续排章纲：${cur.name}`,
                  prompt: buildMoreBeatsPrompts({
                    bookName: cur.name,
                    genre: cur.genre,
                    logline: cur.outline.logline,
                    coreConflict: cur.outline.coreConflict,
                    memorySummary: cur.memorySummary,
                    recentBeats: cur.outline.beats.slice(-5)
                      .map(b => `- 第${b.no}章《${b.title}》：${b.beat}${b.status !== 'pending' ? '（已成稿）' : ''}`),
                    openForeshadows: openForeshadowLines(domain, cur.id),
                    startNo: maxNo + 1,
                    count,
                  }),
                  signal: request.signal,
                  task: 'utility',
                  selection: utilityRef,
                })
                const proposal = result.failure ? null : parseBeatsProposal(result.text, false)
                if (!proposal || proposal.beats.length === 0) {
                  if (request.signal.aborted) break
                  const info = result.failure ?? resolveLlmError('MALFORMED_RESPONSE')
                  void writeLog(domain, { bookId: cur.id, stage: 'beats', ok: false, ms: Date.now() - t0, model: result.model ?? modelLabel(utilityRef), err: info.code })
                  send({ type: 'error', code: info.code, message: `续排章纲失败：${info.zh}`, fatal: true })
                  break
                }
                void writeLog(domain, { bookId: cur.id, stage: 'beats', ok: true, ms: Date.now() - t0, model: result.model ?? modelLabel(utilityRef) })
                const before = cur.outline.beats.length
                await books.update(cur.id, bk => {
                  const existing = new Set(bk.outline.beats.map(x => x.no))
                  const addition = proposal.beats
                    .filter(x => x && typeof x.no === 'number' && typeof x.beat === 'string' && !existing.has(x.no))
                    .map(x => ({
                      no: x.no,
                      title: normBeatTitle(x.title, x.no),
                      beat: x.beat as string,
                      hook: x.hook?.trim() || '章末留钩子',
                      promise: x.promise?.trim() || undefined,
                      uncertainty: x.uncertainty?.trim() || undefined,
                      payoffOf: typeof x.payoffOf === 'number' && x.payoffOf > 0 ? Math.floor(x.payoffOf) : undefined,
                      isCool: x.isCool === true,
                      isClimax: x.isClimax === true,
                      status: 'pending' as const,
                    }))
                  return {
                    ...bk,
                    outline: { ...bk.outline, beats: [...bk.outline.beats, ...addition].sort((a, y) => a.no - y.no) },
                  }
                })
                cur = getBook(domain, book.id)
                send({ type: 'beats/done', added: cur.outline.beats.length - before })
                beat = cur.outline.beats.find(b => b.no === no)
                if (!beat) {
                  send({ type: 'error', code: 'BEATS_MISMATCH', message: `续纲后仍没有第 ${no} 章的 beat，停止`, fatal: true })
                  break
                }
              }
              // 已定稿 → 跳过（断点续跑）
              if (beat.status === 'finalized') {
                skipped++
                send({ type: 'chapter/skip', no, index: no, target })
                continue
              }
              // 已成稿且有正文（上次定稿失败）→ 不重写，直接补定稿
              const existingCh = getChapter(domain, book.id, no)
              const needGen = !(beat.status === 'drafted' && existingCh != null && existingCh.content.trim() !== '')
              let retried = 0
              /** 质量门槛：低于 config.quality.minGrade 才返工（默认 silver，即 bronze/reject 返工）。 */
              const minRank = GRADE_RANK[config.quality.minGrade]
              if (needGen) {
                send({ type: 'chapter/start', no, title: beat.title, index: no, target })
                // 同章重试沿用会话（LLM 可见上一稿）；跨章新会话（prompt 自带前情装配）
                let chSess: { sessionId?: string; baseline?: number } = {}
                let out: GenerateChapterOutcome | null = null
                let grade: QualityGrade | null = null
                let repair: { grade: QualityGrade; issues: QualityIssue[] } | undefined
                let rewriteCount = 0
                let errorRetries = 0
                let verdict: 'accept' | 'reject' | 'fail' = 'fail'
                while (true) {
                  if (request.signal.aborted) break
                  try {
                    out = await generateChapterCore({
                      domain, ctrl: sessionCtrl(), send: () => {}, signal: request.signal,
                      sessionId: chSess.sessionId, baseline: chSess.baseline, bookId: cur.id, no,
                      refs: body.refs, repair, selection: writeRef,
                    })
                  } catch {
                    // 网络抖动等瞬时异常按失败处理，不毁掉整卷任务
                    if (request.signal.aborted) break
                    out = null
                  }
                  if (out) chSess = { sessionId: out.sessionId ?? undefined, baseline: out.baseline }
                  if (request.signal.aborted) break
                  if (!out || out.status === 'error') {
                    // 硬失败（空响应/LLM 错误）：瞬时异常最多补跑 1 次
                    if (errorRetries < 1) {
                      errorRetries++
                      retried = rewriteCount + errorRetries
                      send({ type: 'chapter/retry', no, reason: out?.info.code ?? 'SERVER', grade, attempt: retried })
                      await sleep(1500, request.signal)
                      continue
                    }
                    verdict = 'fail'
                    break
                  }
                  grade = out.quality.grade
                  // 字数硬闸：低于目标章字数 80% 视为未完成（与分级无关，一并进定向重写）
                  const wordsFloor = Math.max(1000, Math.floor(cur.chapterWords * 0.8))
                  const wordsOk = out.quality.words >= wordsFloor
                  // 达标即接受；否则按 GRADE_POLICIES 做定向重写（repair 带上一稿 issues）
                  if (GRADE_RANK[grade] >= minRank && wordsOk) {
                    verdict = 'accept'
                    break
                  }
                  const budget = Math.min(GRADE_POLICIES[grade].maxRewrites, config.quality.maxRewrites)
                  if (rewriteCount >= budget) {
                    // 预算用尽：策略可接受且字数落到 70% 兜底线以上 → 接受，否则跳过本章
                    const tolerable = GRADE_POLICIES[grade].accept
                      && out.quality.words >= Math.max(1000, Math.floor(cur.chapterWords * 0.7))
                    verdict = tolerable ? 'accept' : 'reject'
                    break
                  }
                  rewriteCount++
                  retried = rewriteCount
                  repair = {
                    grade,
                    issues: wordsOk ? out.quality.issues : [...out.quality.issues, {
                      level: 'warn', code: 'WORDS_SHORT',
                      message: `正文仅 ${out.quality.words} 字，未达下限 ${wordsFloor} 字：扩写情节、动作与对话（禁止注水），不要提前收束本章`,
                    }],
                  }
                  send({ type: 'chapter/retry', no, reason: wordsOk ? grade : 'WORDS_SHORT', grade, attempt: rewriteCount })
                  await sleep(1500, request.signal)
                }
                if (request.signal.aborted) break
                if (verdict === 'reject') {
                  // 质量不达标跳过：计 qualityFailures，不进入 failStreak 熔断（避免文风问题误杀整卷）
                  qualityFailures++
                  send({
                    type: 'chapter/reject', no, grade,
                    words: out?.status === 'ok' ? out.quality.words : 0,
                    issues: out?.status === 'ok' ? out.quality.issues.length : 0,
                    index: no, target,
                  })
                  send({ type: 'chapter/skip', no, index: no, target, reason: 'QUALITY_REJECT' })
                  continue
                }
                if (verdict === 'fail' || !out || out.status !== 'ok') {
                  failures++
                  failStreak++
                  const failed = out && out.status === 'error' ? out : null
                  const code = failed?.info.code ?? 'SERVER'
                  const zh = failed?.info.zh ?? '未知错误'
                  if (failStreak >= FAIL_STREAK_LIMIT) {
                    send({ type: 'error', code, message: `连续 ${failStreak} 章失败（第 ${no} 章：${zh}），暂停任务；已完成的章已保存，稍后可继续`, fatal: true })
                    break
                  }
                  send({ type: 'error', code, message: `第 ${no} 章生成失败：${zh}，跳过继续`, fatal: false })
                  continue
                }
                generated++
                words += out.quality.words
                failStreak = 0
                if (rewriteCount > 0) {
                  send({ type: 'chapter/accept', no, grade, acceptedAfterRewrites: rewriteCount, words: out.quality.words, index: no, target })
                }
                send({
                  type: 'chapter/done', no, words: out.quality.words,
                  hookOk: out.chapter.hookOk, issues: out.quality.issues.length,
                  retried, grade, index: no, target,
                })
              }
              if (request.signal.aborted) break
              // 定稿回写 + 记忆自动入册（单章失败不致命，继续下一章；连败才熔断）
              send({ type: 'finalize/start', no })
              let fout: FinalizeChapterOutcome
              try {
                fout = await finalizeChapterCore({
                  domain, ctrl: sessionCtrl(), signal: request.signal, bookId: cur.id, no,
                  selection: utilityRef,
                })
              } catch (err) {
                if (request.signal.aborted) break
                failures++
                failStreak++
                if (failStreak >= FAIL_STREAK_LIMIT) {
                  send({ type: 'error', code: 'SERVER', message: `连续 ${failStreak} 章失败（第 ${no} 章定稿：${err instanceof Error ? err.message : String(err)}），暂停任务；已完成的章已保存，稍后可继续`, fatal: true })
                  break
                }
                send({ type: 'finalize/fail', no, code: 'SERVER', message: err instanceof Error ? err.message : String(err) })
                continue
              }
              if (fout.status === 'fail') {
                failures++
                failStreak++
                if (failStreak >= FAIL_STREAK_LIMIT) {
                  send({ type: 'error', code: fout.info.code, message: `连续 ${failStreak} 章失败（第 ${no} 章定稿：${fout.info.zh}），暂停任务；已完成的章已保存，稍后可继续`, fatal: true })
                  break
                }
                send({ type: 'finalize/fail', no, code: fout.info.code, message: fout.info.zh })
                continue
              }
              failStreak = 0
              let applied = 0
              if (autoMemory) {
                for (const item of fout.items) {
                  try {
                    await applyPendingRec(domain, item)
                    applied++
                  } catch { /* 单条失败不阻塞成书 */ }
                }
              }
              send({ type: 'finalize/done', no, applied, total: fout.items.length })
              // 记忆滚动压缩（每累积 5 章一次；失败 fail-soft，不阻塞成书）
              if (autoMemory && !request.signal.aborted) {
                try {
                  const cres = await compressMemory({
                    domain, ctrl: sessionCtrl(), signal: request.signal, bookId: book.id,
                    selection: utilityRef,
                  })
                  if (cres.ok) send({ type: 'memory/compress', throughNo: cres.throughNo })
                } catch { /* 压缩失败不阻塞成书 */ }
              }
            }
            // 全部定稿 → 收官
            let finished = false
            if (!request.signal.aborted) {
              const fin = getBook(domain, book.id)
              const inRange = fin.outline.beats.filter(b => b.no >= 1 && b.no <= target)
              if (inRange.length >= target && inRange.every(b => b.status === 'finalized')) {
                if (fin.status !== 'finished') {
                  await books.update(book.id, b => ({ ...b, status: 'finished', updatedAt: Date.now() }))
                }
                finished = true
              }
            }
            send({ type: 'done', target, generated, skipped, words, failures, qualityFailures, aborted: request.signal.aborted, finished })
          } catch (err) {
            if (request.signal.aborted) {
              send({ type: 'done', target, generated, skipped, words, failures, qualityFailures, aborted: true, finished: false })
            } else {
              const ext = err as { code?: unknown }
              send({
                type: 'error',
                code: typeof ext?.code === 'string' ? ext.code : 'SERVER',
                message: err instanceof Error ? err.message : String(err),
                fatal: true,
              })
              send({ type: 'done', target, generated, skipped, words, failures, qualityFailures, aborted: false, finished: false })
            }
          } finally {
            // 兜底：任何异常路径都补一发 done，避免订阅者挂死
            if (!job.done) {
              send({ type: 'done', target, generated, skipped, words, failures, qualityFailures, aborted: job.signal.signal.aborted, finished: false })
            }
          }
        })()
      }
      return bookJobSse(job, request)
    }),

    route('/api/writer/generate/book/follow', ['GET'], async (request) => {
      const job = bookJobs.get(queryOf(request).get('bookId') ?? '')
      if (!job) return fail('NO_JOB', '没有正在运行或刚结束的一键成书任务')
      return bookJobSse(job, request)
    }),

    route('/api/writer/generate/book/status', ['GET'], async (request) => {
      const job = bookJobs.get(queryOf(request).get('bookId') ?? '')
      if (!job) return json({ ok: true, data: { running: false } })
      return json({ ok: true, data: { running: !job.done, target: job.target, startedAt: job.startedAt } })
    }),

    route('/api/writer/generate/book/stop', ['POST'], async (request) => {
      const body = await readJson<{ bookId?: string }>(request) ?? {}
      const job = bookJobs.get(body.bookId ?? '')
      if (!job || job.done) return json({ ok: true, data: { stopped: false } })
      job.signal.abort()
      return json({ ok: true, data: { stopped: true } })
    }),

    // 定稿回写（JSON 路由）：提取 → pending 待确认区（人工确认才入册，fail-closed）。
    // LLM 失败走 {ok:true,data:{fail,...}} 保留会话句柄，客户端可重试。
    route('/api/writer/chapter/finalize', ['POST'], async (request) => {
      const body = await readJson<SessionBody & { bookId?: string; no?: number }>(request) ?? {}
      const book = getBook(domain, body.bookId)
      const no = body.no
      if (typeof no !== 'number' || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'no 必填')
      const ch = getChapter(domain, book.id, no)
      if (!ch || ch.content.trim() === '') return fail('CHAPTER_EMPTY', '本章还没有正文，无法定稿')
      const out = await finalizeChapterCore({
        domain, ctrl: sessionCtrl(), signal: request.signal,
        sessionId: body.sessionId, baseline: body.baseline, bookId: book.id, no,
        selection: resolveModelRef('utility', domain, config),
      })
      if (out.status === 'fail') {
        return json({ ok: true, data: { fail: out.info, sessionId: out.sessionId, baseline: out.baseline } })
      }
      return json({
        ok: true,
        data: { pending: out.items, extract: out.extract, sessionId: out.sessionId, baseline: out.baseline },
      })
    }),

    // 记忆确认：approve=false 仅删除；approve=true 按 kind 入册后删除。
    route('/api/writer/memory/confirm', ['POST'], async (request) => {
      const body = await readJson<{ pendingId?: string; approve?: boolean }>(request) ?? {}
      if (!body.pendingId) return fail('INVALID_REQUEST', '缺少 pendingId')
      const pending = pendings.get(body.pendingId) as PendingRec | null
      if (!pending) return fail('INVALID_REQUEST', '待确认条目不存在（可能已确认过）')
      if (body.approve === false) {
        await pendings.delete(pending.id)
        return json({ ok: true, data: { applied: null, skipped: [] } })
      }
      const skipped = await applyPendingRec(domain, pending)
      return json({ ok: true, data: { applied: pending.kind, skipped } })
    }),

    // ---------------- 审稿合并（二期 §11.5）----------------

    // LLM 审稿：合并「AI 味 + 不确定密度 + 连续性」三类，单次同步 askSession。
    // 第一层（词表/统计粗筛）在生成时已跑；这里做需要上下文与判断的第二层，
    // 结果合并写 chapter.quality.review（issue 带 evidence，block 只留事实错误）。
    route('/api/writer/review', ['POST'], async (request) => {
      const body = await readJson<SessionBody & { bookId?: string; no?: number }>(request) ?? {}
      const book = getBook(domain, body.bookId)
      const no = body.no
      if (typeof no !== 'number' || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'no 必填')
      const ch = getChapter(domain, book.id, no)
      if (!ch || ch.content.trim() === '') return fail('CHAPTER_EMPTY', '本章还没有正文，无法审稿')
      const archetype = resolveArchetype(book.archetype ?? '')
      // 第一层粗筛（按原型指纹校准），统计与词表命中注入审稿 prompt 供校准（不重复报）
      const report = analyzeChapter(ch.content, { chapterNo: no, hookOk: ch.hookOk, fingerprint: archetype?.fingerprint })
      // 近 3 章时间锚与前情摘要（连续性审校依据）
      const recentTimelines: { no: number; anchors: NonNullable<ChapterRec['timeline']> }[] = []
      const recentSummaries: { no: number; summary: string }[] = []
      for (let i = no - 1; i >= Math.max(1, no - 3); i--) {
        const prev = getChapter(domain, book.id, i)
        if (!prev) continue
        if (prev.timeline && prev.timeline.length > 0) recentTimelines.push({ no: i, anchors: prev.timeline })
        if (prev.summary && prev.summary.trim() !== '') recentSummaries.push({ no: i, summary: prev.summary })
      }
      const reviewCtx = buildReviewContext({ content: ch.content, settings: settingsOf(domain, book.id) })
      const prompt = buildReviewPrompts({
        chapterNo: no,
        chapterTitle: ch.title,
        content: ch.content,
        archetype,
        firstLayer: { stats: report.stats, flavorHits: flavorHitsOf(report) },
        settings: reviewCtx.settings.map(s => ({ kind: s.kind, name: s.name, summary: s.summary, knownBy: s.knownBy })),
        otherSettingNames: reviewCtx.otherNames,
        recentTimelines,
        recentSummaries,
      })
      const t0 = Date.now()
      const result = await askSession(sessionCtrl(), {
        title: `审稿：第${no}章`,
        prompt,
        signal: request.signal,
        sessionId: body.sessionId,
        baseline: body.baseline,
        task: 'review',
        selection: resolveModelRef('review', domain, config),
      })
      const review = result.failure ? null : parseReviewResult(result.text)
      if (!review) {
        const info = result.failure ?? resolveLlmError('MALFORMED_RESPONSE')
        void writeLog(domain, { bookId: book.id, no, stage: 'review', ok: false, ms: Date.now() - t0, model: result.model ?? modelLabel(resolveModelRef('review', domain, config)), err: info.code })
        return json({ ok: true, data: { fail: info, sessionId: result.sessionId, baseline: result.baseline } })
      }
      // 合并写回：审稿结果挂 chapter.quality.review；旧稿从无质检底 → 先铺第一层结果
      const blockCount = review.issues.filter(i => i.level === 'block').length
      const warnCount = review.issues.filter(i => i.level === 'warn').length
      const prevQuality = ch.quality as { passed?: unknown } | undefined
      const reviewedAt = Date.now()
      const quality: Record<string, unknown> = {
        ...(prevQuality && typeof prevQuality.passed === 'boolean'
          ? prevQuality
          : (report as unknown as Record<string, unknown>)),
        review: { ...review, blockCount, warnCount, reviewedAt },
      }
      await chapters.put(ch.id, { ...ch, quality, updatedAt: reviewedAt })
      void writeLog(domain, { bookId: book.id, no, stage: 'review', ok: true, ms: reviewedAt - t0, issueCount: review.issues.length, model: result.model ?? modelLabel(resolveModelRef('review', domain, config)) })
      return json({ ok: true, data: { review: { ...review, blockCount, warnCount, reviewedAt }, quality, sessionId: result.sessionId, baseline: result.baseline } })
    }),

    // ---------------- 支撑面：日志 / 导出 / 作者档案（二期 §11.6/§11.7）----------------

    // 创作日志：stage/耗时/issue 数/错误码一览（ts 降序，最近 200 条）。
    route('/api/writer/logs', ['GET'], async (request) => {
      const bookId = queryOf(request).get('bookId') ?? ''
      const logs = [...domain.table('log').entries()]
        .map(([, v]) => v as { id: string; bookId: string; no?: number; stage: string; ok: boolean; ms: number; issueCount?: number; err?: string; ts: number })
        .filter(l => l.bookId === bookId)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 200)
      return json({ ok: true, data: { logs } })
    }),

    // ---------------- 按任务分模型（plan ③）----------------

    // 读/写模型分工：global KV writer:llmModels 覆盖插件 config；未配置 = 跟随默认。
    route('/api/writer/llm/config', ['GET', 'POST'], async (request) => {
      const llmSvc = (ctx as unknown as {
        llm?: {
          listProviders?(): { id: string; name?: string }[]
          listModels?(provider: string): Promise<{ id: string; name?: string }[]>
        }
      }).llm
      if (request.method === 'GET') {
        return json({
          ok: true,
          data: {
            current: modelConfigOf(domain, config),
            available: !!(llmSvc?.listModels),
            providers: llmSvc?.listProviders?.() ?? [],
          },
        })
      }
      const body = await readJson<Record<string, unknown>>(request) ?? {}
      const store: Record<string, unknown> = {}
      for (const task of ['write', 'review', 'utility'] as const) {
        const v = body[task]
        if (v === undefined || v === null) continue
        const ref = asModelRef(v)
        if (!ref) return fail('INVALID_REQUEST', `${task} 需提供非空 provider/model`)
        store[task] = ref
      }
      const cur = (domain.global.get() as Record<string, unknown>)[LLM_MODELS_KEY]
      const base: Record<string, unknown> = cur && typeof cur === 'object' ? { ...cur as Record<string, unknown> } : {}
      for (const task of ['write', 'review', 'utility'] as const) {
        if (body[task] === null) delete base[task]
        else if (store[task]) base[task] = store[task]
      }
      await domain.global.set({ ...(domain.global.get() as Record<string, unknown>), [LLM_MODELS_KEY]: base })
      return json({ ok: true, data: { current: modelConfigOf(domain, config) } })
    }),

    // 模型目录：ctx 未注入 llm 时返回 available:false，前端退化为手填 provider/model。
    route('/api/writer/llm/models', ['GET'], async (request) => {
      const llmSvc = (ctx as unknown as { llm?: { listModels?(provider: string): Promise<{ id: string; name?: string }[]> } }).llm
      const provider = queryOf(request).get('provider') ?? ''
      if (!llmSvc?.listModels || !provider) return json({ ok: true, data: { available: false, models: [] } })
      try {
        const models = await llmSvc.listModels(provider)
        return json({ ok: true, data: { available: true, models: models.map(m => ({ id: m.id, name: m.name ?? m.id })) } })
      } catch (err) {
        return json({ ok: true, data: { available: false, models: [], message: err instanceof Error ? err.message : String(err) } })
      }
    }),

    // 导出：md（人读全稿）/ json（全量备份），附件下载（中文文件名 RFC 5987）。
    route('/api/writer/book/export', ['GET'], async (request) => {
      const q = queryOf(request)
      const book = getBook(domain, q.get('bookId'))
      const format = q.get('format') === 'json' ? 'json' : 'md'
      const settingRows = settingsOf(domain, book.id).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      const foreRows = [...domain.table('foreshadow').entries()]
        .map(([, v]) => v)
        .filter(f => f.bookId === book.id)
        .sort((a, b) => a.plantedAt - b.plantedAt)
      const chapterRows = [...domain.table('chapter').entries()]
        .map(([, v]) => v as ChapterRec)
        .filter(c => c.bookId === book.id)
        .sort((a, b) => a.no - b.no)
      const safeName = encodeURIComponent(`${book.name}.${format}`)
      const headers = { 'content-disposition': `attachment; filename*=UTF-8''${safeName}` }
      if (format === 'json') {
        const payload = { book, settings: settingRows, foreshadows: foreRows, chapters: chapterRows }
        return new Response(JSON.stringify(payload, null, 2), {
          headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
        })
      }
      const lines: string[] = []
      lines.push(`# ${book.name}`, '')
      lines.push(`- 题材：${book.genre}`)
      lines.push(`- 简介：${book.intro}`)
      lines.push(`- 单章字数：约 ${book.chapterWords}`)
      if (book.archetype) lines.push(`- 风格原型：${book.archetype}`)
      if (book.narrator) lines.push(`- 叙述契约：${book.narrator}`)
      lines.push('', '## 一句话', book.outline.logline, '', '## 核心冲突', book.outline.coreConflict, '')
      if (book.outline.volumes.length > 0) {
        lines.push('## 卷纲', '')
        for (const v of book.outline.volumes) lines.push(`### 卷${v.index} ${v.title}`, v.summary, '')
      }
      if (book.outline.beats.length > 0) {
        lines.push('## 章节 beat', '')
        lines.push('| 章 | 标题 | beat | 钩子 | 承诺 | 不确定性 | 回收 | 状态 |', '|---|---|---|---|---|---|---|---|')
        for (const b of book.outline.beats) {
          const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
          lines.push(`| ${b.no} | ${cell(b.title)} | ${cell(b.beat)} | ${cell(b.hook)} | ${cell(b.promise ?? '')} | ${cell(b.uncertainty ?? '')} | ${b.payoffOf ?? ''} | ${b.status} |`)
        }
        lines.push('')
      }
      if (settingRows.length > 0) {
        lines.push('## 设定', '')
        for (const s of settingRows) lines.push(`- 【${s.kind}】${s.name}：${s.summary}${s.stale === true ? '（待复核）' : ''}`)
        lines.push('')
      }
      if (foreRows.length > 0) {
        lines.push('## 伏笔', '')
        for (const f of foreRows) lines.push(`- 「${f.desc}」（第 ${f.plantedAt} 章埋${f.paidAt != null ? `，第 ${f.paidAt} 章收` : '，未回收'}）`)
        lines.push('')
      }
      for (const c of chapterRows) {
        if (c.content.trim() === '') continue
        lines.push(`## 第${c.no}章 ${c.title}`, '', c.content.trim(), '')
      }
      return new Response(lines.join('\n'), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers },
      })
    }),

    // 作者档案：文风装配第二层（跨书复用的个人写作偏好），global KV 持久化。
    route('/api/writer/profile', ['GET', 'POST'], async (request) => {
      if (request.method === 'POST') {
        const body = await readJson<{ authorProfile?: string }>(request) ?? {}
        const text = typeof body.authorProfile === 'string' ? body.authorProfile : ''
        await domain.global.set({ ...(domain.global.get() as Record<string, unknown>), [AUTHOR_PROFILE_KEY]: text })
        return json({ ok: true, data: { authorProfile: text } })
      }
      return json({ ok: true, data: { authorProfile: authorProfileOf(domain) } })
    }),

    // 风格原型库摘要（建书向导选择 UI 用；不含 prompt/few-shot 内部层）。
    route('/api/writer/archetypes', ['GET'], async () => {
      return json({ ok: true, data: { archetypes: archetypeSummaries() } })
    }),

    // ---------------- 番茄：发布 / 对账 ----------------

    // 发布（plan §5）：质量闸 → 幂等 → 额度 → 浏览器提交 → 台账记账。
    // 合规红线：逐章人工触发（无批量）、同章已发布拒绝覆盖。
    route('/api/writer/fanqie/publish', ['POST'], async (request) => {
      const body = await readJson<{
        accountId?: string
        bookId?: string
        chapterNo?: number
        mode?: 'draft' | 'now'
        force?: boolean
      }>(request) ?? {}
      const account = requireAccount(domain, body.accountId)
      const book = getBook(domain, body.bookId)
      if (book.accountId !== account.id) return fail('BOOK_BOUND_TO_OTHER_ACCOUNT', '作品不属于该账号')
      if (!book.fanqieBookId) return fail('BOOK_NOT_BOUND', '作品尚未绑定平台书，请先在发布页完成绑定')
      const fbId: string = book.fanqieBookId
      const no = body.chapterNo
      if (typeof no !== 'number' || !Number.isInteger(no) || no <= 0) return fail('INVALID_REQUEST', 'chapterNo 必填')
      const mode = body.mode
      if (mode !== 'draft' && mode !== 'now') return fail('INVALID_REQUEST', 'mode 必须是 draft 或 now')
      const ch = getChapter(domain, book.id, no)
      if (!ch || ch.content.trim() === '') return fail('CHAPTER_EMPTY', '本章还没有正文')
      // 质量闸：优先用生成时的质检结果，否则现场重算（未过闸 fail-closed 拒发）
      const savedQuality = ch.quality as { passed?: boolean } | undefined
      const quality = savedQuality && typeof savedQuality.passed === 'boolean'
        ? savedQuality
        : analyzeChapter(ch.content, { chapterNo: no, hookOk: ch.hookOk, fingerprint: resolveArchetype(book.archetype ?? '')?.fingerprint })
      if (quality.passed !== true) {
        return fail('QUALITY_GATE', '本章未通过质量闸，请先在编辑器处理质检问题', { quality })
      }
      const words = ch.words > 0 ? ch.words : countWords(ch.content)
      // 幂等：同章同稿已成功 → 拒绝重复提交
      const key = idempotencyKey(account.id, book.id, no, ch.content)
      const dup = findSuccessLog(domain, key)
      if (dup) {
        return fail('DUPLICATE_SUBMIT', '该章同内容已发布成功，请勿重复提交', { logId: dup.id, itemId: dup.itemId })
      }
      // 同章已有别的成功版本 → 一期不支持覆盖已发布章节
      const latest = findLatestLog(domain, account.id, book.id, no)
      if (latest?.status === 'success') {
        return fail('CHAPTER_ALREADY_PUBLISHED', '该章已有已发布版本，一期不支持覆盖已发布章节')
      }
      // 额度（存草稿箱不占额度；force 跳过校验，台账照记）
      if (mode === 'now' && body.force !== true) {
        const check = checkQuota(domain, account.id, config, words, book.id)
        if (!check.ok) {
          return fail('QUOTA_EXCEEDED', check.message, { reason: check.reason, usage: check.usage })
        }
      }
      let createdDraft: { itemId: string; volumeId: string } | null = null
      try {
        const done = await browserPool.withPage(account.id, browserOpts(config), async page => {
          await gotoWriterHome(page)
          let itemId = ch!.itemId ?? ''
          let volumeId = book.fanqieVolumeId ?? ''
          // 建稿复用：上次失败的 itemId 直接续用（不留空草稿排）
          if (itemId === '') {
            createdDraft = await createArticle(page, fbId, volumeId || undefined)
            itemId = createdDraft.itemId
            volumeId = createdDraft.volumeId
          }
          if (volumeId === '') {
            const volumes = await fetchVolumes(page, fbId)
            volumeId = volumes[0]?.volumeId ?? ''
            if (volumeId === '') throw new PublishError('DOM_CHANGED', '作品没有可用分卷')
          }
          await publishArticle(page, { itemId, volumeId, no, title: ch!.title, content: ch!.content, mode })
          return { itemId, volumeId }
        })
        const nextCh: ChapterRec = {
          ...ch!,
          itemId: done.itemId,
          publishState: mode === 'now' ? 'submitted' : 'draft',
          updatedAt: Date.now(),
        }
        await chapters.put(nextCh.id, nextCh)
        if (book.fanqieVolumeId !== done.volumeId) {
          await books.update(book.id, b => ({ ...b, fanqieVolumeId: done.volumeId }))
        }
        const log: PublishLogRec = {
          id: newId('pl'),
          accountId: account.id,
          bookId: book.id,
          chapterNo: no,
          itemId: done.itemId,
          mode,
          words,
          status: 'success',
          idempotencyKey: key,
          ts: Date.now(),
        }
        await publishLogs.put(log.id, log)
        return json({ ok: true, data: { chapter: nextCh, log } })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 闭包内的赋值不参与外层 CFA：按声明类型读回（建稿已发生 → itemId 落库，重试复用）
        const draft = createdDraft as { itemId: string; volumeId: string } | null
        if (draft && !ch!.itemId) {
          const draftId = draft.itemId
          await chapters.update(ch!.id, c => ({ ...c, itemId: draftId, updatedAt: Date.now() }))
        }
        // 失败也记账（failed 不占额度，供台账展示与排查）
        const logId = newId('pl')
        await publishLogs.put(logId, {
          id: logId,
          accountId: account.id,
          bookId: book.id,
          chapterNo: no,
          itemId: draft?.itemId,
          mode,
          words,
          status: 'failed',
          idempotencyKey: key,
          error: message.slice(0, 500),
          ts: Date.now(),
        })
        if (isLoginExpired(err)) {
          await accounts.put(account.id, { ...account, status: 'expired', lastLoginCheckAt: Date.now() })
        }
        throw err // 统一走 errorResponse → {ok:false, code}
      }
    }),

    // 状态对账：平台章节列表命中 itemId → submitted 升级 live（保守口径，草稿不对账）
    route('/api/writer/fanqie/sync', ['POST'], async (request) => {
      const body = await readJson<{ accountId?: string; bookId?: string }>(request) ?? {}
      const account = requireAccount(domain, body.accountId)
      const book = getBook(domain, body.bookId)
      if (book.accountId !== account.id) return fail('BOOK_BOUND_TO_OTHER_ACCOUNT', '作品不属于该账号')
      if (!book.fanqieBookId) return fail('BOOK_NOT_BOUND', '作品尚未绑定平台书')
      const fbId: string = book.fanqieBookId
      const remote = await browserPool.withPage(account.id, browserOpts(config), async page => {
        await gotoWriterHome(page)
        return fetchChapterList(page, fbId)
      })
      const remoteIds = new Set(remote.map(c => c.itemId))
      const updated: ChapterRec[] = []
      for (const c of [...chapters.entries()].map(([, v]) => v)) {
        if (c.bookId !== book.id) continue
        if (c.publishState === 'submitted' && c.itemId && remoteIds.has(c.itemId)) {
          const next: ChapterRec = { ...c, publishState: 'live', updatedAt: Date.now() }
          await chapters.put(next.id, next)
          updated.push(next)
        }
      }
      return json({ ok: true, data: { updated, remoteCount: remote.length } })
    }),

    // ---------------- 配额台账 ----------------

    route('/api/writer/quota', ['GET'], async (request) => {
      const accountId = queryOf(request).get('accountId')
      const limits = {
        dailyWordLimit: config.publish.dailyWordLimit,
        monthlyWordLimit: config.publish.monthlyWordLimit,
        dailyUpdateWorksLimit: config.publish.dailyUpdateWorksLimit,
      }
      if (accountId) {
        const account = requireAccount(domain, accountId)
        return json({
          ok: true,
          data: { accountId: account.id, name: account.name, usage: quotaUsage(domain, account.id), limits },
        })
      }
      const list = [...accounts.entries()].map(([, v]) => v)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(a => ({ accountId: a.id, name: a.name, usage: quotaUsage(domain, a.id), limits }))
      return json({ ok: true, data: { accounts: list } })
    }),

    // 标记返还：仅「立即发布成功」的记录；refunded 不占额度
    route('/api/writer/quota/refund', ['POST'], async (request) => {
      const body = await readJson<{ logId?: string }>(request) ?? {}
      if (!body.logId) return fail('INVALID_REQUEST', '缺少 logId')
      const log = publishLogs.get(body.logId) as PublishLogRec | null
      if (!log) return fail('INVALID_REQUEST', '台账记录不存在')
      if (log.mode !== 'now' || log.status !== 'success') {
        return fail('INVALID_REQUEST', '仅「立即发布成功」的记录可以标记返还')
      }
      const next: PublishLogRec = { ...log, status: 'refunded' }
      await publishLogs.put(next.id, next)
      return json({ ok: true, data: next })
    }),

    // ---------------- 浏览器 ----------------

    route('/api/writer/browser/close-all', ['POST'], async () => {
      await browserPool.closeAll()
      return json({ ok: true })
    }),
  ]
}
