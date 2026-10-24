/**
 * LLM 流式生成封装：prompt 资产 + stream 聚合 + 错误码统一路由。
 * 只认 text-delta；reasoning-delta 丢弃；finish 失败按稳定 code 映射。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

// ------------------------------------------------------------------
// Prompt 资产（全部中文语境，人设注入）
// ------------------------------------------------------------------

export interface ArticleGenInput {
  /** 已选中的 active persona */
  persona: {
    name: string
    positioning: string
    tone: string
    audience: string
    taboos: string[]
  }
  /** 选题标题 */
  topicTitle: string
  /** 选题摘要 */
  topicSummary: string
  /** 目标平台 */
  platform: string
  /** 字数要求（含） */
  minWords: number
  /** 复盘统计一句话（可为空） */
  statsSentence: string
  /**
   * 该账号的平台实况摘要（作品标题 + 展现/阅读/点击率，可为空）。
   * 人设是「打算做什么」，这里是「实际做过什么、哪类被验证有效」。
   * 两者漂移时以账号实况为准——否则 agent 会持续产出读者不点的方向。
   */
  accountBrief: string
  /**
   * 该账号的内容方向（题材栏目）。有值时本篇必须落在其中之一，
   * 避免账号越写越散；没设方向的账号不注入。
   */
  directions?: string[]
}

function articleSystemPrompt(input: ArticleGenInput): string {
  const { persona, statsSentence, accountBrief, directions } = input
  const tabooLine = persona.taboos.length
    ? `严禁涉及的内容：${persona.taboos.join('、')}。`
    : ''
  const directionLine = directions && directions.length > 0
    ? `内容方向（本篇必须落在其中之一）：${directions.join('、')}。`
    : ''
  return [
    `你是一位自媒体创作者，人设如下：`,
    `- 定位：${persona.positioning}`,
    `- 语气：${persona.tone}`,
    `- 受众：${persona.audience}`,
    tabooLine,
    directionLine,
    accountBrief,
    statsSentence ? `参考：${statsSentence}` : '',
    `请直接输出正文，不需要问候语、自我介绍或结尾总结。`,
    '',
    `【配图】先判断这篇文章是否真的需要配图，再决定要不要插：`,
    `- 适合配图：正文在讲具体场景、操作步骤、流程、对比差异、产品或工具介绍——看图比读字更快懂。`,
    `- 不适合配图：纯观点、论述、评论、感受、综述、人物故事——文字讲清楚更合适。`,
    `- 判断适合的：在它所属的段落之后插 1~4 张，统一用这个占位格式：`,
    `  ![<图注>](gen:<画面描述>)`,
    `  图注写简短说明，画面描述写具体场景（会原样作为画图提示词）。`,
    `- 判断不适合的：一张都不要插，不要为了凑数硬加。`,
  ].filter(Boolean).join('\n')
}

function articleUserPrompt(input: ArticleGenInput): string {
  const { topicTitle, topicSummary, platform, minWords } = input
  return [
    `请为以下选题撰写一篇面向「${platform}」平台的文章。`,
    `选题标题：${topicTitle}`,
    topicSummary ? `选题摘要：${topicSummary}` : '',
    `要求：不少于 ${minWords} 字，结构清晰， Markdown 格式输出。`,
    `直接输出正文即可。`,
  ].filter(Boolean).join('\n')
}

/** 构建文章生成的 system/user 两条 prompt（供流式/聚合两种消费共用）。 */
export function buildArticlePrompts(input: ArticleGenInput): { system: string; user: string } {
  return { system: articleSystemPrompt(input), user: articleUserPrompt(input) }
}

/** 解析 LLM provider/model：指定路由不可用（无 key / 列不出模型）时逐个回退到其余可用路由。 */
export async function resolveProviderModel(
  ctx: Context,
  opts: { provider?: string; model?: string } = {},
): Promise<{ provider: string; model: string } | { failure: LlmErrorInfo }> {
  const providerIds = ctx.llm.listProviders().map(p => p.id)
  // 指定的路由优先，其余路由作为回退（例如配置了 deepseek-official 但没配 key，回退登录账号额度）
  const candidates = opts.provider
    ? [opts.provider, ...providerIds.filter(id => id !== opts.provider)]
    : providerIds
  for (const provider of candidates) {
    try {
      let model = opts.provider === provider ? opts.model : undefined
      if (!model) {
        const models = await ctx.llm.listModels(provider)
        // 优先普通对话模型：搜索型模型走网关的 search proxy，该代理故障时整条生成报 502
        const plain = models.filter(m => !/search|browse|web|联网/i.test(m.id))
        model = (plain[0] ?? models[0])?.id
      }
      if (model) return { provider, model }
    } catch { /* 该路由不可用（典型：未配 key），继续尝试下一个 */ }
  }
  return { failure: resolveLlmError(opts.provider ? 'MISSING_CREDENTIAL' : 'NO_ADAPTER') }
}

// ------------------------------------------------------------------
// 错误码映射：LlmFailure.code → 中文文案 + 处置建议
// ------------------------------------------------------------------

export interface LlmErrorInfo {
  code: string
  zh: string
  action: string
}

export const LLM_ERROR_MAP: Record<string, LlmErrorInfo> = {
  AUTH:               { code: 'AUTH',               zh: 'LLM 鉴权失败',       action: '请检查 API Key 配置' },
  MISSING_CREDENTIAL: { code: 'MISSING_CREDENTIAL', zh: '未配置 API Key',     action: '请前往设置页配置' },
  QUOTA:              { code: 'QUOTA',              zh: '额度不足',           action: '请充值或更换账号' },
  RATE_LIMIT:         { code: 'RATE_LIMIT',         zh: '限流，稍后重试',     action: '已自动退避，请点击重试' },
  CONTEXT_WINDOW_EXCEEDED: { code: 'CONTEXT_WINDOW_EXCEEDED', zh: '文章过长超出上下文', action: '请缩短 prompt 或分段生成' },
  TIMEOUT:            { code: 'TIMEOUT',            zh: '生成超时',           action: '已保留已产出部分，可续写' },
  ABORTED:            { code: 'ABORTED',            zh: '生成被中断',         action: '已保留已产出部分，可续写' },
  STREAM_CLOSED:      { code: 'STREAM_CLOSED',      zh: '流被关闭',           action: '已保留已产出部分，可续写' },
  EMPTY_RESPONSE:     { code: 'EMPTY_RESPONSE',     zh: '服务返回空内容',     action: '草稿已保留，请稍后重试' },
  MALFORMED_RESPONSE: { code: 'MALFORMED_RESPONSE', zh: '服务返回异常',       action: '草稿已保留，请稍后重试' },
  SERVER:             { code: 'SERVER',             zh: '服务异常',           action: '草稿已保留，请稍后重试' },
  INVALID_REQUEST:    { code: 'INVALID_REQUEST',    zh: '请求参数错误',       action: '请检查输入后重试' },
  NO_ADAPTER:         { code: 'NO_ADAPTER',         zh: '无可用 LLM 适配器',  action: '请检查 provider 配置' },
}

/** 从 LlmFailure.code 或兜底 fallback 获取错误信息。 */
export function resolveLlmError(code: string): LlmErrorInfo {
  return LLM_ERROR_MAP[code] ?? { code, zh: `未知错误 (${code})`, action: '请稍后重试或查看日志' }
}

// ------------------------------------------------------------------
// Stream 聚合：只认 text-delta，reasoning-delta 丢弃
// ------------------------------------------------------------------

export interface GenerateResult {
  /** 已聚合的完整正文 */
  text: string
  /** finish 时的 token 用量（可选） */
  usage?: { inputTokens: number; outputTokens: number }
  /** 若 finish 为 error/aborted，失败信息 */
  failure?: LlmErrorInfo
}

/**
 * 消费 `ctx.llm.stream()` 的异步迭代器，仅提取 text-delta，
 * 遇 finish 错误则聚合为 failure 信息。
 * @param stream - ctx.llm.stream() 返回的 AsyncIterable<StreamChunk>
 */
export async function collectArticleStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<GenerateResult> {
  let text = ''
  let usage: { inputTokens: number; outputTokens: number } | undefined
  let failure: LlmErrorInfo | undefined

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'usage':
        usage = {
          inputTokens: chunk.usage.inputTokens ?? 0,
          outputTokens: chunk.usage.outputTokens ?? 0,
        }
        break
      case 'finish': {
        const r = chunk.reason
        if ((r as { kind: string; failure?: unknown }).kind === 'error') {
          const f = (r as { kind: 'error'; failure: { code: string; message: string } }).failure
          failure = resolveLlmError(f.code)
          failure.zh = `${failure.zh}：${f.message}`
        } else if ((r as { kind: string }).kind === 'aborted') {
          failure = resolveLlmError('ABORTED')
        }
        break
      }
      default:
        // reasoning-delta / block-start / block-end / tool-call-delta 全部丢弃
        break
    }
  }

  return { text, usage, failure }
}

// ------------------------------------------------------------------
// 高层封装：一次文章生成调用（非流式聚合，返回完整文本）
// ------------------------------------------------------------------

/** 生成文章正文（聚合版，供非流式场景使用）。失败时 failure 有值，text 保留已产出部分。 */
export async function generateArticle(
  ctx: Context,
  input: ArticleGenInput,
  opts: { provider?: string; model?: string; signal?: AbortSignal } = {},
): Promise<GenerateResult> {
  const resolved = await resolveProviderModel(ctx, opts)
  if ('failure' in resolved) return { text: '', failure: resolved.failure }

  const { system, user } = buildArticlePrompts(input)
  const stream = ctx.llm.stream({
    provider: resolved.provider,
    model: resolved.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    signal: opts.signal,
  })

  return collectArticleStream(stream)
}

// ------------------------------------------------------------------
// 平台改写：把通用稿重写为指定平台版本
// ------------------------------------------------------------------

export interface RewriteInput {
  title: string
  bodyMd: string
  platform: string
  /** 平台中文名（用于 prompt），缺省用 platform id。 */
  platformLabel?: string
}

/** 平台改写 prompt：保留事实与观点，按目标平台语气/结构重排，只输出正文。 */
export function buildRewritePrompts(input: RewriteInput): { system: string; user: string } {
  const label = input.platformLabel ?? input.platform
  const system = [
    `你是资深自媒体编辑，负责把一篇通用稿改写成适合「${label}」平台发布的版本。`,
    '要求：保留原文的核心事实、数据与观点，不要编造；按目标平台的语气、篇幅与排版习惯调整；',
    '只输出 Markdown 正文，不要包含标题行，不要输出任何解释或前言。',
  ].join('\n')
  const user = [
    `文章标题：${input.title}`,
    `目标平台：${label}`,
    '',
    '原文：',
    input.bodyMd,
  ].join('\n')
  return { system, user }
}

/** 生成指定平台的改写版本（聚合版）。失败时 failure 有值，text 保留已产出部分。 */
export async function rewriteArticle(
  ctx: Context,
  input: RewriteInput,
  opts: { provider?: string; model?: string; signal?: AbortSignal } = {},
): Promise<GenerateResult> {
  const resolved = await resolveProviderModel(ctx, opts)
  if ('failure' in resolved) return { text: '', failure: resolved.failure }

  const { system, user } = buildRewritePrompts(input)
  const stream = ctx.llm.stream({
    provider: resolved.provider,
    model: resolved.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    signal: opts.signal,
  })

  return collectArticleStream(stream)
}

// ------------------------------------------------------------------
// 派活指令解析（数字员工 NL 入口）：一句话 → { topic, platforms, persona }
// ------------------------------------------------------------------

export interface DispatchParsed {
  topic: string
  platforms: string[]
  persona: string | null
}

/** 构建派活解析的 system/user prompt（要求模型只输出严格 JSON）。 */
export function buildDispatchPrompts(
  text: string,
  platforms: readonly { id: string; label: string }[],
  personaNames: readonly string[],
): { system: string; user: string } {
  const system = [
    '你是自媒体运营助理的派活指令解析器。把用户的一句话指令解析为 JSON，只输出 JSON，不要输出任何其他文字。',
    'JSON 格式：{"topic":"文章选题（尽量保留用户原话中的主题描述）","platforms":["平台id"],"persona":"人设名或null"}',
    `可选平台：${platforms.map(p => `${p.id}=${p.label}`).join('、')}。用户未提及平台时输出 []。`,
    personaNames.length
      ? `已知人设：${personaNames.join('、')}。用户未提人设时输出 null。`
      : '当前无人设可选，persona 固定输出 null。',
  ].join('\n')
  return { system, user: text }
}

/** 从模型输出中抠出 JSON 对象并做字段校验；解析失败返回 null（前端降级到弹窗）。 */
export function parseDispatchJson(raw: string): DispatchParsed | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      topic?: unknown
      platforms?: unknown
      persona?: unknown
    }
    const topic = typeof obj.topic === 'string' ? obj.topic.trim() : ''
    if (!topic) return null
    return {
      topic,
      platforms: Array.isArray(obj.platforms)
        ? obj.platforms.filter((p): p is string => typeof p === 'string')
        : [],
      persona: typeof obj.persona === 'string' && obj.persona.trim() !== '' ? obj.persona.trim() : null,
    }
  } catch {
    return null
  }
}

// ------------------------------------------------------------------
// 对话式设置解析（NL settings）：一句话描述 + 多轮反问 → 结构化字段
// ------------------------------------------------------------------

export type NlParseKind = 'account' | 'persona' | 'review'

export interface NlTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface NlParseOut {
  /** 解析出的字段（增量语义：只含用户明确表达的部分），null 表示本轮无字段产出 */
  fields: Record<string, unknown> | null
  /** 需要向用户追问的问题；null 表示无需追问 */
  question: string | null
}

const NL_PLATFORM_LINE = '可选平台：wechat=微信公众号、toutiao=今日头条、zhihu=知乎专栏、xiaohongshu=小红书。'

function nlAccountSystem(current?: Record<string, unknown>): string {
  const lines = [
    '你是自媒体运营助理的账号设置解析器。把用户的描述解析为 JSON，只输出 JSON，不要输出任何其他文字。',
    'JSON 格式：{"fields":{...},"question":null}',
    'fields 可含字段：{"platform":"平台id","displayName":"账号显示名","dailyLimit":每日发布上限数字}',
    `${NL_PLATFORM_LINE}口语同义词要映射（如「公众号」→wechat、「头条」→toutiao、「知乎」→zhihu、「小红书/红书/xhs」→xiaohongshu）。`,
    'dailyLimit 用户没提到就省略（前端默认 3）。fields 只放用户明确表达的字段，不要编造。',
    '规则：platform 明确、且 displayName 明确（或用户表示不提供名字，如「读取账号就知道了」「名字你看着办」「不用问名字」）时，question 输出 null；displayName 用户不给就省略，接入后会从平台自动采集回填。',
    'platform 还不明确时，fields 只放已明确的字段，question 用一句自然的中文反问补齐，一次只问最关键的一个。',
  ]
  if (current) lines.push(`用户正在编辑已有账号，当前值：${JSON.stringify(current)}。没提到的字段保持当前值，不要出现在 fields 里。`)
  return lines.join('\n')
}

function nlPersonaSystem(current?: Record<string, unknown>): string {
  const lines = [
    '你是自媒体运营助理的人设设置解析器。把用户的描述解析为 JSON，只输出 JSON，不要输出任何其他文字。',
    'JSON 格式：{"fields":{...},"question":null}',
    'fields 可含字段：{"name":"人设名(2-6字)","positioning":"账号定位","tone":"语气风格","audience":"目标受众","taboos":["禁忌话题"],"tags":["标签"]}',
    'fields 只放用户明确表达的字段，不要编造；name 用户没给就从定位里提炼一个 2-6 字的名字。taboos/tags 是字符串数组，用户用顿号/逗号罗列的要拆开。',
    '规则：能提炼出 positioning（做什么内容、给谁看）时 question 输出 null，其余信息用户可以在确认卡里再改；连做什么人都看不出来时，fields 输出 null，question 用一句自然的中文反问。',
  ]
  if (current) lines.push(`用户正在编辑现有人设，当前值：${JSON.stringify(current)}。这是增量修改：只输出用户提到的字段，其余保持当前值。`)
  return lines.join('\n')
}

function nlReviewSystem(articles: readonly { id: string; title: string }[]): string {
  const lines = [
    '你是自媒体运营助理的复盘数据录入解析器。把用户的描述解析为 JSON，只输出 JSON，不要输出任何其他文字。',
    'JSON 格式：{"fields":{...},"question":null}',
    'fields 格式：{"articleId":"文章id","platform":"平台id","metrics":{"reads":数字,"likes":数字,"comments":数字,"shares":数字},"note":"备注"}',
    `${NL_PLATFORM_LINE}用户没提平台时 platform 输出 wechat。metrics 只放用户明确提到的数字（「1.2万」「1.2w」要换算成 12000），note 保留用户原话备注，没提就省略。`,
  ]
  if (articles.length) {
    lines.push('候选文章（id=标题）：')
    for (const a of articles.slice(0, 20)) lines.push(`- ${a.id} = ${a.title}`)
    lines.push('用户提到哪篇就按标题语义匹配输出对应 articleId；完全匹配不上或没说是哪篇时，fields 输出 null，question 用一句自然的中文反问，最多列 5 个候选标题。')
  } else {
    lines.push('当前没有任何候选文章：fields 输出 null，question 提示用户先去「文章」页创建文章，再来录复盘数据。')
  }
  return lines.join('\n')
}

/** 构建对话式设置解析的 system/user prompt（history 拼进单条 user 消息，规避多轮 role 兼容问题）。 */
export function buildNlParsePrompts(
  kind: NlParseKind,
  text: string,
  history: readonly NlTurn[],
  extra: { current?: Record<string, unknown>; articles?: readonly { id: string; title: string }[] } = {},
): { system: string; user: string } {
  const system = kind === 'account'
    ? nlAccountSystem(extra.current)
    : kind === 'persona'
      ? nlPersonaSystem(extra.current)
      : nlReviewSystem(extra.articles ?? [])
  const lines = history.slice(-8).map(t => `${t.role === 'user' ? '用户' : '助理'}：${t.text}`)
  lines.push(`用户：${text}`)
  return { system, user: `以下是对话记录，最后一行是需要解析的新输入：\n${lines.join('\n')}` }
}

/** 解析对话式设置的模型输出；结构不合法返回 null（前端按 UNPARSABLE 降级）。 */
export function parseNlJson(raw: string): NlParseOut | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { fields?: unknown; question?: unknown }
    const fields = obj.fields && typeof obj.fields === 'object' && !Array.isArray(obj.fields)
      ? obj.fields as Record<string, unknown>
      : null
    const question = typeof obj.question === 'string' && obj.question.trim() !== '' ? obj.question.trim() : null
    if (!fields && !question) return null
    return { fields, question }
  } catch {
    return null
  }
}

// ------------------------------------------------------------------
// 发布计划对话规划（账号整期提案）：现状快照 + 多轮对话 → 提案 JSON
// ------------------------------------------------------------------

/**
 * 服务端算好的本账号现状快照，喂给模型做整期规划。
 * 关键数字（本期已发 / 本期档期清单）一律由服务端算好，不让模型自己算——
 * 模型只负责理解用户意图、决定目标与偏好时段、并逐条说明档期保留还是移除。
 */
export interface PlanChatSnapshot {
  /** 账号显示名。 */
  accountName: string
  /** 平台中文名。 */
  platformLabel: string
  /** 本期周期与中文标签（本周 / 本月）。 */
  period: 'week' | 'month'
  periodLabel: string
  /** 本期真实成功发布篇数。 */
  published: number
  /** 当前目标篇数（未设目标时为 0）。 */
  target: number
  /** 当前偏好时段（HH:mm；未设时为空数组）。 */
  slots: string[]
  /** 账号的内容方向（题材栏目）；未设时为空数组。用于让回话贴合账号定位。 */
  pillars: string[]
  /** 今天日期（YYYY-MM-DD），模型据此把「周四」落到具体日期。 */
  today: string
  /** 本期已占档期的计划（含待排槽）——模型必须逐条说明保留还是移除。 */
  plans: { id: string; when: string; article: string | null }[]
}

/** 模型输出的整期提案（服务端校验通过后才允许落库）。 */
export interface PlanProposal {
  period: 'week' | 'month'
  target: number
  slots: string[]
  /** 保留下来的本期计划 id。 */
  keep: string[]
  /** 要移除的本期计划 id（服务端只允许移除待排槽）。 */
  remove: string[]
}

export interface PlanChatOut {
  /** 面向用户的中文回话（提案说明，或信息不足时的反问）。 */
  reply: string | null
  /** 提案；null = 信息不足，只有 reply（追问）。 */
  proposal: PlanProposal | null
}

function planChatSystem(snapshot: PlanChatSnapshot): string {
  const planLines = snapshot.plans.length
    ? snapshot.plans.map(p => `- ${p.id}｜${p.when}｜${p.article === null ? '待排（还没选文章）' : `已配文章《${p.article}》`}`)
    : ['（本期还没有任何档期）']
  return [
    '你是自媒体运营助理的发布计划规划器。根据账号现状与用户要求，输出一份「整期提案」，只输出 JSON，不要输出任何其他文字。',
    'JSON 格式：{"reply":"给用户看的中文说明或反问","proposal":{"period":"week|month","target":整数,"slots":["HH:mm",...],"keep":["计划id"],"remove":["计划id"]}}',
    'proposal 为 null 表示信息不足，此时只给 reply。',
    '规则：',
    '1. 用户表述里看不出「发几篇 / 什么周期」时，proposal 输出 null，reply 用一句自然的中文反问，一次只问最关键的一个。',
    '2. period：week=本周一 00:00 起算，month=本月 1 日起算。target：本期目标篇数，≥1 的整数。',
    '3. slots：发布偏好时段（24 小时制 HH:mm）。只能沿用账号现有偏好时段，或用户明确说出的时刻；绝对不许凭空编造时间。',
    '4. 本期已占档期的计划（见下方清单）必须逐条放进 keep 或 remove，既不能遗漏，也不能同时出现在两边。',
    '   keep = 保留这条不动；remove = 移除这条（只能移除「待排」的档期；带文章的正式计划不能移除，想调整就在 reply 里说明）。',
    '5. 新增档期由系统按「目标 − 本期已发 − 保留条数」自动推算，你不需要也不许给出具体日期时间。',
    '6. 你的产出只是「排期档期」——具体发哪篇文章仍需用户在「发布节奏」里为每条档期选文章；reply 里不要承诺替用户选定选题或写完文章。',
    '7. 若账号当前没有偏好时段、用户也没说想几点发，proposal 输出 null，reply 反问一次「想几点发（可以给几个时段）」。',
    '8. 只输出 JSON，不要 markdown 代码块，不要在 JSON 之外写任何文字。',
    '',
    '【账号现状】',
    `账号：${snapshot.accountName}（${snapshot.platformLabel}）`,
    `今天：${snapshot.today}`,
    `本期：${snapshot.periodLabel}（period=${snapshot.period}）`,
    `当前目标：${snapshot.target > 0 ? `${snapshot.target} 篇` : '未设目标'}；当前偏好时段：${snapshot.slots.length ? snapshot.slots.join('、') : '未设'}`,
    `账号内容方向：${snapshot.pillars.length ? snapshot.pillars.join('、') : '未设（reply 里可顺带提醒到「账号管理」补上内容方向）'}`,
    `本期已成功发布：${snapshot.published} 篇`,
    '本期已占档期的计划（id｜时间｜状态）：',
    ...planLines,
  ].join('\n')
}

/** 构建对话规划的 system/user prompt（history 拼进单条 user 消息，规避多轮 role 兼容问题）。 */
export function buildPlanChatPrompts(
  snapshot: PlanChatSnapshot,
  text: string,
  history: readonly NlTurn[],
): { system: string; user: string } {
  const lines = history.slice(-8).map(t => `${t.role === 'user' ? '用户' : '助理'}：${t.text}`)
  lines.push(`用户：${text}`)
  return {
    system: planChatSystem(snapshot),
    user: `以下是对话记录，最后一行是需要处理的新输入：\n${lines.join('\n')}`,
  }
}

/** 解析对话规划的模型输出；结构不合法返回 null（路由层按 LLM 不可用 / 解析失败处理）。 */
export function parsePlanChatJson(raw: string): PlanChatOut | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { reply?: unknown; proposal?: unknown }
    const reply = typeof obj.reply === 'string' && obj.reply.trim() !== '' ? obj.reply.trim() : null
    const rawProposal = obj.proposal
    if (rawProposal === undefined || rawProposal === null) {
      return reply === null ? null : { reply, proposal: null }
    }
    if (typeof rawProposal !== 'object' || Array.isArray(rawProposal)) return null
    const p = rawProposal as Record<string, unknown>
    const period = p.period === 'week' || p.period === 'month' ? p.period : null
    const target = typeof p.target === 'number' && Number.isInteger(p.target) ? p.target : null
    const slots = Array.isArray(p.slots) ? p.slots.filter((x): x is string => typeof x === 'string') : null
    const keep = Array.isArray(p.keep) ? p.keep.filter((x): x is string => typeof x === 'string') : null
    const remove = Array.isArray(p.remove) ? p.remove.filter((x): x is string => typeof x === 'string') : null
    if (period === null || target === null || slots === null || keep === null || remove === null) return null
    return { reply, proposal: { period, target, slots, keep, remove } }
  } catch {
    return null
  }
}
