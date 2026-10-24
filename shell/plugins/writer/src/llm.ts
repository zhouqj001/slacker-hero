/**
 * LLM 生成管线：prompt 构建 + 严格 JSON 解析 + 错误映射。
 * 全部走 dsh 会话（askSession，api.ts），本文件只做纯函数。
 * 模板依据 docs/writer-plugin-plan.md §4 + §11（四层文风装配 /
 * 双层 AI 味闸 / 不确定性进管线 / 定稿回写出处 / 合并审稿）。
 */
import {
  ARCHETYPE_IDS,
  buildAiFlavorConstraints,
  buildDoctrineBlock,
  type Archetype,
} from './style'
import { GENERIC_FINGERPRINT, type QualityStats } from './quality'

/** LLM 失败信息（fail-closed：上层把它转成 SSE error 帧或 data.fail）。 */
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
  CONTEXT_WINDOW_EXCEEDED: { code: 'CONTEXT_WINDOW_EXCEEDED', zh: '内容过长超出上下文', action: '请缩短 prompt 或分段生成' },
  TIMEOUT:            { code: 'TIMEOUT',            zh: '生成超时',           action: '已保留已产出部分，可续写' },
  ABORTED:            { code: 'ABORTED',            zh: '生成被中断',         action: '已保留已产出部分，可续写' },
  STREAM_CLOSED:      { code: 'STREAM_CLOSED',      zh: '流被关闭',           action: '已保留已产出部分，可续写' },
  EMPTY_RESPONSE:     { code: 'EMPTY_RESPONSE',     zh: '服务返回空内容',     action: '草稿已保留，请稍后重试' },
  MALFORMED_RESPONSE: { code: 'MALFORMED_RESPONSE', zh: '服务返回异常',       action: '草稿已保留，请稍后重试' },
  SERVER:             { code: 'SERVER',             zh: '服务异常',           action: '草稿已保留，请稍后重试' },
  INVALID_REQUEST:    { code: 'INVALID_REQUEST',    zh: '请求参数错误',       action: '请检查输入后重试' },
  NO_SESSION:         { code: 'NO_SESSION',         zh: 'dsh 会话服务未就绪', action: '请重启后重试' },
  BLOCKED:            { code: 'BLOCKED',            zh: '会话回合被阻塞',     action: '可能在等待确认，请到 dsh 会话里处理后重试' },
}

/** 从 LlmFailure.code 或兜底 fallback 获取错误信息。 */
export function resolveLlmError(code: string): LlmErrorInfo {
  return LLM_ERROR_MAP[code] ?? { code, zh: `未知错误 (${code})`, action: '请稍后重试或查看日志' }
}

// ------------------------------------------------------------------
// 严格 JSON 解析：取首个 '{' 到最后一个 '}'，字段缺失返回 null（fail-closed）
// ------------------------------------------------------------------

/** 从任意文本中抠出 JSON 对象并解析；失败返回 null。 */
export function parseJsonLoose<T>(text: string): T | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

// ------------------------------------------------------------------
// 默认文风卡（书新建时预填，可编辑）
// ------------------------------------------------------------------

export const DEFAULT_STYLE_CARD = [
  '【文风卡（最高优先级，全书一致）】',
  '- 网文正文腔：短句为主，动作与对话推进剧情，少用心理描写与静态描写。',
  '- 每段 1–3 行；段落之间空一行；禁止 Markdown 语法（番茄正文是纯文本）。',
  '- 禁止空洞形容词堆砌（如「无比强大」「恐怖如斯」连用）、禁止总结腔（如「这告诉我们」）、禁止排比抒情。',
  '- 对话要有信息量与性格，不写寒暄废话；数字与专有名词前后一致。',
  '- 视角：默认第三人称限制视角（跟随主角），不随意跳头。',
].join('\n')

// ------------------------------------------------------------------
// 新书向导：一次产出 JSON 提案（不落库，确认才 apply）
// ------------------------------------------------------------------

export interface WizardInput {
  genre: string
  idea: string
  /** 风格偏好（自由文本，可空）。 */
  style: string
  /** 节奏偏好：默认番茄口径。 */
  pace: string
}

/** 章纲草案条目（向导/续排/新卷共用；promise/uncertainty 二期新增）。 */
export interface BeatDraft {
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
}

export interface WizardProposal {
  names: string[]
  intro: string
  protagonist: { name: string; summary: string; tags: string[] }
  outline: { logline: string; coreConflict: string }
  volume: { title: string; summary: string }
  /** 按题材推荐的风格原型 id（确认建书时落 book.archetype）。 */
  archetype?: string
  beats: BeatDraft[]
}

/** 新书向导 prompt（system + user 合并为一条提交；教义置顶）。 */
export function buildWizardPrompts(input: WizardInput): string {
  return [
    buildDoctrineBlock(null),
    '',
    '你是一位资深网文主编，为「番茄小说」平台策划一本新连载。请严格按 JSON 输出，不要输出任何其他文字。',
    '要求：',
    '- 简介 intro：150–300 字，前两句必须抓人（悬念/冲突/金手指三选一开场），纯文本，禁止背景铺垫式开头。',
    '- beats：前 12 章，其中第 1 章在 beat 里写明「开头 300 字内出现钩子（入口即事件）」，第 3 章为第一个小高潮（isClimax=true），第 10 章左右安排一个明确爽点（isCool=true）。',
    '- 每个 beat 必须给 promise（本章给读者的承诺：读者会期待发生什么）和 uncertainty（本章新增的不确定点）。uncertainty 形态要多样：信息差/想要而得不到/两难抉择/反常细节，不要全写成悬念。',
    '- 每隔 2–3 个 beat 让一个 beat 的 uncertainty 明确呼应前面 beat 的 promise（草蛇灰线），必要时用 payoffOf 标注回收哪一章的 promise。',
    '- 每个 beat 的 hook 字段写清章末钩子（让读者必须往下翻的理由）。',
    '- archetype：按题材从内置原型库选一个最合适的（sharp-tongue=毒舌老炮体，都市/现实向；deadpan=白描冷面体，悬疑/正剧；chatter=生活流唠嗑体，轻喜剧/日常）。',
    '- beat.no 从 1 连续递增；标题不超过 12 字。',
    'JSON 结构：',
    '{"names":["书名候选x5"],"archetype":"sharp-tongue","intro":"简介","protagonist":{"name":"主角名","summary":"主角与核心金手指速写(80-150字)","tags":["主角团","其他标签"]},"outline":{"logline":"一句话故事","coreConflict":"核心矛盾"},"volume":{"title":"第一卷标题","summary":"第一卷卷纲摘要(100-200字)"},"beats":[{"no":1,"title":"","beat":"本章发生什么(60-120字)","hook":"章末钩子","promise":"本章承诺","uncertainty":"本章新增不确定点","isCool":false,"isClimax":false}]}',
    '',
    `题材：${input.genre}`,
    `一句话点子：${input.idea}`,
    input.style ? `风格偏好：${input.style}` : '',
    `节奏：${input.pace || '番茄口径（单章 2200–2800 字，十章一爽点，章末必有钩子）'}`,
  ].filter(Boolean).join('\n')
}

/**
 * 解析单个 beat 条目（向导/续排/新卷共用）。no/title/beat 缺失 → null
 * （fail-closed）；promise/uncertainty/payoffOf 兼容缺省（旧格式仍可解析）。
 */
function parseBeatDraft(b: unknown): BeatDraft | null {
  const beat = b as Record<string, unknown>
  if (typeof beat['no'] !== 'number' || typeof beat['title'] !== 'string' || typeof beat['beat'] !== 'string') return null
  return {
    no: beat['no'],
    title: beat['title'],
    beat: beat['beat'],
    hook: typeof beat['hook'] === 'string' && beat['hook'] ? beat['hook'] : '章末留钩子',
    promise: typeof beat['promise'] === 'string' && beat['promise'] ? beat['promise'] : undefined,
    uncertainty: typeof beat['uncertainty'] === 'string' && beat['uncertainty'] ? beat['uncertainty'] : undefined,
    payoffOf: typeof beat['payoffOf'] === 'number' ? beat['payoffOf'] : undefined,
    isCool: beat['isCool'] === true,
    isClimax: beat['isClimax'] === true,
  }
}

/** 校验原型 id 是否在库内（不在则视为未推荐，调用方回落 recommendArchetype）。 */
export function parseArchetypeId(v: unknown): string | undefined {
  return typeof v === 'string' && ARCHETYPE_IDS.includes(v) ? v : undefined
}

/** 解析新书向导提案；字段缺失返回 null（PROPOSAL_INVALID）。 */
export function parseWizardProposal(text: string): WizardProposal | null {
  const raw = parseJsonLoose<Record<string, unknown>>(text)
  if (!raw) return null
  const names = raw['names']
  const intro = raw['intro']
  const protagonist = raw['protagonist'] as Record<string, unknown> | undefined
  const outline = raw['outline'] as Record<string, unknown> | undefined
  const volume = raw['volume'] as Record<string, unknown> | undefined
  const beats = raw['beats']
  if (!Array.isArray(names) || names.length === 0 || typeof intro !== 'string') return null
  if (!protagonist || typeof protagonist['name'] !== 'string') return null
  if (!outline || typeof outline['logline'] !== 'string' || typeof outline['coreConflict'] !== 'string') return null
  if (!volume || typeof volume['title'] !== 'string' || typeof volume['summary'] !== 'string') return null
  if (!Array.isArray(beats) || beats.length === 0) return null
  const parsedBeats: BeatDraft[] = []
  for (const b of beats) {
    const parsed = parseBeatDraft(b)
    if (!parsed) return null
    parsedBeats.push(parsed)
  }
  return {
    names: names.filter((n): n is string => typeof n === 'string').slice(0, 5),
    archetype: parseArchetypeId(raw['archetype']),
    intro,
    protagonist: {
      name: protagonist['name'],
      summary: typeof protagonist['summary'] === 'string' ? protagonist['summary'] : '',
      tags: Array.isArray(protagonist['tags']) ? protagonist['tags'].filter((t): t is string => typeof t === 'string') : ['主角团'],
    },
    outline: { logline: outline['logline'], coreConflict: outline['coreConflict'] },
    volume: { title: volume['title'], summary: volume['summary'] },
    beats: parsedBeats,
  }
}

// ------------------------------------------------------------------
// 滚动续排 / 开新卷
// ------------------------------------------------------------------

export interface MoreBeatsInput {
  bookName: string
  genre: string
  logline: string
  coreConflict: string
  memorySummary: string
  /** 最近 5 个已排 beat 的摘要行。 */
  recentBeats: string[]
  /** 未回收伏笔行。 */
  openForeshadows: string[]
  startNo: number
  count: number
}

/** 卷内滚动续排：接在已有 beat 后生成 count 个新 beat。 */
export function buildMoreBeatsPrompts(input: MoreBeatsInput): string {
  return [
    buildDoctrineBlock(null),
    '',
    '你是网文主编，为一本连载小说续排章纲（beat）。严格按 JSON 输出，不要输出任何其他文字。',
    '规则：每 10 个 beat 里安排 1 个明确爽点（isCool=true）；每 30 个 1 个高潮（isClimax=true）。',
    '每个 beat 必须给 promise（本章给读者的承诺）与 uncertainty（本章新增的不确定点，形态多样：信息差/想要而得不到/两难/反常细节，不要全写成悬念）；适当时用 payoffOf 标注回收前文哪一章的 promise。每个 beat 的 hook 写清章末钩子（读者必须往下翻的理由）。',
    'JSON 结构：{"beats":[{"no":N,"title":"","beat":"本章发生什么(60-120字)","hook":"章末钩子","promise":"本章承诺","uncertainty":"本章新增不确定点","payoffOf":回收章号或省略,"isCool":false,"isClimax":false}]}',
    '',
    `书名：${input.bookName}（题材：${input.genre}）`,
    `一句话故事：${input.logline}`,
    `核心矛盾：${input.coreConflict}`,
    input.memorySummary ? `剧情进展（全局摘要）：${input.memorySummary}` : '',
    '最近的章纲：',
    ...input.recentBeats,
    input.openForeshadows.length > 0 ? `未回收伏笔（适时推进，不要本章全收）：\n${input.openForeshadows.join('\n')}` : '',
    '',
    `请从第 ${input.startNo} 章开始续排 ${input.count} 个 beat（no 连续递增），衔接上文节奏。`,
  ].filter(Boolean).join('\n')
}

export interface NewVolumeInput extends MoreBeatsInput {
  /** 第几卷（从 1 起，调用方按 volumes.length+1 算）。 */
  volumeIndex: number
  finishedVolumes: string[]
}

/** 开新卷：出卷纲摘要 + 新卷 beat。 */
export function buildNewVolumePrompts(input: NewVolumeInput): string {
  return [
    buildDoctrineBlock(null),
    '',
    '你是网文主编，为一本连载小说开启新卷。严格按 JSON 输出，不要输出任何其他文字。',
    '输出：卷纲摘要（100–200 字，承接总纲与已完成卷）+ 前 12 个 beat。',
    '规则：第 1 个 beat 开新卷冲突（入口即事件）；第 6 个左右安排爽点；每个 beat 必须给 promise 与 uncertainty（形态多样，见写作教义），适当时用 payoffOf 标注回收前文 promise；每个 beat 的 hook 写清章末钩子。',
    'JSON 结构：{"volume":{"title":"卷标题","summary":"卷纲摘要"},"beats":[{"no":N,"title":"","beat":"","hook":"","promise":"","uncertainty":"","isCool":false,"isClimax":false}]}',
    '',
    `书名：${input.bookName}（题材：${input.genre}）`,
    `一句话故事：${input.logline}`,
    `核心矛盾：${input.coreConflict}`,
    input.memorySummary ? `剧情进展（全局摘要）：${input.memorySummary}` : '',
    input.finishedVolumes.length > 0 ? `已完成卷：\n${input.finishedVolumes.join('\n')}` : '',
    input.openForeshadows.length > 0 ? `未回收伏笔（新卷内推进或回收）：\n${input.openForeshadows.join('\n')}` : '',
    '',
    `新卷从第 ${input.startNo} 章开始（no 连续递增 12 个 beat）。`,
  ].filter(Boolean).join('\n')
}

export interface BeatsProposal {
  volume?: { title: string; summary: string }
  beats: BeatDraft[]
}

/** 解析续排/新卷提案。 */
export function parseBeatsProposal(text: string, withVolume: boolean): BeatsProposal | null {
  const raw = parseJsonLoose<Record<string, unknown>>(text)
  if (!raw) return null
  const beats = raw['beats']
  if (!Array.isArray(beats) || beats.length === 0) return null
  const parsedBeats: BeatDraft[] = []
  for (const b of beats) {
    const parsed = parseBeatDraft(b)
    if (!parsed) return null
    parsedBeats.push(parsed)
  }
  if (withVolume) {
    const volume = raw['volume'] as Record<string, unknown> | undefined
    if (!volume || typeof volume['title'] !== 'string' || typeof volume['summary'] !== 'string') return null
    return { volume: { title: volume['title'], summary: volume['summary'] }, beats: parsedBeats }
  }
  return { beats: parsedBeats }
}

// ------------------------------------------------------------------
// 逐章生成：四层文风装配 + 召回升级（plan §4.2 + §11.2 + §11.4）
// 装配顺序：[写作教义+风格原型] → [作者档案] → [叙述契约] → [文风卡]
//   → [本章任务] → [设定装配] → [前情] → [伏笔] → [去AI味硬约束] → [输出要求]
// ------------------------------------------------------------------

/** 设定条目（装配输入的最小面）。 */
export interface AssembleSetting {
  kind: string
  name: string
  summary: string
  tags: string[]
  state?: string
  /** 角色知情边界（kind=character；审稿 KNOWLEDGE_LEAK 的判定依据）。 */
  knownBy?: string[]
  /** 失效条目（出处章节被重写/大改）：召回降级为仅名称+待复核标记。 */
  stale?: boolean
}

export interface ChapterPromptInput {
  styleCard: string
  /** 风格原型（book.archetype；null = 一期通用腔，只出教义）。 */
  archetype: Archetype | null
  /** 作者档案（global KV；审美取向/题材偏好/口头禅禁忌，可空）。 */
  authorProfile: string
  /** 叙述契约（book.narrator：人称/限知范围/时距/时态，可空）。 */
  narrator: string
  chapterNo: number
  chapterTitle: string
  beatText: string
  hookText: string
  /** 本章给读者的承诺（beat.promise，可空）。 */
  promise: string
  /** 本章核心不确定点（beat.uncertainty，可空）。 */
  uncertainty: string
  isCool: boolean
  targetWords: number
  settings: AssembleSetting[]
  /** 作者显式引用的设定名（编辑器「关联设定」标记，最高召回优先级）。 */
  explicitRefs: string[]
  memorySummary: string
  /** 最近 3 章摘要（近→远或远→近均可，调用方排序）。 */
  recentSummaries: { no: number; summary: string }[]
  /** 上一章末尾原文（≤300 字）。 */
  prevTail: string
  /** 本章需回收的伏笔行。 */
  dueForeshadows: string[]
  /** 黄金三章专项要求（第 1–3 章）。 */
  goldenRule: string
}

/** 完整注入软预算（§11.4：超限按优先级截断，降级仅名称）。 */
const ASSEMBLE_BUDGET = 4000

/**
 * 组装单章 prompt。设定召回五级优先：显式引用 > 任务点名 > 主角团 >
 * 关键词命中 > 其余仅名称；stale 条目一律降级仅名称（带待复核标记）。
 */
export function buildChapterPrompts(input: ChapterPromptInput): string {
  const taskText = [input.beatText, input.hookText, input.promise, input.uncertainty].filter(Boolean).join('\n')

  // 召回分级（数字越小越优先完整注入）
  const tierOf = (se: AssembleSetting): number => {
    if (input.explicitRefs.includes(se.name)) return 0
    if (taskText.includes(se.name)) return 1
    if (se.tags.includes('主角团')) return 2
    if (se.tags.some(t => t.length >= 2 && taskText.includes(t))) return 3
    return 4
  }
  const ordered = input.settings
    .map((se, i) => ({ se, i, tier: tierOf(se) }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)

  let used = 0
  const fullLines: string[] = []
  const nameOnly: string[] = []
  for (const { se, tier } of ordered) {
    // 完整注入门槛：tier ≤ 3（其余仅名称）；stale 一律降级
    if (tier <= 3 && !se.stale) {
      const body = `${se.name}（${se.kind}）：${se.summary}${se.state ? `。当前状态：${se.state}` : ''}`
      if (used + body.length <= ASSEMBLE_BUDGET) {
        used += body.length
        fullLines.push(`- ${body}`)
        continue
      }
    }
    nameOnly.push(se.stale ? `${se.name}（待复核，旧记录可能过时）` : se.name)
  }

  const parts: string[] = []
  // 四层装配 1+2：写作教义（写什么）+ 风格原型（怎么写）
  parts.push(buildDoctrineBlock(input.archetype))
  // 3：作者档案
  if (input.authorProfile) parts.push(`\n【作者档案（作者一贯的审美与禁忌）】\n${input.authorProfile.slice(0, 600)}`)
  // 4：叙述契约
  if (input.narrator) parts.push(`【叙述契约（全书一致）】${input.narrator}`)
  // 5：文风卡
  parts.push(input.styleCard)
  parts.push('')
  parts.push(`【本章任务】第 ${input.chapterNo} 章《${input.chapterTitle}》`)
  parts.push(`剧情任务：${input.beatText}`)
  if (input.promise) parts.push(`本章承诺（读者会期待发生的事，必须兑现或推进）：${input.promise}`)
  if (input.uncertainty) parts.push(`本章核心不确定点（围绕它展开，可再加新的）：${input.uncertainty}`)
  parts.push(`章末钩子：${input.hookText}`)
  if (input.isCool) parts.push('本章是爽点章：必须给出明确的情绪爆点/打脸/收获，压—扬曲线在章内完成。')
  if (input.goldenRule) parts.push(input.goldenRule)
  parts.push('写法自检：第一段就要有事发生（入口即事件）；每 ~500 字回头检查是否制造了新的不确定（信息差/两难/反常/想要而得不到）；细节落到具体名词、精确数字、可感知动作上。')
  parts.push(`目标字数：${input.targetWords} 字左右（2000–2800 之间）。`)
  if (fullLines.length > 0) parts.push(`\n【设定装配（相关条目完整注入）】\n${fullLines.join('\n')}`)
  if (nameOnly.length > 0) parts.push(`【其余已有设定（仅名称，如需提及请与前文一致）】${nameOnly.join('、')}`)
  if (input.memorySummary) parts.push(`【前情·全局摘要】${input.memorySummary.slice(0, 300)}`)
  if (input.recentSummaries.length > 0) {
    parts.push('【前情·近章摘要】')
    for (const s of input.recentSummaries) parts.push(`- 第 ${s.no} 章：${s.summary.slice(0, 200)}`)
  }
  if (input.prevTail) parts.push(`【上一章末尾原文（衔接此内容续写）】\n${input.prevTail}`)
  if (input.dueForeshadows.length > 0) parts.push(`【本章需回收的伏笔】\n${input.dueForeshadows.join('\n')}`)
  // 四层装配 6：去 AI 味硬约束（阈值随原型指纹）
  parts.push(buildAiFlavorConstraints(input.archetype))
  parts.push([
    '\n【输出要求】',
    '1. 直接输出本章正文：纯文本段落，不要任何 Markdown 语法、不要输出章节标题行。',
    '2. 每段 1–3 行，段落之间空一行。',
    '3. 正文写完后，另起一行输出结尾承诺强度自评标记：[[HOOK:ok]] 或 [[HOOK:bad]]（ok = 结尾让读者必须往下翻；bad = 平收或只是套路悬念）。',
    '4. 不要调用任何工具、不要输出执行计划、任务总结或任何解释。',
  ].join('\n'))
  return parts.join('\n')
}

/** 剥离结尾自评标记，返回 {content, hookOk}。找不到标记时 hookOk 为 undefined。 */
export function stripHookMark(text: string): { content: string; hookOk?: boolean } {
  const m = text.match(/\[\[HOOK:(ok|bad)\]\]/)
  if (!m) return { content: text.trim(), hookOk: undefined }
  return { content: text.replace(m[0], '').trim(), hookOk: m[1] === 'ok' }
}

// ------------------------------------------------------------------
// 审稿合并：单次 askSession 合并三类审查（plan §11.5）
//   AI 味（按原型校准）+ 不确定密度（500 字分窗）+ 连续性（时间/知情）
// ------------------------------------------------------------------

/** 审稿所需的设定切片（character 条目带 knownBy 才能查知情越界）。 */
export interface ReviewSetting {
  kind: string
  name: string
  summary: string
  /** 该角色已知信息边界（KNOWLEDGE_LEAK 判定依据）。 */
  knownBy?: string[]
}

/** 时间锚（与 domain TimelineAnchor 同构，相对表述全 string）。 */
export interface ReviewAnchor {
  scene?: string
  start: string
  gap: string
  duration: string
  end: string
}

export interface ReviewInput {
  chapterNo: number
  chapterTitle: string
  content: string
  archetype: Archetype | null
  /** 第一层程序闸结果：统计指纹 + 命中词表（AI 校准用，不要重复报同位置）。 */
  firstLayer: { stats: QualityStats; flavorHits: string[] }
  settings: ReviewSetting[]
  /** 最近几章时间锚（供对照检测时间漂移），近章在前。 */
  recentTimelines: { no: number; anchors: ReviewAnchor[] }[]
  /** 最近几章摘要（供连续性参照），近章在前。 */
  recentSummaries: { no: number; summary: string }[]
}

/** 审稿 issue。level：block=事实错误（时间线硬矛盾/知情越界）；文风一律 warn/info。 */
export interface ReviewIssue {
  level: 'block' | 'warn' | 'info'
  code: string
  message: string
  /** 原文逐字摘录（≤60 字），没有原文依据的问题不允许带此字段外的话。 */
  evidence?: string
  /** 具体到句的改法。 */
  suggestion?: string
}

/** 500 字分窗的不确定密度记录。 */
export interface ReviewWindow {
  window: string
  hasNew: boolean
  note?: string
}

export interface ReviewResult {
  issues: ReviewIssue[]
  windows: ReviewWindow[]
  /** 结尾承诺强度（AI 复核，可与生成自评 [[HOOK]] 交叉）。 */
  hookStrength?: 'ok' | 'bad'
}

/** 审稿合并 prompt：按原型指纹校准期望，全部 issue 必须带原文依据。 */
export function buildReviewPrompts(input: ReviewInput): string {
  const fp = input.archetype?.fingerprint ?? GENERIC_FINGERPRINT
  const styleName = input.archetype ? `${input.archetype.name}（${input.archetype.id}）` : '通用腔（未指定原型）'
  const parts: string[] = []
  parts.push([
    '你是通俗小说的审稿编辑。对给定章节做三类审查，合并成一份 JSON 报告，不要输出任何其他文字：',
    'A. AI 味文风（AI_TONE / DIALOGUE / EMOTION / STRUCTURE）',
    'B. 不确定密度（UNCERTAINTY_FLAT）——按 ~500 字分窗逐窗检查',
    'C. 连续性（TIMELINE_DRIFT / KNOWLEDGE_LEAK）',
    '',
    'JSON 结构：',
    '{"issues":[{"level":"block|warn|info","code":"AI_TONE|DIALOGUE|EMOTION|STRUCTURE|UNCERTAINTY_FLAT|TIMELINE_DRIFT|KNOWLEDGE_LEAK","message":"问题概述","evidence":"原文逐字摘录≤60字","suggestion":"具体到句的改法"}],"windows":[{"window":"1","hasNew":true,"note":"该窗新增的不确定点"}],"hookStrength":"ok|bad"}',
    '',
    '硬规则：',
    '- 每个 issue 必须带 evidence（从正文逐字摘录 ≤60 字）；找不到原文依据就不要报这条。suggestion 必须具体到句，不要写「加强描写」这类空话。',
    '- block 只留给事实错误：TIMELINE_DRIFT（时间线硬矛盾）、KNOWLEDGE_LEAK（角色说了不该知道的信息）。文风问题一律 warn 或 info，永远不许 block。',
    '- 第一层程序闸已命中以下词表，你可以复核但不要重复罗列相同位置：' + (input.firstLayer.flavorHits.join('、') || '（无）'),
    '- 第一层统计（供校准，不必复述）：句长标准差 ' + input.firstLayer.stats.sentenceStd.toFixed(1) + '，段落变异系数 ' + input.firstLayer.stats.paraCv.toFixed(2) + '，疑似排比组 ' + input.firstLayer.stats.parallelismRuns + '，疑似升华式结尾段 ' + input.firstLayer.stats.sublimationParas + '。',
    '',
    `原型校准（本章按「${styleName}」的期望审查，不要用别的腔调标准苛责）：`,
    `- 口语词密度期望 ${fp.colloquialPer1k[0]}–${fp.colloquialPer1k[1]} 个/千字；低于下限才报 AI_TONE（书面腔）。`,
    `- 具体细节（名词+数字+动作）期望 ≥ ${fp.concreteDetailPer1kMin} 处/千字；不足才报 STRUCTURE。`,
    `- 句长波动期望标准差 ≥ ${fp.sentenceLenStdMin}，段落节奏变异系数 ≥ ${fp.paraCvMin}；明显低于才报 AI_TONE，且必须指出重复的句式节奏并给改写句。`,
    '- 对话审查 DIALOGUE：各角色说话方式是否可区分、是否都在「传声筒」（只为解释设定）；情感审查 EMOTION：情绪是否被直接说破而非通过动作细节呈现。',
    '',
    '不确定密度审查：把正文按每约 500 字分窗（从第 1 窗编号，windows 数组必须覆盖全部正文），逐窗判断该窗是否「新增」了不确定——信息差/两难/反常/想要而得不到，悬念钩子只是其中一种。连续 2 窗无新增 → 加一条 UNCERTAINTY_FLAT（level=warn）。注意：日常细节里的小不对劲也算新增，不要只认强钩子。',
    '',
    '连续性审查：',
    '- 对照下方近章时间锚，本章若与之矛盾（如时长/先后/昼夜对不上）报 TIMELINE_DRIFT。',
    '- 对照角色 knownBy 边界：角色提到/利用了他不该知道的信息报 KNOWLEDGE_LEAK（level=block）。',
  ].join('\n'))

  if (input.recentTimelines.length > 0) {
    parts.push('\n【近章时间锚（近章在前）】')
    for (const t of input.recentTimelines) {
      const lines = t.anchors.map(a => `  - ${a.scene ? `${a.scene}：` : ''}开始=${a.start}；间隔=${a.gap}；时长=${a.duration}；结束=${a.end}`)
      parts.push(`第 ${t.no} 章：\n${lines.join('\n')}`)
    }
  }
  const chars = input.settings.filter(s => s.kind === 'character')
  if (chars.length > 0) {
    parts.push('\n【角色知情边界（knownBy = 该角色已知道的信息）】')
    for (const c of chars) {
      parts.push(`- ${c.name}：${c.summary.slice(0, 80)}${c.knownBy && c.knownBy.length > 0 ? `。已知道：${c.knownBy.join('；')}` : '。（无已知信息记录，谨慎判 KNOWLEDGE_LEAK）'}`)
    }
  }
  if (input.recentSummaries.length > 0) {
    parts.push('\n【近章摘要（连续性参照）】')
    for (const s of input.recentSummaries) parts.push(`- 第 ${s.no} 章：${s.summary.slice(0, 150)}`)
  }
  parts.push(`\n第 ${input.chapterNo} 章《${input.chapterTitle}》正文：`)
  parts.push(input.content)
  return parts.join('\n')
}

const REVIEW_LEVELS = ['block', 'warn', 'info'] as const
const REVIEW_CODES = ['AI_TONE', 'DIALOGUE', 'EMOTION', 'STRUCTURE', 'UNCERTAINTY_FLAT', 'TIMELINE_DRIFT', 'KNOWLEDGE_LEAK'] as const

/** 解析审稿合并结果；含 UNCERTAINTY_FLAT 程序侧兜底（AI 漏报但分窗数据显示连续 2 窗无新增时补一条）。 */
export function parseReviewResult(text: string): ReviewResult {
  const out: ReviewResult = { issues: [], windows: [] }
  const raw = parseJsonLoose<Record<string, unknown>>(text)
  if (!raw) return out
  if (Array.isArray(raw['issues'])) {
    for (const it of raw['issues']) {
      const rec = it as Record<string, unknown>
      if (typeof rec['code'] !== 'string' || typeof rec['message'] !== 'string') continue
      const lv = typeof rec['level'] === 'string' && (REVIEW_LEVELS as readonly string[]).includes(rec['level'])
        ? rec['level'] as ReviewIssue['level'] : 'info'
      const code = (REVIEW_CODES as readonly string[]).includes(rec['code']) ? rec['code'] : 'AI_TONE'
      out.issues.push({
        level: lv,
        code,
        message: rec['message'],
        evidence: typeof rec['evidence'] === 'string' && rec['evidence'].trim() ? rec['evidence'].slice(0, 60) : undefined,
        suggestion: typeof rec['suggestion'] === 'string' && rec['suggestion'].trim() ? rec['suggestion'] : undefined,
      })
    }
  }
  if (Array.isArray(raw['windows'])) {
    for (const w of raw['windows']) {
      const rec = w as Record<string, unknown>
      if (rec['window'] === undefined) continue
      out.windows.push({
        window: String(rec['window']),
        hasNew: rec['hasNew'] === true,
        note: typeof rec['note'] === 'string' ? rec['note'] : undefined,
      })
    }
  }
  if (raw['hookStrength'] === 'ok' || raw['hookStrength'] === 'bad') out.hookStrength = raw['hookStrength']
  // 兜底：AI 没报 UNCERTAINTY_FLAT，但分窗数据显示连续 2 窗无新增 → 程序补一条
  let flatRun = 0
  let flatFrom = 0
  for (let i = 0; i < out.windows.length; i++) {
    flatRun = out.windows[i].hasNew ? 0 : flatRun + 1
    if (flatRun >= 2) { flatFrom = i - 1; break }
  }
  if (flatRun >= 2 && !out.issues.some(i => i.code === 'UNCERTAINTY_FLAT')) {
    out.issues.push({
      level: 'warn',
      code: 'UNCERTAINTY_FLAT',
      message: `第 ${flatFrom + 1}–${flatFrom + 2} 窗（约 ${(flatFrom) * 500 + 1}–${(flatFrom + 2) * 500} 字）连续无新增不确定点`,
      suggestion: '在平段中埋一个小不对劲：反常细节、人物的小算盘、没被回答的问题',
    })
  }
  return out
}

// ------------------------------------------------------------------
// 定稿回写：一次 askSession 提取结构化记忆（plan §4.2 + §11.4 出处/时间锚）
// ------------------------------------------------------------------

export interface FinalizeInput {
  chapterNo: number
  chapterTitle: string
  content: string
  /** 现有设定条目名列表（避免重复建条目）。 */
  knownSettings: string[]
}

/** 定稿回写 prompt：提取本章摘要/人物状态变化/新设定/新伏笔/知情更新/时间锚，全部带原文出处。 */
export function buildFinalizePrompts(input: FinalizeInput): string {
  return [
    '你是小说连载的记忆管理员。阅读本章正文，提取结构化记忆。严格按 JSON 输出，不要输出任何其他文字。',
    'JSON 结构：',
    '{"summary":"本章摘要(80-150字,第三人称,含关键结果)","characterStateChanges":[{"name":"已有设定中的角色名","state":"本章结束时的状态(位置/伤势/实力/关系变化)","quote":"支撑该状态的原文摘录(≤60字)"}],"knowledgeUpdates":[{"name":"角色名","fact":"该角色本章新得知的事实(一句话)"}],"newSettings":[{"kind":"character|world|item|faction","name":"","summary":"50-100字","tags":["标签"],"quote":"该条目首次出现的原文摘录(≤60字)"}],"newForeshadows":[{"desc":"新埋伏笔描述","suggestPayoffAt":预估回收章号,"quote":"埋伏笔处的原文摘录(≤60字)"}],"timeline":[{"scene":"场景名(可省略)","start":"该场景开始时的时间表述","gap":"与上一场景的时间间隔","duration":"场景持续时长","end":"场景结束时的时间表述"}],"hookOk":true/false}',
    '规则：',
    '- characterStateChanges 只写已有设定条目里的角色；newSettings 只收本章新出现且后续会用到的条目（3 个以内）。',
    '- quote 一律逐字摘录原文、不超过 60 字；找不到就省略该字段，不要编造。',
    '- knowledgeUpdates 只记「角色第一次知道」的信息差（谁知道了什么秘密/消息），公共事件不用记（3 个以内）。',
    '- timeline 按场景顺序列时间锚，时间表述用相对说法（如「入夜」「第三天上午」「约半炷香」），不要编造具体日期。',
    '- summary 要能独立当「前情提要」用。',
    '',
    `第 ${input.chapterNo} 章《${input.chapterTitle}》正文：`,
    input.content,
    '',
    `已有设定条目：${input.knownSettings.join('、') || '（无）'}`,
  ].join('\n')
}

/** 时间锚（与 domain TimelineAnchor 同构；LLM 缺 gap/duration 时程序兜底空串）。 */
export interface FinalizeAnchor {
  scene?: string
  start: string
  gap: string
  duration: string
  end: string
}

export interface FinalizeExtract {
  summary: string
  characterStateChanges: { name: string; state: string; quote?: string }[]
  knowledgeUpdates: { name: string; fact: string }[]
  newSettings: { kind: string; name: string; summary: string; tags: string[]; quote?: string }[]
  newForeshadows: { desc: string; suggestPayoffAt?: number; quote?: string }[]
  timeline: FinalizeAnchor[]
}

/** 解析定稿回写提取；summary 缺失即视为失败（fail-closed，正文保留、标「摘要未提取」）。 */
export function parseFinalizeExtract(text: string): FinalizeExtract | null {
  const raw = parseJsonLoose<Record<string, unknown>>(text)
  if (!raw) return null
  if (typeof raw['summary'] !== 'string' || !raw['summary'].trim()) return null
  const out: FinalizeExtract = {
    summary: raw['summary'].trim(),
    characterStateChanges: [],
    knowledgeUpdates: [],
    newSettings: [],
    newForeshadows: [],
    timeline: [],
  }
  // 出处 quote：逐字摘录 ≤60 字，缺失/非字符串一律省略（sourceChapterNo 由程序侧填，不需 LLM）
  const quoteOf = (rec: Record<string, unknown>): string | undefined =>
    typeof rec['quote'] === 'string' && rec['quote'].trim() ? rec['quote'].slice(0, 60) : undefined
  const states = raw['characterStateChanges']
  if (Array.isArray(states)) {
    for (const s of states) {
      const rec = s as Record<string, unknown>
      if (typeof rec['name'] === 'string' && typeof rec['state'] === 'string') {
        out.characterStateChanges.push({ name: rec['name'], state: rec['state'], quote: quoteOf(rec) })
      }
    }
  }
  const knowledge = raw['knowledgeUpdates']
  if (Array.isArray(knowledge)) {
    for (const k of knowledge) {
      const rec = k as Record<string, unknown>
      if (typeof rec['name'] === 'string' && typeof rec['fact'] === 'string' && rec['fact'].trim()) {
        out.knowledgeUpdates.push({ name: rec['name'], fact: rec['fact'].slice(0, 100) })
      }
    }
  }
  const settings = raw['newSettings']
  if (Array.isArray(settings)) {
    for (const s of settings) {
      const rec = s as Record<string, unknown>
      if (typeof rec['name'] === 'string' && typeof rec['summary'] === 'string') {
        const kind = typeof rec['kind'] === 'string' && ['character', 'world', 'item', 'faction'].includes(rec['kind'])
          ? rec['kind'] : 'world'
        out.newSettings.push({
          kind,
          name: rec['name'],
          summary: rec['summary'],
          tags: Array.isArray(rec['tags']) ? rec['tags'].filter((t): t is string => typeof t === 'string') : [],
          quote: quoteOf(rec),
        })
      }
    }
  }
  const foreshadows = raw['newForeshadows']
  if (Array.isArray(foreshadows)) {
    for (const f of foreshadows) {
      const rec = f as Record<string, unknown>
      if (typeof rec['desc'] === 'string') {
        out.newForeshadows.push({
          desc: rec['desc'],
          suggestPayoffAt: typeof rec['suggestPayoffAt'] === 'number' ? rec['suggestPayoffAt'] : undefined,
          quote: quoteOf(rec),
        })
      }
    }
  }
  const timeline = raw['timeline']
  if (Array.isArray(timeline)) {
    for (const t of timeline) {
      const rec = t as Record<string, unknown>
      // start/end 是锚点最小集；gap/duration 缺失兜底空串（相对表述，无法推断就留空）
      if (typeof rec['start'] === 'string' && rec['start'].trim() && typeof rec['end'] === 'string' && rec['end'].trim()) {
        out.timeline.push({
          scene: typeof rec['scene'] === 'string' && rec['scene'].trim() ? rec['scene'] : undefined,
          start: rec['start'].trim(),
          gap: typeof rec['gap'] === 'string' ? rec['gap'].trim() : '',
          duration: typeof rec['duration'] === 'string' ? rec['duration'].trim() : '',
          end: rec['end'].trim(),
        })
      }
    }
  }
  return out
}
