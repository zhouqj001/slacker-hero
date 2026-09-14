/**
 * 本地 TXT 章节智能切分 —— 从主应用 src/lib/local-toc.ts 原样移植
 * （正则、收集、去重、偏移语义与原实现完全一致）。
 *
 * 切分策略（同原作）：
 * - 卷标题：第一卷 / 卷一 / Volume 1 / 第X卷 / 上部 下部 等
 * - 章节标题：第X章 / Chapter X / 第X节 / 序章 / 楔子 / 后记 / 第X回 等
 * - 每条目录记录字符偏移（titleStart/start），阅读时按偏移截取正文
 */

/** 目录条目（本地章带偏移）。 */
export interface LocalChapter {
  name: string
  isVolume: boolean
  /** 章节正文在全文中的起始字符偏移 */
  start: number
  /** 章节标题在全文中的起始字符偏移 */
  titleStart: number
}

/** 切分结果。 */
export interface LocalToc {
  items: LocalChapter[]
  chapterCount: number
  volumeCount: number
  hasVolume: boolean
}

/** 卷标题正则（必须独占一行）。 */
const VOLUME_PATTERNS: RegExp[] = [
  /^[\t ]*第[零一二三四五六七八九十百千万0-9]+[卷篇部](?:[·：: 　].*)?[\t ]*$/m,
  /^[\t ]*[卷篇部][零一二三四五六七八九十百千万0-9]+(?:[·：: 　].*)?[\t ]*$/m,
  /^[\t ]*(?:上|中|下)[部卷](?:[·：: 　].*)?[\t ]*$/m,
  /^[\t ]*Volume\s+[0-9IVXLCDM]+(?:[.\s].*)?$/im,
  /^[\t ]*卷[零一二三四五六七八九十百千万0-9]+(?:[·：: 　].*)?[\t ]*$/m,
]

/** 章节标题正则（必须独占一行）。 */
const CHAPTER_PATTERNS: RegExp[] = [
  /^[\t ]*第[零一二三四五六七八九十百千万0-9]+[章节回](?:[·：: 　].*)?[\t ]*$/m,
  /^[\t ]*Chapter\s+[0-9IVXLCDM]+(?:[.\s].*)?$/im,
  /^[\t ]*[0-9]{1,4}[、.][\t ]*\S+[\t ]*$/m,
  /^[\t ]*(?:序章|楔子|引子|前言|序言|后记|尾声|番外(?:篇)?)(?:[·：: 　].*)?[\t ]*$/m,
  /^[\t ]*第[0-9]+[节话](?:[·：: 　].*)?[\t ]*$/m,
  /^[\t ]*正文\s+第[零一二三四五六七八九十百千万0-9]+[章节回][\t ]*$/m,
]

/** 自定义规则选项。 */
export interface SplitOptions {
  extraVolumePatterns?: string[]
  extraChapterPatterns?: string[]
}

/** 把全文切分为章节目录（算法同原作：全匹配点按位置排序、去重、偏移截取）。 */
export function splitChapters(text: string, opts: SplitOptions = {}): LocalToc {
  if (!text) return { items: [], chapterCount: 0, volumeCount: 0, hasVolume: false }

  const volumeRes = compilePatterns(VOLUME_PATTERNS, opts.extraVolumePatterns)
  const chapterRes = compilePatterns(CHAPTER_PATTERNS, opts.extraChapterPatterns)

  type Mark = { index: number; length: number; line: string; isVolume: boolean }
  const marks: Mark[] = []

  for (const re of volumeRes) collectMarks(text, re, true, marks)
  for (const re of chapterRes) collectMarks(text, re, false, marks)

  // 按位置排序，去重（同一位置只保留一个）
  marks.sort((a, b) => a.index - b.index)
  const deduped: Mark[] = []
  const seenPos = new Set<number>()
  for (const m of marks) {
    if (seenPos.has(m.index)) continue
    seenPos.add(m.index)
    deduped.push(m)
  }

  if (deduped.length === 0) {
    // 没识别到章节，整篇作为一个条目
    return {
      items: [{ name: '全文', isVolume: false, start: 0, titleStart: 0 }],
      chapterCount: 1, volumeCount: 0, hasVolume: false,
    }
  }

  const items: LocalChapter[] = deduped.map(m => ({
    name: m.line.trim(),
    isVolume: m.isVolume,
    titleStart: m.index,
    // 正文从标题行之后开始
    start: m.index + m.length,
  }))

  const chapterCount = items.filter(it => !it.isVolume).length
  const volumeCount = items.filter(it => it.isVolume).length
  return { items, chapterCount, volumeCount, hasVolume: volumeCount > 0 }
}

/** 取某章正文：从 chapter.start 到下一章 titleStart。 */
export function getChapterText(text: string, toc: LocalToc, index: number): string {
  if (index < 0 || index >= toc.items.length) return ''
  const cur = toc.items[index]!
  const next = index + 1 < toc.items.length ? toc.items[index + 1]!.titleStart : text.length
  return text.slice(cur.start, next).trim()
}

function compilePatterns(defaults: RegExp[], extra?: string[]): RegExp[] {
  const res = [...defaults]
  if (extra) {
    for (const s of extra) {
      try { res.push(new RegExp(s, 'm')) } catch { /* 忽略非法正则 */ }
    }
  }
  return res
}

function collectMarks(
  text: string, re: RegExp, isVolume: boolean,
  out: { index: number; length: number; line: string; isVolume: boolean }[],
): void {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  // 防止零宽匹配死循环
  let guard = 0
  while ((m = re.exec(text)) !== null && guard < 100000) {
    guard++
    const line = m[0]
    // 过滤空行误判
    if (line.trim().length === 0) {
      if (re.lastIndex === m.index) re.lastIndex++
      continue
    }
    out.push({ index: m.index, length: m[0].length, line, isVolume })
    if (re.lastIndex === m.index) re.lastIndex++
  }
}

/** 根据全文中的字符偏移定位章节索引（-1 表示在第一个条目之前）。 */
export function findChapterIndex(toc: LocalToc, offset: number): number {
  if (toc.items.length === 0) return -1
  let idx = -1
  for (let i = 0; i < toc.items.length; i++) {
    if (toc.items[i]!.titleStart <= offset) idx = i
    else break
  }
  return idx
}
