/**
 * 书源/书架元数据存储（kv 落盘版）—— 对应主应用 booksource.ts +
 * shelf.ts 的持久层，键值走壳 kv（origin 每次启动都变，localStorage 不可用）。
 */
import { kvGet, kvSet } from '../../ipc.ts'
import { BOOKSOURCE_SCHEMA, type BookSource } from './types.ts'
import { convertLegadoArray, isLegadoSource, isLegadoUnsupported } from './legado.ts'
import { DEFAULT_SOURCES } from './default-sources.ts'

/** kv keys. */
const SOURCES_KEY = 'novel.sources'
const SOURCES_SEEDED_KEY = 'novel.sources.seeded'
const BOOKS_KEY = 'novel.books'

/** 未校验/未评分书源的默认分（搜索时按分数分批）。 */
export const DEFAULT_SOURCE_SCORE = 50

/** 存储的书源条目。 */
export interface StoredSource {
  source: BookSource
  enabled: boolean
  importedAt: number
  /** 质量评分 0-100（搜索/校验时动态更新，默认 50） */
  score?: number
  lastCheckedAt?: number
}

/** 书架书籍元数据（本地书与网络书统一）。 */
export interface ShelfBookMeta {
  /** local:<书名> 或 <sourceName>::<bookUrl>（同主应用 deriveBookId 语义） */
  id: string
  name: string
  author?: string
  cover?: string
  intro?: string
  /** 网络书：来源书源名 + 书详情 URL */
  sourceName?: string
  bookUrl?: string
  tocUrl?: string
  /** 阅读进度（字段语义同主应用 ShelfBook） */
  chapterIndex: number
  /** 页号（旧语义，兼容旧书数据与书卡片） */
  offset: number
  /** 章内字符偏移：进度主基准。改每页字数/浮条字号/浮条宽度后按新分页重算，位置不丢。 */
  charOffset?: number
  lastChapterName?: string
  lastReadAt?: number
  addedAt: number
}

/** 网络书判定。 */
export const isNetworkBook = (b: ShelfBookMeta): boolean => b.sourceName !== undefined && b.bookUrl !== undefined

/* ── 书源 CRUD ── */

/** 读取全部书源；首次运行（空库且从未 seed 过播放置「已 seed」标记，
 *  用户清空书源后不再重复灌入，同主应用语义）。 */
export async function loadSources(): Promise<StoredSource[]> {
  const saved = await kvGet(SOURCES_KEY)
  if (saved === null) {
    const seeded = await kvGet(SOURCES_SEEDED_KEY)
    if (seeded === null && DEFAULT_SOURCES.length > 0) {
      const pending: StoredSource[] = DEFAULT_SOURCES.map(source => ({
        source, enabled: true, importedAt: Date.now(),
      }))
      await kvSet(SOURCES_SEEDED_KEY, '1')
      await saveSources(pending)
      return pending
    }
    return []
  }
  try { return JSON.parse(saved) as StoredSource[] } catch { return [] }
}

/** 全量写回书源列表。 */
export async function saveSources(list: StoredSource[]): Promise<void> {
  await kvSet(SOURCES_KEY, JSON.stringify(list))
}

/** 书源结构校验（同主应用 validate 的必填项）。 */
export function validateSource(src: unknown): src is BookSource {
  const s = src as Partial<BookSource>
  return (
    s !== null && typeof s === 'object'
    && s.schema === BOOKSOURCE_SCHEMA
    && typeof s.name === 'string' && s.name !== ''
    && typeof s.url === 'string' && /^https?:\/\//.test(s.url)
    && s.bookInfo !== undefined && s.toc !== undefined && s.content !== undefined
  )
}

/** 导入一段 JSON 文本（v2 或 Legado，单对象或数组），返回导入统计。 */
export async function importSourcesText(text: string): Promise<{ added: number; skipped: number }> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('JSON 解析失败') }
  let incoming: BookSource[]
  let skipped = 0
  let enabledMap: Map<string, boolean> | undefined
  if (isLegadoSource(parsed)) {
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const conv = convertLegadoArray(arr as unknown[])
    // 过滤引擎不支持的量源（JSONPath/JS/webView/cookie/java），避免导入即坏
    const supported = conv.sources.filter(s => isLegadoUnsupported(s) === null)
    skipped = conv.skipped + (conv.sources.length - supported.length)
    enabledMap = new Map(
      arr.flatMap((o): [string, boolean][] => {
        const n = (o as { bookSourceName?: string }).bookSourceName
        return n !== undefined ? [[n, (o as { enabled?: boolean }).enabled !== false]] : []
      }),
    )
    incoming = supported
  } else if (Array.isArray(parsed)) {
    const ok = (parsed as unknown[]).filter(validateSource)
    incoming = ok as BookSource[]
    skipped = parsed.length - ok.length
  } else if (validateSource(parsed)) {
    incoming = [parsed]
  } else {
    throw new Error('不是有效的书源 JSON（v2 或 Legado）')
  }
  const list = await loadSources()
  for (const source of incoming) {
    // 同名覆盖（同主应用去重语义）
    const idx = list.findIndex(x => x.source.name === source.name)
    const entry: StoredSource = { source, enabled: enabledMap?.get(source.name) ?? true, importedAt: Date.now() }
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
  }
  await saveSources(list)
  return { added: incoming.length, skipped }
}

/** 删除书源（按名）。 */
export async function removeSource(name: string): Promise<void> {
  await saveSources((await loadSources()).filter(x => x.source.name !== name))
}

/** 启停书源。 */
export async function toggleSource(name: string): Promise<void> {
  const list = await loadSources()
  const hit = list.find(x => x.source.name === name)
  if (hit === undefined) return
  hit.enabled = !hit.enabled
  await saveSources(list)
}

/** 更新书源评分（增量或绝对值），钳到 0-100，写回并返回新列表。 */
export async function setSourceScore(
  name: string,
  score: number | ((prev: number | undefined) => number),
): Promise<StoredSource[]> {
  const list = await loadSources()
  const hit = list.find(x => x.source.name === name)
  if (hit === undefined) return list
  const prev = hit.score
  const next = typeof score === 'function' ? score(prev) : score
  hit.score = Math.max(0, Math.min(100, Math.round(next)))
  hit.lastCheckedAt = Date.now()
  await saveSources(list)
  return list
}

/** 取评分（未评分回默认 50）。 */
export const sourceScore = (s: StoredSource): number => s.score ?? DEFAULT_SOURCE_SCORE

/* ── 书架元数据 CRUD ── */

/** 读取书架元数据列表。 */
export async function loadBooks(): Promise<ShelfBookMeta[]> {
  const saved = await kvGet(BOOKS_KEY)
  if (saved === null) return []
  try { return JSON.parse(saved) as ShelfBookMeta[] } catch { return [] }
}

/** 全量写回书架。 */
export async function saveBooks(list: ShelfBookMeta[]): Promise<void> {
  await kvSet(BOOKS_KEY, JSON.stringify(list))
}

/** upsert 一本书的元数据（按 id 覆盖）。 */
export async function upsertBook(book: ShelfBookMeta): Promise<ShelfBookMeta[]> {
  const list = await loadBooks()
  const idx = list.findIndex(b => b.id === book.id)
  if (idx >= 0) list[idx] = { ...list[idx]!, ...book }
  else list.push(book)
  await saveBooks(list)
  return list
}

/** 删除一本书。 */
export async function removeBook(id: string): Promise<ShelfBookMeta[]> {
  const list = (await loadBooks()).filter(b => b.id !== id)
  await saveBooks(list)
  return list
}

/** 更新阅读进度（同主应用 updateProgress 字段）。 */
export async function updateProgress(
  id: string,
  patch: {
    chapterIndex?: number
    offset?: number
    charOffset?: number
    lastChapterName?: string
    lastReadAt?: number
  },
): Promise<void> {
  const list = await loadBooks()
  const hit = list.find(b => b.id === id)
  if (hit === undefined) {
    // 兜底建档：本地书可能是书架由 localNames 现合成的，从未进过 books 表；
    // 若直接丢弃，进度永远写不进（列表恒“未读”、重开恒从头）。
    list.push({
      id,
      name: id.startsWith('local:') ? id.slice('local:'.length) : id,
      chapterIndex: patch.chapterIndex ?? 0,
      offset: patch.offset ?? 1,
      ...(patch.charOffset !== undefined ? { charOffset: patch.charOffset } : {}),
      ...(patch.lastChapterName !== undefined ? { lastChapterName: patch.lastChapterName } : {}),
      ...(patch.lastReadAt !== undefined ? { lastReadAt: patch.lastReadAt } : {}),
      addedAt: Date.now(),
    })
    await saveBooks(list)
    return
  }
  Object.assign(hit, patch)
  await saveBooks(list)
}
