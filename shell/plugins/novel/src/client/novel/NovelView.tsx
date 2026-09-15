/**
 * 小说中心 —— 复刻主应用的 NovelHome + ShelfReader 全链路：
 * 三标签（书架 / 搜索 / 书源），书架统一本地 TXT 与网络书；阅读器支持
 * 本地（正则切章 + chunkText 分页）与网络（书源引擎按章抓取）双模式，
 * 进度（chapterIndex + 页码）防抖 800ms 落盘，五主题/字号/行距/每页字数。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NovelKey } from '../locales.ts'
import {
  inShell, novelChapter, novelDelete, novelDir, novelFloatMode, novelList, novelPickDir, novelSave,
  novelSetDir, novelToc, novelWindowClose, novelWindowOpen, novelWindowResize, kvGet, kvSet, type NovelTocEntry,
} from '../ipc.ts'
import { BookSourceEngine } from './source/engine.ts'
import type { TocItem } from './source/types.ts'
import {
  isNetworkBook, loadBooks, loadSources, removeBook as removeBookMeta,
  updateProgress, upsertBook, type ShelfBookMeta,
} from './source/store.ts'
import { SourceSearch } from './SourceSearch.tsx'
import { SourceManager } from './SourceManager.tsx'
import css from './NovelView.module.css'

/** 本窗口是否就是独立阅读弹窗（Rust `slacker_novel_window` 注入标记）。 */
const NOVEL_MODE = (window as unknown as { __SLACKER_NOVEL_READER__?: boolean }).__SLACKER_NOVEL_READER__ === true

/* ── 阅读器常量（与主应用完全一致） ── */

const THEMES = [
  { id: 'dark', labelKey: 'novel.theme.dark', bg: '#1a1a2e', text: '#e0d5c1' },
  { id: 'parchment', labelKey: 'novel.theme.parchment', bg: '#f5f0e8', text: '#3d3229' },
  { id: 'green', labelKey: 'novel.theme.green', bg: '#c7edcc', text: '#2d3a2d' },
  { id: 'ink', labelKey: 'novel.theme.ink', bg: '#f0ebe3', text: '#333333' },
  { id: 'white', labelKey: 'novel.theme.white', bg: '#ffffff', text: '#222222' },
] as const
type ThemeId = typeof THEMES[number]['id']

const FONT_SIZES = [12, 14, 15, 16, 18, 20, 22, 24, 28] as const
const LINE_HEIGHTS = [1.4, 1.6, 1.7, 1.8, 2.0, 2.2] as const

/** hex 色（#rgb/#rrggbb）转 rgba 串：透明度精确作用在背景上，文字保持不透明。 */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = Number.parseInt(h, 16)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** 粗估单个字符在给定字号下的像素宽：中文/全角≈1em，西文/数字/空格≈0.5em。
 * 用于浮条按像素宽精确裁剪可见文字（比"直接数符"准得多）。 */
function estCharWidthPx(ch: string, fontSizePx: number): number {
  const code = ch.codePointAt(0) ?? 0
  const han = code > 0x2e80 && code < 0x9fff            // CJK 统一表意 & 兼容
    || (code >= 0x3000 && code <= 0x303f)               // 日式标点/CJK 符号
    || (code >= 0xff00 && code <= 0xffef)               // 全角形式
  if (han) return fontSizePx
  // 半角标点/数字/字母折半；空白取四分之一更稳。
  if (ch === ' ' || ch === '\u3000') return fontSizePx * 0.5
  if (code <= 0x7f && /[A-Za-z0-9]/.test(ch)) return fontSizePx * 0.5
  return fontSizePx * 0.8
}

/** 从单行文本中取出恰好不超出 maxWidthPx 的最长前缀；返回 { text, consumedChars }。 */
function fitFloatText(flat: string, maxWidthPx: number, fontSizePx: number): { text: string; chars: number } {
  let width = 0
  let i = 0
  for (; i < flat.length; i++) {
    const w = estCharWidthPx(flat[i], fontSizePx)
    if (width + w > maxWidthPx) break
    width += w
  }
  return { text: flat.slice(0, i), chars: i }
}

/** 比较一次按键事件是否命中录制的组合键字符串（如 "Ctrl+Shift+ArrowRight"）。
 * 录制时按「Ctrl」顺序存；这里逐 token 解析，不依赖顺序。 */
function matchesKey(ev: KeyboardEvent, combo: string): boolean {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  return ev.key === key
    && mods.has('Ctrl') === ev.ctrlKey
    && mods.has('Alt') === ev.altKey
    && mods.has('Shift') === ev.shiftKey
}

interface Settings {
  fontSize: number
  lineHeight: number
  pageSize: number
  themeId: ThemeId
  lineBreak: '\n' | ' '
  /** 伪装皮肤：none 正常 / dark 黑底纯正文（备用） / float 悬浮细条。 */
  disguise: 'none' | 'dark' | 'float'
  /** 窗口透明度（0.3–1，仅壳内阅读弹窗实际生效）。 */
  windowOpacity: number
  /** 翻页键（逐键录制，可为空串=未自定义使用默认）：下一章键 / 上一章键。 */
  nextKey: string
  prevKey: string
  /** 浮条专属外观（独立于阅读主题与窗口透明度）：文字颜色 / 字体 / 字号 / 背景色 / 背景不透明度。 */
  floatTextColor: string
  floatTextFont: string
  floatFontSize: number
  floatBgColor: string
  floatOpacity: number
  /** 自动隐身：窗口失焦自动切成暗色皮肤，聚焦恢复。 */
  autoStealth: boolean
}

const DEFAULT_SETTINGS: Settings = {
  fontSize: 15, lineHeight: 1.7, pageSize: 300, themeId: 'dark', lineBreak: '\n',
  disguise: 'none', windowOpacity: 1, autoStealth: false,
  nextKey: '', prevKey: '',
  floatTextColor: '#c8cdd6', floatTextFont: '"Microsoft YaHei", Arial, sans-serif',
  floatFontSize: 15, floatBgColor: '#1c212b', floatOpacity: 0.82,
}

/** 伪装皮肤映射（底色 / 字色 / 字体栈），覆盖阅读主题。 */
const DISGUISES = {
  dark: { bg: '#000000', text: '#d0d6e0', font: '"Microsoft YaHei", Arial, sans-serif' },
  float: { bg: 'transparent', text: '#9aa0ac', font: '"Microsoft YaHei", Arial, sans-serif' },
} as const
type DisguiseId = keyof typeof DISGUISES | 'none'

const SETTINGS_KEY = 'novel.settings'

/** 按字符等长切片（Thief 风格，同原作）。 */
function chunkText(text: string, size: number): string[] {
  const pages: string[] = []
  for (let i = 0; i < text.length; i += size) pages.push(text.slice(i, i + size))
  return pages
}

/** 网络目录：跳过卷标题找相邻章（同原作 findNonVolume）。 */
function findNonVolume(toc: readonly TocItem[], from: number, dir: 1 | -1): number {
  let i = from + dir
  while (i >= 0 && i < toc.length && toc[i]!.isVolume === true) i += dir
  return i >= 0 && i < toc.length ? i : -1
}

function relTime(ts: number | undefined, t: (k: NovelKey) => string): string {
  if (ts === undefined) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return t('novel.time.now')
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' ' + t('novel.time.min')
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' ' + t('novel.time.hour')
  return Math.floor(diff / 86_400_000) + ' ' + t('novel.time.day')
}

/** 记住上一次渲染的某个值（首次为 undefined），用于“配置变化前快照”。 */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined)
  const prev = ref.current
  ref.current = value
  return prev
}

const hueOf = (name: string): number =>
  Array.from(name).reduce((a, c) => a + c.codePointAt(0)!, 0) % 360

/** 顶层标签。 */
type Page = 'shelf' | 'search' | 'sources'

/** 下载队列任务：书架网络书 → 本地 TXT（串行抓取 + 逐章进度）。 */
interface DownloadJob {
  id: number
  book: ShelfBookMeta
  status: 'queued' | 'downloading' | 'done' | 'error'
  cur: number
  total: number
  err?: string
}

/** Full props: the locale share. */
export type NovelViewProps = PropsLocale<'novel'>

/** Render the novel center.
 * @param props - the locale share carrying the typed `t` seat.
 */
export function NovelView(props: NovelViewProps): JSX.Element {
  const { t } = props
  const fileRef = useRef<HTMLInputElement>(null)

  /* ── 顶层标签 ── */
  const [page, setPage] = useState<Page>('shelf')

  /* ── 书架数据 ── */
  const [localNames, setLocalNames] = useState<readonly string[]>([])
  const [books, setBooks] = useState<readonly ShelfBookMeta[]>([])
  const [refreshTick, setRefreshTick] = useState(0)

  /* ── 下载目录设置（并入设置面板「小说存放」区） ── */
  const [dlDirCur, setDlDirCur] = useState<string | null>(null)
  const [dlDirMsg, setDlDirMsg] = useState('')

  const reloadDlDir = useCallback(() => {
    void novelDir().then(dir => {
      if (dir !== null) setDlDirCur(dir)
    })
  }, [])

  const saveDlDir = useCallback((dir: string): void => {
    setDlDirMsg('')
    void novelSetDir(dir).then(() => {
      setDlDirMsg(t('novel.dlDir.saved'))
      reloadDlDir()
    }).catch((err: unknown) => {
      const reason = err instanceof Error && err.message !== '' ? err.message : t('novel.dlDir.fail')
      setDlDirMsg(reason)
    })
  }, [reloadDlDir, t])

  /** 原生选夹 → 直接设为下载目录（选完即保存）。 */
  const pickDlDir = useCallback((): void => {
    setDlDirMsg('')
    void novelPickDir().then(dir => {
      if (dir === null) return // 用户取消，不改动
      saveDlDir(dir)
    })
  }, [saveDlDir])

  const reloadShelf = useCallback(() => {
    void novelList().then(setLocalNames)
    void loadBooks().then(setBooks)
  }, [])
  useEffect(() => { reloadShelf() }, [reloadShelf, refreshTick])

  /* kv 变更广播：同进程其它窗口（独立阅读窗/浮条）落盘进度后实时刷新书架，
     否则浮条看完关掉回到书架会显示“未读”。 */
  useEffect(() => {
    if (!inShell()) return
    const w = window as unknown as {
      __TAURI__?: { event?: { listen?: (evt: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } }
    }
    let unlisten: (() => void) | undefined
    let tm: number | undefined
    void w.__TAURI__?.event?.listen?.('slacker:kv-changed', e => {
      if (e.payload !== 'novel.books') return
      window.clearTimeout(tm)
      tm = window.setTimeout(() => reloadShelf(), 250)
    }).then(fn => { unlisten = fn }).catch(() => {})
    return () => { window.clearTimeout(tm); unlisten?.() }
  }, [reloadShelf])

  /* ── 阅读态（本地/网络共用一套翻页与进度） ── */
  const [reading, setReading] = useState<ShelfBookMeta | null>(null)
  // 本地模式：只留章节目录（无偏移的展示条目），正文按章向 Rust 索取
  const [localToc, setLocalToc] = useState<readonly NovelTocEntry[] | null>(null)
  const [localChapter, setLocalChapter] = useState('')
  const [localChapterLoading, setLocalChapterLoading] = useState(false)
  const localCache = useRef<Map<number, string>>(new Map())
  // 网络模式
  const [netToc, setNetToc] = useState<readonly TocItem[] | null>(null)
  const netEngine = useRef<BookSourceEngine | null>(null)
  const netCache = useRef<Map<number, string>>(new Map())
  const [netChapter, setNetChapter] = useState('')
  const [netLoading, setNetLoading] = useState(false)
  // 共用
  const [chapterIndex, setChapterIndex] = useState(0)
  const [page_, setPageNum] = useState(1)
  const [loading, setLoading] = useState(false)

  /* ── 设置 / 目录 ── */
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  /** 设置已从 kv 载入前不碰浮条窗口形态，避免重载瞬间以默认 disguise 放大成完整界面。 */
  const [settingsReady, setSettingsReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [collapsedVolumes, setCollapsedVolumes] = useState<ReadonlySet<number>>(new Set())
  const currentChapterRef = useRef<HTMLDivElement>(null)
  /** 设置面板打开时刷新「小说存放」目录。 */
  useEffect(() => {
    if (settingsOpen) reloadDlDir()
  }, [settingsOpen, reloadDlDir])
  /** 老板键/失焦隐身态：true 时覆盖为 bossKeySkin。 */
  const [stealthed, setStealthed] = useState(false)
  /** 悬浮条唤醒态：双击文字弹出「设置 / 关闭」按钮；再双击或点空白收起。 */
  const [floatAwake, setFloatAwake] = useState(false)
  /** 悬浮条临时展开：点「设置」时还原成完整窗口好让设置面板放下（disguise 保持不变）。 */
  const [floatExpanded, setFloatExpanded] = useState(false)
  /** 翻页键录制：'next' | 'prev' | null。为 null 时不在录制。 */
  const [recordingKey, setRecordingKey] = useState<'next' | 'prev' | null>(null)
  /** 浮条屏索引：整章文本按浮条宽度算出的每屏字数切成若干"浮条屏"，这里记当前屏。 */
  const [floatScreen, setFloatScreen] = useState(0)
  /** 浮条可用文本宽度（px）：视口宽减 padding/meta/唤醒按钮的留白，用于精确算字数。 */
  const [floatWidth, setFloatWidth] = useState(0)
  /** 打开书时的章内字符偏移目标（charOffset）：浮条皮肤首屏定位用。 */
  const progressCoRef = useRef(0)

  useEffect(() => {
    void (async (): Promise<void> => {
      const saved = await kvGet(SETTINGS_KEY)
      if (saved !== null) {
        try {
          const raw = JSON.parse(saved) as Partial<Settings>
          // 旧版本皮肤（editor/terminal/document/sheet）已下线：归一为正常皮肤。
          if (raw.disguise !== undefined && raw.disguise !== 'none' && raw.disguise !== 'dark' && raw.disguise !== 'float') {
            raw.disguise = 'none'
          }
          setSettings({ ...DEFAULT_SETTINGS, ...raw } as Settings)
        } catch { /* ignore */ }
      }
      setSettingsReady(true)
      void kvSet
    })()
  }, [])

  const persistSettings = useCallback((next: Settings): void => {
    setSettings(next)
    void (async (): Promise<void> => {
      await kvSet(SETTINGS_KEY, JSON.stringify(next))
    })()
  }, [kvSet])

  const isNet = reading !== null && isNetworkBook(reading)
  const net = isNet
  const tocCount = net ? (netToc?.length ?? 0) : (localToc?.length ?? 0)

  /* 目录条目统一形状（本地/网络 → {name, isVolume}）。 */
  const tocEntries = useMemo(() => {
    if (net) return (netToc ?? []).map(x => ({ name: x.name, isVolume: x.isVolume === true }))
    return (localToc ?? []).map(x => ({ name: x.name, isVolume: x.isVolume }))
  }, [net, netToc, localToc])

  /* ── 打开书 ── */
  const openBook = useCallback((book: ShelfBookMeta): void => {
    // 先把这本书登记进书架数据：否则地方书（书架由 localNames 现合成）根本没进
    // novel.books，进度落盘会被 updateProgress 静默丢弃 —— 列表恒“未读”、重开恒从头。
    void upsertBook(book)
    setReading(book); setLoading(true)
    netEngine.current = null; netCache.current = new Map()
    localCache.current = new Map()
    setNetToc(null); setLocalToc(null); setNetChapter(''); setLocalChapter('')
    const restore = (chapterCount: number): void => {
      const ci = Math.min(Math.max(book.chapterIndex, 0), Math.max(0, chapterCount - 1))
      setChapterIndex(ci)
      // charOffset 为主基准：按当前每页字数折算页号展开（旧数据只有页号也兼容）。
      progressCoRef.current = book.charOffset ?? Math.max(0, ((book.offset ?? 1) - 1) * settings.pageSize)
      const target = Math.floor(progressCoRef.current / settings.pageSize) + 1
      setPageNum(Math.max(1, target))
      setLoading(false)
    }

    if (isNetworkBook(book)) {
      void (async (): Promise<void> => {
        try {
          const sources = await loadSources()
          const hit = sources.find(s => s.source.name === book.sourceName)
          if (hit === undefined) throw new Error('书源已删除')
          const engine = new BookSourceEngine(hit.source)
          netEngine.current = engine
          const info = await engine.getBookInfo(book.bookUrl!)
          const toc = await engine.getToc(info)
          // 恢复时落在卷标题上则顺移到首个真章
          let ci = Math.min(Math.max(book.chapterIndex, 0), Math.max(0, toc.length - 1))
          if (toc[ci]?.isVolume === true) {
            const nn = findNonVolume(toc, ci, 1)
            if (nn >= 0) ci = nn
          }
          setNetToc(toc)
          setChapterIndex(ci)
          progressCoRef.current = book.charOffset ?? Math.max(0, ((book.offset ?? 1) - 1) * settings.pageSize)
          setPageNum(Math.max(1, Math.floor(progressCoRef.current / settings.pageSize) + 1))
          setLoading(false)
          // 首章预热
          const url = toc[ci]?.url
          if (url !== undefined && url !== '') {
            setNetLoading(true)
            try { netCache.current.set(ci, await engine.getContent(url)) }
            finally { setNetLoading(false) }
          }
        } catch (err) {
          console.warn('[ui-slacker] open network book failed:', err)
          setLoading(false)
        }
      })()
      return
    }

    // 本地书：Rust 切章只给目录，正文按章拉取。
    void novelToc(book.name).then(entries => {
      if (entries === null) { setLoading(false); return }
      setLocalToc(entries)
      restore(entries.length)
    })
  }, [settings.pageSize])

  /** 打开书：壳内一律走独立只读弹窗（含茶水间）；弹窗自身/浏览器→内嵌。 */
  const openBookOrShell = useCallback((book: ShelfBookMeta): void => {
    if (inShell() && !NOVEL_MODE) {
      void novelWindowOpen(book).then(ok => { if (!ok) openBook(book) })
      return
    }
    openBook(book)
  }, [openBook])

  /* 网络模式：按需抓取当前章（带缓存）。 */
  useEffect(() => {
    if (reading === null || !net || netToc === null || loading) return
    const cached = netCache.current.get(chapterIndex)
    if (cached !== undefined) { setNetChapter(cached); return }
    const item = netToc[chapterIndex]
    if (item === undefined || item.url === '') { setNetChapter(''); return }
    let alive = true
    setNetLoading(true); setNetChapter('')
    void netEngine.current!.getContent(item.url)
      .then(text => {
        if (!alive) return
        netCache.current.set(chapterIndex, text)
        setNetChapter(text)
      })
      .catch(err => { if (alive) { console.warn(err); setNetChapter(t('novel.net.fail')) } })
      .finally(() => { if (alive) setNetLoading(false) })
    return () => { alive = false }
  }, [reading, net, netToc, chapterIndex, loading, t])

  /* 本地模式：按章向 Rust 索取正文（定点读取，整本不全载入），带 LRU 式缓存。 */
  useEffect(() => {
    if (reading === null || net || localToc === null || loading) return
    const cached = localCache.current.get(chapterIndex)
    if (cached !== undefined) { setLocalChapter(cached); return }
    let alive = true
    setLocalChapterLoading(true)
    void novelChapter(reading.name, chapterIndex).then(text => {
      if (!alive) return
      if (localCache.current.size > 512) localCache.current.clear()
      localCache.current.set(chapterIndex, text)
      setLocalChapter(text)
    })
      .catch(err => { if (alive) { console.warn('[ui-slacker] load local chapter failed:', err); setLocalChapter('') } })
      .finally(() => { if (alive) setLocalChapterLoading(false) })
    return () => { alive = false }
  }, [reading, net, localToc, chapterIndex, loading])

  /* 正文 → 分页。 */
  const rawText = net ? netChapter : localChapter
  const processedText = settings.lineBreak === ' '
    ? rawText.replace(/\r/g, ' ').replace(/\n/g, ' ')
    : rawText
  const pages = useMemo(() => chunkText(processedText, settings.pageSize), [processedText, settings.pageSize])
  const totalPages = pages.length
  const currentText = pages[page_ - 1] ?? ''
  /** 浮条单行化整章文本：所有换行归一成单个空格，浮条按最大显示宽度拆分屏。 */
  const floatFlat = useMemo(() => rawText.replace(/\r?\n+/g, ' '), [rawText])
  /** 浮条每屏字符数：按浮条实际最大显示宽度 + 浮条字号精确算出（无省略号）。 */
  const floatPerScreen = useMemo(() => {
    if (floatWidth <= 0 || settings.floatFontSize <= 0) return 0
    return fitFloatText(floatFlat, floatWidth, settings.floatFontSize).chars
  }, [floatFlat, floatWidth, settings.floatFontSize])
  /** 整章按浮条每屏字数拆出的屏数。 */
  const floatTotalScreens = floatPerScreen > 0
    ? Math.max(1, Math.ceil(floatFlat.length / floatPerScreen))
    : 1
  /** 当前浮条屏（钳制到合法范围，防跨章瞬时越界而显示空白）。 */
  const floatScreenClamped = Math.min(floatScreen, floatTotalScreens - 1)
  /** 浮条当前屏实际显示的子串。 */
  const floatShown = floatPerScreen > 0
    ? floatFlat.slice(floatScreenClamped * floatPerScreen, (floatScreenClamped + 1) * floatPerScreen)
    : floatFlat
  const theme = THEMES.find(x => x.id === settings.themeId) ?? THEMES[0]
  /** 生效皮肤：悬浮细条优先于隐身态（它本身已是伪装）；
   * 展开状态（点了设置）从浮条临时还原成完整正文窗口（不用伪装皮肤，便于设置/目录摆放）；
   * 否则隐身态（老板键/失焦）取暗色皮肤，日常取 disguise。 */
  // 展开态：点设置从浮条临时还原成完整正文窗口（disguise 仍是 'float'）。
  const floatActive = settings.disguise === 'float' && !floatExpanded
  const effectiveSkin: DisguiseId = floatActive
    ? 'float'
    : floatExpanded && settings.disguise === 'float'
      ? 'none'
      : stealthed ? 'dark' : settings.disguise
  const disguise = effectiveSkin === 'none' ? undefined : DISGUISES[effectiveSkin]
  const skinOn = effectiveSkin !== 'none'

  /** 当前显示内容的章内字符偏移（各自渲染空间：普通页按每页字数，浮条按每屏字数）。
   * 进度保存与设置变化重定位都以此为主基准 —— 改每页字数/浮条字号/浮条宽度后位置不丢。 */
  const showOffset = effectiveSkin === 'float'
    ? (floatPerScreen > 0 ? floatScreenClamped * floatPerScreen : 0)
    : Math.max(0, (page_ - 1) * settings.pageSize)
  /** 上一次渲染的分页配置快照：改配置时把“变化前”的位置换算到“变化后”。 */
  const prevLayout = usePrevious({
    pageSize: settings.pageSize,
    floatPerScreen,
    floatScreen: floatScreenClamped,
    page: page_,
  })

  /* 浮条每屏可用宽度 = Webview 视口宽（浮条横跨全窗，Rust 固定 360 逻辑像素）
   − 固定 chrome（padding 14×2、gap 12、meta 留白、唤醒按钮留白）。
   用视口而非容器实测：浮条 iframe/nowrap 单行内容会把容器测量值撑大，
   而视口宽是内容不可能影响的稳定基准。拖动改窗口大小由 resize 感知。 */
  useEffect(() => {
    const measure = (): void => {
      const metaReserve = 64
      const btnReserve = floatAwake ? 128 : 0
      setFloatWidth(Math.max(0, Math.round(window.innerWidth) - 14 * 2 - 12 - metaReserve - btnReserve))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [floatAwake])
  /* 换章 / 换皮肤时把浮条屏复位到第 1 屏。 */
  useEffect(() => { setFloatScreen(0) }, [effectiveSkin, chapterIndex])

  /* ── 皮肤派生内容（目前只有浮条用；各皮肤渲染差异见阅读器区） ── */

  /* 页码校正（同原作）。 */
  useEffect(() => {
    if (page_ > totalPages && totalPages > 0) setPageNum(totalPages)
  }, [totalPages, page_])

  /* 分页配置变化（每页字数/浮条字号/浮条宽 resize，含设置刚载入落地）时：
   用“变化前”的章内偏移换算出新配置下的页码/浮条屏，保证看到的文字位置不跳变。 */
  useEffect(() => {
    if (!settingsReady || reading === null || loading || prevLayout === undefined) return
    const prevOff = effectiveSkin === 'float'
      ? (prevLayout.floatPerScreen > 0 ? prevLayout.floatScreen * prevLayout.floatPerScreen : 0)
      : (prevLayout.page - 1) * prevLayout.pageSize
    if (effectiveSkin === 'float') {
      if (floatPerScreen <= 0) return
      const target = Math.floor(prevOff / floatPerScreen)
      setFloatScreen(Math.min(target, Math.max(0, floatTotalScreens - 1)))
    } else {
      const target = Math.floor(prevOff / settings.pageSize) + 1
      setPageNum(Math.max(1, Math.min(target, Math.max(1, totalPages))))
    }
    // 依赖只跟“分页参数变化”挂钩：换算基准是 prevLayout（上一次渲染的旧配置）。
  }, [settings.pageSize, settings.floatFontSize, floatWidth, settingsReady]) // eslint-disable-line react-hooks/exhaustive-deps

  /* 浮条皮肤下打开书：按书的章内偏移落到对应屏。progressCoRef 只在 openBook 时
   写入，且定位成功（floatPerScreen 就绪）后标记 -1 —— 之后再改浮条字号/宽度
   由分页配置重定位 effect 处理，不会按“打开书位置”回跳。 */
  useEffect(() => {
    if (effectiveSkin !== 'float' || reading === null || loading || floatPerScreen <= 0) return
    if (progressCoRef.current < 0) return
    setFloatScreen(Math.min(Math.floor(progressCoRef.current / floatPerScreen), Math.max(0, floatTotalScreens - 1)))
    progressCoRef.current = -1
  }, [floatPerScreen, effectiveSkin, reading, loading, floatTotalScreens])

  /* 独立阅读弹窗：Rust 开窗时 init script 注入 __SLACKER_NOVEL_BOOK__
   * （首次）或向既有窗口广播 `slacker:novel-open`（换书），两者落到 openBook。 */
  useEffect(() => {
    if (!NOVEL_MODE) return
    const w = window as unknown as {
      __SLACKER_NOVEL_BOOK__?: unknown
      __TAURI__?: { event?: { listen?: (evt: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } }
    }
    const initBook = w.__SLACKER_NOVEL_BOOK__
    if (initBook !== undefined) openBook(initBook as ShelfBookMeta)
    let unlisten: (() => void) | undefined
    void w.__TAURI__?.event?.listen?.('slacker:novel-open', e => {
      openBook(e.payload as ShelfBookMeta)
    }).then(fn => { unlisten = fn }).catch(() => {})
    return () => { unlisten?.() }
  }, [openBook])

  /* 老板键（Ctrl+Shift+H）：Rust 全局快捷键广播 → 切换外层隐身态（bossKeySkin）。 */
  useEffect(() => {
    const w = window as unknown as { __TAURI__?: { event?: { listen?: (evt: string, cb: () => void) => Promise<() => void> } } }
    let unlisten: (() => void) | undefined
    void w.__TAURI__?.event?.listen?.('slacker:boss-key', () => {
      setStealthed(v => !v)
    }).then(fn => { unlisten = fn }).catch(() => {})
    return () => { unlisten?.() }
  }, [])

  /* 自动隐身：窗口失焦自动套 bossKeySkin，重新聚焦还原。 */
  useEffect(() => {
    if (!settings.autoStealth) return
    const off = (): void => { setStealthed(true) }
    const on = (): void => { setStealthed(false) }
    window.addEventListener('blur', off)
    window.addEventListener('focus', on)
    return () => {
      window.removeEventListener('blur', off)
      window.removeEventListener('focus', on)
    }
  }, [settings.autoStealth])

  /* 窗口形态（仅壳内）：float=悬浮细条；dark=大窗；其余=默认小窗。
     旧版拆成两个 effect（悬浮收窗 + 尺寸调整），settingsReady 翻转/换肤时
     两者同帧先后触发、互相把窗口改回去（悬浮条被撑回大窗）。合成一个
     shape effect：一次只走一个动作，float 态绝不再补 resize。 */
  const shape: 'float' | 'wide' | 'normal' =
    effectiveSkin === 'float' ? 'float' : effectiveSkin === 'dark' ? 'wide' : 'normal'
  // 初值：独立阅读窗记 null（挂载即应用目标形态）；嵌在茶水间/主窗里则
  // 记当前值（首挂不发窗口指令，防把窗口撑大），仅形态变化时才动作。
  const shapeRef = useRef<'float' | 'wide' | 'normal' | null>(NOVEL_MODE ? null : shape)
  useEffect(() => {
    if (!inShell() || !settingsReady) return
    const prev = shapeRef.current
    if (prev === shape) return
    shapeRef.current = shape
    if (shape === 'float') { void novelFloatMode(true); return }
    if (prev === 'float') void novelFloatMode(false)
    void novelWindowResize(shape === 'wide')
  }, [shape, settingsReady])

  /* 进度防抖 800ms 落盘（同原作 saveProgress）。*/
  const saveTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (reading === null || loading) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const entry = tocEntries[chapterIndex]
      void updateProgress(reading.id, {
        chapterIndex,
        offset: page_,
        charOffset: showOffset,
        lastReadAt: Date.now(),
        ...(entry !== undefined ? { lastChapterName: entry.name } : {}),
      })
      setBooks(prev => prev.map(b =>
        b.id === reading.id
          ? {
              ...b, chapterIndex, offset: page_, charOffset: showOffset, lastReadAt: Date.now(),
              ...(entry !== undefined ? { lastChapterName: entry.name } : {}),
            }
          : b))
    }, 800)
    return () => { window.clearTimeout(saveTimer.current) }
  }, [reading, chapterIndex, page_, showOffset, loading, tocEntries])

  /* 翻页/翻章（同原作：章末进下一章，网络模式跳过卷）。
     浮条皮肤下：整章按浮条最大显示宽度切成若干屏，逐屏翻；跨屏到章尾再翻章。 */
  const nextPage = useCallback(() => {
    if (effectiveSkin === 'float') {
      if (floatScreenClamped + 1 < floatTotalScreens) {
        setFloatScreen(floatScreenClamped + 1)
        return
      }
      // 本章最后一屏 → 翻到下一章（复用常规翻章逻辑）。
      if (net && netToc !== null) {
        const nn = findNonVolume(netToc, chapterIndex, 1)
        if (nn >= 0) { setChapterIndex(nn); setPageNum(1) }
        return
      }
      if (localToc !== null && chapterIndex + 1 < localToc.length) {
        setChapterIndex(chapterIndex + 1); setPageNum(1)
      }
      return
    }
    // 非浮条：常规整页。
    if (page_ < totalPages) { setPageNum(page_ + 1); return }
    if (net && netToc !== null) {
      const nn = findNonVolume(netToc, chapterIndex, 1)
      if (nn >= 0) { setChapterIndex(nn); setPageNum(1) }
      return
    }
    if (localToc !== null && chapterIndex + 1 < localToc.length) {
      setChapterIndex(chapterIndex + 1); setPageNum(1)
    }
  }, [page_, totalPages, net, netToc, chapterIndex, localToc, effectiveSkin, floatScreenClamped, floatTotalScreens])

  const prevPage = useCallback(() => {
    if (effectiveSkin === 'float') {
      if (floatScreenClamped > 0) { setFloatScreen(floatScreenClamped - 1); return }
      // 本章第一屏 → 回上一章（回到章末屏）。
      if (net && netToc !== null) {
        const pv = findNonVolume(netToc, chapterIndex, -1)
        if (pv >= 0) { setChapterIndex(pv); setPageNum(9999) }
        return
      }
      if (chapterIndex > 0) { setChapterIndex(chapterIndex - 1); setPageNum(9999) }
      return
    }
    // 非浮条：常规整页。
    if (page_ > 1) { setPageNum(page_ - 1); return }
    if (net && netToc !== null) {
      const pv = findNonVolume(netToc, chapterIndex, -1)
      if (pv >= 0) { setChapterIndex(pv); setPageNum(9999) }
      return
    }
    if (chapterIndex > 0) { setChapterIndex(chapterIndex - 1); setPageNum(9999) }
  }, [page_, net, netToc, chapterIndex, effectiveSkin, floatScreenClamped])

  const goToChapter = useCallback((index: number): void => {
    setChapterIndex(index); setPageNum(1)
    setCatalogOpen(false)
  }, [])

  /** 关闭设置面板；若是悬浮条展开打开的（disguise 仍是 float），自动缩回浮条。 */
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setFloatExpanded(false)
  }, [])

  /* 阅读/环境设置面板：阅读器与首页（茶水间内嵌、书架页均可调）共用。 */
  const settingsPanel = settingsOpen && (
    <div className={css.overlayPanel}>
      <div className={css.panelHead}>
        <b>{t('novel.settings')}</b>
        <button type="button" className={css.rbtn} onClick={() => { closeSettings() }}>✕</button>
      </div>
      <div className={css.settingsBody}>
        <div className={css.setSec}>{t('novel.settings.general')}</div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.fontSize')}</span>
          {FONT_SIZES.map(s => (
            <button key={s} type="button"
              className={css.setOpt + (settings.fontSize === s ? ' ' + css.setOptOn : '')}
              onClick={() => { persistSettings({ ...settings, fontSize: s }) }}>{s}</button>
          ))}
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.lineHeight')}</span>
          {LINE_HEIGHTS.map(h => (
            <button key={h} type="button"
              className={css.setOpt + (settings.lineHeight === h ? ' ' + css.setOptOn : '')}
              onClick={() => { persistSettings({ ...settings, lineHeight: h }) }}>{h}</button>
          ))}
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.pageSize')}</span>
          <input type="range" min={100} max={1000} step={10}
            value={settings.pageSize}
            onChange={e => { persistSettings({ ...settings, pageSize: Number(e.target.value) }) }} />
          <span className={css.dim}>{settings.pageSize}</span>
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.theme')}</span>
          {THEMES.map(th => (
            <button key={th.id} type="button" title={t(th.labelKey)}
              className={css.themeDot + (settings.themeId === th.id ? ' ' + css.themeDotOn : '')}
              style={{ background: th.bg, color: th.text }}
              onClick={() => { persistSettings({ ...settings, themeId: th.id }) }}>
              {settings.themeId === th.id ? '●' : ''}
            </button>
          ))}
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.lineBreak')}</span>
          <button type="button"
            className={css.setOpt + (settings.lineBreak === '\n' ? ' ' + css.setOptOn : '')}
            onClick={() => { persistSettings({ ...settings, lineBreak: '\n' }) }}>{t('novel.keepBreak')}</button>
          <button type="button"
            className={css.setOpt + (settings.lineBreak === ' ' ? ' ' + css.setOptOn : '')}
            onClick={() => { persistSettings({ ...settings, lineBreak: ' ' }) }}>{t('novel.mergeBreak')}</button>
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.pagingKeys')}</span>
          <button type="button" title={t('novel.pagingNextTitle')}
            className={css.recordBtn + (recordingKey === 'next' ? ' ' + css.recordBtnOn : '')}
            onClick={() => { setRecordingKey(recordingKey === 'next' ? null : 'next') }}>
            {t('novel.pagingNext')}: {settings.nextKey || t('novel.pagingDefault')}
          </button>
          <button type="button" title={t('novel.pagingPrevTitle')}
            className={css.recordBtn + (recordingKey === 'prev' ? ' ' + css.recordBtnOn : '')}
            onClick={() => { setRecordingKey(recordingKey === 'prev' ? null : 'prev') }}>
            {t('novel.pagingPrev')}: {settings.prevKey || t('novel.pagingDefault')}
          </button>
        </div>
        <div className={css.setSec}>{t('novel.settings.disguise')}</div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.disguise')}</span>
          {(['none', 'dark', 'float'] as const).map(d => (
            <button key={d} type="button"
              title={d === 'float' ? t('novel.floatHint') : undefined}
              className={css.setOpt + (settings.disguise === d ? ' ' + css.setOptOn : '')}
              onClick={() => { persistSettings({ ...settings, disguise: d }) }}>
              {t(d === 'none' ? 'novel.disguise.none' : d === 'dark'
                ? 'novel.disguise.dark' : 'novel.disguise.float')}
            </button>
          ))}
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.opacity')}</span>
          <input type="range" min={30} max={100} step={5}
            value={Math.round(settings.windowOpacity * 100)}
            onChange={e => { persistSettings({ ...settings, windowOpacity: Number(e.target.value) / 100 }) }} />
          <span className={css.dim}>{Math.round(settings.windowOpacity * 100)}%</span>
        </div>
        {settings.disguise === 'float' && (
          <>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.floatTextColor')}</span>
          <input type="color" value={settings.floatTextColor}
            onChange={e => { persistSettings({ ...settings, floatTextColor: e.target.value }) }} />
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.floatTextFont')}</span>
          {([
            ['"Microsoft YaHei", Arial, sans-serif', t('novel.font.yahei')],
            ['Georgia, "Times New Roman", serif', t('novel.font.serif')],
            ['ui-monospace, "Cascadia Code", Consolas, monospace', t('novel.font.mono')],
          ] as const).map(([font, label]) => (
            <button key={font} type="button"
              className={css.setOpt + (settings.floatTextFont === font ? ' ' + css.setOptOn : '')}
              onClick={() => { persistSettings({ ...settings, floatTextFont: font }) }}>
              {label}
            </button>
          ))}
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.floatFontSize')}</span>
          <input type="range" min={12} max={24} step={1}
            value={settings.floatFontSize}
            onChange={e => { persistSettings({ ...settings, floatFontSize: Number(e.target.value) }) }} />
          <span className={css.dim}>{settings.floatFontSize}px</span>
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.floatBgColor')}</span>
          <input type="color" className={css.colorPick} value={settings.floatBgColor}
            onChange={e => { persistSettings({ ...settings, floatBgColor: e.target.value }) }} />
          <input type="range" className={css.colorAlpha} min={0} max={100} step={5}
            value={Math.round(settings.floatOpacity * 100)}
            onChange={e => { persistSettings({ ...settings, floatOpacity: Number(e.target.value) / 100 }) }} />
          <span className={css.dim}>{Math.round(settings.floatOpacity * 100)}%</span>
        </div>
          </>
        )}
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.autoStealth')}</span>
          <button type="button"
            className={css.setOpt + (settings.autoStealth ? ' ' + css.setOptOn : '')}
            onClick={() => { persistSettings({ ...settings, autoStealth: !settings.autoStealth }) }}>
            {settings.autoStealth ? t('novel.on') : t('novel.off')}
          </button>
          <button type="button" className={css.rbtn}
            onClick={() => { setStealthed(v => !v) }}>
            {t('novel.bossKey')}
          </button>
        </div>
        <div className={css.setSec}>{t('novel.settings.storage')}</div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.dlDir.cur')}</span>
          <code className={css.dlDirPath}>{dlDirCur ?? '—'}</code>
        </div>
        <div className={css.setRow}>
          <span className={css.setLabel}>{t('novel.dlDir')}</span>
          <button type="button" className={css.importBtn} onClick={() => { void pickDlDir() }}>
            {t('novel.dlDir.browse')}
          </button>
          <button type="button" className={css.importBtn} onClick={() => { saveDlDir('') }}>
            {t('novel.dlDir.reset')}
          </button>
          {dlDirMsg !== '' && <span className={css.dlDirMsg}>{dlDirMsg}</span>}
        </div>
      </div>
    </div>
  )

  /* ── 下载管理器（书架网络书 → 本地 TXT） ──
   * 队列串行抓取，逐章更新进度；状态机 queued → downloading → done | error。 */
  const [dlJobs, setDlJobs] = useState<readonly DownloadJob[]>([])
  const [dlPanelOpen, setDlPanelOpen] = useState(false)
  const dlSeq = useRef(0)
  const dlRunning = useRef(false)
  const dlJobsRef = useRef(dlJobs)
  useEffect(() => { dlJobsRef.current = dlJobs }, [dlJobs])

  const patchDlJob = useCallback((id: number, patch: Partial<DownloadJob>): void => {
    setDlJobs(prev => prev.map(j => j.id === id ? ({ ...j, ...patch }) as DownloadJob : j))
  }, [])

  /** 队列泵：一次只处理一个，取首个 queued 串行跑完。 */
  const pumpDownloads = useCallback((): void => {
    if (dlRunning.current) return
    dlRunning.current = true
    void (async (): Promise<void> => {
      try {
        for (;;) {
          const next = dlJobsRef.current.find(j => j.status === 'queued')
          if (next === undefined) break
          patchDlJob(next.id, { status: 'downloading' })
          try {
            const sources = await loadSources()
            const hit = sources.find(s => s.source.name === next.book.sourceName)
            if (hit === undefined) throw new Error(t('novel.net.srcGone'))
            const engine = new BookSourceEngine(hit.source)
            const info = await engine.getBookInfo(next.book.bookUrl ?? '')
            const toc = await engine.getToc(info)
            const chapters = toc.filter(c => !c.isVolume && c.url !== '')
            if (chapters.length === 0) throw new Error(t('novel.net.fail'))
            patchDlJob(next.id, { total: chapters.length })
            const parts: string[] = [next.book.name]
            if (next.book.author !== undefined) parts.push('作者：' + next.book.author)
            parts.push('='.repeat(40)); parts.push('')
            let cur = 0
            for (const ch of chapters) {
              let text = ''
              try { text = await engine.getContent(ch.url) } catch { text = '[本章抓取失败]' }
              parts.push(ch.name); parts.push(''); parts.push(text); parts.push(''); parts.push('-'.repeat(20)); parts.push('')
              cur += 1
              patchDlJob(next.id, { cur })
            }
await novelSave(next.book.name, parts.join('\n'))
            await upsertBook({
              id: 'local:' + next.book.name, name: next.book.name,
              ...(next.book.author !== undefined ? { author: next.book.author } : {}),
              ...(next.book.cover !== undefined ? { cover: next.book.cover } : {}),
              ...(next.book.intro !== undefined ? { intro: next.book.intro } : {}),
              chapterIndex: next.book.chapterIndex,
              offset: next.book.offset,
              ...(next.book.charOffset !== undefined ? { charOffset: next.book.charOffset } : {}),
              ...(next.book.lastChapterName !== undefined ? { lastChapterName: next.book.lastChapterName } : {}),
              ...(next.book.lastReadAt !== undefined ? { lastReadAt: next.book.lastReadAt } : {}),
              addedAt: next.book.addedAt,
            })
            // 下载完成 = 网络书已落地为本地副本：删除原网络书条目，
            // 避免书架重复显示两本、且重启后"下载全书"按钮复活。
            await removeBookMeta(next.book.id)
            patchDlJob(next.id, { status: 'done' })
            setRefreshTick(n => n + 1)
          } catch (err) {
            console.warn('[slacker] download network book failed:', err)
            patchDlJob(next.id, { status: 'error', err: err instanceof Error ? err.message : String(err) })
          }
        }
      } finally {
        dlRunning.current = false
      }
    })()
  }, [t, patchDlJob])

  /** 进队下载：同一本书已有任意任务（排队/下载中/完成/失败）则不入队，
   * 避免重复下载与失败循环；失败重试走 retryDownload。 */
  const enqueueDownload = useCallback((book: ShelfBookMeta): void => {
    if (!isNetworkBook(book) || book.bookUrl === undefined) return
    if (dlJobs.some(j => j.book.id === book.id)) return
    const id = ++dlSeq.current
    setDlJobs(prev => [...prev, {
      id, book, status: 'queued', cur: 0, total: 0, err: undefined,
    } as DownloadJob])
    setDlPanelOpen(true)
  }, [dlJobs])

  /** 失败任务重试 → 重新入队。 */
  const retryDownload = useCallback((id: number): void => {
    patchDlJob(id, { status: 'queued', cur: 0, total: 0 })
  }, [patchDlJob])

  /** 清空已结束（done/error）的任务。 */
  const clearDoneDownloads = useCallback((): void => {
    setDlJobs(prev => prev.filter(j => j.status === 'queued' || j.status === 'downloading'))
  }, [])

  /* 队列泵监听新 queued 任务（dlJobs 变化时若空闲则开跑）。 */
  useEffect(() => {
    if (dlJobs.some(j => j.status === 'queued')) pumpDownloads()
  }, [dlJobs, pumpDownloads])

  /* 下载列表弹窗：队列/进度/完成/失败 + 重试 + 清空。 */
  const downloadsPanel = dlPanelOpen && (
    <div className={css.overlayPanel}>
      <div className={css.panelHead}>
        <b>{t('novel.dl.list')}</b>
        <div className={css.spacer} />
        {dlJobs.some(j => j.status === 'done' || j.status === 'error') && (
          <button type="button" className={css.rbtn} onClick={clearDoneDownloads}>{t('novel.dl.clear')}</button>
        )}
        <button type="button" className={css.rbtn} onClick={() => { setDlPanelOpen(false) }}>✕</button>
      </div>
      <div className={css.dlBody}>
        {dlJobs.length === 0 && <div className={css.empty}>{t('novel.dl.empty')}</div>}
        {dlJobs.map(job => {
          const stateKey = job.status === 'queued' ? 'novel.dl.queued'
            : job.status === 'downloading' ? 'novel.dl.downloading'
            : job.status === 'done' ? 'novel.dl.done'
            : 'novel.dl.error'
          const pct = job.total > 0 ? Math.round((job.cur / job.total) * 100) : 0
          return (
            <div key={job.id} className={css.dlItem}>
              <span className={css.dlName}>{job.book.name}</span>
              <span className={css.dlState + (job.status === 'error' ? ' ' + css.dlStateErr
                : job.status === 'done' ? ' ' + css.dlStateOk : '')}>
                {t(stateKey)}
              </span>
              {job.status === 'downloading' && job.total > 0 && (
                <span className={css.dlBar}><i style={{ width: pct + '%' }} /></span>
              )}
              {job.status === 'downloading' && job.total > 0 && (
                <span className={css.dlPct}>{job.cur}/{job.total}</span>
              )}
              {job.status === 'error' && (
                <>
                  <span className={css.dlErr}>{job.err ?? t('novel.dl.unknown')}</span>
                  <button type="button" className={css.rbtn} onClick={() => { retryDownload(job.id) }}>{t('novel.dl.retry')}</button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  /* 无书态（独立阅读窗开局/等书时）也要能 ESC 关窗：主键盘 effect 在
     reading===null 时不挂监听，曾导致回落页/空窗按 ESC 无反应。 */
  useEffect(() => {
    if (!NOVEL_MODE || reading !== null) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') void novelWindowClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reading])

  /* 键盘（同原作键位）。 */
  useEffect(() => {
    if (reading === null) return
    const onKey = (ev: KeyboardEvent): void => {
      // F5 / Ctrl+R：阻止 WebView2 刷新阅读窗口（浮条被刷新会瞬时退回完整界面）。
      if (ev.key === 'F5' || (ev.ctrlKey && (ev.key === 'r' || ev.key === 'R'))) {
        ev.preventDefault(); ev.stopPropagation()
        return
      }
      // 录制翻页键：捕获当前按键（含修饰符），不执行翻页。
      if (recordingKey !== null) {
        ev.preventDefault(); ev.stopPropagation()
        const mods = [ev.ctrlKey ? 'Ctrl' : '', ev.altKey ? 'Alt' : '', ev.shiftKey ? 'Shift' : ''].filter(Boolean)
        const combo = [...mods, ev.key].join('+')
        persistSettings(recordingKey === 'next'
          ? { ...settings, nextKey: combo }
          : { ...settings, prevKey: combo })
        setRecordingKey(null)
        return
      }
      // 自定义翻页键（非空时覆盖默认）。
      if (settings.nextKey !== '') {
        if (matchesKey(ev, settings.nextKey)) { ev.preventDefault(); nextPage(); return }
      }
      if (settings.prevKey !== '') {
        if (matchesKey(ev, settings.prevKey)) { ev.preventDefault(); prevPage(); return }
      }
      if (catalogOpen || settingsOpen || dlPanelOpen) {
        if (ev.key === 'Escape') { setCatalogOpen(false); closeSettings(); setDlPanelOpen(false) }
        return
      }
      // 翻页：→/↓/Enter/空格 下一页，←/↑ 上一页（空格在伪装态即翻段）。
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        nextPage()
      }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') { ev.preventDefault(); prevPage() }
      else if (ev.key === 'PageDown' || (ev.altKey && ev.key === 'ArrowRight')) {
        ev.preventDefault()
        if (net && netToc !== null) {
          const nn = findNonVolume(netToc, chapterIndex, 1)
          if (nn >= 0) goToChapter(nn)
        } else if (localToc !== null && chapterIndex + 1 < localToc.length) {
          goToChapter(chapterIndex + 1)
        }
      }
      else if (ev.key === 'PageUp' || (ev.altKey && ev.key === 'ArrowLeft')) {
        ev.preventDefault()
        if (net && netToc !== null) {
          const pv = findNonVolume(netToc, chapterIndex, -1)
          if (pv >= 0) goToChapter(pv)
        } else if (chapterIndex > 0) goToChapter(chapterIndex - 1)
      }
      else if (ev.ctrlKey && (ev.key === 't' || ev.key === 'T')) { ev.preventDefault(); setCatalogOpen(true) }
      else if (ev.key === 'Escape') {
        // 阅读弹窗内按老板键逻辑处理：直接关窗；主窗/茶室则回书架。
        if (NOVEL_MODE) void novelWindowClose()
        else setReading(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reading, catalogOpen, settingsOpen, nextPage, prevPage, net, netToc, localToc, chapterIndex, goToChapter, closeSettings, recordingKey, settings, persistSettings])

  useEffect(() => {
    if (catalogOpen) currentChapterRef.current?.scrollIntoView({ block: 'center' })
  }, [catalogOpen])

  /* 全局快捷键 Ctrl+Alt+←/→ 翻页：Rust 捕获后广播事件到这里。 */
  useEffect(() => {
    const w = window as unknown as { __TAURI__?: { event?: { listen?: (evt: string, cb: () => void) => Promise<() => void> } } }
    const on = (evt: string, cb: () => void): (() => void) | undefined => {
      let un: (() => void) | undefined
      void w.__TAURI__?.event?.listen?.(evt, cb).then(fn => { un = fn }).catch(() => {})
      return () => { un?.() }
    }
    const offs: (() => void)[] = []
    const push = (f: (() => void) | undefined): void => { if (f !== undefined) offs.push(f) }
    push(on('slacker:novel-page-next', () => { nextPage() }))
    push(on('slacker:novel-page-prev', () => { prevPage() }))
    return () => { offs.forEach(f => { f() }) }
  }, [nextPage, prevPage])

  /* 导入 TXT（同原作：UTF-8 严格解码失败回退 GBK）。 */
  const onPickFile = useCallback((file: File): void => {
    void file.arrayBuffer().then(buf => {
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) }
      catch { text = new TextDecoder('gbk').decode(buf) }
      const name = file.name.replace(/\.(txt|text)$/i, '')
      void novelSave(name, text).then(() => {
        setRefreshTick(n => n + 1)
        openBookOrShell({ id: 'local:' + name, name, chapterIndex: 0, offset: 1, addedAt: Date.now() })
      })
    })
  }, [openBookOrShell])

  const doRemove = useCallback((book: ShelfBookMeta): void => {
    if (!isNetworkBook(book)) void novelDelete(book.name)
    void removeBookMeta(book.id).then(() => setRefreshTick(n => n + 1))
  }, [])

  /* 目录分组（卷为组头）。 */
  const catalogGroups = useMemo(() => {
    const groups: { volumeIndex: number; volumeName: string; chapters: { index: number; name: string }[] }[] = []
    let cur: { volumeIndex: number; volumeName: string; chapters: { index: number; name: string }[] } | undefined
    tocEntries.forEach((item, index) => {
      if (item.isVolume) {
        cur = { volumeIndex: index, volumeName: item.name, chapters: [] }
        groups.push(cur)
      } else {
        if (cur === undefined) { cur = { volumeIndex: -1, volumeName: '', chapters: [] }; groups.push(cur) }
        cur.chapters.push({ index, name: item.name })
      }
    })
    return groups
  }, [tocEntries])

  const toggleVolume = useCallback((volumeIndex: number): void => {
    setCollapsedVolumes(prev => {
      const next = new Set(prev)
      if (next.has(volumeIndex)) next.delete(volumeIndex)
      else next.add(volumeIndex)
      return next
    })
  }, [])

  /* 书架汇总：本地文件合入书架元数据（未读过的本地书给默认元数据） */
  const shelfBooks: ShelfBookMeta[] = useMemo(() => {
    const locals: ShelfBookMeta[] = localNames.map(name => {
      const hit = books.find(b => b.id === 'local:' + name)
      if (hit !== undefined) return hit
      return { id: 'local:' + name, name, chapterIndex: 0, offset: 1, addedAt: 0 }
    })
    const nets = books.filter(isNetworkBook)
    return [...locals, ...nets].sort((a, b) => {
      const ta = a.lastReadAt ?? 0
      const tb = b.lastReadAt ?? 0
      if (ta !== tb) return tb - ta
      return a.name.localeCompare(b.name)
    })
  }, [localNames, books])

  /** 搜索页「阅读/加书架」回调：入库后直接开读（壳内开独立弹窗，失败回落内嵌）。 */
  const readNetwork = useCallback((book: ShelfBookMeta): void => {
    void upsertBook(book).then(() => {
      setRefreshTick(n => n + 1)
      if (inShell() && !NOVEL_MODE) {
        void novelWindowOpen(book).then(ok => { if (!ok) openBook(book) })
      } else openBook(book)
    })
  }, [openBook])

  /* ═══ 阅读器（本地/网络共用） ═══ */
  if (reading !== null) {
    const chapterName = tocEntries[chapterIndex]?.name ?? ''
    const chapterPos = (chapterIndex + 1) + '/' + tocCount
    return (
      <div className={css.root + (skinOn ? ' ' + css.skinRoot : '') + (effectiveSkin === 'float' ? ' ' + css.skinFloat : '')}
        style={effectiveSkin === 'float' ? { opacity: 1 } : undefined}>
        <div className={css.reader + (skinOn ? ' ' + css.skinOn : '')}
          style={{
            background: disguise?.bg ?? theme.bg,
            color: disguise?.text ?? theme.text,
            ...(disguise?.font !== undefined ? { fontFamily: disguise.font } : {}),
            // 透明度（隐蔽套件）：仅阅读弹窗整体半透明，防窥。浮条皮肤下保持 1（透明由窗口透出实现）。
            opacity: effectiveSkin === 'float' ? 1 : (NOVEL_MODE ? settings.windowOpacity : 1),
          }}>
          {/* 阅读弹窗无系统标题栏：顶栏兼任拖拽区。
          "deep" 使标题/章节名等内层元素也能按拖，交互按钮自动放行。
          悬浮细条皮肤无顶栏（整条即正文）；暗色皮肤无顶栏（整屏即正文）。 */}
          {effectiveSkin !== 'float' && effectiveSkin !== 'dark' && (
          <div className={css.topBar} data-tauri-drag-region={NOVEL_MODE ? 'deep' : undefined}>
            {NOVEL_MODE
              ? (
                <button type="button" className={css.rbtn} title={t('novel.close')}
                  onClick={() => { void novelWindowClose() }}>✕</button>
              )
              : (
                <button type="button" className={css.rbtn}
                  onClick={() => { setReading(null); setRefreshTick(n => n + 1) }}>{t('novel.back')}</button>
              )}
            <span className={css.rtitle}>{reading.name}</span>
            <span className={css.rchap}>{chapterName}{isNet && reading.sourceName !== undefined ? ' · ' + reading.sourceName : ''}</span>
            <span className={css.rbtns}>
              <button type="button" className={css.rbtn} onClick={() => { setCatalogOpen(true) }}>{t('novel.catalog')}</button>
              <button type="button" className={css.rbtn} onClick={() => { setSettingsOpen(true) }}>{t('novel.settings')}</button>
            </span>
          </div>
          )}

          {/* 悬浮细条：双击文字唤醒按钮（设置/关闭），平时整条可拖动、全局键翻页。
              字号/行高/主题跟随「设置」中的值，保证对悬浮框生效。 */}
          {effectiveSkin === 'float' && (
            <div className={css.floatBar}
              data-tauri-drag-region="deep"
              onDoubleClick={() => { setFloatAwake(w => !w) }}
              style={{
                fontFamily: settings.floatTextFont,
                fontSize: settings.floatFontSize,
                lineHeight: settings.lineHeight,
                color: settings.floatTextColor,
                backgroundColor: hexToRgba(settings.floatBgColor, settings.floatOpacity),
              }}>
              <span className={css.floatText}>{floatShown}</span>
              {(floatAwake ? (
                <>
                  <button type="button" className={css.floatBtn}
                    onClick={e => {
                      e.stopPropagation()
                      // 悬浮窗只有 48px 高，先临时展开成完整窗口好放下设置面板。
                      // 不改变 disguise（仍是「悬浮」）；关掉设置后自动缩回浮条。
                      setFloatAwake(false)
                      setFloatExpanded(true)
                      setSettingsOpen(true)
                    }}>{t('novel.settings')}</button>
                  <button type="button" className={css.floatBtn}
                    onClick={e => { e.stopPropagation(); setFloatAwake(false); void novelWindowClose() }}>{t('novel.close')}</button>
                </>
              ) : null)}
              <span className={css.floatMeta}>
                {floatScreenClamped + 1} / {floatTotalScreens}
              </span>
            </div>
          )}

          {/* 暗色皮肤：黑底纯正文，整屏即正文、无任何 chrome、书名零出现。 */}
          {effectiveSkin === 'dark' && (
            <div className={css.darkPage} data-tauri-drag-region={NOVEL_MODE ? 'deep' : undefined}
              style={{ fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight }}>
              {loading ? t('novel.loading') : (net ? netLoading : localChapterLoading) ? t('novel.net.loading') : currentText}
            </div>
          )}

          {/* 正常皮肤：原文 */}
          {effectiveSkin === 'none' && (
            <div className={css.content} style={{ fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight }}>
              {loading ? t('novel.loading') : (net ? netLoading : localChapterLoading) ? t('novel.net.loading') : currentText}
            </div>
          )}

          {effectiveSkin === 'none' ? (
            <div className={css.bottomBar}>
              <button type="button" className={css.rbtn} onClick={prevPage}>{t('novel.prev')}</button>
              <span className={css.pagePos}>
                {page_ > totalPages ? '…' : page_ + ' / ' + totalPages}
                <span className={css.chapTotal}> · {chapterPos}</span>
              </span>
              <button type="button" className={css.rbtn} onClick={nextPage}>{t('novel.next')}</button>
            </div>
          ) : effectiveSkin === 'float' || effectiveSkin === 'dark' ? null : (
            <div className={css.ideStatus} />
          )}

          {catalogOpen && (
            <div className={css.overlayPanel}>
              <div className={css.panelHead}>
                <b>{t('novel.catalog')}</b>
                <span className={css.dim}>{tocCount} {t('novel.chUnit')}</span>
                <button type="button" className={css.rbtn} onClick={() => { setCatalogOpen(false) }}>✕</button>
              </div>
              <div className={css.catalog}>
                {catalogGroups.map(g => {
                  const collapsed = collapsedVolumes.has(g.volumeIndex)
                  const containsCurrent = tocEntries[chapterIndex] !== undefined
                    && (tocEntries[chapterIndex]!.isVolume
                      ? g.volumeIndex === chapterIndex
                      : g.chapters.some(c => c.index === chapterIndex))
                  return (
                    <div key={g.volumeIndex} className={css.volGroup}>
                      {g.volumeName !== '' && (
                        <button type="button" className={css.volHead + (containsCurrent ? ' ' + css.volActive : '')}
                          onClick={() => { toggleVolume(g.volumeIndex) }}>
                          <span className={css.volTri}>{collapsed ? '▶' : '▼'}</span>{g.volumeName}
                        </button>
                      )}
                      {!collapsed && g.chapters.map(c => (
                        <div key={c.index}
                          ref={c.index === chapterIndex ? currentChapterRef : undefined}
                          className={css.catalogItem + (c.index === chapterIndex ? ' ' + css.catalogActive : '')}
                          onClick={() => { goToChapter(c.index) }}>
                          {c.name}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {settingsPanel}
          {downloadsPanel}
        </div>
      </div>
    )
  }

  /* ═══ 三标签首页 ═══ */
  return (
    <div className={css.root}>
      <div className={css.home}>
        <div className={css.homeTabs}>
          {(['shelf', 'search', 'sources'] as const).map(p => (
            <button key={p} type="button"
              className={css.homeTab + (page === p ? ' ' + css.homeTabOn : '')}
              onClick={() => { setPage(p) }}>
              {t(p === 'shelf' ? 'novel.tab.shelf' : p === 'search' ? 'novel.tab.search' : 'novel.tab.sources')}
            </button>
          ))}
          <span className={css.spacer} />
          <button type="button" className={css.gearBtn} title={t('novel.dl.list')}
            onClick={() => { setDlPanelOpen(o => !o) }}>
            ↓<span className={css.dlBadgeWrap}>{dlJobs.length > 0 && <i className={css.dlBadge}>{dlJobs.length}</i>}</span>
          </button>
          <button type="button" className={css.gearBtn} title={t('novel.settings')}
            onClick={() => { setSettingsOpen(true) }}>⚙</button>
        </div>

        {page === 'shelf' && (
          <div className={css.shelf}>
            <div className={css.shelfBar}>
              <b>{t('novel.shelf')}</b>
              <span className={css.dim}>{shelfBooks.length}</span>
              <span className={css.spacer} />
              <input ref={fileRef} type="file" accept=".txt,.text" hidden
                onChange={e => { const f = e.target.files?.[0]; if (f !== undefined) onPickFile(f); e.target.value = '' }} />
              <button type="button" className={css.importBtn} onClick={() => { fileRef.current?.click() }}>
                {t('novel.import')}
              </button>
            </div>
            {shelfBooks.length === 0 && <div className={css.empty}>{t('novel.empty')}</div>}
            {shelfBooks.map(book => {
              const hue = hueOf(book.name)
              const meta = book.lastChapterName ?? t('novel.notStarted')
              const sub = book.author !== undefined
                ? book.author + ' · ' + (isNetworkBook(book) ? (book.sourceName ?? '') : 'TXT')
                : (isNetworkBook(book) ? (book.sourceName ?? '') : 'TXT')
              return (
                <div key={book.id} className={css.book} onClick={() => {
                  openBookOrShell(book)
                }}>
                  <span className={css.cover}
                    style={{ background: `linear-gradient(155deg, hsl(${hue},42%,52%), hsl(${(hue + 26) % 360},48%,30%))` }}
                    aria-hidden="true" />
                  <span className={css.bookInfo}>
                    <b>{book.name}</b>
                    <span className={css.bookMeta}>
                      <span className={css.bookType + (isNetworkBook(book) ? ' ' + css.bookTypeNet : ' ' + css.bookTypeLocal)}>
                        {isNetworkBook(book) ? t('novel.badge.net') : t('novel.badge.local')}
                      </span>
                      {sub}
                    </span>
                    <span className={css.bookMeta}>{meta}{book.lastReadAt !== undefined ? ' · ' + relTime(book.lastReadAt, t) : ''}</span>
                  </span>
                  {isNetworkBook(book) && (() => {
                    const job = dlJobs.find(j => j.book.id === book.id)
                    const busy = job !== undefined && (job.status === 'queued' || job.status === 'downloading')
                    const done = job !== undefined && job.status === 'done'
                    const failed = job !== undefined && job.status === 'error'
                    return (
                      <button type="button"
                        className={css.dlShelf + ((busy || done) ? ' ' + css.srcStateOff : '')}
                        title={done ? t('novel.search.saved')
                          : failed ? t('novel.search.retry')
                          : busy ? t('novel.search.downloading')
                          : t('novel.search.download')}
                        disabled={busy || done}
                        onClick={e => {
                          e.stopPropagation()
                          if (failed) retryDownload(job.id)
                          else enqueueDownload(book)
                        }}>
                        {busy ? t('novel.search.downloading')
                          : done ? t('novel.search.saved')
                          : failed ? t('novel.search.retry')
                          : t('novel.search.download')}
                      </button>
                    )
                  })()}
                  <button type="button" className={css.del} title={t('novel.delete')}
                    onClick={e => { e.stopPropagation(); doRemove(book) }}>✕</button>
                </div>
              )
            })}
          </div>
        )}

        {page === 'search' && (
          <SourceSearch key={'search-' + refreshTick} t={t} onRead={readNetwork}
            shelfIds={new Set(books.map(b => b.id))} books={books}
            onChanged={reloadShelf} onGoSources={() => { setPage('sources') }} />
        )}
        {page === 'sources' && <SourceManager t={t} onChanged={() => { setRefreshTick(n => n + 1) }} />}
      </div>
      {settingsPanel}
      {downloadsPanel}
    </div>
  )
}
