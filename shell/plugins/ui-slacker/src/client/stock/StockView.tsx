/**
 * The watchlist panel — the third real slacker view. Codes persist via
 * kv; quotes come from the shell (eastmoney ulist, fetched Rust-side),
 * refreshed on mount, on demand, and every 30s while mounted.
 * Card-grid shape: one card per code with a big price, a tinted change
 * badge and an intraday sparkline (eastmoney trends2, Rust-side).
 *
 * v2 additions:
 *  - a live search box backed by eastmoney suggest (name/code/letters);
 *  - a kline detail panel per code (SVG candlesticks, period + adjust
 *    switching) — the source supports daily/weekly/monthly + minute bars;
 *  - a "mini window" launcher for the persistent desktop ticker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  kvGet, kvSet, stockQuotes, stockTrends, stockSearch, stockKline, stockMiniOpen,
  type StockQuote, type StockSearchItem, type StockKlineItem, type StockKlinePeriod,
} from '../ipc.ts'
import type { SlackerKey } from '../locales.ts'
import css from './StockView.module.css'

/** kv key for the persisted code list. */
const WATCHLIST_KEY = 'watchlist'

/** Default codes on first run. */
const DEFAULT_CODES: readonly string[] = ['600519', '300750', '510300']

/** Refresh interval. */
const REFRESH_MS = 30_000

/** Sparkline geometry: logical viewBox the path is built against. */
const SPARK_W = 100
const SPARK_H = 34

/** Kline chart geometry. */
const CHART_W = 640
const CHART_H = 240
const CHART_PAD = 8

/** Kline period tabs (klt codes the eastmoney API understands). */
const PERIODS: readonly { key: StockKlinePeriod; label: SlackerKey }[] = [
  { key: '101', label: 'stock.pk1' },
  { key: '102', label: 'stock.pk2' },
  { key: '103', label: 'stock.pk3' },
  { key: '5', label: 'stock.pk4' },
  { key: '15', label: 'stock.pk5' },
  { key: '30', label: 'stock.pk6' },
  { key: '60', label: 'stock.pk7' },
]

/** Adjust modes for the kline fetch (eastmoney fqt). */
const ADJUSTS: readonly { key: 'qfq' | 'hfq' | 'none'; label: SlackerKey }[] = [
  { key: 'qfq', label: 'stock.adjustQfq' },
  { key: 'hfq', label: 'stock.adjustHfq' },
  { key: 'none', label: 'stock.adjustNone' },
]

/** Downsample a minute series to ~this many points for the path. */
function sample(points: readonly number[], target = 64): number[] {
  if (points.length <= target) return [...points]
  const step = points.length / target
  const out: number[] = []
  for (let i = 0; i < target; i++) out.push(points[Math.floor(i * step)]!)
  return out
}

/** Build polyline + area paths for one sparkline series. */
function sparkPaths(points: readonly number[]): { line: string; area: string } {
  const pts = sample(points)
  const min = Math.min(...pts)
  const max = Math.max(...pts)
  const span = max - min || 1
  const step = pts.length > 1 ? SPARK_W / (pts.length - 1) : SPARK_W
  const coords = pts.map((p, i) => [
    i * step,
    3 + (1 - (p - min) / span) * (SPARK_H - 6),
  ] as const)
  const segs = coords.map(([x, y]) => 'L' + x.toFixed(2) + ' ' + y.toFixed(2))
  const line = 'M' + coords[0]![0].toFixed(2) + ' ' + coords[0]![1].toFixed(2) + segs.join('')
  const area = 'M0 ' + SPARK_H + line.slice(1) + 'L' + SPARK_W + ' ' + SPARK_H + ' Z'
  return { line, area }
}

/** One watchlist card's sparkline. */
function Spark(props: { points: readonly number[]; up: boolean; code: string }): JSX.Element {
  const { line, area } = sparkPaths(props.points)
  const color = props.up ? 'var(--pa-up)' : 'var(--pa-down)'
  const gid = 'sg-' + props.code
  return (
    <svg className={css.spark} viewBox={'0 0 ' + SPARK_W + ' ' + SPARK_H} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={'url(#' + gid + ')'} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** The kline legend title uses the day-vs-minute shape of the bars. */
function isMinuteBars(bars: readonly StockKlineItem[]): boolean {
  return bars.length > 0 && bars[0]!.time.includes(' ')
}

/** SVG candlestick chart with a price/date grid (hand-drawn, no deps). */
function KlineChart(props: { bars: readonly StockKlineItem[] }): JSX.Element {
  const bars = props.bars
  const n = bars.length
  if (n === 0) {
    return <div className={css.chartEmpty}>{'—'}</div>
  }
  const min = Math.min(...bars.map(b => b.low))
  const max = Math.max(...bars.map(b => b.high))
  const span = max - min || 1
  const plotW = CHART_W - CHART_PAD * 2
  const plotH = CHART_H - 22 // leave a strip for x labels
  const slot = plotW / n
  const cw = Math.max(1.5, slot * 0.66)
  const minute = isMinuteBars(bars)
  const y = (p: number): number => CHART_PAD + (1 - (p - min) / span) * (plotH - CHART_PAD * 2)

  // horizontal gridlines + price labels (5 stops)
  const hLines: JSX.Element[] = []
  const hTexts: JSX.Element[] = []
  for (let i = 0; i <= 4; i++) {
    const value = max - (span * i) / 4
    const yy = y(value)
    hLines.push(<line key={'hl' + i} x1={CHART_PAD} x2={CHART_W - CHART_PAD} y1={yy} y2={yy} className={css.cGrid} />)
    hTexts.push(
      <text key={'ht' + i} x={CHART_W - CHART_PAD} y={yy - 3} textAnchor="end" className={css.cPrice}>
        {value.toFixed(2)}
      </text>,
    )
  }

  // a few x labels (dates for daily bars, times for minute bars)
  const xLabels: JSX.Element[] = []
  const ticks = Math.min(n, 6)
  for (let i = 0; i < ticks; i++) {
    const idx = Math.min(n - 1, Math.round((i / (ticks - 1)) * (n - 1)))
    const bar = bars[idx]!
    const label = minute ? bar.time.slice(11, 16) : bar.time.slice(5)
    xLabels.push(
      <text key={'xb' + i} x={CHART_PAD + idx * slot + slot / 2} y={CHART_H - 6} textAnchor="middle" className={css.cTime}>
        {label}
      </text>,
    )
  }

  return (
    <svg className={css.chart} viewBox={`0 0 ${CHART_W} ${CHART_H}`} aria-hidden="true">
      {hLines}
      {hTexts}
      {xLabels}
      {bars.map((b, i) => {
        const x = CHART_PAD + i * slot + (slot - cw) / 2
        const cx = x + cw / 2
        const oY = y(b.open)
        const cY = y(b.close)
        const hY = y(b.high)
        const lY = y(b.low)
        const bull = b.close >= b.open
        const fill = bull ? 'var(--pa-up)' : 'var(--pa-down)'
        const bodyY = Math.min(oY, cY)
        const bodyH = Math.max(1, Math.abs(oY - cY))
        return (
          <g key={b.time + i}>
            <line x1={cx} x2={cx} y1={hY} y2={lY} stroke={fill} strokeWidth="1.1" />
            <rect x={x} y={bodyY} width={cw} height={bodyH} fill={fill} />
          </g>
        )
      })}
    </svg>
  )
}

/** Full props: the locale share. */
export type StockViewProps = PropsLocale<'slacker'>

/** Render the watchlist cards, search add, kline detail, mini launcher.
 * @param props - the locale share carrying the typed `t` seat.
 */
export function StockView(props: StockViewProps): JSX.Element {
  const { t } = props
  const [codes, setCodes] = useState<readonly string[]>(DEFAULT_CODES)
  const [quotes, setQuotes] = useState<readonly StockQuote[]>([])
  const [dirs, setDirs] = useState<ReadonlyMap<string, 1 | -1>>(new Map())
  const [trends, setTrends] = useState<ReadonlyMap<string, readonly number[]>>(new Map())
  const [updated, setUpdated] = useState('')
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const codesRef = useRef(codes)
  codesRef.current = codes

  // search state
  const [results, setResults] = useState<readonly StockSearchItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchTimer = useRef<number | undefined>(undefined)

  // kline detail state
  const [detail, setDetail] = useState<string | null>(null)
  const [kPeriod, setKPeriod] = useState<StockKlinePeriod>('101')
  const [kAdjust, setKAdjust] = useState<'qfq' | 'hfq' | 'none'>('qfq')
  const [kBars, setKBars] = useState<readonly StockKlineItem[]>([])
  const [kLoading, setKLoading] = useState(false)

  // 上一次行情快照：刷新时对比出每只票的涨跌方向，驱动价格闪动。
  const prevQuotes = useRef<readonly StockQuote[]>([])

  // Restore the persisted watchlist once.
  useEffect(() => {
    void kvGet(WATCHLIST_KEY).then(saved => {
      if (saved !== null) {
        try { setCodes(JSON.parse(saved) as string[]) } catch { /* keep defaults */ }
      }
    })
  }, [])

  const persist = useCallback((next: readonly string[]): void => {
    setCodes(next)
    void kvSet(WATCHLIST_KEY, JSON.stringify(next))
  }, [])

  const refresh = useCallback(() => {
    setBusy(true)
    const list = [...codesRef.current]
    void Promise.all([stockQuotes(list), stockTrends(list)]).then(([rows, trends]) => {
      const d = new Map<string, 1 | -1>()
      for (const q of rows) {
        const old = prevQuotes.current.find(x => x.code === q.code)
        if (old !== undefined && old.price !== q.price) d.set(q.code, q.price > old.price ? 1 : -1)
      }
      prevQuotes.current = rows
      setQuotes(rows)
      setDirs(d)
      setTrends(new Map(trends.map(t => [t.code, t.points] as const)))
      setUpdated(new Date().toTimeString().slice(0, 8))
      setLoaded(true)
      setBusy(false)
    })
  }, [])

  // Refresh on any code change, then on the interval.
  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [codes, refresh])

  // ── search: debounced kick, click-to-add ──
  const runSearch = useCallback((q: string): void => {
    const trim = q.trim()
    if (trim === '') { setResults([]); setSearchOpen(false); return }
    setSearching(true)
    void stockSearch(trim).then(list => {
      setResults(list)
      setSearching(false)
      setSearchOpen(true)
    })
  }, [])

  const onSearchInput = useCallback((e: { target: { value: string } }): void => {
    const v = e.target.value
    setAdding(v)
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => runSearch(v), 300)
  }, [runSearch])

  const addStock = useCallback((item: StockSearchItem): void => {
    if (codesRef.current.includes(item.code)) { setAdding(''); setSearchOpen(false); return }
    persist([...codesRef.current, item.code])
    setDetail(item.code)
    setKPeriod('101')
    setKAdjust('qfq')
    setAdding('')
    setSearchOpen(false)
  }, [persist])

  const addByCode = useCallback(() => {
    const code = adding.trim()
    if (!/^\d{6}$/.test(code) || codes.includes(code)) { setAdding(''); return }
    // Validate against the live quote before committing it to the shelf.
    void stockQuotes([code]).then(rows => {
      if (rows.length > 0 && rows[0]!.name !== '') {
        persist([...codesRef.current, code])
        addStock({ code, name: rows[0]!.name, market: code[0] === '6' ? 'sh' : 'sz' })
      }
      setAdding('')
    })
  }, [adding, codes, persist, addStock])

  const remove = useCallback((code: string) => {
    persist(codesRef.current.filter(c => c !== code))
    if (detail === code) setDetail(null)
  }, [persist, detail])

  // ── kline fetch when the detail selection / period / adjust changes ──
  useEffect(() => {
    if (detail === null) return
    setKLoading(true)
    void stockKline(detail, kPeriod, kAdjust).then(bars => {
      setKBars(bars)
      setKLoading(false)
    })
  }, [detail, kPeriod, kAdjust])

  const openMini = useCallback(() => {
    void stockMiniOpen('toggle')
  }, [])

  const byCode = new Map(quotes.map(q => [q.code, q] as const))
  const detailQuote = detail === null ? undefined : byCode.get(detail)

  return (
    <div className={css.root}>
      <div className={css.head}>
        <b>{t('stock.title')}</b>
        <span className={css.live} aria-hidden="true"><i className={css.dot} />{Math.round(REFRESH_MS / 1000) + 's'}</span>
        <span className={css.updated}>{updated === '' ? '' : t('stock.updated') + ' ' + updated}</span>
        <button type="button" className={css.pill} title={t('stock.mini')} onClick={openMini}>◇ {t('stock.mini')}</button>
        <button type="button" className={css.refresh + (busy ? ' ' + css.spin : '')}
          title={t('stock.refresh')} onClick={refresh}>↻</button>
      </div>

      <div className={css.addRow}>
        <input className={css.input} value={adding} placeholder={t('stock.searchPh')}
          onChange={onSearchInput}
          onKeyDown={e => {
            if (e.key === 'Enter') addByCode()
            if (e.key === 'Escape') { setAdding(''); setSearchOpen(false) }
          }}
          onBlur={() => { window.setTimeout(() => setSearchOpen(false), 150) }} />
        <button type="button" className={css.pill} onClick={addByCode}>{t('stock.addBtn')}</button>
      </div>
      {searchOpen && (
        <div className={css.results}>
          {searching && <div className={css.resultHint}>{t('stock.searching')}</div>}
          {!searching && results.length === 0 && <div className={css.resultHint}>{t('stock.noResult')}</div>}
          {results.map(r => (
            <button key={r.market + r.code} type="button" className={css.resultRow}
              onClick={() => addStock(r)}>
              <span className={css.resultName}>{r.name}</span>
              <span className={css.resultMeta}>{r.market === 'sh' ? '沪' : r.market === 'sz' ? '深' : '北'} · {r.code}</span>
              {codes.includes(r.code) && <span className={css.resultAdded}>{t('stock.added')}</span>}
            </button>
          ))}
        </div>
      )}

      <div className={css.grid}>
        {!loaded && codes.map((code, i) => (
          <div key={code} className={css.card + ' ' + css.skeleton} style={{ animationDelay: i * 0.08 + 's' }}>
            <span className={css.skName} />
            <span className={css.skPrice} />
            <span className={css.skSpark} />
          </div>
        ))}
        {loaded && codes.map(code => {
          const q = byCode.get(code)
          const up = (q?.change ?? 0) >= 0
          const sign = up ? '+' : '−'
          const dir = dirs.get(code)
          const points = trends.get(code)
          return (
            <button key={code} type="button" className={css.card + (up ? '' : ' ' + css.down) + (detail === code ? ' ' + css.active : '')}
              onClick={() => { setDetail(detail === code ? null : code) }}>
              <span className={css.del} title={t('stock.remove')} onClick={(e) => { e.stopPropagation(); remove(code) }}>✕</span>
              <span className={css.top}>
                <span className={css.name}>
                  <b>{q?.name ?? '—'}</b>
                  <span>{code}</span>
                </span>
                <span className={css.chg + ' ' + (up ? css.chgUp : css.chgDown)}>
                  <b>{q === undefined ? '—' : sign + Math.abs(q.change_pct).toFixed(2) + '%'}</b>
                  <span>{q === undefined ? '' : sign + Math.abs(q.change).toFixed(2)}</span>
                </span>
              </span>
              <span className={css.mid}>
                <span className={css.price + (dir === 1 ? ' ' + css.flashUp : dir === -1 ? ' ' + css.flashDown : '')}>
                  {q === undefined ? '—' : q.price.toFixed(2)}
                </span>
              </span>
              <span className={css.sparkBox}>
                {points !== undefined && points.length > 1
                  ? <Spark points={points} up={up} code={code} />
                  : <span className={css.sparkEmpty} />}
              </span>
            </button>
          )
        })}
      </div>

      {detail !== null && (
        <div className={css.detail}>
          <div className={css.detailHead}>
            <span className={css.detailTitle}>
              <b>{detailQuote?.name ?? detail}</b>
              <span className={css.detailCode}>{detail}</span>
              {detailQuote !== undefined && (
                <span className={' ' + (detailQuote.change >= 0 ? css.chgUpBare : css.chgDownBare)}>
                  {detailQuote.price.toFixed(2)}  {detailQuote.change >= 0 ? '+' : ''}
                  {detailQuote.change.toFixed(2)} ({detailQuote.change >= 0 ? '+' : ''}
                  {detailQuote.change_pct.toFixed(2)}%)
                </span>
              )}
            </span>
            <button type="button" className={css.pill} onClick={() => setDetail(null)}>{t('stock.closeDetail')}</button>
          </div>
          <div className={css.detailBars}>
            {PERIODS.map(p => (
              <button key={p.key} type="button"
                className={css.barBtn + (kPeriod === p.key ? ' ' + css.barOn : '')}
                onClick={() => setKPeriod(p.key)}>{t(p.label)}</button>
            ))}
          </div>
          <div className={css.detailBars}>
            {ADJUSTS.map(a => (
              <button key={a.key} type="button"
                className={css.barBtn + (kAdjust === a.key ? ' ' + css.barOn : '')}
                onClick={() => setKAdjust(a.key)}>{t(a.label)}</button>
            ))}
          </div>
          {kLoading && <div className={css.chartEmpty}>{t('stock.loading')}</div>}
          {!kLoading && <KlineChart bars={kBars} />}
        </div>
      )}
    </div>
  )
}

// keep default export shape for Storybook-style direct imports if ever used
export default StockView