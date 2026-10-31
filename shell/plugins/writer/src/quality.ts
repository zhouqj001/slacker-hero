/**
 * 质量闸·双层 AI 味闸的第一层（plan §4.2 + §11.2）：程序粗筛，零 LLM。
 * 生成完成后自动跑，标黄/标红不阻塞、硬伤才拦截。
 * 二期新增统计项：段末升华 / 句长方差 / 段落均匀性 / 排比三连，
 * 阈值全部由风格原型指纹参数化（缺省用通用阈值 = 一期语义）。
 * 第二层（LLM 专项审）见 review.ts/llm.ts，与本层合并结果写 chapter.quality。
 */
import type { ArchetypeFingerprint } from './style'

export interface QualityIssue {
  /** block = 硬伤拦截；warn = 标黄提示；info = 人工复查提示。 */
  level: 'block' | 'warn' | 'info'
  code: string
  message: string
}

/** 第一层粗筛的统计产物（前端质检面板可展示，也供第二层 LLM 审参考）。 */
export interface QualityStats {
  /** 全章句长（字）标准差。 */
  sentenceStd: number
  /** 段落长度变异系数（标准差/均值）。 */
  paraCv: number
  /** 段末升华（总结腔收段）段数。 */
  sublimationParas: number
  /** 排比三连命中组数。 */
  parallelismRuns: number
}

/** 质量分级（plan §4.2 分级门禁）：gold/silver 直接接受，bronze 定向重写，reject 重写后仍不合格则跳过。 */
export type QualityGrade = 'gold' | 'silver' | 'bronze' | 'reject'

/** 分级策略（重写预算与是否接受）。 */
export interface GradePolicy {
  maxRewrites: number
  accept: boolean
  reason: string
}

/** 各分级默认策略：gold/silver 0 次重写；bronze 1 次；reject 2 次后仍 reject 则跳过。 */
export const GRADE_POLICIES: Record<QualityGrade, GradePolicy> = {
  gold: { maxRewrites: 0, accept: true, reason: '无阻断、无提醒，字数与章末钩子达标' },
  silver: { maxRewrites: 0, accept: true, reason: '无阻断，提醒不超过 2 条' },
  bronze: { maxRewrites: 1, accept: true, reason: '无阻断但提醒较多，定向重写 1 次' },
  reject: { maxRewrites: 2, accept: false, reason: '存在阻断问题或提醒过多，重写后仍不合格则跳过' },
}

/** 分级排序（用于 minGrade 比较，越大越好）。 */
export const GRADE_RANK: Record<QualityGrade, number> = { reject: 0, bronze: 1, silver: 2, gold: 3 }

export interface QualityReport {
  /** 有效字数（去空白）。 */
  words: number
  paragraphCount: number
  issues: QualityIssue[]
  /** 粗筛统计项（句长方差等，二期限定）。 */
  stats: QualityStats
  /** 模型自评的结尾钩子（缺失 = undefined）。 */
  hookOk?: boolean
  /** 有 block 级问题 → false（保留旧字段语义，等价于 grade !== 'reject'）。 */
  passed: boolean
  /** 质量分级（分级门禁据此决定返工与接受）。 */
  grade: QualityGrade
  /** 0–100，仅用于排序/展示，不参与放行判定。 */
  score: number
}

/**
 * 按第一层统计计算分级（纯函数，零 LLM）。
 * block → reject；warn 0 且字数 2000–3000 且钩子达标 → gold；warn ≤2 → silver；
 * warn 3–4 → bronze；warn ≥5 → reject。
 */
function gradeOf(issues: QualityIssue[], words: number, hookOk: boolean | undefined): QualityGrade {
  if (issues.some(i => i.level === 'block')) return 'reject'
  const warns = issues.filter(i => i.level === 'warn').length
  if (warns === 0 && words >= 2000 && words <= 3000 && hookOk === true) return 'gold'
  if (warns <= 2) return 'silver'
  if (warns <= 4) return 'bronze'
  return 'reject'
}

/** 展示用分数：每 warn −15、每 block −50，info 不扣分。 */
function scoreOf(issues: QualityIssue[]): number {
  const penalty = issues.reduce((n, i) => n + (i.level === 'block' ? 50 : i.level === 'warn' ? 15 : 0), 0)
  return Math.max(0, 100 - penalty)
}

/** 平台硬线：番茄正文 ≥1000 字。 */
const HARD_MIN_WORDS = 1000
/** 标黄线：低于番茄最佳阅读长度太多。 */
const SOFT_MIN_WORDS = 1600

/** 未指定原型指纹时的通用阈值（= 一期兜底语义）。 */
export const GENERIC_FINGERPRINT: ArchetypeFingerprint = {
  colloquialPer1k: [2, 10],
  concreteDetailPer1kMin: 4,
  sentenceLenStdMin: 5,
  endingSublimationMax: 0,
  paraCvMin: 0.3,
}

/**
 * 去 AI 味粗筛词表（§11.2 扩充）：总结腔 / 书面虚词 / 含糊修饰 / 网文陈词。
 * 命中只计数进 warn，不替用户改稿；误报由第二层 LLM 审复核。
 */
const AI_FLAVOR_PATTERNS: { re: RegExp; label: string }[] = [
  // 总结腔
  { re: /这(告诉|说)了?我们/g, label: '总结腔' },
  { re: /值得一提|不得不说|总的来说|综上所述|可以说，/g, label: '总结腔' },
  // 书面虚词（高频命中即腔调可疑）
  { re: /仿佛/g, label: '书面虚词' },
  { re: /似乎/g, label: '书面虚词' },
  { re: /不禁/g, label: '书面虚词' },
  // 含糊修饰（AI 爱用含糊量词兜圈子）
  { re: /莫名的/g, label: '含糊修饰' },
  { re: /某种[^，。]{0,8}的/g, label: '含糊修饰' },
  { re: /一[丝抹][^，。]{0,6}(的感觉|情绪)/g, label: '含糊修饰' },
  // 网文陈词（身体反应套话）
  { re: /心中一紧|心头一紧/g, label: '陈词' },
  { re: /(眼底|眼中|眸中|眼眸)(深处|之中)?(闪过|掠过)/g, label: '陈词' },
  { re: /嘴角(勾起|浮现|微微上扬)/g, label: '陈词' },
  { re: /空气(中|里|仿佛)?(弥漫|凝固|骤然|瞬间紧张)/g, label: '陈词' },
  { re: /时间仿佛(静止|停止|凝固)|时间在这一刻(静止|凝固)/g, label: '陈词' },
  { re: /(心中|心里|心口)(涌起|升起|泛起)一[股丝抹]/g, label: '陈词' },
  { re: /一[丝抹]不易察觉的/g, label: '陈词' },
  { re: /(眸子|眼眸)(深处|之中)?(闪过|掠过)一[丝抹]/g, label: '陈词' },
]

/**
 * 段末升华词表：以总结腔收段（「或许…吧」「这就是…」「命运…」类）。
 * 通俗小说章内一律禁止（指纹 endingSublimationMax，通常 0）。
 */
const SUBLIMATION_ENDINGS: RegExp[] = [
  /(?:或许|也许|大概|恐怕)[^。！？]*吧[。！？!？]*$/,
  /这就是(?:所谓)?的?[^。！？]{0,16}[。！？!？]*$/,
  /(?:人生|生活|命运|爱情)(?:就像|不过是|总是|从来)[^。！？]{0,24}[。！？!？]*$/,
  /(?:这一刻|这一夜|这一天)[，,][^。！？]{0,24}(?:明白了|懂了|再也回不去)[^。！？]{0,8}[。！？!？]*$/,
]

/**
 * 禁词/敏感词粗筛（与番茄审核口径对齐的本地小词表，持续维护）。
 * 粗筛不可能覆盖平台审核，仅提前暴露明显问题；命中标 warn。
 */
const TABOO_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /(党和国家领导人|国家主席|总理)/g, label: '涉政词汇' },
  { re: /自杀(方法|教程)|自残(方法|教程)/g, label: '危险内容' },
  { re: /(开房|床上运动|肉体交换)/g, label: '低俗内容' },
  { re: /(冰|麻古|k 粉)(毒)?品/g, label: '毒品内容' },
]

/** 中文字数：去掉所有空白后的字符数（番茄口径近似）。 */
export function countWords(text: string): number {
  return text.replace(/\s+/g, '').length
}

/** 黄金三章专项要求（1–3 章），生成时进 prompt、复查时出 info。 */
export function goldenRuleFor(no: number): string {
  if (no === 1) return '【黄金三章·第 1 章】开头 300 字内必须出现钩子（悬念/冲突/金手指三选一），直接入戏，不要背景铺垫。'
  if (no === 2) return '【黄金三章·第 2 章】立起全书核心矛盾，让读者明确主角要对抗什么。'
  if (no === 3) return '【黄金三章·第 3 章】完成第一个小高潮，本章内铺垫不超过 500 字。'
  return ''
}

/** 切句：按中英文句末标点切，保留标点，滤空。 */
function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[。！？!?…])/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** 均值/标准差（length ≤1 时 std=0）。 */
function stdOf(nums: number[]): number {
  if (nums.length <= 1) return 0
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

/** 排比三连：连续 3 句以上同开头（前两字相同）记 1 组。 */
function countParallelism(sentences: string[]): number {
  let runs = 0
  let run = 1
  const key = (s: string) => (s.length >= 2 ? s.slice(0, 2) : '')
  for (let i = 1; i < sentences.length; i++) {
    if (key(sentences[i]) && key(sentences[i]) === key(sentences[i - 1])) {
      run++
      if (run === 3) runs++
    } else {
      run = 1
    }
  }
  return runs
}

/**
 * 跑第一层质量闸。纯函数：正文 + 元信息 → 报告。
 * @param opts.hookOk 模型自评的结尾钩子（stripHookMark 产物）。
 * @param opts.fingerprint 风格原型指纹（book.archetype 对应参数；
 *   缺省用通用阈值，兼容一期旧书）。
 */
export function analyzeChapter(
  content: string,
  opts: { chapterNo: number; hookOk?: boolean; fingerprint?: ArchetypeFingerprint },
): QualityReport {
  const fp = opts.fingerprint ?? GENERIC_FINGERPRINT
  const words = countWords(content)
  const paragraphs = content.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const issues: QualityIssue[] = []

  // 字数闸（plan：硬伤拦截 + 标黄）
  if (words < HARD_MIN_WORDS) {
    issues.push({ level: 'block', code: 'TOO_SHORT', message: `正文仅 ${words} 字，低于平台 1000 字硬线，无法提交` })
  } else if (words < SOFT_MIN_WORDS) {
    issues.push({ level: 'warn', code: 'SHORT', message: `正文 ${words} 字，低于 ${SOFT_MIN_WORDS} 字（番茄最佳阅读长度 2200–2800），建议补写` })
  } else if (words > 3200) {
    issues.push({ level: 'info', code: 'LONG', message: `正文 ${words} 字，超出单章建议上限（2800），可考虑拆章` })
  }

  // 结尾钩子（模型自评）
  if (opts.hookOk === false) {
    issues.push({ level: 'warn', code: 'HOOK_BAD', message: '模型自评本章结尾缺少钩子（承诺强度不足，读者没有必须往下翻的理由），建议重写结尾' })
  } else if (opts.hookOk === undefined) {
    issues.push({ level: 'info', code: 'HOOK_UNKNOWN', message: '未获取到结尾钩子自评，请人工确认结尾是否留钩' })
  }

  // 统计项：句长方差 / 段落均匀性 / 段末升华 / 排比三连
  const sentences = splitSentences(content)
  const sentenceStd = stdOf(sentences.map(s => countWords(s)))
  if (sentences.length >= 12 && sentenceStd < fp.sentenceLenStdMin) {
    issues.push({ level: 'warn', code: 'SENTENCE_FLAT', message: `句长过于均匀（标准差 ${sentenceStd.toFixed(1)} < ${fp.sentenceLenStdMin}），是典型 AI 腔；长短句要砸出参差` })
  }
  const paraLens = paragraphs.map(p => countWords(p))
  const paraMean = paraLens.length ? paraLens.reduce((a, b) => a + b, 0) / paraLens.length : 0
  const paraCv = paraMean > 0 ? stdOf(paraLens) / paraMean : 0
  if (paragraphs.length >= 8 && paraCv < fp.paraCvMin) {
    issues.push({ level: 'warn', code: 'PARA_UNIFORM', message: `段落长度过于均匀（变异系数 ${paraCv.toFixed(2)} < ${fp.paraCvMin}），每段等长是 AI 排版味；该碎的碎、该并的并` })
  }
  let sublimationParas = 0
  for (const p of paragraphs) {
    if (SUBLIMATION_ENDINGS.some(re => re.test(p))) sublimationParas++
  }
  if (sublimationParas > fp.endingSublimationMax) {
    issues.push({ level: 'warn', code: 'ENDING_SUBLIMATION', message: `${sublimationParas} 个段落用总结腔收尾（或许…吧/这就是…/命运…），章内禁止升华，收在动作或对话上` })
  }
  const parallelismRuns = countParallelism(sentences)
  if (parallelismRuns > 0) {
    issues.push({ level: 'warn', code: 'PARALLELISM', message: `${parallelismRuns} 处连续 3 句同开头（排比三连），网文正文忌排比堆砌，拆掉重写` })
  }

  // 去 AI 味词表粗筛
  const flavorHits: string[] = []
  for (const { re, label } of AI_FLAVOR_PATTERNS) {
    const hits = content.match(re)
    if (hits) flavorHits.push(`${label}×${hits.length}（如「${hits[0]}」）`)
  }
  if (flavorHits.length > 0) {
    issues.push({ level: 'warn', code: 'AI_FLAVOR', message: `去 AI 味粗筛命中：${flavorHits.join('；')}` })
  }

  // 禁词/敏感词粗筛
  const tabooHits: string[] = []
  for (const { re, label } of TABOO_PATTERNS) {
    const hits = content.match(re)
    if (hits) tabooHits.push(`${label}（「${hits[0]}」）`)
  }
  if (tabooHits.length > 0) {
    issues.push({ level: 'warn', code: 'TABOO', message: `禁词粗筛命中（以平台审核为准）：${tabooHits.join('；')}` })
  }

  // 黄金三章人工复查提示
  if (opts.chapterNo >= 1 && opts.chapterNo <= 3) {
    issues.push({ level: 'info', code: 'GOLDEN_THREE', message: goldenRuleFor(opts.chapterNo).replace('【黄金三章·', '人工复查：').replaceAll('】', '——') })
  }

  // 排版：段落数与长度粗查（每段 1–3 行规范 → 超长段提示）
  const longParas = paragraphs.filter(p => p.length > 160).length
  if (longParas > 0) {
    issues.push({ level: 'info', code: 'LONG_PARA', message: `${longParas} 个段落超过 160 字，网文排版建议每段 1–3 行（约 ≤80 字）` })
  }

  return {
    words,
    paragraphCount: paragraphs.length,
    issues,
    stats: { sentenceStd, paraCv, sublimationParas, parallelismRuns },
    hookOk: opts.hookOk,
    passed: gradeOf(issues, words, opts.hookOk) !== 'reject',
    grade: gradeOf(issues, words, opts.hookOk),
    score: scoreOf(issues),
  }
}
