/**
 * 网络小说浏览器 —— 完整复刻主应用 NetworkNovel 的浏览体验：
 *
 * browse：书源下拉（切源重置）→ 搜索（单源 / 多源按源评分分批并发，动态调分，
 *         结果按 name::author 去重并按源分数排序）→ 分类浏览（explore）→ 最近阅读
 * detail：封面/书名/作者/简介/章数 + 章节目录树（卷可折叠）+ 恢复上次进度
 *         阅读进入插件自带阅读器（按章分页、进度落 books kv）；「下载全书」抓全章拼
 *         TXT 入库（本地书架）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BookSourceEngine } from './source/engine.ts'
import type { BookInfo, ExploreCategory, SearchResultItem, TocItem } from './source/types.ts'
import {
  DEFAULT_SOURCE_SCORE, isNetworkBook, loadSources, setSourceScore as persistSourceScore,
  type ShelfBookMeta, type StoredSource, upsertBook, removeBook as removeBookMeta,
} from './source/store.ts'
import { novelSave } from '../ipc.ts'
import css from './NovelView.module.css'

/** 展示结果（带来源书源名）。 */
interface Row extends SearchResultItem { sourceName: string }

const emsg = (e: unknown): string => e instanceof Error ? e.message : String(e)

function hueOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

function findNonVolume(toc: readonly TocItem[], from: number, dir: 1 | -1): number {
  let i = from
  while (i >= 0 && i < toc.length) {
    if (!toc[i].isVolume) return i
    i += dir
  }
  return -1
}

/** 相对时间短文案（「刚刚 / n 分钟前 / n 小时前 / n 天前」）。 */
function relShort(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + '分钟前'
  if (s < 86400) return Math.floor(s / 3600) + '小时前'
  return Math.floor(s / 86400) + '天前'
}

/** Full props. */
export type SourceSearchProps = PropsLocale<'novel'> & {
  onRead: (book: ShelfBookMeta) => void
  shelfIds: ReadonlySet<string>
  /** 书架全量（派生「最近阅读」，源名+bookUrl 即网络书 id） */
  books: readonly ShelfBookMeta[]
  /** 下载入库等活动后通知上层刷书架 */
  onChanged: () => void
  /** 跳转「书源」页（添加/导入/删除） */
  onGoSources: () => void
}

/** Render the network-novel browser (browse/search/detail/download). */
export function SourceSearch(props: SourceSearchProps): JSX.Element {
  const { t, onRead, shelfIds, books, onChanged, onGoSources } = props

  const [sources, setSources] = useState<readonly StoredSource[]>([])
  const [sourceName, setSourceName] = useState('')
  const [view, setView] = useState<'browse' | 'detail'>('browse')

  // ── 搜索 ──
  const [keyword, setKeyword] = useState('')
  const [multi, setMulti] = useState(true)
  const [rows, setRows] = useState<readonly Row[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)

  // ── 分类 ──
  const [categories, setCategories] = useState<readonly ExploreCategory[]>([])
  const [activeCat, setActiveCat] = useState<ExploreCategory | null>(null)
  const [catBooks, setCatBooks] = useState<readonly Row[] | null>(null)
  const [loadingCats, setLoadingCats] = useState(false)
  const [loadingCatBooks, setLoadingCatBooks] = useState(false)
  const [catErr, setCatErr] = useState('')

  // ── 详情 ──
  const [bookInfo, setBookInfo] = useState<BookInfo | null>(null)
  const [toc, setToc] = useState<readonly TocItem[]>([])
  const [loadingBook, setLoadingBook] = useState(false)
  const [bookErr, setBookErr] = useState('')
  const [detailSourceName, setDetailSourceName] = useState('')
  const [chapterIdx, setChapterIdx] = useState(0)
  const [collapsedVols, setCollapsedVols] = useState<ReadonlySet<number>>(new Set())

  // ── 下载 ──
  const [downloading, setDownloading] = useState(false)
  const [dlProgress, setDlProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [dlMsg, setDlMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const srcInit = useRef(false)

  const enabledSources = useMemo(() => sources.filter(s => s.enabled), [sources])
  const source = useMemo(
    () => enabledSources.find(s => s.source.name === sourceName),
    [enabledSources, sourceName],
  )
  const srcName = source?.source.name ?? ''
  const browseEngine = useMemo(
    () => (source !== undefined ? new BookSourceEngine(source.source) : null),
    [source],
  )
  const detailEngine = useMemo(() => {
    const hit = enabledSources.find(s => s.source.name === detailSourceName) ?? source
    return hit !== undefined ? new BookSourceEngine(hit.source) : null
  }, [enabledSources, detailSourceName, source])

  /** 最近阅读：书架里读过的网络书，MRU 排序。 */
  const recents = useMemo(() => books
    .filter(b => isNetworkBook(b) && b.lastReadAt !== undefined)
    .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))
    .slice(0, 8), [books])

  /* 初始：载入书源并选第一个启用源。 */
  useEffect(() => {
    void loadSources().then(list => {
      setSources(list)
      if (!srcInit.current) {
        const e = list.filter(s => s.enabled)
        if (e.length > 0) setSourceName(e[0].source.name)
        srcInit.current = true
      }
    })
  }, [])

  /* 切源：重置浏览态 + 加载分类入口。依赖字符串源名而非引擎对象——
     搜索中的动态评分会重建书源对象，若依赖对象则会把刚搜出的结果清掉。 */
  useEffect(() => {
    setKeyword(''); setRows(null); setSearchErr(''); setCatBooks(null); setCatErr('')
    setBookInfo(null); setToc([]); setView('browse')
    setCategories([]); setActiveCat(null); setDlMsg(null)
    if (!browseEngine || source?.source.explore === undefined) return
    setLoadingCats(true)
    void browseEngine.listExploreEntries()
      .then(list => { setCategories(list); if (list.length > 0) setActiveCat(list[0]) })
      .catch(e => setCatErr(emsg(e)))
      .finally(() => setLoadingCats(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcName])

  /* 切分类：加载该分类第 1 页。 */
  useEffect(() => {
    if (!browseEngine || activeCat === null) return
    setLoadingCatBooks(true); setCatErr('')
    void browseEngine.explorePage(activeCat, 1)
      .then(list => setCatBooks(list.map(it => ({ ...it, sourceName: srcName }))))
      .catch(e => setCatErr(emsg(e)))
      .finally(() => setLoadingCatBooks(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcName, activeCat])

  /** 评分动态调整（本地乐观更新 + 异步落盘）。 */
  const bump = useCallback((name: string, delta: number): void => {
    setSources(prev => prev.map(s => {
      if (s.source.name !== name) return s
      const score = Math.max(0, Math.min(100, (s.score ?? DEFAULT_SOURCE_SCORE) + delta))
      return { ...s, score, lastCheckedAt: Date.now() }
    }))
    void persistSourceScore(name, (prev) => (prev ?? DEFAULT_SOURCE_SCORE) + delta)
  }, [])

  /** 单源 / 多源分批并发搜索，动态调分，去重排序。 */
  const doSearch = useCallback(async (): Promise<void> => {
    const kw = keyword.trim()
    if (kw === '') return
    setSearching(true); setSearchErr(''); setRows(null); setProgress(null)

    // 单源（或只有一个启用源）
    if (!multi || enabledSources.length <= 1) {
      if (!browseEngine || !source) { setSearching(false); return }
      try {
        const list = await browseEngine.search(kw, 1)
        setRows(list.map(it => ({ ...it, sourceName: source.source.name })))
        if (list.length === 0) setSearchErr(t('novel.search.empty'))
      } catch (e) { setSearchErr(emsg(e)) }
      setSearching(false)
      return
    }

    const getScore = (s: StoredSource): number => s.score ?? DEFAULT_SOURCE_SCORE
    const sorted = [...enabledSources].sort((a, b) => getScore(b) - getScore(a))
    const batches: StoredSource[][] = [
      sorted.filter(s => getScore(s) >= 60),
      sorted.filter(s => { const sc = getScore(s); return sc >= 30 && sc < 60 }),
      sorted.filter(s => getScore(s) < 30),
    ].filter(b => b.length > 0)

    const all: Row[] = []
    let done = 0
    let firstErr: string | null = null

    for (let bi = 0; bi < batches.length; bi++) {
      const label = bi === 0 ? '高' : bi === 1 ? '中' : '低'
      setProgress({ done, total: sorted.length, label })
      await Promise.allSettled(batches[bi].map(async s => {
        try {
          const eng = new BookSourceEngine(s.source)
          const items = await eng.search(kw, 1)
          for (const it of items) all.push({ ...it, sourceName: s.source.name })
          bump(s.source.name, items.length > 0 ? 3 : -1)
        } catch (e) {
          firstErr ??= emsg(e)
          bump(s.source.name, -8)
        } finally {
          done++
          setProgress({ done, total: sorted.length, label })
        }
      }))
      if (all.length >= 5 && bi < batches.length - 1) break
    }

    const dedup = new Map<string, Row>()
    for (const r of all) {
      const k = r.name + '::' + (r.author ?? '')
      if (!dedup.has(k)) dedup.set(k, r)
    }
    const finalRows = Array.from(dedup.values()).sort((a, b) => {
      const sa = enabledSources.find(s => s.source.name === a.sourceName)?.score ?? DEFAULT_SOURCE_SCORE
      const sb = enabledSources.find(s => s.source.name === b.sourceName)?.score ?? DEFAULT_SOURCE_SCORE
      return sb - sa
    })
    setRows(finalRows)
    if (finalRows.length === 0) {
      setSearchErr(firstErr !== null ? '所有书源均未搜到：' + firstErr : t('novel.search.empty'))
    }
    setProgress(null)
    setSearching(false)
  }, [keyword, multi, enabledSources, browseEngine, source, t, bump])

  /** 打开详情（bookUrl 可来自任意来源书源）。 */
  const openBook = useCallback(async (bookUrl: string, srcNameOpt?: string): Promise<void> => {
    const src = srcNameOpt !== undefined
      ? enabledSources.find(s => s.source.name === srcNameOpt)
      : source
    if (src === undefined) return
    setDetailSourceName(src.source.name)
    setView('detail')
    setLoadingBook(true); setBookErr(''); setBookInfo(null); setToc([]); setDlMsg(null)
    try {
      const eng = new BookSourceEngine(src.source)
      const info = await eng.getBookInfo(bookUrl)
      const tocList = await eng.getToc(info)
      setBookInfo(info)
      setToc(tocList)
      const prev = books.find(b => b.id === src.source.name + '::' + bookUrl)
      let ci = prev?.chapterIndex ?? 0
      if (tocList[ci]?.isVolume === true) {
        const nn = findNonVolume(tocList, ci, 1)
        if (nn >= 0) ci = nn
      }
      setChapterIdx(ci)
    } catch (e) { setBookErr(emsg(e)) }
    finally { setLoadingBook(false) }
  }, [enabledSources, source, books])

  /** 搜索结果里直接读（不先进详情）。 */
  const quickRead = useCallback((row: Row): void => {
    const id = row.sourceName + '::' + row.bookUrl
    const prev = books.find(b => b.id === id)
    onRead({
      id,
      name: row.name,
      ...(row.author !== undefined ? { author: row.author } : {}),
      ...(row.intro !== undefined ? { intro: row.intro } : {}),
      ...(row.cover !== undefined ? { cover: row.cover } : {}),
      sourceName: row.sourceName,
      bookUrl: row.bookUrl,
      chapterIndex: prev?.chapterIndex ?? 0,
      offset: 1,
      addedAt: prev?.addedAt ?? Date.now(),
    })
  }, [books, onRead])

  /** 加入书架（仅收藏，不下载不打开）。已入架的静默跳过。 */
  const addToShelf = useCallback((row: Row): void => {
    const id = row.sourceName + '::' + row.bookUrl
    if (shelfIds.has(id)) return
    void upsertBook({
      id,
      name: row.name,
      ...(row.author !== undefined ? { author: row.author } : {}),
      ...(row.intro !== undefined ? { intro: row.intro } : {}),
      ...(row.cover !== undefined ? { cover: row.cover } : {}),
      sourceName: row.sourceName,
      bookUrl: row.bookUrl,
      chapterIndex: 0,
      offset: 1,
      addedAt: Date.now(),
    }).then(onChanged)
  }, [shelfIds, onChanged])

  /** 详情页进入阅读（从目录选章）。 */
  const readBook = useCallback((idx: number): void => {
    if (bookInfo === null) return
    const bookUrl = bookInfo.sourceUrl ?? ''
    onRead({
      id: detailSourceName + '::' + bookUrl,
      name: bookInfo.name,
      ...(bookInfo.author !== undefined ? { author: bookInfo.author } : {}),
      ...(bookInfo.cover !== undefined ? { cover: bookInfo.cover } : {}),
      ...(bookInfo.intro !== undefined ? { intro: bookInfo.intro } : {}),
      sourceName: detailSourceName,
      ...(bookUrl !== '' ? { bookUrl } : {}),
      chapterIndex: idx,
      offset: 1,
      addedAt: Date.now(),
    })
  }, [bookInfo, detailSourceName, onRead])

  /** 下载全书：逐章抓正文拼接 TXT，落本地书架。 */
  const handleDownload = useCallback(async (): Promise<void> => {
    if (detailEngine === null || bookInfo === null || toc.length === 0) return
    const chapters = toc.filter(c => !c.isVolume && c.url !== '')
    setDownloading(true); setDlProgress({ done: 0, total: chapters.length, current: '' }); setDlMsg(null)
    try {
      const parts: string[] = [bookInfo.name]
      if (bookInfo.author !== undefined) parts.push('作者：' + bookInfo.author)
      parts.push('='.repeat(40)); parts.push('')
      let done = 0
      for (const ch of chapters) {
        setDlProgress({ done, total: chapters.length, current: ch.name })
        let text = ''
        try { text = await detailEngine.getContent(ch.url) } catch { text = '[本章抓取失败]' }
        parts.push(ch.name); parts.push(''); parts.push(text); parts.push(''); parts.push('-'.repeat(20)); parts.push('')
        done++
        setDlProgress({ done, total: chapters.length, current: ch.name })
      }
      const text = parts.join('\n')
      await novelSave(bookInfo.name, text)
      const netBookId = detailSourceName + '::' + (bookInfo.sourceUrl ?? '')
      const netBook = books.find(b => b.id === netBookId)
      await upsertBook({
        id: 'local:' + bookInfo.name,
        name: bookInfo.name,
        ...(bookInfo.author !== undefined ? { author: bookInfo.author } : {}),
        ...(bookInfo.cover !== undefined ? { cover: bookInfo.cover } : {}),
        ...(bookInfo.intro !== undefined ? { intro: bookInfo.intro } : {}),
        chapterIndex: netBook?.chapterIndex ?? 0,
        offset: netBook?.offset ?? 1,
        ...(netBook?.charOffset !== undefined ? { charOffset: netBook.charOffset } : {}),
        ...(netBook?.lastChapterName !== undefined ? { lastChapterName: netBook.lastChapterName } : {}),
        ...(netBook?.lastReadAt !== undefined ? { lastReadAt: netBook.lastReadAt } : {}),
        addedAt: netBook?.addedAt ?? Date.now(),
      })
      if (netBook !== undefined) await removeBookMeta(netBookId)
      onChanged()
      setDlMsg({ ok: true, text: t('novel.search.saved') })
    } catch (e) { setDlMsg({ ok: false, text: emsg(e) }) }
    finally { setDownloading(false); setDlProgress(null) }
  }, [detailEngine, bookInfo, toc, t, onChanged])

  const toggleVol = useCallback((index: number): void => {
    setCollapsedVols(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  /* ════ 渲染 ════ */

  const totalTxt = t('novel.search.total').replace('{n}', String(toc.filter(c => !c.isVolume).length))

  return (
    <div className={css.searchWrap}>
      <div className={css.toolbar}>
        {view === 'detail' && (
          <button type="button" className={css.sourceBtn} onClick={() => { setView('browse') }}>
            {t('novel.search.back')}
          </button>
        )}
        {view === 'browse' && enabledSources.length > 1 && (
          <select className={css.selectSrc} value={sourceName}
            onChange={e => { setSourceName(e.target.value) }}>
            {enabledSources.map(s => <option key={s.source.name} value={s.source.name}>{s.source.name}</option>)}
          </select>
        )}
        <span className={css.spacer} />
        <button type="button" className={css.sourceBtn} title={t('novel.search.manage')} onClick={onGoSources}>
          {t('novel.tab.sources')}
        </button>
      </div>

      {enabledSources.length === 0 ? (
        <div className={css.empty}>
          {t('novel.search.nosrc')}
          <button type="button" className={css.importBtn} onClick={onGoSources}>
            {t('novel.tab.sources')}
          </button>
        </div>
      ) : view === 'browse' ? (
        <div className={css.browseWrap}>
          <div className={css.browseSide}>
            <div className={css.sideSearch}>
              <div className={css.searchRow}>
                <input className={css.searchInput} value={keyword} placeholder={t('novel.search.placeholder')}
                  onChange={e => { setKeyword(e.target.value) }}
                  onKeyDown={e => { if (e.key === 'Enter') void doSearch() }} />
                <button type="button" className={css.searchGo} disabled={searching} onClick={() => { void doSearch() }}>
                  {searching ? t('novel.search.searching') : t('novel.search.btn')}
                </button>
              </div>
              <label className={css.multiLabel}>
                <input type="checkbox" checked={multi} onChange={e => { setMulti(e.target.checked) }} />
                {t('novel.search.multi')}（{enabledSources.length}）
              </label>
              {searching && progress !== null && (
                <span className={css.progressText}>
                  {progress.label !== '' ? t('novel.search.searching') + '·' + progress.label + '·' : ''}{progress.done}/{progress.total}
                </span>
              )}
            </div>

            <div className={css.catArea}>
              <div className={css.catTitle}>{t('novel.search.category')}</div>
              {loadingCats ? (
                <div className={css.catEmpty}>{t('novel.loading')}</div>
              ) : catErr !== '' ? (
                <div className={css.catEmpty}>{catErr}</div>
              ) : categories.length === 0 ? (
                <div className={css.catEmpty}>{t('novel.search.noCat')}</div>
              ) : (
                categories.map(c => (
                  <button key={c.title} type="button"
                    className={css.catItem + (activeCat?.title === c.title ? ' ' + css.catActive : '')}
                    onClick={() => { setActiveCat(c) }}>
                    {c.title}
                  </button>
                ))
              )}
            </div>

            {recents.length > 0 && (
              <div className={css.sideBlock}>
                <div className={css.sideBlockTitle}>{t('novel.search.recent')}</div>
                {recents.map(r => (
                  <button key={r.id} type="button" className={css.recentItem}
                    title={r.name + ' · ' + (r.lastChapterName ?? r.sourceName ?? '')}
                    onClick={() => {
                      if (r.sourceName !== undefined && r.bookUrl !== undefined) {
                        void openBook(r.bookUrl, r.sourceName)
                      }
                    }}>
                    <span className={css.recentName}>{r.name}</span>
                    <span className={css.recentSub}>
                      {r.sourceName}{r.lastReadAt !== undefined ? ' · ' + relShort(r.lastReadAt) : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={css.browseMain}>
            {rows !== null ? (
              <>
                <div className={css.areaHead}>
                  {t('novel.search.btn')}「{keyword}」· {rows.length}
                </div>
                {rows.length === 0 && <div className={css.empty}>{searchErr}</div>}
                <BookGrid rows={rows} shelfIds={shelfIds} onOpen={openBook} onQuickRead={quickRead} onAdd={addToShelf} t={t} />
              </>
            ) : loadingCatBooks ? (
              <div className={css.empty}>{t('novel.loading')}</div>
            ) : catErr !== '' ? (
              <div className={css.empty}>{catErr}</div>
            ) : activeCat !== null ? (
              <>
                <div className={css.areaHead}>
                  {activeCat.title} · {(catBooks ?? []).length}
                </div>
                {catBooks !== null && (
                  <BookGrid rows={catBooks} shelfIds={shelfIds} onOpen={openBook} onQuickRead={quickRead} onAdd={addToShelf} t={t} />
                )}
              </>
            ) : (
              <div className={css.empty}>{t('novel.search.recentEmpty')}</div>
            )}
          </div>
        </div>
      ) : (
        <div className={css.detailWrap}>
          <div className={css.detailPanel}>
            {loadingBook ? (
              <div className={css.empty}>{t('novel.loading')}</div>
            ) : bookErr !== '' ? (
              <div className={css.empty}>{bookErr}</div>
            ) : bookInfo !== null ? (
              <>
                <div className={css.detailCover}
                  style={{ background: `linear-gradient(155deg, hsl(${hueOf(bookInfo.name)},42%,52%), hsl(${(hueOf(bookInfo.name) + 26) % 360},48%,30%))` }}>
                  {bookInfo.cover !== undefined && bookInfo.cover !== '' ? (
                    <img className={css.cardImg} src={bookInfo.cover} alt="" loading="lazy"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  ) : bookInfo.name.charAt(0)}
                </div>
                <div className={css.detailName}>{bookInfo.name}</div>
                {bookInfo.author !== undefined && <div className={css.detailAuth}>{bookInfo.author}</div>}
                <div className={css.detailChaps}>{totalTxt}</div>
                {bookInfo.intro !== undefined && bookInfo.intro !== '' && (
                  <div className={css.detailIntro}>{bookInfo.intro}</div>
                )}
                <button type="button" className={css.dlBtn} disabled={downloading || toc.length === 0} onClick={() => { void handleDownload() }}>
                  {downloading ? t('novel.search.downloading') : t('novel.search.download')}
                </button>
                <div className={css.detailBtns}>
                  {shelfIds.has(detailSourceName + '::' + (bookInfo.sourceUrl ?? '')) ? (
                    <span className={css.addedTagDetail}>{t('novel.search.added')}</span>
                  ) : (
                    <button type="button" className={css.dlBtnSmall}
                      onClick={() => {
                        void upsertBook({
                          id: detailSourceName + '::' + (bookInfo.sourceUrl ?? ''),
                          name: bookInfo.name,
                          ...(bookInfo.author !== undefined ? { author: bookInfo.author } : {}),
                          ...(bookInfo.cover !== undefined ? { cover: bookInfo.cover } : {}),
                          ...(bookInfo.intro !== undefined ? { intro: bookInfo.intro } : {}),
                          sourceName: detailSourceName,
                          ...(bookInfo.sourceUrl !== undefined && bookInfo.sourceUrl !== '' ? { bookUrl: bookInfo.sourceUrl } : {}),
                          chapterIndex: 0,
                          offset: 1,
                          addedAt: Date.now(),
                        }).then(onChanged)
                      }}>
                      {t('novel.search.add2shelf')}
                    </button>
                  )}
                </div>
                {dlProgress !== null && (
                  <div>
                    <div className={css.dlProgress}>
                      <span className="truncate">{dlProgress.current}</span>
                      <span>{dlProgress.done}/{dlProgress.total}</span>
                    </div>
                    <div className={css.dlBarOut}>
                      <div className={css.dlBarIn}
                        style={{ width: `${dlProgress.total > 0 ? (dlProgress.done / dlProgress.total) * 100 : 0}%` }} />
                    </div>
                  </div>
                )}
                {dlMsg !== null && (
                  <div className={css.dlMsg + ' ' + (dlMsg.ok ? css.dlMsgOk : css.dlMsgErr)}>{dlMsg.text}</div>
                )}
              </>
            ) : null}
          </div>

          <div className={css.tocArea}>
            <div className={css.tocHeader}>{t('novel.catalog')}</div>
            <div className={css.tocScroll}>
              {loadingBook ? (
                <div className={css.tocEmpty}>{t('novel.loading')}</div>
              ) : bookErr !== '' ? (
                <div className={css.tocEmpty}>{bookErr}</div>
              ) : toc.length === 0 ? (
                <div className={css.tocEmpty}>{t('novel.empty')}</div>
              ) : (
                ((): JSX.Element[] => {
                  const groups: { type: 'vol' | 'ch'; index: number; children?: { index: number }[] }[] = []
                  let i = 0
                  while (i < toc.length) {
                    if (toc[i].isVolume === true) {
                      const children: { index: number }[] = []
                      let j = i + 1
                      while (j < toc.length && toc[j].isVolume !== true) { children.push({ index: j }); j++ }
                      groups.push({ type: 'vol', index: i, children })
                      i = j
                    } else {
                      groups.push({ type: 'ch', index: i })
                      i++
                    }
                  }
                  return groups.map(g => {
                    if (g.type === 'vol') {
                      const folded = collapsedVols.has(g.index)
                      return (
                        <div key={g.index} className={css.tocGroup}>
                          <button type="button" className={css.tocVol} onClick={() => { toggleVol(g.index) }}>
                            <span className={css.volTri}>{folded ? '▸' : '▾'}</span>
                            <span className="truncate">{toc[g.index].name}</span>
                          </button>
                          {!folded && g.children !== undefined && g.children.length > 0 && (
                            <div className={css.tocChildren}>
                              {g.children.map(c => (
                                <TocRow key={c.index} active={c.index === chapterIdx}
                                  name={toc[c.index].name}
                                  onClick={() => readBook(c.index)} />
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    }
                    return <TocRow key={g.index} active={g.index === chapterIdx}
                      name={toc[g.index].name} onClick={() => readBook(g.index)} />
                  })
                })()
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TocRow({ active, name, onClick }: { active: boolean; name: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={css.tocItem + (active ? ' ' + css.tocActive : '')} onClick={onClick} title={name}>
      <span className="truncate">{name}</span>
    </button>
  )
}

/** 书籍网格卡片（封面/书名/作者/源名 + 阅读 / 加书架 / 已入架标签）。 */
function BookGrid({ rows, shelfIds, onOpen, onQuickRead, onAdd, t }: {
  rows: readonly Row[]
  shelfIds: ReadonlySet<string>
  onOpen: (url: string, src: string) => void
  onQuickRead: (row: Row) => void
  onAdd: (row: Row) => void
  t: SourceSearchProps['t']
}): JSX.Element {
  return (
    <div className={css.cardGrid}>
      {rows.map((b, i) => {
        const hue = hueOf(b.name)
        const onShelf = shelfIds.has(b.sourceName + '::' + b.bookUrl)
        return (
          <div key={i} className={css.card}>
            <div className={css.cardCoverWrap}>
              <button type="button" className={css.cardCover}
                onClick={() => { onOpen(b.bookUrl, b.sourceName) }}
                style={{ background: `linear-gradient(155deg, hsl(${hue},42%,52%), hsl(${(hue + 26) % 360},48%,30%))` }}>
                {b.cover !== undefined && b.cover !== '' ? (
                  <img className={css.cardImg} src={b.cover} alt="" loading="lazy"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                ) : b.name.charAt(0)}
              </button>
              {b.sourceName !== undefined && <span className={css.cardSrc}>{b.sourceName}</span>}
            </div>
            <div className={css.cardName} title={b.name}>{b.name}</div>
            <div className={css.cardMeta}>{b.author ?? ''}</div>
            <div className={css.resultBtns}>
              <button type="button" className={css.rbtn2} onClick={() => { onQuickRead(b) }}>{t('novel.search.read')}</button>
              {onShelf ? (
                <span className={css.addedTag}>{t('novel.search.added')}</span>
              ) : (
                <button type="button" className={css.rbtn2} onClick={() => { onAdd(b) }}>{t('novel.search.add2shelf')}</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}