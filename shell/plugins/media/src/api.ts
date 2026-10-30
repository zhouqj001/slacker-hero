/**
 * /api/media/* route table — registered on the shared /api channel through
 * `ctx.connection.fetch.register`. Routes match the FULL request pathname
 * (verified against the harness: `fetchRoutes.get(url.pathname)`), so paths
 * here include the `/api` prefix.
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { z } from 'zod'
import {
  MEDIA_TABLES,
  HotspotSchema,
  ArticleSchema,
  PlanSchema,
  PublishSchema,
  ReviewSchema,
  type MediaDomain,
} from './domain.ts'
import type { MediaConfig } from './config.ts'
import {
  buildArticlePrompts,
  buildDispatchPrompts,
  parseDispatchJson,
  buildNlParsePrompts,
  parseNlJson,
  buildPlanChatPrompts,
  parsePlanChatJson,
  resolveLlmError,
  rewriteArticle,
  type LlmErrorInfo,
  type NlParseKind,
  type NlTurn,
  type PlanChatSnapshot,
  type PlanProposal,
} from './llm.ts'
import { refreshHotspots, scoreHotspot, scoreHotspotsBatch, type Persona } from './topics.ts'
import { buildStatsSentence, computeStats } from './review.ts'
import { accountBrief, personaAlignment } from './alignment.ts'
import {
  articleAssetRoute, assetRoute, assetsListRoute, cleanupAssets, illustrateArticle,
  illustrateSpots, listFigureRefs, listFigureSpots, redrawFigures, type IllustrateProgress,
} from './assets.ts'
import { IMAGE_PRESETS, imageAdapterStatus, imageGenRuntime } from './imagegen.ts'
import { browserPool } from './platforms/browser.ts'
import { resolveVideoAdapter, videoAdapterStatus } from './videogen.ts'
import {
  suggestWorkspaceRoot,
  workspaceRoot,
  setWorkspaceRoot,
  syncWorkspace,
  writeArticleFile,
  writePlatformFile,
  writePlanFile,
  articlePersona,
  resolveCoverFile,
  articleAssetDir,
} from './workspace.ts'
import { getAdapter } from './platforms/wechat.ts'
import { PublishError, type Account, type AccountWork, type PublishAdapter } from './platforms/types.ts'

/** dsh sessionController 服务最小结构面（仅用到的能力；运行时由 inject 注入，不引入类型包依赖）。 */
interface MediaSessionController {
  create(request: { sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string }>
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
    event?: { type: string; data: unknown }
    records?: ReadonlyArray<{ type: string; event?: { type: string; data: unknown } }>
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

/**
 * 通过 dsh 会话跑一次问答（复用 dsh 默认模型与凭据），返回聚合后的助手文本。
 * 与文章生成走同一条路线：媒体工作台不直连 provider（避免 search 代理 / 缺 Key 的 502）。
 *
 * 支持**会话复用**：调用方把上一轮返回的 sessionId + baseline 传回来，则续用同一会话
 * （多轮对话在 dsh 里是同一个会话，而不是每问一句就新建一个）。
 * `baseline` = 该会话在本轮之前已完成的回合数；`follow` 的首帧会**重放历史**，
 * 用 baseline 把历史 turn/end 全部划掉，避免误判「本轮已结束」而取到上一轮的旧文本；
 * 只有快照里第 baseline 个之后的 assistant/message 与 turn/end 才算本轮的。
 *
 * 失败返回 failure（fail-closed），不静默兜底。返回的 baseline 可直接用于下一轮调用。
 */
async function askSession(
  ctrl: MediaSessionController,
  opts: { title: string; prompt: string; signal: AbortSignal; sessionId?: string; baseline?: number },
): Promise<{ text: string; failure?: LlmErrorInfo; sessionId: string | null; baseline: number; accepted: boolean }> {
  const base = opts.baseline ?? 0
  let sessionId = opts.sessionId ?? null
  let accepted = false
  let text = ''
  let failure: LlmErrorInfo | undefined
  try {
    if (sessionId === null) {
      const created = await ctrl.create({})
      sessionId = created.sessionId
      try {
        await ctrl.rename({ sessionId, title: opts.title })
      } catch { /* 命名失败不阻塞问答 */ }
    }
    await ctrl.prompt({
      requestId: `media-ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: opts.prompt }],
    }, opts.signal)
    accepted = true
    let endsSeen = 0
    const handle = (evType: string, evData: unknown, live: boolean): boolean => {
      if (evType === 'assistant/message') {
        const t = assistantTextFromEvent(evData)
        // 历史回合里的旧回答不采纳（会污染本轮）；只有过了 baseline 或实时帧才算本轮回答
        if (t.trim() !== '' && (live || endsSeen >= base)) text = t
        return false
      }
      if (evType === 'turn/end') {
        endsSeen++
        if (endsSeen <= base) return false // 快照重放的历史回合，跳过
        const info = turnEndFailure((evData as { reason?: unknown }).reason)
        if (info) failure ??= info
        return true
      }
      return false
    }
    const frames = ctrl.follow({ address: { kind: 'session', sessionId } }, opts.signal)
    let ended = false
    for await (const frame of frames) {
      if (frame.type === 'snapshot') {
        for (const rec of frame.records ?? []) {
          if (rec.type === 'event' && rec.event && handle(rec.event.type, rec.event.data, false)) {
            ended = true
            break
          }
        }
      } else if (frame.type === 'event' && frame.event) {
        if (handle(frame.event.type, frame.event.data, true)) ended = true
      }
      if (ended) break
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
  // accepted=false 表示 prompt 没被接受（典型：复用的会话在 dsh 重启后已不存在）——调用方据此降级重试
  return { text, failure, sessionId, baseline: base + (accepted ? 1 : 0), accepted }
}

/** Shared prefix of every media route below the /api channel. */
const ROUTE_PREFIX = '/api/media'

/** JSON response helper. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** 读取 request JSON body（buffered 模式）。 */
async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return await request.json() as T
  } catch {
    return null
  }
}

/** 构造 SSE Response。 */
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

/** SSE 消息信封。 */
function sseEvent(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/** 生成带前缀的记录 id。 */
function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 按岗位顺序排人设（order 小者在前，updatedAt 兜底）。 */
function sortedPersonas(domain: MediaDomain): Persona[] {
  return [...domain.table('persona').entries()].map(([, v]) => v)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || b.updatedAt - a.updatedAt)
}

/** 取当前在岗人设（排序后第一条）；无人设时返回 null。 */
function firstPersona(domain: MediaDomain): Persona | null {
  return sortedPersonas(domain)[0] ?? null
}

/** 人设 <-> 账号 1:1：取某账号绑定的人设；未绑定返回 null。 */
function personaOfAccount(domain: MediaDomain, accountId: string | undefined): Persona | null {
  if (!accountId) return null
  const all = [...domain.table('persona').entries()].map(([, v]) => v)
  return all.find(p => p.accountId === accountId) ?? null
}

/** 通用兜底人设（账号未绑人设、或没有账号上下文时使用）。 */
function genericPersona(): Persona {
  return {
    id: '_default', name: '默认（未绑定人设）', positioning: '通用内容创作者',
    tone: '平实专业', audience: '大众', taboos: [], tags: [], updatedAt: 0,
  }
}

/**
 * 读某个人设视角下的契合度：新评分按 personaId 存 personaFits；
 * 旧数据只有 personaFit 单值，视为通用人设（'_default'）的评分。
 */
function fitOf(hotspot: HotspotRec, personaId: string): { score: number; reason: string; scoredAt: number } | undefined {
  return hotspot.personaFits?.[personaId] ?? (personaId === '_default' ? hotspot.personaFit : undefined)
}

/** 跨所有人设取最高契合分（feed 简报排序用）；一份评分都没有返回 undefined。 */
function bestFitScore(hotspot: HotspotRec): number | undefined {
  const scores = [hotspot.personaFit?.score ?? 0, ...Object.values(hotspot.personaFits ?? {}).map(f => f.score)]
  const best = Math.max(...scores)
  return best > 0 ? best : undefined
}

/** 本地日期键 YYYY-MM-DD（配额按天）。 */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 周期起点/终点与中文标签（账号发布目标用）。
 * week = 本周一 00:00 起；month = 本月 1 日 00:00 起。终点为左闭右开。
 */
function periodStart(period: 'week' | 'month', now = new Date()): { from: number; to: number; label: string } {
  if (period === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
    return { from, to, label: '本月' }
  }
  const dow = (now.getDay() + 6) % 7 // 周一 = 0
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).getTime()
  return { from, to: from + 7 * 86400_000, label: '本周' }
}

/**
 * 本期该账号成功发布篇数。
 * 只数 publish 表里 state='success' 且 publishedAt 落在周期内的**真实记录**——
 * 半自动待确认 / 降级人工（publishedAt 为 null）一律不计，也不按计划数推算。
 */
function publishedInPeriod(domain: MediaDomain, accountId: string, period: 'week' | 'month'): number {
  const { from, to } = periodStart(period)
  let n = 0
  for (const [, p] of domain.table('publish').entries()) {
    if (
      p.accountId === accountId &&
      p.state === 'success' &&
      p.publishedAt !== null &&
      p.publishedAt >= from &&
      p.publishedAt < to
    ) n++
  }
  return n
}

/**
 * 本期「已排但未发布」的计划：发布目标的排期推算要用。
 * 只算真正会占位的状态（planned / pending-review / approved / publishing）——
 * 已发布（已计入 publishedInPeriod）、失败/降级/跳过的都不占额度，避免重复扣减。
 */
function plannedInPeriod(
  domain: MediaDomain,
  accountId: string,
  period: 'week' | 'month',
): { periodPlanned: number; periodPlannedAt: number[] } {
  const { from, to } = periodStart(period)
  const at: number[] = []
  for (const [, p] of domain.table('plan').entries()) {
    if (p.accountId !== accountId) continue
    if (
      p.state !== 'planned' && p.state !== 'pending-review' &&
      p.state !== 'approved' && p.state !== 'publishing'
    ) continue
    if (p.scheduledAt >= from && p.scheduledAt < to) at.push(p.scheduledAt)
  }
  return { periodPlanned: at.length, periodPlannedAt: at }
}

/** 偏好时段格式（HH:mm，24 小时制）。 */
const SLOT_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** 档期比对键：同一「日期 + 时:分」视为同一时段（与客户端 slotKey 同口径）。 */
function slotKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`
}

/**
 * 由发布目标推算本期排期（服务端版，与客户端 planSlots 同口径，供物化待排槽用）。
 * 本期还差 = max(0, 目标 − 已发 − 已排未发布)；从今天起在偏好时段里逐日枚举到周期末，
 * 跳过已过去/本期之前的时段；`takenKeys` 里已占用的档期不再给出，避免重复占位。
 * capacity = 本期剩余时段总数（含已被占用的），用于判断「剩下的时段排不下目标」。
 */
function computeSlotPlan(
  cadence: { period: 'week' | 'month'; target: number; slots: string[] },
  published: number,
  plannedAt: number[],
  takenKeys: Set<string>,
  now = new Date(),
): { needed: number; slots: number[]; capacity: number } {
  const needed = Math.max(0, cadence.target - published - plannedAt.length)
  if (needed === 0) return { needed: 0, slots: [], capacity: 0 }
  const mins = cadence.slots
    .map((s) => {
      const m = SLOT_RE.exec(s.trim())
      return m === null ? undefined : Number(m[1]) * 60 + Number(m[2])
    })
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b)
  if (mins.length === 0) return { needed, slots: [], capacity: 0 }
  const { from, to } = periodStart(cadence.period, now)
  const free: number[] = []
  let capacity = 0
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (; day.getTime() < to; day.setDate(day.getDate() + 1)) {
    for (const m of mins) {
      const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m).getTime()
      if (ts <= now.getTime() || ts < from) continue
      capacity++
      if (!takenKeys.has(slotKeyOf(ts))) free.push(ts)
    }
  }
  return { needed, slots: free.slice(0, needed), capacity }
}

/**
 * 该账号**全部**计划（不论状态，含已发布/失败/跳过）占用的档期键。
 * 物化待排槽前先避开这些，避免把新槽塞进已被占用的时段造成同档期撞车。
 */
function occupiedKeys(domain: MediaDomain, accountId: string): Set<string> {
  const keys = new Set<string>()
  for (const [, p] of domain.table('plan').entries()) {
    if (p.accountId === accountId) keys.add(slotKeyOf(p.scheduledAt))
  }
  return keys
}

/** 真正占住档期、需要纳入规划换算的计划状态（已发布/失败/跳过的不占额度）。 */
const OCCUPYING_STATES: ReadonlySet<string> = new Set(['planned', 'pending-review', 'approved', 'publishing'])

/** 本期该账号占据档期的计划（含待排槽），按档期升序。 */
function plansInPeriod(domain: MediaDomain, accountId: string, period: 'week' | 'month'): PlanRec[] {
  const { from, to } = periodStart(period)
  return [...domain.table('plan').entries()].map(([, v]) => v)
    .filter(p => p.accountId === accountId && p.scheduledAt >= from && p.scheduledAt < to && OCCUPYING_STATES.has(p.state))
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
}

/** 档期短标签（喂给模型看：10/21 20:30）。 */
function whenLabel(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 校验模型提案：周期/目标/时段合法、keep 与 remove 逐条可查且恰好覆盖本期全部档期、
 * remove 只能是待排槽、「本期已发 + 保留」不得超目标。任一不满足都返回中文错误（PROPOSAL_INVALID），
 * 绝不「先落库再报错」，也不静默忽略非法条目——让模型重新给一份完整提案。
 */
function validateProposal(
  domain: MediaDomain,
  accountId: string,
  p: PlanProposal,
): { ok: true; keep: PlanRec[]; remove: PlanRec[] } | { ok: false; message: string } {
  if (p.target < 1) return { ok: false, message: '目标篇数需要是不小于 1 的整数' }
  if (p.slots.length === 0) return { ok: false, message: '没有可用偏好时段，排不出档期（请说明想几点发）' }
  const badSlot = p.slots.find(s => !SLOT_RE.test(s.trim()))
  if (badSlot !== undefined) return { ok: false, message: `偏好时段「${badSlot}」不是合法的 HH:mm` }
  const dup = p.keep.find(id => p.remove.includes(id))
  if (dup !== undefined) return { ok: false, message: `计划 ${dup} 同时出现在保留和移除里` }
  const period = plansInPeriod(domain, accountId, p.period)
  const byId = new Map(period.map(x => [x.id, x]))
  const keep: PlanRec[] = []
  for (const id of p.keep) {
    const row = byId.get(id)
    if (!row) return { ok: false, message: `计划 ${id} 不在本期档期清单里` }
    keep.push(row)
  }
  const remove: PlanRec[] = []
  for (const id of p.remove) {
    const row = byId.get(id)
    if (!row) return { ok: false, message: `计划 ${id} 不在本期档期清单里` }
    if (row.articleId !== null) {
      return { ok: false, message: `计划 ${id} 已经配了文章，不能移除（可改时间或换账号）` }
    }
    remove.push(row)
  }
  const uncovered = period.filter(x => !p.keep.includes(x.id) && !p.remove.includes(x.id))
  if (uncovered.length > 0) {
    return { ok: false, message: `还有 ${uncovered.length} 条本期档期没说明保留还是移除，请重新给一份完整提案` }
  }
  const published = publishedInPeriod(domain, accountId, p.period)
  if (published + keep.length > p.target) {
    return {
      ok: false,
      message: `本期已发 ${published} 篇、保留 ${keep.length} 条，已超过目标 ${p.target} 篇（请减少保留或提高目标）`,
    }
  }
  return { ok: true, keep, remove }
}

/** 字符串数组规整：去空白、去重、去空；结果为空返回 undefined（= 没这项）。 */
function normalizeList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.trim()
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out.length > 0 ? out : undefined
}

/** 规范化发布目标：period/target 非法或缺失返回 undefined（fail-closed，不编造默认目标）。 */
function normalizeCadence(
  v: unknown,
): { period: 'week' | 'month'; target: number; slots: string[] } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const period = o.period === 'week' || o.period === 'month' ? o.period : undefined
  const target = typeof o.target === 'number' && Number.isInteger(o.target) && o.target >= 0
    ? o.target
    : undefined
  if (period === undefined || target === undefined) return undefined
  const slots = (normalizeList(o.slots) ?? []).filter(s => SLOT_RE.test(s))
  return { period, target, slots }
}

/** 读 global 数值（不存在=0）。 */
function globalNumber(domain: MediaDomain, key: string): number {
  const v = (domain.global.get() as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : 0
}

/**
 * 账号今日已发数（成功发布计数）。
 *
 * 注意语义：`dailyLimit` 是**我们自设的风控**，不是平台配额——头条/公众号本身
 * 没有「一天几篇」的限制。所以这个数只回答「我们自己今天放行了几篇」，
 * 不代表平台允许发几篇。UI 上别把它写成「剩余可发」，那是虚假承诺。
 */
function sentToday(domain: MediaDomain, accountId: string): number {
  return globalNumber(domain, `publish:counter:${accountId}:${todayKey()}`)
}

/**
 * 账号的历史发布统计。
 * `publish` 表里该账号成功发布的总条数 + 最近一次发布时间。
 * 从没发过就返回 0 / null，UI 据此说「尚未通过本工作台发布」。
 */
function publishHistory(domain: MediaDomain, accountId: string): { total: number; lastAt: number | null } {
  const rows = [...domain.table('publish').entries()]
    .map(([, v]) => v)
    .filter(p => p.accountId === accountId)
  const succeeded = rows.filter(p => p.state === 'success')
  const lastAt = succeeded.reduce<number | null>(
    (acc, p) => (acc === null || (p.publishedAt ?? 0) > acc ? (p.publishedAt ?? null) : acc),
    null,
  )
  return { total: succeeded.length, lastAt }
}

/** 工作文件夹写入 fire-and-forget：失败只打日志，绝不阻塞主流程。 */
function wsTask(task: Promise<void>): void {
  task.catch(err => console.warn('[media/workspace] 写文件失败:', err instanceof Error ? err.message : String(err)))
}

/** 适配器选项（Config.publish → adapter opts）。 */
function adapterOpts(config: MediaConfig) {
  return {
    channel: config.publish.browserChannel,
    headless: config.publish.headless,
    wechatDirectSend: config.publish.wechatDirectSend,
  }
}

/** 账号最近一次成功发布时间（无则 0）。 */
export function lastPublishedAt(domain: MediaDomain, accountId: string): number {
  let max = 0
  for (const [, p] of domain.table('publish').entries()) {
    if (p.accountId === accountId && p.publishedAt && p.publishedAt > max) max = p.publishedAt
  }
  return max
}

/** 进行中的扫码登录（accountId → 取消控制器），供 /account/login/cancel 使用。 */
const loginControllers = new Map<string, AbortController>()

/** 有效热榜抓取源：domain global 覆盖优先（运行期可改），否则回落配置文件。 */
function effectiveFetchers(domain: MediaDomain, config: MediaConfig): { name: string; url: string }[] {
  const g = domain.global.get() as Record<string, unknown>
  const v = g['hotspot:fetchers']
  if (Array.isArray(v)) {
    return v
      .map(x => x as Record<string, unknown>)
      .filter(x => typeof x?.name === 'string' && typeof x?.url === 'string')
      .map(x => ({ name: String(x.name).trim(), url: String(x.url).trim() }))
      .filter(x => x.name !== '' && /^https?:\/\//.test(x.url))
  }
  return [...config.hotspot.fetchers]
}

/** plan/run 核心执行体（供手动路由与定时调度器共用）。 */
export interface RunPlanResult {
  ok: boolean
  /** 建议 HTTP 状态（未在路由里重用时无副作用）。 */
  status: number
  code?: string
  message?: string
  data?: unknown
}

/**
 * 执行一个已审核通过的计划：登录校验 → adapter.publish → 记账/落盘。
 * 语义与原 plan/run 路由完全一致（LOGIN_EXPIRED 回 approved，其它失败转 degraded）。
 */
export async function runPlanCore(
  domain: MediaDomain,
  config: MediaConfig,
  planId: string,
): Promise<RunPlanResult> {
  const plan = planId ? domain.table('plan').get(planId) : undefined
  if (!plan) {
    return { ok: false, status: 404, code: 'PLAN_NOT_FOUND', message: `计划 ${planId} 不存在` }
  }
  if (plan.state !== 'approved') {
    return { ok: false, status: 409, code: 'PLAN_NOT_APPROVED', message: `计划状态为 ${plan.state}，需先审核通过才能发布` }
  }
  // 待排槽（还没选文章）绝不能发：明确拒绝，不静默跳过、不替它随便挑一篇文章
  if (plan.articleId === null) {
    return { ok: false, status: 409, code: 'PLAN_NO_ARTICLE', message: '这条是待排档期，还没选文章，请先在「发布节奏」里选一篇草稿' }
  }
  const article = domain.table('article').get(plan.articleId)
  if (!article) {
    return { ok: false, status: 404, code: 'ARTICLE_NOT_FOUND', message: `文章 ${plan.articleId} 不存在` }
  }
  // 文章审核是唯一审核闸：文章未通过审批（生成中/写完待审/编辑中）不放行。
  // 排期到点自动发也过这道闸——心智模型只有一句话：「文章通过审批 + 排期到点 = 自动发布」。
  if (article.status !== 'approved') {
    return { ok: false, status: 409, code: 'ARTICLE_NOT_APPROVED', message: '文章还没通过审批，先在内容库/动态流点「通过审批」' }
  }
  const adapter = getAdapter(plan.platform)
  if (!adapter) {
    return { ok: false, status: 400, code: 'PLATFORM_UNSUPPORTED', message: `平台 ${plan.platform} 暂不支持` }
  }

  // 账号必须真实存在：绝不给不存在的 accountId 自动建档（那是假账号）
  const account = domain.table('account').get(plan.accountId)
  if (!account) {
    return { ok: false, status: 404, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${plan.accountId} 不存在，请先在「账号管理」创建并登录` }
  }

  // 日限额
  if (sentToday(domain, account.id) >= account.dailyLimit) {
    return {
      ok: false,
      status: 429,
      code: 'DAILY_LIMIT',
      message: `账号 ${account.displayName} 今日已发 ${sentToday(domain, account.id)}/${account.dailyLimit}，请明天再发或调高限额`,
    }
  }

  await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'publishing' }))

  const recordPublish = async (rec: {
    state: 'success' | 'failed' | 'degraded-manual' | 'awaiting-manual'
    url?: string
    error?: string
    note?: string
    draftPackage?: Record<string, string>
  }) => {
    const publishId = newId('pub')
    await domain.table('publish').put(publishId, {
      id: publishId,
      planId: plan.id,
      platform: plan.platform,
      accountId: account.id,
      ...rec,
      publishedAt: rec.state === 'success' ? Date.now() : null,
    })
    return publishId
  }

  try {
    // 登录态失效即停：账号置 expired，计划回 approved 等人工重扫，绝不重试。
    // 草稿优先平台（autoPublish=false）跳过登录校验，直接产出降级草稿包。
    if (adapter.autoPublish !== false) {
      const loggedIn = await adapter.checkLogin(account, adapterOpts(config))
      if (!loggedIn) {
        await domain.table('account').update(account.id, (current) => ({
          ...current, status: 'expired', lastLoginCheckAt: Date.now(),
        }))
        await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'approved' }))
        return { ok: false, status: 401, code: 'LOGIN_EXPIRED', message: '登录态失效，请先在「账号」页扫码登录' }
      }
    }

    // 半自动发布的匹配基准：本次尝试开始的时刻（用于排除作品列表里的同名历史文章）
    const startedAt = Date.now()
    // 封面：解析本机封面文件（`<工作文件夹>/assets/<articleId>/cover.png|jpg|jpeg`）交给 adapter
    // 直接传进平台编辑器的封面控件；取不到就如实带原因，由 adapter 写进说明交人工。
    const cover = await resolveCoverFile(domain, article.id)
    // 正文配图：把本机素材目录交给 adapter，由它读图上传到平台并插回正文原位
    const assetDir = articleAssetDir(domain, article.id)
    const outcome = await adapter.publish(
      {
        plan, article, account,
        coverPath: cover.path,
        coverMissingReason: cover.reason,
        assetDir: assetDir === '' ? undefined : assetDir,
      },
      adapterOpts(config),
    )

    if (outcome.state === 'success') {
      const publishId = await recordPublish({ state: 'success', url: outcome.url, note: outcome.note })
      // 配额计数
      const key = `publish:counter:${account.id}:${todayKey()}`
      await domain.global.set({ ...domain.global.get(), [key]: sentToday(domain, account.id) + 1 })
      await domain.table('account').update(account.id, (current) => ({
        ...current, status: 'active', lastLoginCheckAt: Date.now(),
      }))
      await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'published' }))
      // 工作文件夹：发布成功落盘平台版本
      wsTask(writePlatformFile(domain, { ...plan, state: 'published' }, article, outcome.url))
      return { ok: true, status: 200, data: { publishId, state: 'published', note: outcome.note, url: outcome.url } }
    }

    // 半自动：内容已填进平台编辑器，最终那一下等用户在浏览器里点。
    // **先按「需人工」记账**（不谎报成功），同时起一个 detached 轮询去核实，检出后才升级。
    if (outcome.state === 'awaiting-manual') {
      const publishId = await recordPublish({
        state: 'awaiting-manual', note: outcome.note, draftPackage: outcome.draftPackage,
      })
      await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'degraded' }))
      startManualConfirm(domain, config, {
        plan, article, account, adapter, publishId,
        expectedTitle: outcome.expectedTitle ?? article.title,
        since: startedAt,
      })
      return {
        ok: true,
        status: 200,
        data: { publishId, state: 'awaiting-manual', draftPackage: outcome.draftPackage, note: outcome.note },
      }
    }
    const publishId = await recordPublish({ state: 'degraded-manual', draftPackage: outcome.draftPackage, note: outcome.note })
    await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'degraded' }))
    return {
      ok: true,
      status: 200,
      data: { publishId, state: 'degraded-manual', draftPackage: outcome.draftPackage, note: outcome.note },
    }
  } catch (err) {
    const isPub = err instanceof PublishError
    const code = isPub ? err.code : 'PUBLISH_FAILED'
    const message = err instanceof Error ? err.message : String(err)
    const draftPackage = isPub ? err.draftPackage : adapter.draftExport({ plan, article, account })
    await recordPublish({ state: 'degraded-manual', error: `${code}: ${message}`, draftPackage })
    if (code === 'LOGIN_EXPIRED') {
      await domain.table('account').update(account.id, (current) => ({ ...current, status: 'expired' }))
      await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'approved' }))
      return { ok: false, status: 401, code: 'LOGIN_EXPIRED', message }
    }
    await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'degraded' }))
    return { ok: true, status: 200, data: { state: 'degraded-manual', code, message, draftPackage } }
  }
}

/**
 * 半自动发布的**后台确认**（detached，不挂在 HTTP 响应上）：
 * 轮询平台侧是否真发出去了，检出才把这条 `awaiting-manual` 记录升级成 `success`
 * 并置计划 `published`、落盘平台版本；超时/未检出就保持「需人工」等回填。
 *
 * 三重防呆，防止把不是这次的结果写成成功：
 * 1. 计划已被删 / 已 published / 账号被换掉 → 不动（人已处理过，别覆盖）；
 * 2. 该 publish 记录已经是 success → 不动；
 * 3. 配额计数只在升级成功时 +1（半自动期间先不占额度）。
 */
function startManualConfirm(
  domain: MediaDomain,
  config: MediaConfig,
  ctx: {
    plan: PlanRec
    article: ArticleRec
    account: Account
    adapter: PublishAdapter
    publishId: string
    expectedTitle: string
    since: number
  },
): void {
  const confirm = ctx.adapter.confirmManualPublish
  if (!confirm) return
  const opts = adapterOpts(config)
  void (async () => {
    try {
      const hit = await confirm.call(ctx.adapter, ctx.account, opts, {
        title: ctx.expectedTitle, since: ctx.since,
      })
      if (!hit) {
        console.info(`[media/publish] 半自动确认未检出：计划 ${ctx.plan.id}（《${ctx.expectedTitle}》）仍需人工确认`)
        return
      }
      const plan = domain.table('plan').get(ctx.plan.id)
      if (!plan || plan.state === 'published' || plan.accountId !== ctx.account.id) {
        console.info(`[media/publish] 半自动确认忽略：计划 ${ctx.plan.id} 状态/账号已被改动人已处理`)
        return
      }
      const rec = domain.table('publish').get(ctx.publishId)
      if (!rec || rec.state === 'success') return

      await domain.table('publish').update(ctx.publishId, (current) => ({
        ...current,
        state: 'success',
        url: hit.url,
        publishedAt: Date.now(),
        error: undefined,
        note: hit.note,
      }))
      const key = `publish:counter:${ctx.account.id}:${todayKey()}`
      await domain.global.set({ ...domain.global.get(), [key]: sentToday(domain, ctx.account.id) + 1 })
      await domain.table('account').update(ctx.account.id, (current) => ({
        ...current, status: 'active', lastLoginCheckAt: Date.now(),
      }))
      await domain.table('plan').update(ctx.plan.id, (current) => ({ ...current, state: 'published' }))
      wsTask(writePlatformFile(domain, { ...plan, state: 'published' }, ctx.article, hit.url))
      console.info(`[media/publish] 半自动确认成功：计划 ${ctx.plan.id} → published${hit.url ? `（${hit.url}）` : '（未取到链接）'}`)
    } catch (err) {
      console.warn(`[media/publish] 半自动确认异常（保持需人工）：计划 ${ctx.plan.id}`, err)
    }
  })()
}

// ------------------------------------------------------------------
// 定时发布调度器（与 index.ts 的定时器、/scheduler/tick 路由共用）
// ------------------------------------------------------------------

/** 调度器运行态（内存；重启归零，仅用于可观测与去重）。 */
export const schedulerState = {
  /** 定时器回调次数（诊断定时器是否在跑）。 */
  timerTicks: 0,
  /** 上一次实际巡检时间 / 结果。 */
  lastRunAt: null as number | null,
  lastResult: null as string | null,
  /** 上一次实际执行的节流时间。 */
  lastTickAt: 0,
  /** 是否正在巡检（防重入）。 */
  running: false,
}

/**
 * 单次巡检：找出「已审核通过且到点」的计划，按时间顺序逐条执行。
 *
 * 三道防呆（避免一次巡检炸出十几个浏览器窗口）：
 * 1. 账号状态为「未登录/过期」直接跳过——**不开浏览器**，因为它本来也发不出去；
 * 2. 单轮最多执行 MAX_PER_TICK 条，超出的留到下一轮并写入巡检结果；
 * 3. 同账号最小发布间隔未到的跳过。
 * `dryRun` 只回报「将要做什么」，不执行任何发布动作。
 */
export const MAX_PLANS_PER_TICK = 5

export async function runSchedulerOnce(
  domain: MediaDomain,
  config: MediaConfig,
  opts: { dryRun?: boolean } = {},
): Promise<{ scanned: number; executed: number; skipped: number; results: string[] }> {
  const gapMs = Math.max(0, config.publish.minGapMinutes) * 60_000
  const now = Date.now()
  const due = [...domain.table('plan').entries()].map(([, v]) => v)
    .filter(p => p.state === 'approved' && p.scheduledAt <= now)
    .sort((a, b) => a.scheduledAt - b.scheduledAt)

  const results: string[] = []
  let executed = 0
  let skipped = 0

  if (due.length > MAX_PLANS_PER_TICK) {
    results.push(`本轮只处理前 ${MAX_PLANS_PER_TICK} 条，剩余 ${due.length - MAX_PLANS_PER_TICK} 条下轮再发`)
  }

  for (const plan of due.slice(0, MAX_PLANS_PER_TICK)) {
    const account = domain.table('account').get(plan.accountId)
    // 防呆 1：账号没登录就别去开浏览器核验——省窗口，也避免无人值守时刷屏
    if (account && account.status !== 'active') {
      skipped++
      results.push(`${plan.id}→跳过（账号「${account.displayName}」未登录）`)
      continue
    }
    // 防呆 1.5：文章还没通过审批（生成中/写完待审/编辑中）就跳过，等过审后的下一轮——
    // 审核闸只在文章层，这里不把未过审计划计入执行
    const art = plan.articleId === null ? undefined : domain.table('article').get(plan.articleId)
    if (art && art.status !== 'approved') {
      skipped++
      results.push(`${plan.id}→跳过（文章未通过审批）`)
      continue
    }
    // 防呆 3：同账号最小发布间隔
    const last = lastPublishedAt(domain, plan.accountId)
    if (last > 0 && now - last < gapMs) {
      skipped++
      results.push(`${plan.id}→跳过（距该账号上次发布不足 ${config.publish.minGapMinutes} 分钟）`)
      continue
    }
    if (opts.dryRun) {
      results.push(`${plan.id}→将发布（${plan.platform}，账号 ${account?.displayName ?? plan.accountId}）`)
      continue
    }
    const result = await runPlanCore(domain, config, plan.id)
    const state = result.ok ? ((result.data as { state?: string } | undefined)?.state ?? 'ok') : result.code
    results.push(`${plan.id}→${state}`)
    executed++
    if (!result.ok && (result.code === 'DAILY_LIMIT' || result.code === 'LOGIN_EXPIRED')) break
  }

  schedulerState.lastRunAt = Date.now()
  schedulerState.lastResult = due.length === 0 ? '无到点计划' : results.join('；')
  return { scanned: due.length, executed, skipped, results }
}

// ------------------------------------------------------------------
// 工作台（feed / dispatch）共享类型与常量
// ------------------------------------------------------------------

type HotspotRec = z.infer<typeof HotspotSchema>
type ArticleRec = z.infer<typeof ArticleSchema>
type PlanRec = z.infer<typeof PlanSchema>
type PublishRec = z.infer<typeof PublishSchema>
type ReviewRec = z.infer<typeof ReviewSchema>

/** feed 汇报卡片联合类型（结构与前端 client/common.ts 的 FeedItem 对齐）。 */
type FeedItem =
  | { kind: 'brief'; id: string; at: number; hotspots: HotspotRec[]; total: number }
  | { kind: 'draft'; id: string; at: number; article: ArticleRec; plans: PlanRec[] }
  | { kind: 'receipt'; id: string; at: number; publish: PublishRec; article?: ArticleRec; plan?: PlanRec }
  | { kind: 'metrics'; id: string; at: number; review: ReviewRec; article?: ArticleRec }
  | { kind: 'event'; id: string; at: number; accountId: string; platform: string; displayName: string }

/** 支持的平台选项（与前端 PLATFORM_LABEL 保持一致）。 */
const PLATFORM_OPTIONS = [
  { id: 'wechat', label: '微信公众号' },
  { id: 'toutiao', label: '今日头条' },
  { id: 'zhihu', label: '知乎专栏' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'douyin', label: '抖音' },
] as const

/** M1 health payload. */
interface HealthPayload {
  ok: boolean
  plugin: string
  version: string
  domain: string
  layout: string
  tables: readonly string[]
  records: Record<string, number>
  globalKeys: number
}

// ------------------------------------------------------------------
// 路由注册
// ------------------------------------------------------------------

export function mediaRoutes(domain: MediaDomain, ctx: Context, config: MediaConfig): ConnectionFetchRoute[] {
  // ---------------------------------------------------------- health
  const health: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/health`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const records: Record<string, number> = {}
      for (const name of MEDIA_TABLES) records[name] = domain.table(name).size
      return json({
        ok: true,
        plugin: '@slacker/media',
        version: '0.1.0',
        domain: domain.name,
        layout: 'per-record',
        tables: MEDIA_TABLES,
        records,
        globalKeys: Object.keys(domain.global.get()).length,
      } satisfies HealthPayload)
    },
  }

  // ---------------------------------------------------------- persona
  /** GET /api/media/persona — 人设列表（按岗位顺序）。 */
  const persona: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/persona`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      // accountId 恒定出现（未绑定为 null），避免消费方靠 key 是否存在来判断
      const rows = sortedPersonas(domain).map(p => ({ ...p, accountId: p.accountId ?? null }))
      return json({ ok: true, data: rows })
    },
  }

  /** POST /api/media/persona/save — 新建/更新人设。 */
  const personaSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/persona/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        name?: string
        positioning?: string
        tone?: string
        audience?: string
        taboos?: string[]
        tags?: string[]
        order?: number
      }>(request)
      if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'name 不能为空' }, 400)
      }
      const existing = body.id ? domain.table('persona').get(body.id) : undefined
      const maxOrder = Math.max(0, ...[...domain.table('persona').entries()].map(([, v]) => v.order ?? 0))
      const id = body.id ?? newId('per')
      const record = {
        id,
        name: body.name.trim(),
        positioning: body.positioning ?? existing?.positioning ?? '',
        tone: body.tone ?? existing?.tone ?? '',
        audience: body.audience ?? existing?.audience ?? '',
        taboos: body.taboos ?? existing?.taboos ?? [],
        tags: body.tags ?? existing?.tags ?? [],
        order: body.order ?? existing?.order ?? maxOrder + 1,
        updatedAt: Date.now(),
      }
      await domain.table('persona').put(id, record)
      return json({ ok: true, data: record })
    },
  }

  /** POST /api/media/persona/delete — 删除人设。body: { id } */
  /**
   * POST /api/media/persona/bind — 人设 <-> 账号 1:1 绑定。
   * body: { id, accountId }（accountId 传空串 = 解绑，变成通用人设）
   * 约束对称生效：换绑时自动把对方原来的绑定清掉，数据库里永远只有一对一。
   */
  const personaBind: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/persona/bind`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; accountId?: string }>(request)
      const persona = body?.id ? domain.table('persona').get(body.id) : undefined
      if (!persona) {
        return json({ ok: false, code: 'PERSONA_NOT_FOUND', message: `人设 ${body?.id ?? ''} 不存在` }, 404)
      }
      const accountId = (body?.accountId ?? '').trim()
      if (accountId !== '' && !domain.table('account').get(accountId)) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${accountId} 不存在` }, 404)
      }
      const all = [...domain.table('persona').entries()].map(([, v]) => v)
      // 1) 目标账号若已绑别人，把那个人设解绑
      if (accountId !== '') {
        for (const other of all) {
          if (other.id !== persona.id && other.accountId === accountId) {
            await domain.table('persona').update(other.id, (c) => ({ ...c, accountId: undefined }))
          }
        }
      }
      // 2) 本人设转绑：账号侧靠 personaOfAccount() 反查，无需在账号上冗余存一份
      await domain.table('persona').update(persona.id, (c) => ({
        ...c,
        accountId: accountId === '' ? undefined : accountId,
        updatedAt: Date.now(),
      }))
      const fresh = domain.table('persona').get(persona.id)
      const account = accountId === '' ? undefined : domain.table('account').get(accountId)
      return json({
        ok: true,
        data: {
          id: persona.id,
          accountId: accountId === '' ? null : accountId,
          platform: account?.platform ?? null,
          displayName: account?.displayName ?? null,
          persona: fresh,
          // 绑完立刻告诉调用方：人设和这个号的历史内容对不对得上。
          // 不在 UI 上拦住绑定（那是用户的选择），但得让人看见错配。
          alignment: accountId === '' || !fresh ? null : personaAlignment(domain, fresh, accountId),
        },
      })
    },
  }

  const personaDelete: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/persona/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      if (!body?.id) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'id 不能为空' }, 400)
      }
      const existed = await domain.table('persona').delete(body.id)
      return json({ ok: true, data: { deleted: existed } })
    },
  }

  // ---------------------------------------------------------- hotspots
  /**
   * GET /api/media/hotspots?state=&source=&accountId=
   * 选题列表：默认按 fetchedAt 倒序；带 accountId 时切换到该账号人设视角，
   * 按契合度降序（没评分的沉底）。meta.accounts 是账号→人设视角表，
   * 选择器与「适合账号」标记共用，免第二次请求。
   */
  const hotspots: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspots`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const state = url.searchParams.get('state')
      const source = url.searchParams.get('source')
      const accountId = url.searchParams.get('accountId') ?? undefined
      let list = [...domain.table('hotspot').entries()].map(([, v]) => v)
      if (state) list = list.filter(h => h.state === state)
      if (source) list = list.filter(h => h.source === source)

      const accountsMeta = [...domain.table('account').entries()].map(([, v]) => v)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(a => {
          const persona = personaOfAccount(domain, a.id)
          return {
            id: a.id,
            displayName: a.displayName,
            status: a.status,
            personaId: persona?.id ?? '_default',
            personaName: persona?.name ?? '通用人设',
            // 该账号的内容方向：选题页在账号视角下展示，并作为选题归属的规划依据
            pillars: a.pillars ?? [],
          }
        })

      let viewPersonaId: string | null = null
      if (accountId) {
        viewPersonaId = personaOfAccount(domain, accountId)?.id ?? '_default'
        const pid = viewPersonaId
        // 契合度降序；没评分的沉底并按 fetchedAt 兜底，避免退回存储顺序
        list.sort((a, b) =>
          ((fitOf(b, pid)?.score ?? -1) - (fitOf(a, pid)?.score ?? -1)) || (b.fetchedAt - a.fetchedAt))
      } else {
        list.sort((a, b) => b.fetchedAt - a.fetchedAt)
      }
      return json({
        ok: true,
        data: list,
        meta: {
          threshold: config.hotspot.personaFitThreshold,
          accounts: accountsMeta,
          ...(viewPersonaId ? { viewPersonaId } : {}),
        },
      })
    },
  }

  /** POST /api/media/hotspot/refresh — 触发聚合热榜抓取（按标题去重），抓完自动按各账号人设批量评分。 */
  const hotspotRefresh: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/refresh`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const fetchers = effectiveFetchers(domain, config)
      if (fetchers.length === 0) {
        return json({ ok: true, data: { results: [], hint: '未配置热榜抓取源' } })
      }
      const existingTitles = new Set(
        [...domain.table('hotspot').entries()].map(([, v]) => v.title),
      )
      const addedItems: { id: string; title: string; summary?: string }[] = []
      const results = await refreshHotspots(fetchers, async (item) => {
        if (existingTitles.has(item.title)) return false
        existingTitles.add(item.title)
        const id = newId('hot')
        await domain.table('hotspot').put(id, {
          id,
          source: 'fetch',
          title: item.title,
          summary: item.source ? `来源：${item.source}` : undefined,
          heat: item.heat,
          url: item.url,
          fetchedAt: Date.now(),
          state: 'pending',
        })
        addedItems.push({ id, title: item.title, summary: item.source ? `来源：${item.source}` : undefined })
        return true
      })

      // 抓完自动评分：每个账号视角的人设一轮批量 LLM 调用。
      // 范围 = pending 且还没有该人设评分的条目：刚抓的新项天然在内，
      // 存量旧数据缺的分会在这里一次性回填；已评过的条目绝不重复打分。
      // 没有任何账号时不跑（没有视角可答，等手动评分）。
      const scoreNotes: string[] = []
      const scoreTargets = new Map<string, Persona>()
      for (const acc of [...domain.table('account').entries()].map(([, v]) => v)) {
        const p = personaOfAccount(domain, acc.id) ?? genericPersona()
        scoreTargets.set(p.id, p)
      }
      for (const persona of scoreTargets.values()) {
        const targets = [...domain.table('hotspot').entries()].map(([, v]) => v)
          .filter(h => h.state === 'pending' && !h.personaFits?.[persona.id])
          .map(h => ({ id: h.id, title: h.title, summary: h.summary }))
        if (targets.length === 0) continue
        const res = await scoreHotspotsBatch(ctx, persona, targets, {
          provider: config.llm.provider,
          model: config.llm.model,
        })
        if ('failure' in res) {
          scoreNotes.push(`${persona.name}：${res.failure.zh}`)
          continue
        }
        for (let i = 0; i < targets.length; i++) {
          const fit = res.fits[i]
          if (!fit) continue
          await domain.table('hotspot').update(targets[i].id, (current) => ({
            ...current,
            personaFits: { ...(current.personaFits ?? {}), [persona.id]: fit },
            // 旧字段兼容：通用人设评分同步镜像，feed 等旧读法不断档
            ...(persona.id === '_default' ? { personaFit: fit } : {}),
          }))
        }
      }

      await domain.global.set({ ...domain.global.get(), 'hotspot:lastFetch': Date.now() })
      return json({
        ok: true,
        data: {
          results,
          hint: scoreNotes.length > 0 ? `自动评分部分失败 → ${scoreNotes.join('；')}` : undefined,
        },
      })
    },
  }

  /** POST /api/media/hotspot/delete — 删一条热点。抓来的热榜会无限累积，必须给清理入口。 */
  const hotspotDelete: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      if (!body?.id) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'id 不能为空' }, 400)
      }
      const existed = await domain.table('hotspot').delete(body.id)
      if (!existed) {
        return json({ ok: false, code: 'HOTSPOT_NOT_FOUND', message: `热点 ${body.id} 不存在` }, 404)
      }
      return json({ ok: true, data: { id: body.id, deleted: true } })
    },
  }

  /** POST /api/media/account/collect — 采集账号概况 + 作品列表（纯只读，不改平台任何东西）。 */
  const accountCollect: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/collect`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; works?: boolean }>(request)
      const account = body?.id ? domain.table('account').get(body.id) : undefined
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${body?.id ?? ''} 不存在` }, 404)
      }
      const adapter = getAdapter(account.platform)
      if (!adapter) {
        return json({ ok: false, code: 'PLATFORM_UNSUPPORTED', message: `平台 ${account.platform} 暂不支持` }, 400)
      }
      if (!adapter.collectProfile) {
        return json({
          ok: false,
          code: 'PLATFORM_UNSUPPORTED',
          message: `${account.platform} 暂不支持账号信息采集`,
        }, 400)
      }
      const opts = adapterOpts(config)
      try {
        const profile = await adapter.collectProfile(account, opts)
        const capturedAt = Date.now()
        // 概况覆盖写在账号上；平台展示名顺手回填，省得账号列表永远显示空名
        await domain.table('account').update(account.id, (c) => ({
          ...c,
          displayName: profile.displayName || c.displayName,
          profile: { ...profile, capturedAt },
          lastLoginCheckAt: c.lastLoginCheckAt ?? capturedAt,
        }))

        // 作品列表：按 accountId + 标题去重，重采集覆盖旧指标
        let works: AccountWork[] = []
        let workError: string | null = null
        if (body?.works !== false && adapter.collectWorks) {
          try {
            const raw = await adapter.collectWorks(account, opts)
            for (const w of raw) {
              const old = [...domain.table('account_work').entries()].find(([, v]) =>
                v.accountId === account.id && v.title === w.title)
              const row = {
                ...w,
                id: old?.[0] ?? newId('awk'),
                accountId: account.id,
                platform: account.platform,
                capturedAt,
              }
              await domain.table('account_work').put(row.id, row)
              works.push(row)
            }
          } catch (err) {
            workError = err instanceof Error ? err.message : String(err)
          }
        }
        return json({
          ok: true,
          data: {
            id: account.id,
            profile: { ...profile, capturedAt },
            works,
            workError,
          },
        })
      } catch (err) {
        const isPublishErr = err instanceof PublishError
        return json({
          ok: false,
          code: isPublishErr ? err.code : 'COLLECT_FAILED',
          message: `账号信息采集失败：${err instanceof Error ? err.message : String(err)}`,
        }, isPublishErr && err.code === 'LOGIN_EXPIRED' ? 401 : 502)
      }
    },
  }

  /** GET /api/media/account/works — 采集到的作品列表（可按账号过滤）。 */
  const accountWorksGet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/works`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const accountId = new URL(request.url).searchParams.get('accountId') ?? undefined
      const rows = [...domain.table('account_work').entries()]
        .map(([, v]) => v)
        .filter(w => !accountId || w.accountId === accountId)
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      return json({ ok: true, data: rows })
    },
  }

  /** GET /api/media/hotspot/fetchers — 当前生效的热榜抓取源。 */
  const hotspotFetchersGet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/fetchers`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const g = domain.global.get() as Record<string, unknown>
      return json({
        ok: true,
        data: {
          fetchers: effectiveFetchers(domain, config),
          overridden: Array.isArray(g['hotspot:fetchers']),
        },
      })
    },
  }

  /** POST /api/media/hotspot/fetchers/save — 运行期保存热榜源；空数组=回落到配置文件。 */
  const hotspotFetchersSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/fetchers/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ fetchers?: { name?: string; url?: string }[] }>(request)
      if (!body || !Array.isArray(body.fetchers)) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'fetchers 必须是数组' }, 400)
      }
      const clean = body.fetchers
        .map(x => ({ name: String(x?.name ?? '').trim(), url: String(x?.url ?? '').trim() }))
        .filter(x => x.name !== '' || x.url !== '')
      const bad = clean.find(x => x.name === '' || !/^https?:\/\//.test(x.url))
      if (bad) {
        return json({
          ok: false,
          code: 'INVALID_REQUEST',
          message: bad.name === '' ? '热榜源名称不能为空' : `URL 需以 http(s):// 开头：${bad.url || '(空)'}`,
        }, 400)
      }
      const g: Record<string, unknown> = { ...(domain.global.get() as Record<string, unknown>) }
      if (clean.length === 0) delete g['hotspot:fetchers']
      else g['hotspot:fetchers'] = clean
      await domain.global.set(g)
      return json({ ok: true, data: { fetchers: clean } })
    },
  }

  /** POST /api/media/hotspot/save — 手动录入 / 常青新增 / 更新。 */
  const hotspotSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        source?: 'manual' | 'evergreen'
        title?: string
        summary?: string
        url?: string
        state?: 'pending' | 'adopted' | 'rejected' | 'used'
        accountId?: string | null
      }>(request)
      if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'title 不能为空' }, 400)
      }
      const existing = body.id ? domain.table('hotspot').get(body.id) : undefined
      const id = body.id ?? newId(body.source === 'evergreen' ? 'evg' : 'hot')

      // 归属账号（选题池）：缺省 = 沿用；'' / null = 出池（回到公共池）；非空必须存在，否则 404
      let accountId = existing?.accountId
      if (body.accountId !== undefined) {
        if (body.accountId === null || body.accountId === '') accountId = undefined
        else {
          if (!domain.table('account').get(body.accountId)) {
            return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${body.accountId} 不存在` }, 404)
          }
          accountId = body.accountId
        }
      }

      const record = {
        id,
        // 已有记录保留原 source；新建只能是 manual/evergreen（fetch 由 refresh 写入）
        source: existing?.source ?? body.source ?? 'manual',
        title: body.title.trim(),
        summary: body.summary ?? existing?.summary,
        heat: existing?.heat,
        url: body.url ?? existing?.url,
        fetchedAt: existing?.fetchedAt ?? Date.now(),
        personaFit: existing?.personaFit,
        // 只改归属也要保留各账号人设的评分，不能因一次保存把评分清空
        personaFits: existing?.personaFits,
        state: body.state ?? existing?.state ?? 'pending',
        linkedArticleId: existing?.linkedArticleId,
        ...(accountId ? { accountId } : {}),
      }
      await domain.table('hotspot').put(id, record)
      return json({ ok: true, data: record })
    },
  }

  /** POST /api/media/hotspot/score — personaFit 评分（body: id）。 */
  const hotspotScore: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/score`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; accountId?: string }>(request)
      const hotspot = body?.id ? domain.table('hotspot').get(body.id) : undefined
      if (!hotspot) {
        return json({ ok: false, code: 'HOTSPOT_NOT_FOUND', message: `选题 ${body?.id ?? ''} 不存在` }, 404)
      }
      // 评分用哪个账号的���设：请求可指定 accountId，否则用通用人设
      const persona: Persona = personaOfAccount(domain, body?.accountId) ?? genericPersona()
      const result = await scoreHotspot(ctx, persona, hotspot, {
        provider: config.llm.provider,
        model: config.llm.model,
      })
      if ('failure' in result) {
        const f: LlmErrorInfo = result.failure
        return json({ ok: false, code: f.code, message: f.zh, action: f.action }, 502)
      }
      await domain.table('hotspot').update(hotspot.id, (current) => ({
        ...current,
        personaFits: { ...(current.personaFits ?? {}), [persona.id]: result.fit },
        // 旧字段兼容：通用人设评分同步镜像
        ...(persona.id === '_default' ? { personaFit: result.fit } : {}),
      }))
      return json({
        ok: true,
        data: {
          personaId: persona.id,
          personaName: persona.name,
          personaFit: result.fit,
          recommended: result.fit.score >= config.hotspot.personaFitThreshold,
        },
      })
    },
  }

  /** POST /api/media/hotspot/adopt — 采纳为文章选题（建草稿并回链）。 */
  const hotspotAdopt: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/hotspot/adopt`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const hotspot = body?.id ? domain.table('hotspot').get(body.id) : undefined
      if (!hotspot) {
        return json({ ok: false, code: 'HOTSPOT_NOT_FOUND', message: `选题 ${body?.id ?? ''} 不存在` }, 404)
      }
      const now = Date.now()
      const articleId = newId('art')
      const article = {
        id: articleId,
        title: hotspot.title,
        bodyMd: '',
        status: 'draft' as const,
        topic: hotspot.source === 'evergreen'
          ? { evergreenId: hotspot.id }
          : { hotspotId: hotspot.id },
        platformVersions: {},
        createdAt: now,
        updatedAt: now,
      }
      await domain.table('article').put(articleId, article)
      await domain.table('hotspot').update(hotspot.id, (current) => ({
        ...current,
        state: 'adopted',
        linkedArticleId: articleId,
      }))
      return json({ ok: true, data: { article, hotspotId: hotspot.id } })
    },
  }

  // ---------------------------------------------------------- articles
  /** GET /api/media/articles — 按 updatedAt 倒序列出全部文章。 */
  const articles: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/articles`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const list = [...domain.table('article').entries()].map(([, v]) => v)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return json({ ok: true, data: list })
    },
  }

  /** POST /api/media/article/save — 新建或更新（body 即文章完整对象，无需包装）。 */
  const articleSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/article/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        title?: string
        bodyMd?: string
        status?: string
        platformVersions?: Record<string, string>
        topic?: { hotspotId?: string; evergreenId?: string; manual?: boolean }
      }>(request)
      if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'title 不能为空' }, 400)
      }
      const now = Date.now()
      const existing = body.id ? domain.table('article').get(body.id) : undefined
      const id = body.id ?? newId('art')
      const record = {
        id,
        title: body.title.trim(),
        bodyMd: body.bodyMd ?? existing?.bodyMd ?? '',
        status: (body.status as 'draft') ?? existing?.status ?? 'draft',
        topic: body.topic ?? existing?.topic ?? { manual: true },
        platformVersions: body.platformVersions ?? existing?.platformVersions ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      await domain.table('article').put(id, record)
      // 工作文件夹：编辑保存后同步落盘（标题/正文变化会改名重写）
      if (record.bodyMd.trim()) {
        wsTask(writeArticleFile(domain, record, articlePersona(domain, id)))
        // 标题变化时规划文件名也要跟着变（writePlanFile 内部做旧文件清理）
        const hasPlans = [...domain.table('plan').entries()].some(([, v]) => v.articleId === id)
        if (hasPlans) wsTask(writePlanFile(domain, record))
      }
      return json({ ok: true, data: record })
    },
  }

  /** POST /api/media/article/delete — 按 id 删除。 */
  const articleDelete: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/article/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      if (!body?.id) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'id 不能为空' }, 400)
      }
      const existed = await domain.table('article').delete(body.id)
      // 资产是附属投影：顺手清理（失败不影响删除语义）
      if (existed) wsTask(cleanupAssets(domain, body.id).catch(err => {
        console.warn('[media/assets] 清理图片失败:', err instanceof Error ? err.message : String(err))
      }))
      return json({ ok: true, data: { deleted: existed } })
    },
  }

  /**
   * POST /api/media/article/approve — 文章送审通过 / 退回。
   * body: { id: string, approved?: boolean }（默认 approved=true）
   */
  const articleApprove: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/article/approve`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; approved?: boolean }>(request)
      const article = body?.id ? domain.table('article').get(body.id) : undefined
      if (!article) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${body?.id ?? ''} 不存在` }, 404)
      }
      const approved = body?.approved !== false
      const status = approved ? 'approved' as const : 'editing' as const
      await domain.table('article').update(article.id, (current) => ({
        ...current, status, updatedAt: Date.now(),
      }))
      // 连带同步计划：文章「通过审批」即内容定稿，名下待审计划一并放行
      // （已到点被调度器立即执行、未来排期到点自动发）；「退回」则把已批
      // 未发的计划撤回待审，防止退回后的旧稿仍被定时发布。其余状态不动。
      let planSynced = 0
      for (const [pid, p] of domain.table('plan').entries()) {
        if (p.articleId !== article.id) continue
        if (approved && p.state === 'pending-review') {
          await domain.table('plan').update(pid, (cur) => ({ ...cur, state: 'approved' }))
          planSynced++
        } else if (!approved && p.state === 'approved') {
          await domain.table('plan').update(pid, (cur) => ({ ...cur, state: 'pending-review' }))
          planSynced++
        }
      }
      return json({ ok: true, data: { id: article.id, status, planSynced } })
    },
  }

  // ------------------------------------------------- article/generate
  /**
   * POST /api/media/article/rewrite — 生成指定平台的改写版本，写入 platformVersions[platform]。
   * body: { id: string, platform: string }
   */
  const articleRewrite: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/article/rewrite`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; platform?: string }>(request)
      const article = body?.id ? domain.table('article').get(body.id) : undefined
      if (!article) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${body?.id ?? ''} 不存在` }, 404)
      }
      const platform = (body?.platform ?? '').trim()
      if (!platform) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'platform 不能为空' }, 400)
      }
      if (!article.bodyMd.trim()) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: '正文为空，请先写或生成正文' }, 400)
      }
      const platformLabel = PLATFORM_OPTIONS.find(p => p.id === platform)?.label ?? platform
      const res = await rewriteArticle(ctx, {
        title: article.title, bodyMd: article.bodyMd, platform, platformLabel,
      })
      if (res.failure || !res.text.trim()) {
        const f = res.failure
        return json({
          ok: false,
          code: f?.code ?? 'EMPTY_RESPONSE',
          message: f ? `${f.zh}（${f.action}）` : '模型没有产出内容',
        }, 502)
      }
      const text = res.text.trim()
      const platformVersions = { ...article.platformVersions, [platform]: text }
      await domain.table('article').update(article.id, (current) => ({
        ...current, platformVersions, updatedAt: Date.now(),
      }))
      return json({ ok: true, data: { id: article.id, platform, text } })
    },
  }

  /**
   * POST /api/media/article/illustrate — 正文配图补齐 / 重画。
   * body: { id, onlyIndex? }（onlyIndex 从 1 起，只重画第 N 张）
   * 把正文里的 `![图注](gen:描述)` 占位画成真图并回填；单张失败回落模板图。
   * 出图是逐张顺序 await 的，耗时可观，所以这里走 SSE 把逐张进度实时推给前端
   * （plan/start/end/finish），否则用户只能对着禁用按钮盲等。
   */
  const articleIllustrate: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/article/illustrate`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; onlyIndex?: number; redraw?: boolean }>(request)
      const article = body?.id ? domain.table('article').get(body.id) : undefined
      if (!article) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${body?.id ?? ''} 不存在` }, 404)
      }
      if (workspaceRoot(domain) === '') {
        return json({ ok: false, code: 'NO_WORKSPACE', message: '请先在「设置」里选择工作文件夹' }, 400)
      }
      const spots = listFigureSpots(article.bodyMd)
      // 没有 gen: 占位时：正文里可能已经有上一轮落下的配图（多半是失败的模板图）。
      // 先回报数量让前端问一句，用户确认后再带 redraw 重画——不静默花钱。
      const existing = spots.length === 0 ? listFigureRefs(article.bodyMd, article.id) : []
      if (spots.length === 0 && existing.length === 0) {
        return json({
          ok: false,
          code: 'NO_FIGURE_SPOTS',
          message: '正文里没有待生成的配图占位（形如 ![图注](gen:描述)），也没有可重画的已有配图',
        }, 400)
      }
      if (spots.length === 0 && body?.redraw !== true) {
        return json({
          ok: true,
          data: {
            id: article.id, total: 0, filled: 0, failed: 0,
            existing: existing.length, errors: [], blocked: null,
          },
        })
      }
      const redraw = spots.length === 0
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const send = (frame: object): void => {
            try { controller.enqueue(encoder.encode(sseEvent(frame))) } catch { /* 客户端已断开 */ }
          }
          void (async () => {
            try {
              const onProgress = (e: IllustrateProgress): void => {
                if (e.kind === 'plan') send({ type: 'plan', mode: e.mode, total: e.total, items: e.items })
                else if (e.kind === 'start') send({ type: 'start', index: e.index, prompt: e.prompt })
                else send({ type: 'end', index: e.index, ok: e.ok, message: e.message })
              }
              const out = redraw
                ? await redrawFigures(domain, article.id, article.bodyMd, { onProgress })
                : await illustrateSpots(domain, article.id, article.bodyMd, {
                    onlyIndex: typeof body?.onlyIndex === 'number' ? body.onlyIndex : undefined,
                    onProgress,
                  })
              if (out.bodyMd !== article.bodyMd) {
                await domain.table('article').update(article.id, (current) => ({
                  ...current, bodyMd: out.bodyMd, updatedAt: Date.now(),
                }))
                const personaName = firstPersona(domain)?.name ?? ''
                if (out.bodyMd.trim()) wsTask(writeArticleFile(domain, { ...article, bodyMd: out.bodyMd }, personaName))
              }
              send({
                type: 'finish',
                id: article.id,
                total: redraw ? existing.length : spots.length,
                filled: out.filled,
                failed: out.failed,
                redrawn: redraw ? out.filled : 0,
                errors: out.errors,
                blocked: out.blocked,
              })
            } catch (err) {
              send({ type: 'error', code: 'ILLUSTRATE_FAILED', message: err instanceof Error ? err.message : String(err) })
            } finally {
              try { controller.close() } catch { /* already closed */ }
            }
          })()
        },
      })
      return sseResponse(stream)
    },
  }

  // ------------------------------------------------- article/generate
  /**
   * POST /api/media/article/generate — 会话化写作：派活给 dsh agent 会话。
   * body: { id: string, platform?: string, personaId?: string, accountId?: string }
   * 流程：创建 dsh 会话 → 提交写作 prompt → 跟随会话日志取回正文 → 回写内容库。
   * 模型/凭据复用 dsh 里配置的默认模型；会话列表会出现「媒体工作台 · <标题>」。
   * SSE 帧格式：data: {"type":"session","sessionId":"..."}
   *             {"type":"done","articleId":..,"sessionId":..}
   *             {"type":"error","code":..,"message":..,"action":..}
   */
  const articleGenerate: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/article/generate`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string; platform?: string; personaId?: string; accountId?: string }>(request)
      const articleId = body?.id ?? ''
      const article = domain.table('article').get(articleId)
      if (!article) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${articleId} 不存在` }, 404)
      }

      // 人设解析：显式点名 > 该账号绑定的人设（1:1）> 通用兜底
      const accountId = body?.accountId ?? undefined
      const account = accountId ? domain.table('account').get(accountId) : undefined
      const specified = body?.personaId ? domain.table('persona').get(body.personaId) : undefined
      const persona: Persona = specified ?? personaOfAccount(domain, accountId) ?? genericPersona()
      // 平台：显式指定 > 账号所属平台 > 通用
      const platform = body?.platform ?? account?.platform ?? '通用'
      const now = Date.now()

      // 状态切换为 generating（持久化，前端可感知）
      await domain.table('article').update(articleId, (current) => ({
        ...current,
        status: 'generating',
        updatedAt: now,
      }))

      // 组装 prompt 输入（M3 起拼入复盘统计一句话，闭环反哺）
      const genInput = {
        persona,
        topicTitle: article.title,
        topicSummary: '',
        platform,
        minWords: 800,
        statsSentence: buildStatsSentence(computeStats(domain)),
        // 账号实况优先于人手写的人设：agent 得知道这个号实际发过什么、哪类点击率高
        accountBrief: accountBrief(domain, account?.id),
        // 该账号的内容方向：本篇必须落在其中之一（没设方向则不注入）
        directions: account?.pillars ?? [],
      }

      const encoder = new TextEncoder()
      const sseStream = new ReadableStream({
        async start(controller) {
          let text = ''
          let failure: LlmErrorInfo | undefined
          let sessionId: string | undefined

          // 写作全程每 10s 往流里发一帧心跳：写作/配图阶段可能几分钟没有任何帧，
          // 静默的 SSE 会被传输中间层掐断（如 undici 默认 bodyTimeout 300s），前端就会
          // 永远停在「生成中」。心跳既给链路保活，也是前端的存活信号。
          // enqueue 抛错（流已关闭/客户端已断开）时自动停跳，不阻碍正常收尾。
          let dead = false
          const ping = setInterval(() => {
            if (dead) return
            try {
              controller.enqueue(encoder.encode(sseEvent({ type: 'ping', at: Date.now() })))
            } catch {
              dead = true
              clearInterval(ping)
            }
          }, 10_000)
          // 发帧统一入口：客户端已断开时 enqueue 会抛，吞掉并停跳，保证收尾逻辑跑完
          const send = (data: object) => {
            try {
              controller.enqueue(encoder.encode(sseEvent(data)))
            } catch {
              dead = true
              clearInterval(ping)
            }
          }


          // fail-closed：sessionController 未注入时直接报错，不回落直连 LLM
          const ctrl = (ctx as unknown as { sessionController?: MediaSessionController }).sessionController
          if (!ctrl?.create) {
            failure = { code: 'NO_SESSION', zh: 'dsh 会话服务未就绪', action: '请重启后重试' }
          }

          if (!failure) {
            try {
              // 1. 创建 dsh 会话（写作全程在会话里执行，dsh 会话列表可见）
              // 不指定 agentPreset，走 dsh 默认 preset（standard）
              const created = await ctrl.create({})
              sessionId = created.sessionId
              send({ type: 'session', sessionId })
              // 会话命名（best-effort）：让用户在会话列表一眼认出这篇稿子
              try {
                await ctrl.rename({ sessionId, title: `媒体工作台 · ${article.title.slice(0, 24)}` })
              } catch { /* 命名失败不阻塞写作 */ }

              // 2. 提交写作 prompt（system+user 合并为一条；正文必须作为回复输出，禁止动用工具）
              const { system, user } = buildArticlePrompts(genInput)
              const promptText = [
                system, '', '---', '', user, '',
                '【输出要求】直接把完整的 Markdown 文章正文作为你的回复输出；',
                '不要写入文件、不要调用任何工具、不要输出执行计划或任务总结。',
              ].join('\n')
              await ctrl.prompt({
                requestId: `media-article-${articleId}-${Date.now()}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: promptText }],
              }, request.signal)

              // 3. 跟随会话日志直到本回合结束；快照与实时帧走同一处理（兜底订阅竞速）
              let progressChars = -1
              const handleEvent = (evType: string, evData: unknown): boolean => {
                if (evType === 'assistant/message') {
                  const t = assistantTextFromEvent(evData)
                  if (t.trim()) {
                    text = t
                    // 进度帧：把当前字数推给前端（顺带持续保活链路），字数没变不发
                    if (t.length !== progressChars) {
                      progressChars = t.length
                      send({ type: 'progress', chars: t.length })
                    }
                  }
                  return false
                }
                if (evType === 'turn/end') {
                  const info = turnEndFailure((evData as { reason?: unknown }).reason)
                  if (info) failure ??= info
                  return true
                }
                return false
              }
              const frames = ctrl.follow({ address: { kind: 'session', sessionId } }, request.signal)
              let ended = false
              for await (const frame of frames) {
                if (frame.type === 'snapshot') {
                  for (const rec of frame.records ?? []) {
                    if (rec.type === 'event' && rec.event && handleEvent(rec.event.type, rec.event.data)) {
                      ended = true
                      break
                    }
                  }
                } else if (frame.type === 'event' && frame.event) {
                  ended = handleEvent(frame.event.type, frame.event.data)
                }
                if (ended) break
              }
            } catch (err) {
              if (request.signal.aborted) {
                failure ??= resolveLlmError('ABORTED')
              } else {
                const msg = err instanceof Error ? err.message : String(err)
                failure ??= { code: 'SERVER', zh: `会话派工失败：${msg}`, action: '请查看日志或稍后重试' }
              }
            }
          }

          // 无论成功或失败，已产出的 text 都写回 article（保留已产出部分）
          // 失败但有部分正文 → editing（可继续编辑）；失败且一字未出 → failed（生成失败，可重新生成）
          const status = failure ? (text.trim() ? 'editing' : 'failed') : 'generated'

          // 正文先行落库：配图（封面+逐张内联图，串行生图可达数分钟）不再阻塞「已完成」的
          // 感知——会话 turn/end 后正文立即入库、发 done 帧；配图转后台任务补齐后再覆盖落库
          let bodyMd = text
          await domain.table('article').update(articleId, (current) => ({
            ...current,
            bodyMd,
            status,
            updatedAt: Date.now(),
          }))

          // 工作文件夹：正文先落盘 <root>/<员工名>/<日期>-<标题>.md；配图完成后会再覆盖一次
          if (bodyMd.trim()) {
            wsTask(writeArticleFile(domain, { ...article, bodyMd, status }, persona.name))
          }

          // 收尾：先停心跳再发最终帧，避免 done 与 ping 竞争乱序（配图告警在后台任务完成后落日志）
          clearInterval(ping)
          if (failure) {
            send({ type: 'error', code: failure.code, message: failure.zh, action: failure.action })
          } else {
            send({ type: 'done', articleId, sessionId })
          }

          // 自动配图（后台）：依次产出封面 + 正文内联配图，失败逐条告警但不影响正文；
          // 完成后覆盖落库与工作文件夹落盘，前端 25s 轮询即可拿到带图版本
          if (!failure && text.trim()) {
            void (async () => {
              const warns: string[] = []
              let rich = text
              try {
                const cover = await illustrateArticle(domain, { ...article, bodyMd: text, status }, { forAgent: true })
                if (cover.url) rich = `![封面](${cover.url})\n\n${text}`
                if (cover.blocked) warns.push(`封面：${cover.blocked}`)
                if (cover.error) warns.push(`封面生成失败：${cover.error}`)
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                console.warn('[media/assets] 自动配图失败:', msg)
                warns.push(`封面生成失败：${msg}`)
              }
              try {
                const out = await illustrateSpots(domain, articleId, rich, { forAgent: true })
                if (out.filled > 0 || out.failed > 0) rich = out.bodyMd
                if (out.blocked) warns.push(`正文配图：${out.blocked}`)
                for (const e of out.errors) warns.push(`正文配图第 ${e.index} 张：${e.message}`)
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                console.warn('[media/assets] 正文配图失败:', msg)
                warns.push(`正文配图失败：${msg}`)
              }
              await domain.table('article').update(articleId, (current) => ({
                ...current,
                bodyMd: rich,
                status: 'generated',
                updatedAt: Date.now(),
              }))
              if (rich.trim()) {
                wsTask(writeArticleFile(domain, { ...article, bodyMd: rich, status: 'generated' }, persona.name))
              }
              if (warns.length > 0) console.warn(`[media/assets] 《${article.title.slice(0, 20)}》配图告警:`, warns.join('；'))
            })().catch(err => {
              console.warn('[media/assets] 后台配图任务异常:', err instanceof Error ? err.message : String(err))
            })
          }
          controller.close()
        },
      })

      return sseResponse(sseStream)
    },
  }

  // ---------------------------------------------------------- asset
  /** 编辑器上传图片（base64 → 工作文件夹 assets）。 */
  const articleAsset: ConnectionFetchRoute = articleAssetRoute(domain)
  /** 图片二进制服务（<img src> 直连）。 */
  const asset: ConnectionFetchRoute = assetRoute(domain)

  /**
   * POST /api/media/asset/generate — 按需为文章生成/重生成封面。
   * 复用 illustrateArticle（按配置走渠道，失败回落 SVG 模板）；正文未引用则前置封面。
   */
  const assetGenerate: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/asset/generate`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ articleId?: string }>(request)
      const article = body?.articleId ? domain.table('article').get(body.articleId) : undefined
      if (!article) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${body?.articleId ?? ''} 不存在` }, 404)
      }
      if (workspaceRoot(domain) === '') {
        return json({ ok: false, code: 'NO_WORKSPACE', message: '请先在「设置」里选择工作文件夹' }, 400)
      }
      try {
        const cover = await illustrateArticle(domain, article)
        if (!cover.url) return json({ ok: false, code: 'ASSET_IO', message: cover.error ?? '封面生成失败' }, 500)
        // 正文未引用该封面时前置（已引用则原样保留，避免重复）
        const bodyMd = article.bodyMd.includes(cover.url)
          ? article.bodyMd
          : `![封面](${cover.url})\n\n${article.bodyMd}`.trim()
        await domain.table('article').update(article.id, (current) => ({
          ...current, bodyMd, updatedAt: Date.now(),
        }))
        return json({
          ok: true,
          data: {
            url: cover.url,
            articleId: article.id,
            bodyMd,
            usedTemplate: cover.usedTemplate,
            error: cover.error,
            blocked: cover.blocked,
          },
        })
      } catch (err) {
        return json({ ok: false, code: 'ASSET_IO', message: err instanceof Error ? err.message : String(err) }, 500)
      }
    },
  }

  // ---------------------------------------------------------- plan
  /** GET /api/media/plan?from=&to= — 发布计划（默认本周）。 */
  const plan: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const from = Number(url.searchParams.get('from') ?? 0)
      const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER)
      const list = [...domain.table('plan').entries()].map(([, v]) => v)
        .filter(p => p.scheduledAt >= from && p.scheduledAt <= to)
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
      return json({
        ok: true,
        data: list,
      })
    },
  }

  /**
   * POST /api/media/plan/save — 建/改计划。正式计划一律 approved（排期即生效，
   * 发布还须文章通过审批——审核闸只在文章层）。
   *
   * `articleId` 可省略/为空 → 建「待排槽」（articleId=null，state 固定 'planned'）：
   * 由账号发布目标推算出来的档期占位，先占住时段、等用户选文章。
   * 给已有待排槽补上文章 → 这条才是真正要发的计划，state 按审核总闸重算
   * （绝不把 'planned' 留在带文章的正式计划上，否则调度器不会去发它）。
   */
  const planSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        articleId?: string | null
        platform?: string
        accountId?: string
        scheduledAt?: number
        topic?: string | null
      }>(request)
      const existing = body?.id ? domain.table('plan').get(body.id) : undefined
      if (body?.id !== undefined && !existing) {
        return json({ ok: false, code: 'PLAN_NOT_FOUND', message: `计划 ${body.id} 不存在` }, 404)
      }
      // articleId：显式传空串/null = 清空成待排槽；不传 = 沿用原值（新建则 null）
      const rawArticleId = body?.articleId
      const articleId = rawArticleId === undefined
        ? (existing?.articleId ?? null)
        : (typeof rawArticleId === 'string' && rawArticleId.trim() !== '' ? rawArticleId : null)
      if (articleId !== null && !domain.table('article').get(articleId)) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${articleId} 不存在` }, 404)
      }
      // topic：显式传空串/null = 清空选题；不传 = 沿用原值（新建则未定）
      const rawTopic = body?.topic
      const topic = rawTopic === undefined
        ? existing?.topic
        : (typeof rawTopic === 'string' && rawTopic.trim() !== '' ? rawTopic.trim() : undefined)
      const platform = typeof body?.platform === 'string' && body.platform.trim() !== ''
        ? body.platform.trim()
        : existing?.platform
      if (!platform) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'platform 必填' }, 400)
      }
      const accountId = body?.accountId ?? existing?.accountId
      if (!accountId) {
        return json({ ok: false, code: 'ACCOUNT_REQUIRED', message: 'accountId 必填：发布计划必须落在真实账号上' }, 400)
      }
      if (!domain.table('account').get(accountId)) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${accountId} 不存在` }, 404)
      }
      const id = body?.id ?? newId('plan')
      const wasSlot = existing !== undefined && existing.articleId === null
      // 计划不再单独审核（审核闸只在文章层）：正式计划一律 approved，排期即生效。
      // 误发防护 = 文章审核（未过审文章到点被调度器跳过）+ 账号/限额/间隔防呆。
      const state = articleId === null
        ? 'planned' as const
        : wasSlot
          ? 'approved' as const
          : (existing?.state ?? 'approved' as const)
      const record = {
        id,
        articleId,
        platform,
        accountId,
        scheduledAt: body?.scheduledAt ?? existing?.scheduledAt ?? Date.now(),
        state,
        reviewNote: wasSlot ? undefined : existing?.reviewNote,
        topic,
        createdAt: existing?.createdAt ?? Date.now(),
      }
      await domain.table('plan').put(id, record)
      // 工作文件夹：规划落盘（该文章全部计划聚合一份）；待排槽没有文章，无可落盘内容
      const planArticle = articleId === null ? undefined : domain.table('article').get(articleId)
      if (planArticle) wsTask(writePlanFile(domain, planArticle))
      return json({ ok: true, data: record })
    },
  }

  /**
   * POST /api/media/plan/slots — 把账号发布目标的「本期还差几篇」物化成真实的待排槽记录。
   *
   * 与客户端 planSlots 同一口径：本期还差 = max(0, 目标 − 本期已发 − 本期已排未发布)。
   * 幂等：已被占用的「同日同时:分」时段一律跳过，只补差额，重复点不会重复生成。
   * 容量不够时如实返回 shortfall，不硬凑、不伪造时段。
   */
  const planSlots: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/slots`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ accountId?: string }>(request)
      const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
      if (accountId === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'accountId 必填' }, 400)
      }
      const account = domain.table('account').get(accountId)
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${accountId} 不存在` }, 404)
      }
      const cadence = account.cadence
      if (!cadence || cadence.target <= 0) {
        return json({ ok: false, code: 'NO_CADENCE', message: '该账号未设发布目标，先去「规划」设定周期与目标' }, 400)
      }
      if (cadence.slots.length === 0) {
        return json({ ok: false, code: 'NO_SLOTS', message: '该账号未设偏好时段，排不出待排计划' }, 400)
      }
      const sp = computeSlotPlan(cadence, publishedInPeriod(domain, accountId, cadence.period),
        plannedInPeriod(domain, accountId, cadence.period).periodPlannedAt, occupiedKeys(domain, accountId))
      if (sp.needed === 0) {
        return json({ ok: true, data: { created: 0, shortfall: 0, slots: [] }, meta: { message: '本期目标已排满' } })
      }
      const created: number[] = []
      for (const ts of sp.slots) {
        const id = newId('plan')
        await domain.table('plan').put(id, {
          id, articleId: null, platform: account.platform, accountId,
          scheduledAt: ts, state: 'planned' as const,
          createdAt: Date.now(),
        })
        created.push(ts)
      }
      return json({ ok: true, data: { created: created.length, shortfall: sp.needed - created.length, slots: created } })
    },
  }

  /**
   * POST /api/media/plan/chat — 账号整期「对话规划」：只出提案，**不写库**。
   *
   * body: { accountId, messages: [{role,text}] }（最后一条是用户本轮输入）。
   * 服务端先算好现状快照（本期已发 / 本期档期清单 / 当前目标与偏好时段）喂给模型；
   * 模型只负责出「周期 + 目标 + 偏好时段 + 保留/移除清单」，新增档期由服务端按
   * 「目标 − 本期已发 − 保留条数」推算（模型不得凭空编时间）。
   * 模型不可用 / 解析失败 → LLM_UNAVAILABLE；提案不合规 → PROPOSAL_INVALID，
   * 都明确报错（客户端据此退化成「改这条」表单流），绝不静默兜底。
   */
  const planChat: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/chat`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        accountId?: string
        messages?: { role?: string; text?: string }[]
        sessionId?: string
        baseline?: number
      }>(request)
      const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
      if (accountId === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'accountId 必填' }, 400)
      }
      const account = domain.table('account').get(accountId)
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${accountId} 不存在` }, 404)
      }
      const messages: NlTurn[] = (Array.isArray(body?.messages) ? body.messages : [])
        .filter((t): t is { role: 'user' | 'assistant'; text: string } =>
          (t?.role === 'user' || t?.role === 'assistant') && typeof t?.text === 'string' && t.text.trim() !== '')
        .map(t => ({ role: t.role, text: t.text.trim() }))
      const last = messages[messages.length - 1]
      if (!last || last.role !== 'user') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: '最后一条消息必须是用户的输入' }, 400)
      }
      const period = account.cadence?.period ?? 'week'
      const snapshot: PlanChatSnapshot = {
        accountName: account.displayName,
        platformLabel: PLATFORM_OPTIONS.find(o => o.id === account.platform)?.label ?? account.platform,
        period,
        periodLabel: periodStart(period).label,
        published: publishedInPeriod(domain, accountId, period),
        target: account.cadence?.target ?? 0,
        slots: account.cadence?.slots ?? [],
        pillars: account.pillars ?? [],
        today: todayKey(),
        plans: plansInPeriod(domain, accountId, period).map(p => ({
          id: p.id,
          when: whenLabel(p.scheduledAt),
          article: p.articleId === null ? null : (domain.table('article').get(p.articleId)?.title ?? null),
          topic: p.topic ?? null,
        })),
      }
      // 走 dsh 会话（复用 dsh 默认模型与凭据），与文章生成同一条路线。
      // fail-closed：sessionController 未注入时直接报错，不回落直连 provider。
      const ctrl = (ctx as unknown as { sessionController?: MediaSessionController }).sessionController
      if (!ctrl?.create) {
        return json({ ok: false, code: 'NO_SESSION', message: 'dsh 会话服务未就绪，请重启后重试' }, 409)
      }
      const { system, user } = buildPlanChatPrompts(snapshot, last.text, messages.slice(0, -1))
      const promptText = [
        system, '', '---', '', user, '',
        '【输出要求】只输出一个 JSON 对象作为你的回复；',
        '不要写入文件、不要调用任何工具、不要输出执行计划或任务总结。',
      ].join('\n')
      // 会话句柄服务端持久化（存账号 planChat 槽）：关掉对话、刷新页面、换端进来都续用同一会话；
      // 客户端传回的句柄仅作兜底（旧客户端 / 槽缺失时）。「新对话」reset 清掉槽后开新会话。
      const stored = account.planChat
      const reuseId = stored?.sessionId
        ?? (typeof body?.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : undefined)
      const baseline = stored?.baseline
        ?? (typeof body?.baseline === 'number' && Number.isInteger(body.baseline) && body.baseline >= 0 ? body.baseline : undefined)
      const askOnce = (sessionId?: string) => askSession(ctrl, {
        title: `媒体工作台 · 发布规划 · ${account.displayName.slice(0, 16)}`,
        prompt: promptText,
        signal: request.signal,
        sessionId,
        baseline: sessionId !== undefined ? baseline : undefined,
      })
      let asked = await askOnce(reuseId)
      if (asked.failure !== undefined && reuseId !== undefined && !asked.accepted) {
        // 持久化的会话可能已随 dsh 重启失效：prompt 没被接受时降级开新会话重试一次
        asked = await askOnce(undefined)
      }
      // 句柄回存账号：下一轮无论从哪个端进来都续上（含失败轮——同一会话里排错重说）
      if (asked.sessionId !== null) {
        const sid = asked.sessionId
        await domain.table('account').update(accountId, (cur) => ({
          ...cur,
          planChat: { sessionId: sid, baseline: asked.baseline },
        }))
      }
      // 会话句柄随回复带回：客户端下一轮传回来即续用同一会话（不再每问一句新开一个）。
      const turn = { sessionId: asked.sessionId, baseline: asked.baseline }
      // 大模型不通 / 回复看不懂：仍返回会话句柄（同一会话里排错重说），明确标 fail 不静默兜底
      if (asked.failure) {
        return json({
          ok: true,
          data: {
            reply: null,
            proposal: null,
            fail: { code: 'LLM_UNAVAILABLE', message: `大模型调用失败：${asked.failure.zh}（${asked.failure.action}）` },
            ...turn,
          },
        })
      }
      const out = parsePlanChatJson(asked.text)
      if (out === null) {
        return json({
          ok: true,
          data: {
            reply: null,
            proposal: null,
            fail: { code: 'LLM_UNAVAILABLE', message: '模型返回的内容看不懂，请换个说法再说一遍' },
            ...turn,
          },
        })
      }
      if (out.proposal === null) {
        return json({ ok: true, data: { reply: out.reply, proposal: null, pillarSuggestions: out.pillarSuggestions, ...turn } })
      }
      const p = out.proposal
      const checked = validateProposal(domain, accountId, p)
      if (!checked.ok) {
        return json({
          ok: true,
          data: {
            reply: out.reply,
            proposal: null,
            fail: { code: 'PROPOSAL_INVALID', message: checked.message },
            ...turn,
          },
        })
      }
      const pub = publishedInPeriod(domain, accountId, p.period)
      // 新增档期的可用时段：已被保留计划占用的要避开；本次要移除的档期时刻可以复用
      const removedIds = new Set(checked.remove.map(x => x.id))
      const taken = new Set<string>()
      for (const [, row] of domain.table('plan').entries()) {
        if (row.accountId === accountId && !removedIds.has(row.id)) taken.add(slotKeyOf(row.scheduledAt))
      }
      const sp = computeSlotPlan(
        { period: p.period, target: p.target, slots: p.slots },
        pub,
        checked.keep.map(x => x.scheduledAt),
        taken,
      )
      const titleOf = (row: PlanRec): string | null =>
        row.articleId === null ? null : (domain.table('article').get(row.articleId)?.title ?? null)
      return json({
        ok: true,
        data: {
          reply: out.reply ?? '这是调整后的整期提案，确认后写入日程。',
          pillarSuggestions: out.pillarSuggestions,
          proposal: {
            period: p.period,
            periodLabel: periodStart(p.period).label,
            target: p.target,
            slots: p.slots,
            published: pub,
            topics: p.topics,
            keep: checked.keep.map(x => ({ id: x.id, scheduledAt: x.scheduledAt, title: titleOf(x) })),
            remove: checked.remove.map(x => ({ id: x.id, scheduledAt: x.scheduledAt, title: titleOf(x) })),
            add: sp.slots,
            shortfall: sp.needed - sp.slots.length,
          },
          ...turn,
        },
      })
    },
  }

  /** POST /api/media/plan/chat/reset — 结束当前对话排期会话（服务端清句柄，下轮开新会话）。 */
  const planChatReset: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/chat/reset`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ accountId?: string }>(request)
      const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
      if (accountId === '') return json({ ok: false, code: 'INVALID_REQUEST', message: 'accountId 必填' }, 400)
      const account = domain.table('account').get(accountId)
      if (!account) return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${accountId} 不存在` }, 404)
      await domain.table('account').update(accountId, (cur) => {
        const next = { ...cur }
        delete next.planChat
        return next
      })
      return json({ ok: true, data: { cleared: true } })
    },
  }

  /**
   * POST /api/media/plan/apply — 把「对话规划」确认后的整期提案原子落库。
   * body: { accountId, period, target, slots, removePlanIds[] }
   * 顺序：删待排槽 → 存发布目标 → 物化新增档期。幂等：重复提交同一提案不会重复生成
   * （已删的移除项跳过、已占用的档期跳过）。带文章的正式计划一律不允许移除。
   */
  const planApply: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/apply`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        accountId?: string
        period?: string
        target?: number
        slots?: unknown
        removePlanIds?: unknown
        topics?: unknown
      }>(request)
      const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
      if (accountId === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'accountId 必填' }, 400)
      }
      const account = domain.table('account').get(accountId)
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${accountId} 不存在` }, 404)
      }
      const cadence = normalizeCadence({ period: body?.period, target: body?.target, slots: body?.slots })
      if (!cadence || cadence.target < 1 || cadence.slots.length === 0) {
        return json({
          ok: false,
          code: 'INVALID_REQUEST',
          message: 'period/target/slots 不合法（target ≥1，slots 至少一个 HH:mm）',
        }, 400)
      }
      const removeIds = Array.isArray(body?.removePlanIds)
        ? body.removePlanIds.filter((x): x is string => typeof x === 'string')
        : []
      // 先整体校验移除项，再动库：只能删本账号的待排槽；已不存在的（重复提交）视作幂等跳过
      const toDelete: string[] = []
      for (const id of removeIds) {
        const row = domain.table('plan').get(id)
        if (!row) continue
        if (row.accountId !== accountId) {
          return json({ ok: false, code: 'PLAN_NOT_OWNED', message: `计划 ${id} 不属于该账号` }, 409)
        }
        if (row.articleId !== null) {
          return json({ ok: false, code: 'PLAN_NOT_SLOT', message: `计划 ${id} 已配文章，不能移除` }, 409)
        }
        toDelete.push(id)
      }
      for (const id of toDelete) await domain.table('plan').delete(id)
      await domain.table('account').put(accountId, { ...account, cadence })
      const removed = new Set(toDelete)
      const taken = new Set<string>()
      for (const [, row] of domain.table('plan').entries()) {
        if (row.accountId === accountId && !removed.has(row.id)) taken.add(slotKeyOf(row.scheduledAt))
      }
      const sp = computeSlotPlan(
        cadence,
        publishedInPeriod(domain, accountId, cadence.period),
        plannedInPeriod(domain, accountId, cadence.period).periodPlannedAt,
        taken,
      )
      const created: number[] = []
      // 对话提案带的选题清单：按发布顺序逐条配到新增档期上（可少给，多出的忽略）
      const topics = Array.isArray(body?.topics)
        ? body.topics.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim())
        : []
      let topicIndex = 0
      for (const ts of sp.slots) {
        const id = newId('plan')
        const topic = topics[topicIndex]
        if (topic !== undefined) topicIndex += 1
        await domain.table('plan').put(id, {
          id, articleId: null, platform: account.platform, accountId,
          scheduledAt: ts, state: 'planned' as const,
          ...(topic !== undefined ? { topic } : {}),
          createdAt: Date.now(),
        })
        created.push(ts)
      }
      return json({
        ok: true,
        data: { removed: toDelete.length, created: created.length, shortfall: sp.needed - created.length, slots: created },
      })
    },
  }

  /**
   * POST /api/media/plan/approve — 审核通过 / 单条跳过审核 / 跳过该条。
   * body: { id, action?: 'approve'|'skip', skipReview?: boolean, note? }
   * - action='skip' → state='skipped'（本条不发了）
   * - 其余（含 skipReview: true）→ state='approved'（任何状态允许人工直接批准）
   */
  const planApprove: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/approve`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        action?: 'approve' | 'skip'
        skipReview?: boolean
        note?: string
      }>(request)
      const plan = body?.id ? domain.table('plan').get(body.id) : undefined
      if (!plan) {
        return json({ ok: false, code: 'PLAN_NOT_FOUND', message: `计划 ${body?.id ?? ''} 不存在` }, 404)
      }
      // 待排槽没有可审内容：「跳过」= 直接删掉这个占位（不再需要这一档），不留下无文章的 skipped 记录
      if (plan.articleId === null && body?.action !== 'skip') {
        return json({ ok: false, code: 'PLAN_NO_ARTICLE', message: '这条是待排档期，还没有文章可审' }, 400)
      }
      if (plan.articleId === null) {
        await domain.table('plan').delete(plan.id)
        return json({ ok: true, data: { id: plan.id, state: 'deleted' } })
      }
      const state = body?.action === 'skip' ? 'skipped' as const : 'approved' as const
      await domain.table('plan').update(plan.id, (current) => ({
        ...current,
        state,
        reviewNote: body?.note ?? current.reviewNote,
      }))
      return json({ ok: true, data: { id: plan.id, state } })
    },
  }

  /**
   * POST /api/media/plan/delete — 移除一条计划（body: { id }）。
   * 已产生的发布回执 / 复盘保留（它们是发生过的事实），只删计划本身。
   */
  const planDelete: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const plan = body?.id ? domain.table('plan').get(body.id) : undefined
      if (!plan) {
        return json({ ok: false, code: 'PLAN_NOT_FOUND', message: `计划 ${body?.id ?? ''} 不存在` }, 404)
      }
      await domain.table('plan').delete(plan.id)
      const article = plan.articleId === null ? undefined : domain.table('article').get(plan.articleId)
      if (article) wsTask(writePlanFile(domain, article))
      return json({ ok: true, data: { deleted: true } })
    },
  }

  // ---------------------------------------------------------- review
  /** GET /api/media/review — 复盘数据（按 capturedAt 倒序）。 */
  const review: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/review`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const list = [...domain.table('review').entries()].map(([, v]) => v)
        .sort((a, b) => b.capturedAt - a.capturedAt)
      return json({ ok: true, data: list })
    },
  }

  /** POST /api/media/review/save — 手动录入复盘数据。 */
  const reviewSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/review/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        publishId?: string
        articleId?: string
        platform?: string
        metrics?: { reads?: number; likes?: number; comments?: number; shares?: number; collected?: number }
        note?: string
      }>(request)
      if (!body?.articleId || typeof body.platform !== 'string' || body.platform.trim() === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'articleId 与 platform 必填' }, 400)
      }
      if (!domain.table('article').get(body.articleId)) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${body.articleId} 不存在` }, 404)
      }
      const id = newId('rev')
      const record = {
        id,
        publishId: body.publishId ?? '',
        articleId: body.articleId,
        platform: body.platform.trim(),
        metrics: body.metrics ?? {},
        capturedAt: Date.now(),
        manual: true,
        note: body.note,
      }
      await domain.table('review').put(id, record)
      return json({ ok: true, data: record })
    },
  }

  // ---------------------------------------------------------- accounts
  /** GET /api/media/accounts — 账号列表（附今日已发/限额余量）。 */
  const accounts: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/accounts`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const list = [...domain.table('account').entries()].map(([, v]) => v)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(a => {
          const hist = publishHistory(domain, a.id)
          const period = a.cadence?.period ?? 'week'
          return {
            ...a,
            sentToday: sentToday(domain, a.id),
            // dailyLimit 是自设风控，不是平台配额；命名里带 Daily 以免被当成平台上限
            dailyLimitSelf: a.dailyLimit,
            publishTotal: hist.total,
            lastPublishedAt: hist.lastAt,
            canPublish: a.status === 'active' && getAdapter(a.platform)?.autoPublish === true,
            // 发布目标达成率：周期标签 + 本期真实成功发布数（没定目标也给，前端自行决定显不显示）
            periodLabel: periodStart(period).label,
            periodPublished: publishedInPeriod(domain, a.id, period),
            // 本期已排未发布：前端据此算「还差几篇」并排出候选时段
            ...plannedInPeriod(domain, a.id, period),
          }
        })
      return json({ ok: true, data: list })
    },
  }

  /** POST /api/media/account/save — 新建/更新平台账号。 */
  const accountSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        platform?: string
        displayName?: string
        status?: 'active' | 'expired' | 'disabled'
        dailyLimit?: number
        cadence?: unknown
        pillars?: unknown
      }>(request)
      if (!body || typeof body.platform !== 'string' || body.platform.trim() === '' ||
          typeof body.displayName !== 'string' || body.displayName.trim() === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'platform 与 displayName 必填' }, 400)
      }
      const existing = body.id ? domain.table('account').get(body.id) : undefined
      const id = body.id ?? newId('acc')

      // 发布目标：字段缺省 = 沿用旧值；传 null = 清空；传结构但不合法 = 400（不静默清空）
      let cadence: Account['cadence']
      if (body.cadence !== undefined) {
        if (body.cadence === null) cadence = undefined
        else {
          cadence = normalizeCadence(body.cadence)
          if (cadence === undefined) {
            return json({
              ok: false,
              code: 'INVALID_REQUEST',
              message: 'cadence 需要合法的 period(week|month) 与 target(≥0 的整数)',
            }, 400)
          }
        }
      } else {
        cadence = existing?.cadence
      }

      // 内容方向：缺省 = 沿用；null / 空数组 = 清空；非数组 = 400
      let pillars: string[] | undefined
      if (body.pillars !== undefined) {
        if (body.pillars === null) pillars = undefined
        else if (Array.isArray(body.pillars)) pillars = normalizeList(body.pillars)
        else {
          return json({ ok: false, code: 'INVALID_REQUEST', message: 'pillars 需为字符串数组' }, 400)
        }
      } else {
        pillars = existing?.pillars
      }

      const record: Account = {
        id,
        platform: body.platform.trim(),
        displayName: body.displayName.trim(),
        // 新账号一律「未登录」：建号 ≠ 已登录，写 active 会让调度器误以为可直接发布
        status: body.status ?? existing?.status ?? 'expired',
        dailyLimit: body.dailyLimit ?? existing?.dailyLimit ?? config.publish.dailyLimitPerAccount,
        lastLoginCheckAt: existing?.lastLoginCheckAt ?? null,
        createdAt: existing?.createdAt ?? Date.now(),
        // 重存（如设发布目标）不能把已采集的账号概况丢掉
        ...(existing?.profile ? { profile: existing.profile } : {}),
        // 对话排期的会话句柄是服务端状态，重存账号不能丢
        ...(existing?.planChat ? { planChat: existing.planChat } : {}),
        ...(cadence ? { cadence } : {}),
        ...(pillars ? { pillars } : {}),
      }
      await domain.table('account').put(id, record)
      return json({ ok: true, data: record })
    },
  }

  /** POST /api/media/account/delete — 删除账号。body: { id } */
  const accountDelete: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      if (!body?.id) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'id 不能为空' }, 400)
      }
      const existed = await domain.table('account').delete(body.id)
      let orphans: string[] = []
      if (existed) {
        // 配额计数器按「账号id:日期」存 global，删账号不清理就会留下孤儿键，
        // 以后再建同 id 的账号就会莫名继承旧额度。
        const g = domain.global.get() as Record<string, unknown>
        orphans = Object.keys(g).filter(k => k.startsWith(`publish:counter:${body.id}:`))
        if (orphans.length > 0) {
          const next = { ...g }
          for (const k of orphans) delete next[k]
          await domain.global.set(next)
        }
      }
      return json({ ok: true, data: { deleted: existed, cleanedCounters: orphans.length } })
    },
  }

  /** POST /api/media/account/login — 拉起托管浏览器等待扫码（长请求，约 3 分钟）。 */
  const accountLogin: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/login`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const account = body?.id ? domain.table('account').get(body.id) : undefined
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${body?.id ?? ''} 不存在` }, 404)
      }
      const adapter = getAdapter(account.platform)
      if (!adapter) {
        return json({ ok: false, code: 'PLATFORM_UNSUPPORTED', message: `平台 ${account.platform} 暂不支持` }, 400)
      }
      try {
        await adapter.ensureLogin(account, adapterOpts(config))
        await domain.table('account').update(account.id, (current) => ({
          ...current, status: 'active', lastLoginCheckAt: Date.now(),
        }))
        return json({ ok: true, data: { id: account.id, loggedIn: true } })
      } catch (err) {
        const code = err instanceof PublishError ? err.code : 'LOGIN_FAILED'
        const message = err instanceof Error ? err.message : String(err)
        if (code === 'LOGIN_EXPIRED') {
          await domain.table('account').update(account.id, (current) => ({ ...current, status: 'expired' }))
        }
        return json({ ok: false, code, message }, code === 'LOGIN_EXPIRED' ? 401 : 502)
      }
    },
  }

  /**
   * POST /api/media/account/login/stream — 扫码登录进度流（SSE）+ 可取消。
   * 相比阻塞版多三件事：① 实时回显「已拉起浏览器 / 在等什么」；
   * ② 用户可随时取消（不必等满 3 分钟超时）；③ 登录成功后**再校验一次**
   * 确认登录态真的落到了 profile 目录（否则报「登录态未持久化」而不是假装成功）。
   */
  const accountLoginStream: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/login/stream`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const account = body?.id ? domain.table('account').get(body.id) : undefined
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${body?.id ?? ''} 不存在` }, 404)
      }
      const adapter = getAdapter(account.platform)
      if (!adapter) {
        return json({ ok: false, code: 'PLATFORM_UNSUPPORTED', message: `平台 ${account.platform} 暂不支持` }, 400)
      }

      const controller = new AbortController()
      loginControllers.set(account.id, controller)
      const started = Date.now()
      const encoder = new TextEncoder()

      const stream = new ReadableStream<Uint8Array>({
        start(streamCtl) {
          const send = (obj: object): void => {
            try { streamCtl.enqueue(encoder.encode(sseEvent(obj))) } catch { /* 已关闭 */ }
          }
          void (async () => {
            try {
              const res = await adapter.ensureLogin(account, adapterOpts(config), {
                signal: controller.signal,
                onProgress: (p) => { send({ type: 'stage', ...p }) },
              })
              // 二次校验：确认登录态已持久化到 profile（重启后仍能用）
              send({ type: 'stage', stage: 'verifying', message: '扫码完成，正在校验登录态是否已保存…' })
              const persisted = await adapter.checkLogin(account, adapterOpts(config)).catch(() => false)
              if (!persisted) {
                send({
                  type: 'error',
                  code: 'LOGIN_NOT_PERSISTED',
                  message: '平台页面显示已登录，但复核时未通过；请重试或确认账号无二次验证要求',
                })
                return
              }
              await domain.table('account').update(account.id, (current) => ({
                ...current, status: 'active', lastLoginCheckAt: Date.now(),
              }))
              send({
                type: 'done',
                loggedIn: true,
                reason: res.reason ?? '登录成功',
                elapsed: Math.round((Date.now() - started) / 1000),
              })
            } catch (err) {
              const code = err instanceof PublishError ? err.code : 'LOGIN_FAILED'
              const message = err instanceof Error ? err.message : String(err)
              // 只有「等超时」才判定登录态失效；用户主动取消不该把原本已登录的账号标成过期
              if (code === 'LOGIN_EXPIRED') {
                await domain.table('account').update(account.id, (current) => ({ ...current, status: 'expired' }))
              }
              send({ type: 'error', code, message, elapsed: Math.round((Date.now() - started) / 1000) })
            } finally {
              loginControllers.delete(account.id)
              try { streamCtl.close() } catch { /* noop */ }
            }
          })()
        },
        cancel() {
          controller.abort()
          loginControllers.delete(account.id)
        },
      })

      return sseResponse(stream)
    },
  }

  /** POST /api/media/account/login/cancel — 取消进行中的扫码登录。 */
  const accountLoginCancel: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/login/cancel`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const id = body?.id ?? ''
      const controller = loginControllers.get(id)
      if (!controller) {
        return json({ ok: false, code: 'NOT_LOGGING_IN', message: '该账号当前没有进行中的登录' }, 404)
      }
      controller.abort()
      loginControllers.delete(id)
      // 顺手关掉该账号的托管浏览器：否则窗口会挂到 10 分钟空闲回收，白占屏幕
      wsTask(browserPool.close(id))
      return json({ ok: true, data: { id, cancelled: true } })
    },
  }

  /** POST /api/media/browser/close-all — 关闭当前全部托管浏览器（批量检测/采集收尾用）。 */
  const browserCloseAll: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/browser/close-all`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      await browserPool.closeAll()
      return json({ ok: true })
    },
  }

  /** POST /api/media/account/check — 静默校验登录态（不写不发）。 */
  const accountCheck: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/account/check`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const account = body?.id ? domain.table('account').get(body.id) : undefined
      if (!account) {
        return json({ ok: false, code: 'ACCOUNT_NOT_FOUND', message: `账号 ${body?.id ?? ''} 不存在` }, 404)
      }
      const adapter = getAdapter(account.platform)
      if (!adapter) {
        return json({ ok: false, code: 'PLATFORM_UNSUPPORTED', message: `平台 ${account.platform} 暂不支持` }, 400)
      }
      try {
        const loggedIn = await adapter.checkLogin(account, adapterOpts(config))
        await domain.table('account').update(account.id, (current) => ({
          ...current,
          status: loggedIn ? 'active' : 'expired',
          lastLoginCheckAt: Date.now(),
        }))
        return json({ ok: true, data: { id: account.id, loggedIn } })
      } catch (err) {
        return json({
          ok: false,
          code: 'CHECK_FAILED',
          message: `登录态校验失败：${err instanceof Error ? err.message : String(err)}`,
        }, 502)
      }
    },
  }

  // ---------------------------------------------------------- plan/run
  /**
   * POST /api/media/plan/run — 立即执行发布（body: id）。
   * 状态：approved → publishing → published / degraded（LOGIN_EXPIRED 回 approved）。
   */
  const planRun: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/plan/run`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ planId?: string }>(request)
      const result = await runPlanCore(domain, config, body?.planId ?? '')
      return json(
        result.ok ? { ok: true, data: result.data } : { ok: false, code: result.code, message: result.message },
        result.status,
      )
    },
  }

  /** POST /api/media/publish/manual — 人工发布后回填链接。 */
  const publishManual: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/publish/manual`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ planId?: string; url?: string }>(request)
      const plan = body?.planId ? domain.table('plan').get(body.planId) : undefined
      if (!plan || !body) {
        return json({ ok: false, code: 'PLAN_NOT_FOUND', message: `计划 ${body?.planId ?? ''} 不存在` }, 404)
      }
      if (typeof body.url !== 'string' || body.url.trim() === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'url 不能为空' }, 400)
      }
      if (plan.articleId === null) {
        return json({ ok: false, code: 'PLAN_NO_ARTICLE', message: '这条是待排档期，还没有文章，无法回填发布链接' }, 400)
      }
      const url = body.url.trim()
      // 更新该计划最近一条 publish 记录；没有就补建
      const latest = [...domain.table('publish').entries()]
        .map(([, v]) => v)
        .filter(p => p.planId === plan.id)
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0]
      let publishId: string
      if (latest) {
        publishId = latest.id
        await domain.table('publish').update(publishId, (current) => ({
          ...current, state: 'success', url, publishedAt: Date.now(), error: undefined,
        }))
      } else {
        publishId = newId('pub')
        await domain.table('publish').put(publishId, {
          id: publishId, planId: plan.id, platform: plan.platform, accountId: plan.accountId,
          state: 'success', url, publishedAt: Date.now(),
        })
      }
      const key = `publish:counter:${plan.accountId}:${todayKey()}`
      await domain.global.set({ ...domain.global.get(), [key]: globalNumber(domain, key) + 1 })
      await domain.table('plan').update(plan.id, (current) => ({ ...current, state: 'published' }))
      // 工作文件夹：人工回填同样视为发布成功，落盘平台版本
      const manualArticle = domain.table('article').get(plan.articleId)
      if (manualArticle) wsTask(writePlatformFile(domain, { ...plan, state: 'published' }, manualArticle, url))
      return json({ ok: true, data: { publishId, state: 'published', url } })
    },
  }

  /**
   * POST /api/media/open-url — 用系统默认浏览器打开一个外链（回执卡的「打开文章 / 打开后台」）。
   *
   * 壳里 **`window.open` 是空操作**：主窗口由 tauri.conf.json 声明，没注册 Tauri 的
   * `on_new_window` 处理器，webkit2gtk 的 create 信号没人接 → 新窗口直接不创建
   * （也没装 opener 插件、没给建窗权限）。所以外链只能由**宿主进程**代开。
   * 只接受 http(s)，且 url 以 argv 传给 xdg-open/open（不过 shell），没有拼接注入面。
   */
  const openExternalUrl: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/open-url`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ url?: string }>(request)
      const raw = typeof body?.url === 'string' ? body.url.trim() : ''
      if (raw === '') return json({ ok: false, code: 'INVALID_REQUEST', message: 'url 不能为空' }, 400)
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        return json({ ok: false, code: 'INVALID_REQUEST', message: `不是合法的链接：${raw}` }, 400)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: `只允许 http(s) 链接（收到 ${parsed.protocol}）` }, 400)
      }
      const target = parsed.toString()
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
      const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[media/open-url] 拉起系统浏览器失败（${cmd}）：${message}`)
        return json({ ok: false, code: 'OPEN_FAILED', message: `没能拉起系统浏览器：${message}` }, 500)
      }
      return json({ ok: true, data: { url: target } })
    },
  }

  /** GET /api/media/scheduler — 定时发布调度器状态与有效配置。 */
  const schedulerGet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/scheduler`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const g = domain.global.get() as Record<string, unknown>
      const tickSeconds = typeof g['scheduler:tickSeconds'] === 'number'
        ? g['scheduler:tickSeconds'] as number
        : config.publish.tickSeconds
      return json({
        ok: true,
        data: {
          tickSeconds,
          minGapMinutes: config.publish.minGapMinutes,
          dailyLimitPerAccount: config.publish.dailyLimitPerAccount,
          lastRunAt: schedulerState.lastRunAt,
          lastResult: schedulerState.lastResult,
          timerTicks: schedulerState.timerTicks,
        },
      })
    },
  }

  /**
   * POST /api/media/scheduler/tick — 立即巡检一次（不等到轮询点）。
   * body: { dryRun?: boolean } —— dryRun 只回报「将要发布什么」，不执行、不开浏览器。
   * 前端先 dryRun 预览、再让用户确认执行，避免无人值守时炸出一堆浏览器窗口。
   */
  const schedulerTick: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/scheduler/tick`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ dryRun?: boolean }>(request)
      const dryRun = body?.dryRun === true
      try {
        const r = await runSchedulerOnce(domain, config, { dryRun })
        return json({ ok: true, data: { ...r, dryRun } })
      } catch (err) {
        return json({
          ok: false,
          code: 'SCHEDULER_TICK_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }, 500)
      }
    },
  }

  /** POST /api/media/scheduler/save — 运行期调整巡检间隔（存 domain global，持久于媒体库）。 */
  const schedulerSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/scheduler/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ tickSeconds?: number }>(request)
      if (!body) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'body 不能为空' }, 400)
      }
      const g: Record<string, unknown> = { ...(domain.global.get() as Record<string, unknown>) }
      if (typeof body.tickSeconds === 'number' && Number.isFinite(body.tickSeconds)) {
        g['scheduler:tickSeconds'] = Math.max(15, Math.round(body.tickSeconds))
      }
      await domain.global.set(g)
      return json({
        ok: true,
        data: { tickSeconds: g['scheduler:tickSeconds'] },
      })
    },
  }

  /** 生图渠道的对外形状：key 只回「有没有」，不回本体。 */
  const publicChannels = (): Array<{ id: string; name: string; baseUrl: string; hasApiKey: boolean; models: { alias: string; id: string }[]; protocol: 'openai' | 'dashscope' }> =>
    imageGenRuntime(domain).channels.map(c => ({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      hasApiKey: c.apiKey !== '',
      models: c.models,
      protocol: c.protocol,
    }))

  /**
   * 生图配置的完整对外载荷：状态 + 渠道 + 内置预设。
   * 读接口与所有写接口共用同一形状 —— 客户端每次写后直接以返回覆盖本地态，
   * 少带 presets 会让「一键预设」按钮在保存后凭空消失。
   */
  const imageGenPayload = (): Record<string, unknown> => ({
    ...imageAdapterStatus(domain),
    channels: publicChannels(),
    presets: IMAGE_PRESETS,
  })

  /** GET /api/media/imagegen — 生图配置状态（总开关 / agent 开关 / 渠道 / 生效者；不回显 key）。 */
  const imageGenGet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/imagegen`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, data: imageGenPayload() }),
  }

  /** POST /api/media/imagegen/save — 总开关 / agent 自动配图开关 / 默认渠道。 */
  const imageGenSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/imagegen/save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ enabled?: boolean; allowAgent?: boolean; defaultChannelId?: string }>(request)
      if (!body) return json({ ok: false, code: 'INVALID_REQUEST', message: 'body 不能为空' }, 400)
      const g: Record<string, unknown> = { ...(domain.global.get() as Record<string, unknown>) }
      if (body.enabled !== undefined) g['imageGen:enabled'] = body.enabled === true
      if (body.allowAgent !== undefined) g['imageGen:allowAgent'] = body.allowAgent === true
      if (body.defaultChannelId !== undefined) {
        const id = body.defaultChannelId.trim()
        if (id !== '' && !imageGenRuntime(domain).channels.some(c => c.id === id)) {
          return json({ ok: false, code: 'INVALID_REQUEST', message: `渠道不存在：${id}` }, 400)
        }
        g['imageGen:defaultChannelId'] = id
      }
      await domain.global.set(g)
      return json({ ok: true, data: imageGenPayload() })
    },
  }

  /** POST /api/media/imagegen/channel — 新增 / 覆盖一个渠道（apiKey 省略=保留原值）。 */
  const imageGenChannelSave: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/imagegen/channel`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        id?: string
        name?: string
        baseUrl?: string
        apiKey?: string
        models?: { alias?: string; id?: string }[]
        protocol?: string
      }>(request)
      if (!body) return json({ ok: false, code: 'INVALID_REQUEST', message: 'body 不能为空' }, 400)
      const channels = imageGenRuntime(domain).channels
      const id = (body.id ?? '').trim() || `ch-${Date.now().toString(36)}`
      const prev = channels.find(c => c.id === id)
      const baseUrl = (body.baseUrl ?? prev?.baseUrl ?? '').trim()
      if (baseUrl !== '' && !/^https?:\/\/\S+$/.test(baseUrl)) {
        return json({ ok: false, code: 'INVALID_REQUEST', message: `端点需以 http(s):// 开头：${baseUrl}` }, 400)
      }
      const models = body.models === undefined
        ? (prev?.models ?? [])
        : (Array.isArray(body.models) ? body.models : [])
          .map(m => ({ alias: (m.alias ?? '').trim(), id: (m.id ?? m.alias ?? '').trim() }))
          .filter(m => m.alias !== '' || m.id !== '')
      // apiKey 省略 = 不改；显式空串 = 清空（渠道变不可用，UI 会标出来）。
      const apiKey = body.apiKey === undefined ? (prev?.apiKey ?? '') : body.apiKey.trim()
      // protocol 省略 = 保留原值（新渠道缺省 openai 方言）。
      const protocol = body.protocol === 'dashscope' ? 'dashscope'
        : body.protocol === 'openai' ? 'openai'
          : (prev?.protocol ?? 'openai')
      const next = [...channels.filter(c => c.id !== id), {
        id,
        name: (body.name ?? prev?.name ?? '').trim() || `渠道 ${channels.length + 1}`,
        baseUrl: baseUrl.replace(/\/$/, ''),
        apiKey,
        models,
        protocol,
      }]
      const g: Record<string, unknown> = { ...(domain.global.get() as Record<string, unknown>), 'imageGen:channels': next }
      // 首个渠道自动成为默认，省一次手动选择。
      if (typeof g['imageGen:defaultChannelId'] !== 'string' || (g['imageGen:defaultChannelId'] as string) === '') {
        g['imageGen:defaultChannelId'] = id
      }
      await domain.global.set(g)
      return json({ ok: true, data: imageGenPayload() })
    },
  }

  /** POST /api/media/imagegen/channel/delete — 删一个渠道；删掉的若是默认渠道，改落到首个剩余渠道。 */
  const imageGenChannelDelete: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/imagegen/channel/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ id?: string }>(request)
      const id = (body?.id ?? '').trim()
      if (id === '') return json({ ok: false, code: 'INVALID_REQUEST', message: '缺少渠道 id' }, 400)
      const rt = imageGenRuntime(domain)
      if (!rt.channels.some(c => c.id === id)) {
        return json({ ok: false, code: 'CHANNEL_NOT_FOUND', message: `渠道不存在：${id}` }, 404)
      }
      const next = rt.channels.filter(c => c.id !== id)
      const g: Record<string, unknown> = {
        ...(domain.global.get() as Record<string, unknown>),
        'imageGen:channels': next,
        'imageGen:defaultChannelId': rt.defaultChannelId === id ? (next[0]?.id ?? '') : rt.defaultChannelId,
      }
      await domain.global.set(g)
      return json({ ok: true, data: imageGenPayload() })
    },
  }

  /** GET /api/media/videogen — 视频生成供应商状态。 */
  const videoGenGet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/videogen`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({
      ok: true,
      data: { adapters: videoAdapterStatus(domain), supported: resolveVideoAdapter(domain) !== null },
    }),
  }

  /**
   * POST /api/media/video/generate — 视频生成（适配位）。
   * 当前仅注册 none 占位，未接入真实供应商 → 明确 501，不产出占位视频。
   */
  const videoGenerate: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/video/generate`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ articleId?: string }>(request)
      const article = body?.articleId ? domain.table('article').get(body.articleId) : undefined
      if (!article) {
        return json({ ok: false, code: 'ARTICLE_NOT_FOUND', message: `文章 ${body?.articleId ?? ''} 不存在` }, 404)
      }
      const adapter = resolveVideoAdapter(domain)
      if (!adapter) {
        return json({
          ok: false,
          code: 'VIDEO_NOT_CONFIGURED',
          message: '尚未接入视频生成供应商（当前为占位适配器）；接入后本路由将返回视频文件地址',
        }, 501)
      }
      try {
        const out = await adapter.generate({
          title: article.title,
          scriptMd: article.bodyMd,
        }, domain)
        return json({
          ok: true,
          data: { articleId: article.id, ext: out.ext, bytes: out.data.byteLength, provider: adapter.id },
        })
      } catch (err) {
        return json({
          ok: false,
          code: 'VIDEO_GEN_FAILED',
          message: err instanceof Error ? err.message : String(err),
        }, 502)
      }
    },
  }

  /** GET /api/media/stats — 聚合统计（追热点 vs 常青 / 按平台）。 */
  const stats: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/stats`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, data: computeStats(domain) }),
  }

  /**
   * POST /api/media/review/sync — M6：对已发布且有 url 的 publish 记录，
   * 逐条用对应 adapter 打开文章页抓指标，upsert review（manual:false）。
   * 单篇失败不阻塞整体；返回 {synced, failed, skipped, details}。
   */
  const reviewSync: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/review/sync`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const publishes = [...domain.table('publish').entries()].map(([, v]) => v)
        .filter(p => p.state === 'success' && p.url)
      const accountsById = new Map([...domain.table('account').entries()].map(([, v]) => [v.id, v]))
      const opts = adapterOpts(config)
      let synced = 0, failed = 0, skipped = 0
      const details: { publishId: string; platform: string; result: string }[] = []

      for (const pub of publishes) {
        const account = accountsById.get(pub.accountId)
        if (!account || account.status !== 'active') {
          skipped++
          details.push({ publishId: pub.id, platform: pub.platform, result: 'skipped: account inactive/missing' })
          continue
        }
        const adapter = getAdapter(pub.platform)
        if (!adapter?.fetchMetrics) {
          skipped++
          details.push({ publishId: pub.id, platform: pub.platform, result: 'skipped: adapter has no fetchMetrics' })
          continue
        }
        try {
          const metrics = await adapter.fetchMetrics(account, pub.url!, opts)
          // 按 publishId 找已有 review（同平台同 publishId 只留最新一条）
          const existing = [...domain.table('review').entries()].map(([, v]) => v)
            .filter(r => r.publishId === pub.id)
            .sort((a, b) => b.capturedAt - a.capturedAt)[0]
          const record = {
            id: existing?.id ?? newId('rev'),
            publishId: pub.id,
            articleId: domain.table('plan').get(pub.planId)?.articleId ?? '',
            platform: pub.platform,
            metrics,
            capturedAt: Date.now(),
            manual: false,
          }
          await domain.table('review').put(record.id, record)
          synced++
          details.push({ publishId: pub.id, platform: pub.platform, result: `synced: ${Object.keys(metrics).length} fields` })
        } catch (e) {
          failed++
          const code = e instanceof PublishError ? e.code : 'UNKNOWN'
          details.push({ publishId: pub.id, platform: pub.platform, result: `failed: ${code} ${e instanceof Error ? e.message : String(e)}` })
        }
      }

      // 记游标
      const g = domain.global.get() as Record<string, unknown>
      await domain.global.set({ ...g, 'review:lastSync': Date.now() })

      return json({ ok: true, data: { synced, failed, skipped, details } })
    },
  }

  // ---------------------------------------------------------- feed
  /**
   * GET /api/media/feed — 工作台动态流：把热点/文章/计划/发布/复盘/账号
   * 聚合为按时间倒序的汇报卡片时间线（简报/待审草稿/发布回执/数据回报/事件）。
   */
  const feed: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/feed`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const now = Date.now()
      // `pub_<ts>_<rand>`：降级记录 publishedAt 为 null 时，用 id 内嵌时间戳兜底
      const idTs = (id: string): number => {
        const ts = Number(id.split('_')[1])
        return Number.isFinite(ts) ? ts : 0
      }

      const items: FeedItem[] = []

      // brief：48h 内待用热点合并成一张简报卡（跨人设最高契合分优先，热度兜底，截 8 条）
      const pendingHotspots = [...domain.table('hotspot').entries()].map(([, v]) => v)
        .filter(h => h.state === 'pending' && now - h.fetchedAt < 48 * 3_600_000)
        .sort((a, b) => (bestFitScore(b) ?? b.heat ?? 0) - (bestFitScore(a) ?? a.heat ?? 0))
      if (pendingHotspots.length > 0) {
        items.push({
          kind: 'brief',
          id: 'brief:pending',
          at: Math.max(...pendingHotspots.map(h => h.fetchedAt)),
          hotspots: pendingHotspots.slice(0, 8),
          total: pendingHotspots.length,
        })
      }

      // plans 按文章分组，文章建索引；待排槽（articleId=null）不属任何文章，跳过以免污染草稿分组
      const plansByArticle = new Map<string, PlanRec[]>()
      const planById = new Map<string, PlanRec>()
      for (const p of [...domain.table('plan').entries()].map(([, v]) => v)) {
        planById.set(p.id, p)
        if (p.articleId === null) continue
        const list = plansByArticle.get(p.articleId) ?? []
        list.push(p)
        plansByArticle.set(p.articleId, list)
      }
      const articleById = new Map([...domain.table('article').entries()].map(([, v]) => [v.id, v]))
      const PLAN_OPEN = new Set(['pending-review', 'approved', 'publishing'])

      // draft：待你审的草稿（有正文、生成中，或生成失败待重试，且无计划或计划仍在待办态）
      for (const article of articleById.values()) {
        if (article.bodyMd.trim() === '' && article.status !== 'generating' && article.status !== 'failed') continue
        const plans = plansByArticle.get(article.id) ?? []
        if (plans.length > 0 && !plans.some(p => PLAN_OPEN.has(p.state))) continue
        items.push({
          kind: 'draft',
          id: `draft:${article.id}`,
          at: article.updatedAt,
          article,
          plans: [...plans].sort((a, b) => a.scheduledAt - b.scheduledAt),
        })
      }

      // receipt：发布回执（成功带链接 / 降级带人工包 / 失败带原因）
      for (const pub of [...domain.table('publish').entries()].map(([, v]) => v)) {
        const plan = planById.get(pub.planId)
        items.push({
          kind: 'receipt',
          id: `receipt:${pub.id}`,
          at: pub.publishedAt ?? idTs(pub.id),
          publish: pub,
          article: articleById.get(plan?.articleId ?? ''),
          plan,
        })
      }

      // metrics：数据回报（review 快照）
      for (const rev of [...domain.table('review').entries()].map(([, v]) => v)) {
        items.push({
          kind: 'metrics',
          id: `metrics:${rev.id}`,
          at: rev.capturedAt,
          review: rev,
          article: articleById.get(rev.articleId),
        })
      }

      // event：账号登录过期 → 需要人工扫码
      for (const acc of [...domain.table('account').entries()].map(([, v]) => v)) {
        if (acc.status !== 'expired') continue
        items.push({
          kind: 'event',
          id: `event:expired:${acc.id}`,
          at: acc.lastLoginCheckAt ?? now,
          accountId: acc.id,
          platform: acc.platform,
          displayName: acc.displayName,
        })
      }

      items.sort((a, b) => b.at - a.at)
      return json({ ok: true, data: { items: items.slice(0, 60), pendingHotspots: pendingHotspots.length } })
    },
  }

  // ---------------------------------------------------------- dispatch
  /**
   * POST /api/media/dispatch — NL 派活解析。body: { text, sessionId?, baseline? }
   * 会话句柄原样带回：客户端每条派活指令传回，全部落在同一个 dsh 会话里（不再每句新开一个）。
   * LLM 不可用或解析失败时返回 parsed:null + reason，前端降级打开确认弹窗。
   */
  const dispatch: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/dispatch`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ text?: string; sessionId?: string; baseline?: number }>(request)
      const text = body?.text?.trim() ?? ''
      if (text === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'text 不能为空' }, 400)
      }
      const ctrl = (ctx as unknown as { sessionController?: MediaSessionController }).sessionController
      if (!ctrl?.create) {
        return json({ ok: true, data: { parsed: null, reason: 'NO_LLM' } })
      }
      const personaNames = [...domain.table('persona').entries()].map(([, v]) => v.name)
      const { system, user } = buildDispatchPrompts(text, PLATFORM_OPTIONS, personaNames)
      try {
        const asked = await askSession(ctrl, {
          title: '媒体工作台 · 派活解析',
          prompt: [system, '', '---', '', user, '', '【输出要求】只输出一个 JSON 对象作为你的回复；不要写入文件、不要调用任何工具。'].join('\n'),
          signal: request.signal,
          sessionId: typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined,
          baseline: typeof body?.baseline === 'number' && Number.isFinite(body.baseline) && body.baseline >= 0
            ? Math.floor(body.baseline)
            : 0,
        })
        // 失败也带回句柄，下一句指令仍在同一会话里
        const handle = { sessionId: asked.sessionId, baseline: asked.baseline }
        if (asked.failure) {
          return json({ ok: true, data: { parsed: null, reason: 'LLM_ERROR', ...handle } })
        }
        const parsed = parseDispatchJson(asked.text)
        // 把解析出的人设名匹配成本地 personaId（精确 → 包含），匹配不上保持 null
        let personaId: string | null = null
        const wanted = parsed?.persona ?? null
        if (parsed && wanted) {
          const all = sortedPersonas(domain)
          const hit = all.find(p => p.name === wanted)
            ?? all.find(p => p.name.includes(wanted) || wanted.includes(p.name))
          personaId = hit?.id ?? null
        }
        return json({
          ok: true,
          data: {
            parsed: parsed ? { ...parsed, personaId } : null,
            reason: parsed ? 'OK' : 'UNPARSABLE',
            ...handle,
          },
        })
      } catch {
        return json({ ok: true, data: { parsed: null, reason: 'LLM_ERROR' } })
      }
    },
  }

  // ---------------------------------------------------------- nl parse
  /**
   * POST /api/media/nl/parse — 对话式设置解析（表单的替代形态）。
   * body: { kind: 'account'|'persona'|'review', text, history?, current?, articles?, sessionId?, baseline? }
   * 返回 { fields, question, reason, sessionId, baseline }；fields/question 都为空表示本轮没解析出来。
   * 会话句柄（sessionId/baseline）原样带回，客户端下轮传回以复用同一个 dsh 会话（否则每轮新建一个会话）。
   */
  const nlParse: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/nl/parse`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{
        kind?: string
        text?: string
        history?: { role?: string; text?: string }[]
        current?: Record<string, unknown>
        articles?: { id?: string; title?: string }[]
        sessionId?: string
        baseline?: number
      }>(request)
      const kind = body?.kind
      const text = body?.text?.trim() ?? ''
      const kinds: NlParseKind[] = ['account', 'persona', 'review']
      if (!kind || !kinds.includes(kind as NlParseKind) || text === '') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'kind 或 text 不合法' }, 400)
      }
      const history: NlTurn[] = (Array.isArray(body?.history) ? body.history : [])
        .filter((t): t is { role: 'user' | 'assistant'; text: string } =>
          (t?.role === 'user' || t?.role === 'assistant') && typeof t?.text === 'string' && t.text.trim() !== '')
        .map(t => ({ role: t.role, text: t.text }))
      const articles = (Array.isArray(body?.articles) ? body.articles : [])
        .filter((a): a is { id: string; title: string } =>
          typeof a?.id === 'string' && a.id !== '' && typeof a?.title === 'string' && a.title !== '')
        .map(a => ({ id: a.id, title: a.title }))
      const current = body?.current && typeof body.current === 'object' ? body.current : undefined
      const ctrl = (ctx as unknown as { sessionController?: MediaSessionController }).sessionController
      if (!ctrl?.create) {
        return json({ ok: true, data: { fields: null, question: null, reason: 'NO_LLM' } })
      }
      const { system, user } = buildNlParsePrompts(kind as NlParseKind, text, history, { current, articles })
      try {
        const asked = await askSession(ctrl, {
          title: '媒体工作台 · 对话式设置',
          prompt: [system, '', '---', '', user, '', '【输出要求】只输出一个 JSON 对象作为你的回复；不要写入文件、不要调用任何工具。'].join('\n'),
          signal: request.signal,
          sessionId: typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined,
          baseline: typeof body?.baseline === 'number' && Number.isFinite(body.baseline) && body.baseline >= 0
            ? Math.floor(body.baseline)
            : 0,
        })
        const handle = { sessionId: asked.sessionId, baseline: asked.baseline }
        if (asked.failure) {
          return json({ ok: true, data: { fields: null, question: null, reason: 'LLM_ERROR', ...handle } })
        }
        const parsed = parseNlJson(asked.text)
        return json({
          ok: true,
          data: {
            fields: parsed?.fields ?? null,
            question: parsed?.question ?? null,
            reason: parsed ? 'OK' : 'UNPARSABLE',
            ...handle,
          },
        })
      } catch {
        return json({ ok: true, data: { fields: null, question: null, reason: 'LLM_ERROR' } })
      }
    },
  }

  // ---------------------------------------------------------- workspace
  /** GET /api/media/workspace — 当前工作文件夹（root 空串=未设置）+ 建议的专用工作区路径。 */
  const workspaceGet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/workspace`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, data: { root: workspaceRoot(domain), suggested: suggestWorkspaceRoot() } }),
  }

  /** POST /api/media/workspace/set — 设置/清除工作文件夹（root 空串=清除）。目录不可用时 400。 */
  const workspaceSet: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/workspace/set`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJson<{ root?: string }>(request)
      if (!body || typeof body.root !== 'string') {
        return json({ ok: false, code: 'INVALID_REQUEST', message: 'root 必填（空串=清除）' }, 400)
      }
      try {
        await setWorkspaceRoot(domain, body.root)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return json({ ok: false, code: 'INVALID_ROOT', message: `目录不可用：${msg}` }, 400)
      }
      return json({ ok: true, data: { root: workspaceRoot(domain) } })
    },
  }

  /** POST /api/media/workspace/sync — 存量文章全量落盘。 */
  const workspaceSync: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/workspace/sync`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => json({ ok: true, data: await syncWorkspace(domain) }),
  }

  /** 存量修复一次性标志：早前无 LLM key 时失败文章被误标 editing/generating，迁为 failed。 */
  let stuckMigrated = false

  /**
   * GET /api/media/content — 内容管理聚合列表：article 按 updatedAt 倒序，
   * 每篇联查其 plans、publishes、reviews（每条 publish 取最新一条 review）。
   * 筛选/搜索/排序/分页由客户端派生。
   */
  const content: ConnectionFetchRoute = {
    path: `${ROUTE_PREFIX}/content`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      if (!stuckMigrated) {
        stuckMigrated = true
        const table = domain.table('article')
        for (const [id, a] of [...table.entries()]) {
          if ((a.status === 'editing' || a.status === 'generating') && !a.bodyMd.trim()) {
            await table.update(id, (cur) => ({ ...cur, status: 'failed', updatedAt: Date.now() }))
          }
        }
      }
      const articles = [...domain.table('article').entries()].map(([, v]) => v)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const plans = [...domain.table('plan').entries()].map(([, v]) => v)
        .sort((a, b) => a.createdAt - b.createdAt)
      const publishes = [...domain.table('publish').entries()].map(([, v]) => v)
      const reviews = [...domain.table('review').entries()].map(([, v]) => v)
        .sort((a, b) => b.capturedAt - a.capturedAt)
      const rows = articles.map((article) => {
        const articlePlans = plans.filter(p => p.articleId === article.id)
        const planIds = new Set(articlePlans.map(p => p.id))
        const articlePublishes = publishes.filter(p => planIds.has(p.planId))
        const latestReviewByPublish = new Map<string, typeof reviews[number]>()
        for (const r of reviews) {
          if (r.articleId !== article.id || latestReviewByPublish.has(r.publishId)) continue
          latestReviewByPublish.set(r.publishId, r)
        }
        return {
          article,
          plans: articlePlans,
          publishes: articlePublishes,
          reviews: [...latestReviewByPublish.values()],
        }
      })
      // 待排槽：不属于任何文章，单独返回，由发布节奏的月历/账号泳道直接渲染
      const slots = plans
        .filter(p => p.articleId === null)
        .sort((a, b) => a.scheduledAt - b.scheduledAt)
      return json({ ok: true, data: { rows, slots } })
    },
  }

  return [
    health,
    persona, personaSave, personaBind, personaDelete,
    accounts, accountSave, accountDelete, accountLogin, accountLoginStream, accountLoginCancel, accountCheck, accountCollect, accountWorksGet,
    browserCloseAll,
    hotspots, hotspotRefresh, hotspotSave, hotspotScore, hotspotAdopt, hotspotDelete,
    hotspotFetchersGet, hotspotFetchersSave,
    articles, articleSave, articleDelete, articleApprove, articleRewrite, articleIllustrate, articleGenerate,
    articleAsset, asset, assetGenerate, assetsListRoute(domain), content,
    plan, planSave, planSlots, planChat, planChatReset, planApply, planApprove, planRun, planDelete,
    publishManual,
    openExternalUrl,
    review, reviewSave, reviewSync,
    stats,
    schedulerGet, schedulerSave, schedulerTick,
    imageGenGet, imageGenSave, imageGenChannelSave, imageGenChannelDelete, videoGenGet, videoGenerate,
    dispatch, nlParse, feed,
    workspaceGet, workspaceSet, workspaceSync,
  ]
}
