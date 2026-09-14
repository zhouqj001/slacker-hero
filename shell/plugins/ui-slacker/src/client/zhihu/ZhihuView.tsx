/**
 * 知乎摸鱼：推荐流卡片 + Cookie 登录 + 四层去重 + 就地展开读正文。
 * 数据全部经壳的 Rust 代理（zhihuFeed/zhihuContent/zhihuReportRead/zhihuMe，
 * Cookie 与浏览器头在 Rust 侧注入）；纯浏览器内不可用（显示引导）。
 *
 * 业务逻辑（照 weread-vscode TouchPlus 的知乎模块）：
 *  - 翻页三参数（session_token/page_number/end_offset）从 paging.next 解析，
 *    解析失败本地兜底（page_number+1、end_offset+=本页条数）；
 *  - 四层去重：session_token 轮替（重置即换流）+ 已读上报（连续 3 次失败
 *    熔断）+ 会话内 seenFeedIds + 持久化 seenTargetKeys（LRU 5000 FIFO）；
 *  - 正文 HTML 清洗成纯文本，按 400 字分段，「展开全文」逐段追加；
 *  - 图片默认关闭（摸鱼特性，关闭时不发任何图片请求）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  isZhihuAuthError, kvGet, kvSet, zhihuContent, zhihuFeed, zhihuMe, zhihuReportRead,
} from '../ipc.ts'
import type { SlackerKey } from '../locales.ts'
import css from './ZhihuView.module.css'

/** kv key：Cookie / 图片开关 / 已读去重历史。 */
const COOKIE_KEY = 'zhihu.cookie'
const IMAGES_KEY = 'zhihu.images'
const SEEN_KEY = 'zhihu.seenTargets'

/** 已读历史上限（FIFO 裁剪，防 kv 无限膨胀）。 */
const SEEN_MAX = 5000

/** 正文分段大小（字符）。 */
const CHUNK_SIZE = 400

/** 已读上报连续失败熔断阈值。 */
const REPORT_BREAKER = 3

/** 一屏新卡的最少条数：过滤后攒够即停（避免连环翻页）。 */
const BATCH_MIN = 5

/** 翻页游标：三参数一起走。 */
interface PageCursor {
  pageNumber: number
  endOffset: number
  sessionToken: string | null
}

/** 归一化后的卡片。 */
interface ZhihuCard {
  feedId: string
  kind: 'answer' | 'article' | 'pin'
  targetId: string
  title: string
  excerpt: string
  author: string
  meta: string
  attachedInfo?: string
}

/** 详情视图状态。 */
interface DetailState {
  card: ZhihuCard
  byline: string
  chunks: string[]
  shown: number
  loading: boolean
  error: string | null
}

/** 数字缩写（知乎风格）：12345 → 1.2w。 */
function abbrev(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v >= 10000) {
    const w = v / 10000
    return (w >= 10 ? String(Math.round(w)) : String(Math.round(w * 10) / 10)) + 'w'
  }
  return String(Math.round(v))
}

/** 把一条 feed item 归一化成卡片；无关类型（视频/直播/…）返回 null。 */
function toCard(item: Record<string, unknown>): ZhihuCard | null {
  const feedId = String(item.id ?? '')
  const target = (item.target ?? {}) as Record<string, unknown>
  const type = String(target.type ?? '')
  const targetId = String(target.id ?? '')
  if (feedId === '' || targetId === '') return null
  const author = String((target.author as Record<string, unknown> | undefined)?.name ?? '')
  const votes = abbrev(target.voteup_count)
  let kind: ZhihuCard['kind']
  let title = ''
  let excerpt = ''
  let meta = ''
  if (type === 'answer') {
    kind = 'answer'
    const q = (target.question ?? {}) as Record<string, unknown>
    title = String(q.title ?? '')
    excerpt = String(target.excerpt ?? '')
    meta = votes === '' ? '回答' : `回答 · ${votes} 赞同`
  } else if (type === 'article') {
    kind = 'article'
    title = String(target.title ?? '')
    excerpt = String(target.excerpt ?? '')
    meta = votes === '' ? '文章' : `文章 · ${votes} 赞同`
  } else if (type === 'pin') {
    kind = 'pin'
    title = ''
    excerpt = String(target.excerpt_title ?? '').slice(0, 60)
    meta = '想法'
  } else {
    return null // 视频/直播/会员内容等：摸鱼场景直接过滤
  }
  const attachedInfo = typeof item.attached_info === 'string' && item.attached_info !== ''
    ? item.attached_info
    : undefined
  return { feedId, kind, targetId, title, excerpt, author, meta, attachedInfo }
}

/** 从 paging.next 解析下一页游标；缺参时保持本地兜底。 */
function nextCursor(st: PageCursor, paging: Record<string, unknown>, count: number): PageCursor {
  const next: PageCursor = {
    pageNumber: st.pageNumber + 1,
    endOffset: st.endOffset + count,
    sessionToken: st.sessionToken,
  }
  const url = typeof paging.next === 'string' ? paging.next : ''
  if (url === '') return next
  try {
    const u = new URL(url)
    const token = u.searchParams.get('session_token')
    const pn = u.searchParams.get('page_number')
    const eo = u.searchParams.get('end_offset')
    if (token !== null && pn !== null && eo !== null) {
      next.sessionToken = token
      next.pageNumber = Number(pn) || next.pageNumber
      next.endOffset = Number(eo) || next.endOffset
    }
  } catch { /* keep local fallback */ }
  return next
}

/** 拉一页原始 feed 并归一化（不做去重——去重交给调用方逐层做）。 */
async function fetchPage(cookie: string, st: PageCursor): Promise<{
  cards: ZhihuCard[]
  cursor: PageCursor
  isEnd: boolean
}> {
  const raw = await zhihuFeed({
    cookie,
    pageNumber: st.pageNumber,
    endOffset: st.endOffset,
    sessionToken: st.sessionToken ?? undefined,
  }) as { data?: unknown; paging?: Record<string, unknown> }
  const items = (Array.isArray(raw.data) ? raw.data : []) as Array<Record<string, unknown>>
  const paging = raw.paging ?? {}
  return {
    cards: items.map(toCard).filter((c): c is ZhihuCard => c !== null),
    cursor: nextCursor(st, paging, items.length),
    isEnd: paging.is_end === true,
  }
}

/** 正文 HTML → 纯文本（img 取 data-original 转占位、br/p 转换行、剥标签、实体反转义）。 */
function cleanHtml(html: string): string {
  let s = html
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<img[^>]*>/gi, tag => {
      const m = tag.match(/data-original="([^"]+)"|data-actualsrc="([^"]+)"|src="([^"]+)"/i)
      const url = m?.[1] ?? m?.[2] ?? m?.[3]
      return url !== undefined && url !== '' ? `\n[IMG:${url}]\n` : ''
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
  return s.trim()
}

/** 把纯文本按 ~CHUNK_SIZE 字符切段（段为原子，图片占位不被劈开）。 */
function makeChunks(text: string, size = CHUNK_SIZE): string[] {
  if (text === '') return []
  const paras = text.split(/\n{2,}/)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur !== '' && cur.length + p.length > size) {
      chunks.push(cur)
      cur = p
    } else {
      cur = cur === '' ? p : cur + '\n\n' + p
    }
  }
  if (cur !== '') chunks.push(cur)
  return chunks
}

/** 纯 Cookie 合法性初检（字段齐全即可保存，真实校验交给 /v4/me）。 */
function cookieLooksValid(text: string): boolean {
  return /z_c0=/.test(text) && /d_c0=/.test(text)
}

/**
 * 渲染知乎摸鱼面板。
 * @param props - 携带类型化 `t` 的 locale 份额。
 */
export type ZhihuViewProps = PropsLocale<'slacker'>

export function ZhihuView(props: ZhihuViewProps): JSX.Element {
  const { t } = props
  const [phase, setPhase] = useState<'boot' | 'noCookie' | 'ready'>('boot')
  const [cookie, setCookie] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorText, setEditorText] = useState('')
  const [editorErr, setEditorErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [cards, setCards] = useState<ZhihuCard[]>([])
  const [loading, setLoading] = useState(false)
  const [endReached, setEndReached] = useState(false)
  const [failed, setFailed] = useState(false)
  const [images, setImages] = useState(false)
  const [banner, setBanner] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [detail, setDetail] = useState<DetailState | null>(null)

  const cursorRef = useRef<PageCursor>({ pageNumber: 1, endOffset: 0, sessionToken: null })
  const seenFeedsRef = useRef<Set<string>>(new Set())
  const seenTargetsRef = useRef<Set<string>>(new Set())
  const loadingRef = useRef(false)
  const cookieRef = useRef('')
  const reportFailsRef = useRef(0)
  const bannerAtRef = useRef(0)

  cookieRef.current = cookie

  /** Cookie 失效横幅：被动展示，30s 节流（不弹窗打断摸鱼）。 */
  const showBanner = useCallback((): void => {
    const now = Date.now()
    if (now - bannerAtRef.current < 30_000) return
    bannerAtRef.current = now
    setBanner(true)
  }, [])

  /** 已读上报（fire-and-forget；连续 3 次失败即熔断到会话结束）。 */
  const reportRead = useCallback((page: readonly ZhihuCard[]): void => {
    if (reportFailsRef.current >= REPORT_BREAKER) return
    const items = page
      .filter(c => c.attachedInfo !== undefined)
      .map(c => ({ attached_info: c.attachedInfo }))
    if (items.length === 0) return
    void zhihuReportRead(items, cookieRef.current).then(ok => {
      reportFailsRef.current = ok ? 0 : reportFailsRef.current + 1
    })
  }, [])

  /** 标记一篇已读：更新内存 Set + FIFO 裁剪 + 落 kv（fire-and-forget）。 */
  const markSeen = useCallback((card: ZhihuCard): void => {
    const key = card.kind + ':' + card.targetId
    if (seenTargetsRef.current.has(key)) return
    const arr = Array.from(seenTargetsRef.current)
    arr.push(key)
    const trimmed = arr.length > SEEN_MAX ? arr.slice(arr.length - SEEN_MAX) : arr
    seenTargetsRef.current = new Set(trimmed)
    void kvSet(SEEN_KEY, JSON.stringify(trimmed))
  }, [])

  /** 拉推荐：reset=换一批（重置游标+会话去重），否则续翻页。
   *  单次最多连环 4 页（全被去重过滤时也要给用户内容）。 */
  const load = useCallback(async (reset: boolean): Promise<void> => {
    const ck = cookieRef.current
    if (loadingRef.current || ck === '') return
    loadingRef.current = true
    setLoading(true)
    setFailed(false)
    if (reset) {
      cursorRef.current = { pageNumber: 1, endOffset: 0, sessionToken: null }
      seenFeedsRef.current = new Set()
      setCards([])
      setEndReached(false)
    }
    try {
      const fresh: ZhihuCard[] = []
      let page: { cards: ZhihuCard[]; cursor: PageCursor; isEnd: boolean } =
        { cards: [], cursor: cursorRef.current, isEnd: false }
      let rounds = 0
      while (rounds < 4) {
        rounds++
        page = await fetchPage(ck, page.cursor)
        for (const c of page.cards) seenFeedsRef.current.add(c.feedId)
        reportRead(page.cards)
        for (const c of page.cards) {
          if (seenTargetsRef.current.has(c.kind + ':' + c.targetId)) continue
          fresh.push(c)
        }
        if (page.isEnd || fresh.length >= BATCH_MIN) break
      }
      cursorRef.current = page.cursor
      setEndReached(page.isEnd || (fresh.length === 0 && rounds >= 4))
      if (fresh.length > 0) setCards(prev => (reset ? fresh : [...prev, ...fresh]))
    } catch (err) {
      if (isZhihuAuthError(err)) showBanner()
      else setFailed(true)
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [reportRead, showBanner])

  // 启动：读 Cookie/图片开关/去重历史；Cookie 可用则直接拉流。
  useEffect(() => {
    void (async () => {
      const [savedCookie, savedImages, savedSeen] = await Promise.all([
        kvGet(COOKIE_KEY), kvGet(IMAGES_KEY), kvGet(SEEN_KEY),
      ])
      if (savedImages === '1') setImages(true)
      if (savedSeen !== null && savedSeen !== '') {
        try {
          const arr = JSON.parse(savedSeen) as unknown
          if (Array.isArray(arr)) {
            seenTargetsRef.current = new Set(arr.filter((x): x is string => typeof x === 'string'))
          }
        } catch { /* ignore */ }
      }
      if (savedCookie !== null && savedCookie !== '') {
        setCookie(savedCookie)
        cookieRef.current = savedCookie
        if (cookieLooksValid(savedCookie)) {
          setPhase('ready')
          void load(true)
          return
        }
      }
      setPhase('noCookie')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 保存 Cookie：先 /v4/me 校验再落 kv。 */
  async function saveCookie(): Promise<void> {
    const text = editorText.trim()
    if (text === '' || saving) return
    if (!cookieLooksValid(text)) {
      setEditorErr(t('zhihu.cookieInvalid'))
      return
    }
    setSaving(true)
    setEditorErr(null)
    try {
      await zhihuMe(text)
      await kvSet(COOKIE_KEY, text)
      setCookie(text)
      cookieRef.current = text
      reportFailsRef.current = 0
      setEditorOpen(false)
      setPhase('ready')
      void load(true)
    } catch (err) {
      setEditorErr(isZhihuAuthError(err) ? t('zhihu.cookieInvalid') : t('zhihu.error'))
    } finally {
      setSaving(false)
    }
  }

  /** 打开详情：就地切详情视图并加载正文。 */
  function openDetail(card: ZhihuCard): void {
    markSeen(card)
    setDetail({
      card,
      byline: (card.author !== '' ? card.author + ' · ' : '') + card.meta,
      chunks: [],
      shown: 1,
      loading: true,
      error: null,
    })
    void (async () => {
      try {
        const raw = (await zhihuContent(card.kind, card.targetId, cookieRef.current)) as Record<string, unknown>
        let html = ''
        if (card.kind === 'pin') {
          const blocks = (Array.isArray(raw.content) ? raw.content : []) as Array<Record<string, unknown>>
          html = blocks.map(b => String(b.content ?? '')).join('')
        } else {
          html = String(raw.content ?? '')
        }
        const chunks = makeChunks(cleanHtml(html))
        setDetail(d => d?.card.feedId === card.feedId
          ? { ...d, chunks, shown: Math.min(1, chunks.length), loading: false }
          : d)
      } catch (err) {
        if (isZhihuAuthError(err)) {
          showBanner()
          setDetail(null)
          return
        }
        setDetail(d => d?.card.feedId === card.feedId
          ? { ...d, loading: false, error: t('zhihu.error') }
          : d)
      }
    })()
  }

  /** 展开全文：多追加分段。 */
  function expand(): void {
    setDetail(d => d === null ? d : { ...d, shown: Math.min(d.chunks.length, d.shown + 1) })
  }

  /** 图片开关：落 kv（关闭时彻底不发图片请求——占位框替代）。 */
  function toggleImages(): void {
    const next = !images
    setImages(next)
    void kvSet(IMAGES_KEY, next ? '1' : '0')
  }

  /** 换一批：重置游标 + 会话去重（持久已读历史保留，不重复推已读篇）。 */
  function resetFeed(): void {
    void load(true)
  }

  /** 清已读历史：持久 seenTargetKeys 清空（重置后可能重新见到旧篇）。 */
  function clearHistory(): void {
    seenTargetsRef.current = new Set()
    void kvSet(SEEN_KEY, '')
    setCleared(true)
    window.setTimeout(() => setCleared(false), 1500)
  }

  // ── 无 Cookie 引导（也作右上角 Cookie 按钮的编辑覆盖层） ──
  const editor = (
    <div className={css.editor}>
      <p className={css.editorLead}>{t('zhihu.needCookie')}</p>
      <textarea
        className={css.editorArea}
        value={editorText}
        placeholder={t('zhihu.cookiePh')}
        rows={5}
        spellCheck={false}
        onChange={e => { setEditorText(e.target.value) }}
      />
      <p className={css.editorHow}>{t('zhihu.cookieHint')}</p>
      {editorErr !== null && <p className={css.editorErr}>{editorErr}</p>}
      <div className={css.editorRow}>
        <button type="button" className={css.saveBtn} disabled={saving} onClick={() => { void saveCookie() }}>
          {t('zhihu.cookieSave')}
        </button>
        {phase === 'ready' && (
          <button type="button" className={css.pill} onClick={() => { setEditorOpen(false); setEditorErr(null) }}>
            ✕
          </button>
        )}
      </div>
    </div>
  )

  if (phase === 'boot') {
    return <div className={css.root}><div className={css.state}>{t('zhihu.loading')}</div></div>
  }

  if (phase === 'noCookie') {
    return <div className={css.root}>{editor}</div>
  }

  return (
    <div className={css.root}>
      <div className={css.head}>
        <b>{t('zhihu.title')}</b>
        <span className={css.spacer} />
        <button
          type="button"
          className={images ? css.pillOn : css.pill}
          title={t('zhihu.images')}
          onClick={toggleImages}
        >
          {t('zhihu.images')}
        </button>
        <button type="button" className={css.pill} onClick={resetFeed}>{t('zhihu.reset')}</button>
        <button type="button" className={css.pill} onClick={clearHistory}>
          {cleared ? t('zhihu.cleared') : t('zhihu.clearHistory')}
        </button>
        <button
          type="button"
          className={css.pill}
          onClick={() => { setEditorText(cookie); setEditorOpen(v => !v) }}
        >
          Cookie
        </button>
      </div>

      {banner && <div className={css.banner}>{t('zhihu.cookieBad')}</div>}
      {editorOpen && editor}

      {detail !== null ? (
        <div className={css.detail}>
          <div className={css.detailHead}>
            <button type="button" className={css.back} onClick={() => { setDetail(null) }}>
              ‹ {t('zhihu.back')}
            </button>
            <span className={css.detailMeta}>{detail.byline}</span>
          </div>
          {detail.card.title !== '' && <h3 className={css.detailTitle}>{detail.card.title}</h3>}
          {detail.loading && <div className={css.state}>{t('zhihu.loading')}</div>}
          {detail.error !== null && <div className={css.state}>{detail.error}</div>}
          {!detail.loading && detail.error === null && (
            <>
              {detail.chunks.slice(0, detail.shown).map((chunk, i) => (
                <div key={i} className={css.prose}>{renderChunk(chunk, images, t)}</div>
              ))}
              {detail.chunks.length > detail.shown && (
                <button type="button" className={css.more} onClick={expand}>{t('zhihu.readAll')}</button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className={css.list}>
          {cards.map(c => (
            <button type="button" key={c.feedId} className={css.card} onClick={() => { openDetail(c) }}>
              <span className={css.cardMeta}>{c.meta}{c.author !== '' ? ' · ' + c.author : ''}</span>
              {c.title !== '' && <b className={css.cardTitle}>{c.title}</b>}
              {c.excerpt !== '' && <span className={css.cardExcerpt}>{c.excerpt}</span>}
            </button>
          ))}
          {loading && <div className={css.state}>{t('zhihu.loading')}</div>}
          {!loading && cards.length === 0 && (
            <div className={css.state}>{failed ? t('zhihu.error') : t('zhihu.empty')}</div>
          )}
          {!loading && !endReached && cards.length > 0 && (
            <button type="button" className={css.more} onClick={() => { void load(false) }}>
              {t('zhihu.loadMore')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 渲染一段正文：[IMG:url] 占位转 <img>（referrerPolicy 空 Referer 直连
 *  zhimg CDN）或隐藏占位框；其余文本按 \n 换行。 */
function renderChunk(text: string, images: boolean, t: (key: SlackerKey) => string): JSX.Element[] {
  return text.split(/(\[IMG:[^\]]+\])/).map((part, i) => {
    const m = part.match(/^\[IMG:([^\]]+)\]$/)
    if (m !== null) {
      return images
        ? <img key={i} className={css.img} src={m[1]} referrerPolicy="no-referrer" alt="" loading="lazy" />
        : <span key={i} className={css.imgHidden}>{'🖼 ' + t('zhihu.imgHidden')}</span>
    }
    return <span key={i}>{part}</span>
  })
}
