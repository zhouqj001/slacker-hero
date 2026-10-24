/**
 * 选题线：personaFit 人设闸门评分 + 聚合热榜抓取解析。
 * 评分复用 llm.ts 的 resolveProviderModel / collectArticleStream，
 * 低温度、严格 JSON 输出，解析失败重试 1 次后标 parse-failed。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'
import type { HotspotSchema, PersonaSchema } from './domain.ts'
import { collectArticleStream, resolveProviderModel, type LlmErrorInfo } from './llm.ts'

export type Hotspot = z.output<typeof HotspotSchema>
export type Persona = z.output<typeof PersonaSchema>

/** personaFit 评分结果（写回 hotspot.personaFit）。 */
export interface PersonaFit {
  score: number
  reason: string
  scoredAt: number
}

// ------------------------------------------------------------------
// Prompt 资产
// ------------------------------------------------------------------

function scoreSystemPrompt(): string {
  return [
    '你是自媒体选题评估助手。根据给定人设评估一个选题与该账号的契合度。',
    '只输出一行 JSON：{"score": 0到1之间的小数, "reason": "一句话理由"}。',
    '不要输出任何其他内容（不要解释、不要问候、不要 markdown 代码块标记）。',
  ].join('\n')
}

function scoreUserPrompt(persona: Persona, hotspot: Pick<Hotspot, 'title' | 'summary'>): string {
  return [
    `人设：定位「${persona.positioning}」，语气「${persona.tone}」，受众「${persona.audience}」` +
      (persona.taboos.length ? `，禁忌「${persona.taboos.join('、')}」` : '') + '。',
    `选题标题：${hotspot.title}`,
    hotspot.summary ? `选题摘要：${hotspot.summary}` : '',
    '请评分。',
  ].filter(Boolean).join('\n')
}

// ------------------------------------------------------------------
// 严格 JSON 解析
// ------------------------------------------------------------------

/** 从模型输出提取 {score, reason}；容忍 ```json 围栏与前后杂讯。失败返回 null。 */
export function parsePersonaFit(raw: string): { score: number; reason: string } | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as { score?: unknown; reason?: unknown }
    if (typeof obj.score !== 'number' || Number.isNaN(obj.score)) return null
    if (typeof obj.reason !== 'string' || obj.reason.trim() === '') return null
    const score = Math.min(1, Math.max(0, obj.score))
    return { score, reason: obj.reason.trim() }
  } catch {
    return null
  }
}

/**
 * 对单条热点做 personaFit 评分。失败路径：
 * - LLM 调用失败 → 返回 { failure }
 * - JSON 解析失败 → 重试 1 次，仍失败 → 返回 score=0 / reason='parse-failed' 的标记结果
 */
export async function scoreHotspot(
  ctx: Context,
  persona: Persona,
  hotspot: Pick<Hotspot, 'title' | 'summary'>,
  opts: { provider?: string; model?: string } = {},
): Promise<{ fit: PersonaFit } | { failure: LlmErrorInfo }> {
  const resolved = await resolveProviderModel(ctx, opts)
  if ('failure' in resolved) return { failure: resolved.failure }

  const system = scoreSystemPrompt()
  const user = scoreUserPrompt(persona, hotspot)

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await collectArticleStream(ctx.llm.stream({
      provider: resolved.provider,
      model: resolved.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.2,
    }))
    if (result.failure) return { failure: result.failure }
    const parsed = parsePersonaFit(result.text)
    if (parsed) return { fit: { ...parsed, scoredAt: Date.now() } }
    // 解析失败 → 重试 1 次（attempt 0 落空后继续循环）
  }
  return { fit: { score: 0, reason: 'parse-failed', scoredAt: Date.now() } }
}

// ------------------------------------------------------------------
// 批量评分（一次 LLM 调用评一批，按人设视角抓取后自动跑）
// ------------------------------------------------------------------

function scoreBatchSystemPrompt(): string {
  return [
    '你是自媒体选题评估助手。根据给定人设，评估一批选题与该账号的契合度。',
    '只输出一行 JSON 数组：[{"i":0,"score":0.8,"reason":"一句话理由"},…]。',
    'i 是选题序号（从 0 开始），数组必须按输入顺序逐条给出，不得遗漏。',
    '不要输出任何其他内容（不要解释、不要问候、不要 markdown 代码块标记）。',
  ].join('\n')
}

function scoreBatchUserPrompt(persona: Persona, items: readonly Pick<Hotspot, 'title' | 'summary'>[]): string {
  return [
    `人设：定位「${persona.positioning}」，语气「${persona.tone}」，受众「${persona.audience}」` +
      (persona.taboos.length ? `，禁忌「${persona.taboos.join('、')}」` : '') + '。',
    '选题列表：',
    ...items.map((it, i) => `${i}. ${it.title}${it.summary ? `｜${it.summary}` : ''}`),
    '请逐条评分。',
  ].filter(Boolean).join('\n')
}

/** 解析批量评分输出；要求全覆盖、序号合法且不重复，否则返回 null（调用方退回逐条兜底）。 */
export function parsePersonaFitBatch(
  raw: string,
  total: number,
): { i: number; score: number; reason: string }[] | null {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return null
  try {
    const arr: unknown = JSON.parse(m[0])
    if (!Array.isArray(arr)) return null
    const out: { i: number; score: number; reason: string }[] = []
    for (let pos = 0; pos < arr.length; pos++) {
      const it = arr[pos] as { i?: unknown; index?: unknown; score?: unknown; reason?: unknown }
      if (it === null || typeof it !== 'object') return null
      if (typeof it.score !== 'number' || Number.isNaN(it.score)) return null
      if (typeof it.reason !== 'string' || it.reason.trim() === '') return null
      const idx = typeof it.i === 'number' ? it.i : typeof it.index === 'number' ? it.index : pos
      if (!Number.isInteger(idx) || idx < 0 || idx >= total) return null
      out.push({ i: idx, score: Math.min(1, Math.max(0, it.score)), reason: it.reason.trim() })
    }
    const seen = new Set(out.map(x => x.i))
    if (out.length < total || seen.size !== out.length) return null
    return out
  } catch {
    return null
  }
}

/**
 * 对一批热点做同一人设的批量评分：先两次尝试批量 JSON；仍解析不出 / 覆盖不全的
 * 条目退回逐条 scoreHotspot 兜底。LLM 调用失败整体返回 { failure }；
 * 逐条兜底也失败的条目 fit 为 null（调用方跳过写回，下次再评）。
 */
export async function scoreHotspotsBatch(
  ctx: Context,
  persona: Persona,
  items: readonly Pick<Hotspot, 'title' | 'summary'>[],
  opts: { provider?: string; model?: string } = {},
): Promise<{ fits: (PersonaFit | null)[] } | { failure: LlmErrorInfo }> {
  const fits: (PersonaFit | null)[] = items.map(() => null)
  if (items.length === 0) return { fits }
  const resolved = await resolveProviderModel(ctx, opts)
  if ('failure' in resolved) return { failure: resolved.failure }

  const system = scoreBatchSystemPrompt()
  const user = scoreBatchUserPrompt(persona, items)

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await collectArticleStream(ctx.llm.stream({
      provider: resolved.provider,
      model: resolved.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0.2,
    }))
    if (result.failure) return { failure: result.failure }
    const parsed = parsePersonaFitBatch(result.text, items.length)
    if (parsed) {
      for (const p of parsed) fits[p.i] = { ...p, scoredAt: Date.now() }
      break
    }
  }
  // 批量没覆盖到的条目退回逐条评分兜底
  for (let i = 0; i < items.length; i++) {
    if (fits[i]) continue
    const single = await scoreHotspot(ctx, persona, items[i], opts)
    if ('fit' in single) fits[i] = single.fit
  }
  return { fits }
}

// ------------------------------------------------------------------
// 聚合热榜抓取（配置驱动，解析失败只记日志 → 由路由层聚合返回）
// ------------------------------------------------------------------

/** 抓取到的原始条目。 */
export interface FetchedItem {
  title: string
  url?: string
  heat?: number
}

/** 单个 fetcher 的结果。 */
export interface FetcherResult {
  name: string
  added: number
  error?: string
}

/** 从响应文本提取条目：优先 JSON（递归找含 title/name 字段的数组），退化 <a> 正则。 */
/**
 * 取字段，**键名大小写不敏感**。
 * 各家 API 的命名不统一：头条热榜是 `Title`/`Url`/`HotValue`，
 * B 站是 `title`，微博是 `word`。只认小写会让大部分源解析失败。
 */
function pickField(o: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    const v = o[n]
    if (v !== undefined && v !== null) return v
  }
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]))
  for (const n of names) {
    const v = lower.get(n.toLowerCase())
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

const TITLE_KEYS = ['title', 'name', 'word', 'Title', 'query']
const URL_KEYS = ['url', 'link', 'Url', 'mobileUrl', 'shareUrl']
const HEAT_KEYS = ['heat', 'hot', 'hotValue', 'HotValue', 'view', 'score']

/** 从一条原始记录里取标题（大小写不敏感）。 */
function titleOf(o: Record<string, unknown>): string {
  const v = pickField(o, TITLE_KEYS)
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

/**
 * 取热度：各家给法不一（头条 `HotValue` 是字符串 "13031018"，微博给数字），
 * 数字字符串也认，否则热度字段永远是空的。
 */
function heatOf(o: Record<string, unknown>): number | undefined {
  const v = pickField(o, HEAT_KEYS)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export function parseHotspotItems(text: string): FetchedItem[] {
  try {
    const data: unknown = JSON.parse(text)
    const arr = findTitleArray(data)
    if (arr) {
      return arr.slice(0, 50).map((it) => {
        const o = it as Record<string, unknown>
        const u = pickField(o, URL_KEYS)
        return {
          title: titleOf(o),
          url: typeof u === 'string' ? u : undefined,
          heat: heatOf(o),
        }
      }).filter(it => it.title.length >= 4)
    }
    // 是合法 JSON 但里面没有标题数组：别再去正则扒 JSON 文本，那只会抓出一堆乱码。
    return []
  } catch { /* not JSON → fall through to anchor regex */ }
  const items: FetchedItem[] = []
  const re = /<a[^>]+href="([^"]+)"[^>]*>([^<]{4,80})<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && items.length < 30) {
    items.push({ title: m[2].trim(), url: m[1] })
  }
  return items
}

/** 递归找第一个元素含标题字段的数组（键名大小写不敏感）。 */
function findTitleArray(data: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || data === null || typeof data !== 'object') return null
  if (Array.isArray(data)) {
    const first = data[0]
    if (first && typeof first === 'object' && titleOf(first as Record<string, unknown>) !== '') return data
    return null
  }
  for (const v of Object.values(data)) {
    const found = findTitleArray(v, depth + 1)
    if (found) return found
  }
  return null
}

/** 触发所有配置 fetcher 抓取；每个 fetcher 失败不阻塞其余。 */
export async function refreshHotspots(
  fetchers: readonly { name: string; url: string }[],
  add: (item: FetchedItem & { source: string }) => Promise<boolean>,
): Promise<FetcherResult[]> {
  const results: FetcherResult[] = []
  for (const f of fetchers) {
    try {
      const res = await fetch(f.url, {
        signal: AbortSignal.timeout(15000),
        // 头条/百度等站点不给默认 UA 会直接 403
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; slacker-media/0.1)' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const items = parseHotspotItems(await res.text())
      let added = 0
      for (const it of items) {
        if (await add({ ...it, source: f.name })) added++
      }
      results.push({ name: f.name, added })
    } catch (err) {
      results.push({ name: f.name, added: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
