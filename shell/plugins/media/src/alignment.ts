/**
 * 人设 ↔ 账号 对齐。
 *
 * 背景：人设是「你打算做什么」，账号实况是「你实际在做什么、哪类有效」。
 * 两者会漂移——人设写「效率工具测评」，号里堆的却是「Windows 小技巧」，
 * agent 照人设写、读者照经验不点，看板上的点击率就是这么被拖下去的。
 *
 * 本模块提供两件事：
 *   1. `accountBrief()`：把 account_work 的真实数据压成一段话，直接进生成 prompt。
 *      让 agent 知道这个号「已经被验证过什么」，对齐不靠人设写得准不准。
 *   2. `personaAlignment()`：绑定时算出人设与账号历史内容的重合度，错配当场提示。
 *
 * 刻意不做的事：不猜「什么题材赚钱」。样本 5 篇时任何这类结论都是噪音。
 */
import type { MediaDomain } from './domain.ts'
import type { AccountWork } from './platforms/types.ts'

/** 一篇作品 + 它的点击率（展现→阅读，衡量标题/题材的吸引力）。 */
interface WorkStat {
  work: AccountWork
  ctr: number | undefined
}

function worksOf(domain: MediaDomain, accountId: string): WorkStat[] {
  return [...domain.table('account_work').entries()]
    .map(([, v]) => v)
    .filter(w => w.accountId === accountId)
    .sort((a, b) => (b.reads ?? 0) - (a.reads ?? 0))
    .map(work => ({ work, ctr: ctrOf(work) }))
}

/** 点击率 = 阅读 / 展现。展现为 0 时无意义，返回 undefined。 */
export function ctrOf(work: AccountWork): number | undefined {
  const shows = work.shows ?? 0
  const reads = work.reads ?? 0
  return shows > 0 ? reads / shows : undefined
}

function fmtNum(v: number | undefined): string {
  return v === undefined ? '—' : v.toLocaleString('zh-CN')
}

/**
 * 账号实况摘要，进生成 prompt。
 *
 * 只列事实（标题 + 展现 + 阅读 + 点击率），让模型自己读出题材规律——
 * 代替我们在 5 篇样本上硬编一条「结论」，那只会把偏见喂给模型。
 */
export function accountBrief(domain: MediaDomain, accountId: string | undefined, limit = 5): string {
  if (!accountId) return ''
  const rows = worksOf(domain, accountId)
  if (rows.length === 0) return ''
  const lines = rows.slice(0, limit).map(({ work, ctr }) =>
    `- 《${work.title}》展现 ${fmtNum(work.shows)} · 阅读 ${fmtNum(work.reads)}`
    + (ctr !== undefined ? ` · 点击率 ${(ctr * 100).toFixed(1)}%` : ''))
  return [
    `该账号在平台上已有 ${rows.length} 篇作品，实测表现如下（按阅读排序）：`,
    ...lines,
    `请延续已验证有效的题材与写法；不要写成账号从未发过的方向。`
    + `若选题与人设定位冲突，以账号实况为准，并在正文中保持该账号既有的表达风格。`,
  ].join('\n')
}

/**
 * 人设里可用于匹配的中文词块。
 *
 * 不能直接拿整句去匹配：「面向职场新人的效率工具测评」这种长句在任何作品标题里
 * 都不会原样出现，于是**真正对齐的人设也会被判成 0%**——指标就系统性偏低了。
 * 做法：先按标点/数字切成中文片段，再对每段取 2~4 字滑窗当词块。
 *
 * 已知局限：滑窗会带来零星的误命中（如「电脑工具」切出「工具」）。
 * 这是个提示性指标，不是判定依据，所以宁可召回高一点。
 */
export function personaTerms(persona: { name: string; positioning: string; audience: string; tags: string[] }): string[] {
  const raw = [persona.name, persona.positioning, persona.audience, ...persona.tags].join(' ')
  // 只保留中文片段：拉丁词（Windows/WiFi）逐字母切出来的是 "Wi"/"in"/"nd" 这种垃圾词块
  const cjkRuns = raw.match(/[\u4e00-\u9fff]+/g) ?? []
  const grams = new Set<string>()
  for (const run of cjkRuns) {
    const chars = [...run]
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= chars.length; i++) grams.add(chars.slice(i, i + n).join(''))
    }
  }
  return [...grams]
}

/** 绑定时的对齐结果。 */
export interface Alignment {
  /** 该账号有作品记录吗？没记录就没法比对。 */
  comparable: boolean
  /** 命中的作品数 / 总作品数；comparable=false 时为 null */
  overlap: number | null
  /** 人设词块里被账号作品实际用到的 */
  usedTerms: string[]
  /** 人设词块里没有任何作品用到的 */
  unusedTerms: string[]
  /** 高于这个值算对齐（保守：4 篇里命中 2 篇 = 0.5 算过） */
  threshold: number
  /** 结论：aligned / weak / unknown */
  verdict: 'aligned' | 'weak' | 'unknown'
  /** 给用户看的一句话 */
  note: string
}

/** 算人设与账号历史内容的重合度。 */
export function personaAlignment(
  domain: MediaDomain,
  persona: { name: string; positioning: string; audience: string; tags: string[] },
  accountId: string | undefined,
): Alignment {
  const threshold = 0.5
  const terms = personaTerms(persona)
  if (!accountId) {
    return {
      comparable: false, overlap: null, usedTerms: [], unusedTerms: terms, threshold,
      verdict: 'unknown', note: '该账号还没有采集平台数据，暂时无法校验人设是否对齐',
    }
  }
  const rows = worksOf(domain, accountId)
  if (rows.length === 0) {
    return {
      comparable: false, overlap: null, usedTerms: [], unusedTerms: terms, threshold,
      verdict: 'unknown', note: '该账号还没采集作品数据，暂时无法校验人设是否对齐',
    }
  }
  const used: string[] = []
  let hits = 0
  for (const { work } of rows) {
    const t = work.title
    const matched = terms.filter(term => t.includes(term))
    if (matched.length > 0) hits++
    for (const m of matched) if (!used.includes(m)) used.push(m)
  }
  // 滑窗词块有几十个，全列出来是噪音；只报「一条都没用上」的情况
  const unused = used.length === 0 ? terms.slice(0, 12) : []
  const overlap = hits / rows.length
  return {
    comparable: true,
    overlap,
    usedTerms: used,
    unusedTerms: unused,
    threshold,
    verdict: overlap >= threshold ? 'aligned' : 'weak',
    note: overlap >= threshold
      ? `人设与账号 ${rows.length} 篇作品有 ${hits} 篇题材重合（${Math.round(overlap * 100)}%），方向一致`
      : `人设与账号 ${rows.length} 篇作品只有 ${hits} 篇题材重合（${Math.round(overlap * 100)}%）。`
        + (used.length > 0 ? `命中：${used.slice(0, 6).join('、')}。` : '')
        + 'agent 会照人设写，可能和账号既有内容对不上。建议把定位/受众改成账号实际在发的方向。',
  }
}