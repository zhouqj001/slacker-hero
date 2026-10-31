/**
 * 上下文分层检索（plan ②）：按任务把上下文压成 P0 必读 / P1 相关 / P2 背景三层，
 * 各有字符预算并按分数截断；不做 embedding，全部是确定性打分。
 * 纯函数、零副作用，调用方（api.ts）负责取数与注入 prompt。
 */

/** 设定条目的最小面（与 domain SettingSchema 兼容）。 */
export interface ContextSetting {
  id: string
  kind: string
  name: string
  summary: string
  tags: string[]
  state?: string
  knownBy?: string[]
  stale?: boolean
}

/** 伏笔条目的最小面。 */
export interface ContextForeshadow {
  desc: string
  plantedAt: number
  suggestPayoffAt?: number
  paidAt?: number
  stale?: boolean
}

/** 章 beat 的最小面。 */
export interface ContextBeat {
  no: number
  title: string
  beat: string
  hook: string
  promise?: string
  uncertainty?: string
  payoffOf?: number
}

/** 书级上下文（全局摘要 + 压缩游标）。 */
export interface ContextBook {
  memorySummary: string
  memoryThroughChapter?: number
}

export type ContextTier = 0 | 1 | 2

export interface ContextItem {
  id: string
  kind: 'setting' | 'summary' | 'foreshadow' | 'prevTail'
  /** 已渲染好的 prompt 行（列表项自带 "- " 前缀）。 */
  text: string
  tier: ContextTier
  score: number
  stale?: boolean
  /** 设定条目的原始名称（降级仅名称时用）。 */
  label?: string
}

export interface ChapterContext {
  /** 必读：显式引用/任务点名设定、本章需回收伏笔、payoffOf 章摘要、上一章尾部。 */
  p0: ContextItem[]
  /** 相关：关键词命中设定、近 3 章摘要、近 20 章内未回收伏笔。 */
  p1: ContextItem[]
  /** 背景：全局摘要、更早摘要、其余设定。 */
  p2: ContextItem[]
  /** 预算溢出/失效后仅保留名称的设定。 */
  nameOnly: string[]
  stats: { p0Chars: number; p1Chars: number; p2Chars: number; fullSettings: number; nameOnlySettings: number }
}

/** 各层字符预算（溢出按 P2 → P1 低分 → 设定降级为名称的顺序裁）。 */
export const CONTEXT_BUDGET = { p0: 1600, p1: 1500, p2: 600 } as const

/** 任务文本里的中文/英文二元组（用于确定性相关度打分）。 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  const clean = text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, ' ')
  for (const seg of clean.split(/\s+/)) {
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const g of a) if (b.has(g)) n++
  return n
}

/** 设定条目按任务文本打分：显式引用/点名 → P0；标签/二元组命中 → P1；其余 P2。 */
function scoreSetting(se: ContextSetting, taskText: string, taskGrams: Set<string>, explicitRefs: string[]): { tier: ContextTier; score: number } {
  if (explicitRefs.includes(se.name) || taskText.includes(se.name)) return { tier: 0, score: 100 }
  if (se.tags.includes('主角团')) return { tier: 1, score: 60 }
  const tagHit = se.tags.some(t => t.length >= 2 && taskText.includes(t))
  if (tagHit) return { tier: 1, score: 50 }
  const n = overlap(bigrams(`${se.name} ${se.summary} ${se.tags.join(' ')}`), taskGrams)
  // 名称权重高于摘要：name 命中单独加分，避免长摘要误判高相关
  const nameHit = taskText.includes(se.name) ? 20 : 0
  if (n + nameHit >= 2) return { tier: 1, score: Math.min(45, 10 + n + nameHit) }
  return { tier: 2, score: 0 }
}

function settingLine(se: ContextSetting): string {
  return `- ${se.name}（${se.kind}）：${se.summary}${se.state ? `。当前状态：${se.state}` : ''}`
}

/** 按分数降序装箱，超预算即丢弃（返回保留项与被丢项）。 */
function pack(items: ContextItem[], budget: number): { kept: ContextItem[]; dropped: ContextItem[] } {
  const ordered = [...items].sort((a, b) => b.score - a.score)
  const kept: ContextItem[] = []
  const dropped: ContextItem[] = []
  let used = 0
  for (const it of ordered) {
    if (kept.length === 0 || used + it.text.length <= budget) {
      kept.push(it)
      used += it.text.length
    } else {
      dropped.push(it)
    }
  }
  return { kept, dropped }
}

function charsOf(items: ContextItem[]): number {
  return items.reduce((n, it) => n + it.text.length, 0)
}

/**
 * 组装单章上下文。
 * @param args.chapterSummaries 全部已有章摘要（no 升序或乱序皆可，内部按 no 取近远）。
 */
export function buildChapterContext(args: {
  book: ContextBook
  beat: ContextBeat
  settings: ContextSetting[]
  foreshadows: ContextForeshadow[]
  chapterSummaries: { no: number; summary: string }[]
  prevTail: string
  explicitRefs: string[]
}): ChapterContext {
  const no = args.beat.no
  const taskText = [args.beat.beat, args.beat.hook, args.beat.promise, args.beat.uncertainty].filter(Boolean).join('\n')
  const taskGrams = bigrams(taskText)
  const p0: ContextItem[] = []
  const p1: ContextItem[] = []
  const p2: ContextItem[] = []
  const nameOnly: string[] = []

  // 设定：stale 一律降级仅名称；其余按打分分三层
  for (const se of args.settings) {
    if (se.stale) {
      nameOnly.push(`${se.name}（待复核，旧记录可能过时）`)
      continue
    }
    const { tier, score } = scoreSetting(se, taskText, taskGrams, args.explicitRefs)
    const item: ContextItem = { id: `se:${se.id}`, kind: 'setting', text: settingLine(se), tier, score, label: se.name }
    if (tier === 0) p0.push(item)
    else if (tier === 1) p1.push(item)
    else p2.push(item)
  }

  // 伏笔：本章应回收 → P0；近 20 章内未回收 → P1；stale 仅给带复核标记的行
  for (const f of args.foreshadows) {
    if (f.paidAt != null) continue
    const suggest = f.suggestPayoffAt
    const due = suggest != null && suggest <= no
    const recent = f.plantedAt >= no - 20
    const body = `「${f.desc}」（第 ${f.plantedAt} 章埋设${suggest != null ? `，建议第 ${suggest} 章前后回收` : ''}）${f.stale ? '（待复核，旧记录可能过时）' : ''}`
    if (due) p0.push({ id: `fs:${f.desc}`, kind: 'foreshadow', text: `- ${body}`, tier: 0, score: 90, stale: f.stale })
    else if (recent && !f.stale) p1.push({ id: `fs:${f.desc}`, kind: 'foreshadow', text: `- ${body}`, tier: 1, score: 40 })
  }

  // 摘要：payoffOf 指向章 → P0；近 3 章 → P1；更早 5 章 → P2
  const summaries = [...args.chapterSummaries].filter(s => s.summary.trim()).sort((a, b) => b.no - a.no)
  const payoffNo = args.beat.payoffOf
  for (const s of summaries) {
    const isPayoff = payoffNo != null && s.no === payoffNo
    const recency = summaries.indexOf(s)
    const item: ContextItem = {
      id: `sm:${s.no}`,
      kind: 'summary',
      text: `- 第 ${s.no} 章${isPayoff ? '（需回收此章承诺）' : ''}：${s.summary.slice(0, 200)}`,
      tier: isPayoff ? 0 : recency < 3 ? 1 : recency < 8 ? 2 : 2,
      score: isPayoff ? 90 : recency < 3 ? 40 : 20,
    }
    if (isPayoff) p0.push(item)
    else if (recency < 3) p1.push(item)
    else if (recency < 8) p2.push(item)
  }

  // 全局滚动摘要 → P2 背景
  if (args.book.memorySummary.trim()) {
    p2.push({
      id: 'mem',
      kind: 'summary',
      text: `全局前情摘要${args.book.memoryThroughChapter != null ? `（截至第 ${args.book.memoryThroughChapter} 章）` : ''}：${args.book.memorySummary.slice(0, 300)}`,
      tier: 2,
      score: 30,
    })
  }

  // 上一章末尾原文 → P0（衔接锚点）
  if (args.prevTail.trim()) {
    p0.push({ id: 'tail', kind: 'prevTail', text: `上一章末尾原文（衔接此内容续写）：\n${args.prevTail}`, tier: 0, score: 95 })
  }

  // 预算装箱：P0 不裁（规模天然有界）；P1/P2 超限按分数截断
  const p1Packed = pack(p1, CONTEXT_BUDGET.p1)
  const p2Packed = pack(p2, CONTEXT_BUDGET.p2)
  // P1 溢出里的设定降级为仅名称（摘要/伏笔直接丢弃）
  for (const it of p1Packed.dropped) {
    if (it.kind === 'setting' && it.label) nameOnly.push(it.label)
  }
  // P2 溢出里的设定同样降级
  for (const it of p2Packed.dropped) {
    if (it.kind === 'setting' && it.label) nameOnly.push(it.label)
  }
  // 已在 P1/P2 完整保留的设定不再出现在 nameOnly（去重）
  const keptSettingNames = new Set(
    [...p1Packed.kept, ...p2Packed.kept].filter(i => i.kind === 'setting' && i.label).map(i => i.label as string),
  )
  const cleanNameOnly = [...new Set(nameOnly)].filter(n => !keptSettingNames.has(n.replace(/（.*$/, '')))

  // P0 若仍有设定超预算，降级为仅名称（保留条目名）
  let p0Chars = charsOf(p0)
  if (p0Chars > CONTEXT_BUDGET.p0) {
    for (let i = p0.length - 1; i >= 0; i--) {
      const it = p0[i]
      if (it.kind === 'setting' && it.label) {
        cleanNameOnly.push(it.label)
        p0.splice(i, 1)
        p0Chars = charsOf(p0)
        if (p0Chars <= CONTEXT_BUDGET.p0) break
      }
    }
  }

  const fullSettings = [...p0, ...p1Packed.kept, ...p2Packed.kept].filter(i => i.kind === 'setting').length
  return {
    p0,
    p1: p1Packed.kept,
    p2: p2Packed.kept,
    nameOnly: [...new Set(cleanNameOnly)],
    stats: { p0Chars, p1Chars: charsOf(p1Packed.kept), p2Chars: charsOf(p2Packed.kept), fullSettings, nameOnlySettings: cleanNameOnly.length },
  }
}

/**
 * 审稿上下文：只给正文里实际出现的角色（含 knownBy）与相关设定，
 * 其余设定只返回名称，避免把全量设定塞进审稿 prompt。
 */
export function buildReviewContext(args: { content: string; settings: ContextSetting[]; limit?: number }): {
  settings: ContextSetting[]
  otherNames: string[]
} {
  const limit = args.limit ?? 12
  const picked: ContextSetting[] = []
  const others: string[] = []
  // 角色优先（正文提及次数降序）
  const chars = args.settings
    .filter(s => s.kind === 'character')
    .map(s => ({ s, mentions: args.content.split(s.name).length - 1 }))
    .filter(x => x.mentions > 0)
    .sort((a, b) => b.mentions - a.mentions)
  for (const { s } of chars) {
    if (picked.length >= limit) break
    picked.push(s)
  }
  // 非角色设定：名称出现在正文才完整注入
  for (const s of args.settings) {
    if (s.kind === 'character') continue
    if (args.content.includes(s.name) && picked.length < limit) picked.push(s)
    else others.push(s.name)
  }
  // 未入选的角色也归入名称列表
  for (const { s } of chars) if (!picked.includes(s)) others.push(s.name)
  return { settings: picked, otherNames: [...new Set(others)] }
}
