/**
 * The shell IPC seam: slacker views persist through the Rust shell
 * (Tauri `slacker_*` commands), never localStorage — the dsh webview
 * origin changes on every boot (fresh port + token), which voids
 * browser storage. Outside the shell (plain-browser dsh dev) the same
 * API falls back to localStorage so components stay testable.
 * @module ui-slacker/client/ipc
 */

/** Shape of Tauri's global invoke (exposed via withGlobalTauri). */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** Resolve the Tauri invoke bridge, if running inside the shell. */
export function shellInvoke(): Invoke | undefined {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke }
  }
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke
}

/** Whether the slacker views are running inside the Rust shell. */
export function inShell(): boolean {
  return shellInvoke() !== undefined
}

/** Read one persisted slacker value; null when absent. */
export async function kvGet(key: string): Promise<string | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    try { return localStorage.getItem('slacker:' + key) } catch { return null }
  }
  try { return (await invoke('slacker_kv_get', { key })) as string | null }
  catch (err) { console.warn('[ui-slacker] kvGet failed:', err); return null }
}

/** Persist one slacker value (fire-and-forget; failures only log). */
export async function kvSet(key: string, value: string): Promise<void> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    try { localStorage.setItem('slacker:' + key, value) } catch { /* storage full/blocked */ }
    return
  }
  try { await invoke('slacker_kv_set', { key, value }) }
  catch (err) { console.warn('[ui-slacker] kvSet failed:', err) }
}

/* ── stocks ─────────────────────────────────────────────────────── */

/** One watchlist row. */
export interface StockQuote {
  code: string
  name: string
  price: number
  change: number
  change_pct: number
}

/** Map a 6-digit A-share code to an eastmoney secid. */
function secid(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null
  const market = ('659'.includes(code[0]!)) ? '1' : ('03'.includes(code[0]!)) ? '0' : null
  return market === null ? null : market + '.' + code
}

/** Decode a response as text, tolerating eastmoney's GB18030 bytes:
 *  try UTF-8 first, then a lenient GB18030 decode. */
async function emText(res: Response): Promise<string> {
  const buf = await res.arrayBuffer()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) }
  catch { return new TextDecoder('gb18030').decode(buf) }
}

/** Fetch live quotes; browser-dev falls back to a direct fetch. */
export async function stockQuotes(codes: string[]): Promise<StockQuote[]> {
  const secids = codes.map(secid).filter((s): s is string => s !== null)
  if (secids.length === 0) return []
  const parse = (body: string): StockQuote[] => {
    const diff = (JSON.parse(body) as { data?: { diff?: unknown[] } }).data?.diff ?? []
    return (diff as Array<Record<string, unknown>>).map(q => ({
      code: String(q.f12 ?? ''),
      name: String(q.f14 ?? ''),
      price: Number(q.f2 ?? 0),
      change: Number(q.f4 ?? 0),
      change_pct: Number(q.f3 ?? 0),
    }))
  }
  const invoke = shellInvoke()
  if (invoke !== undefined) {
    try { return (await invoke('slacker_stock_quotes', { codes })) as StockQuote[] }
    catch (err) { console.warn('[ui-slacker] stockQuotes failed:', err); return [] }
  }
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14&secids=' + secids.join(',')
  try { return parse(await emText(await fetch(url))) }
  catch { return [] }
}

/** One code's intraday minute closes (for the card sparkline). */
export interface StockTrend {
  code: string
  points: number[]
}

/** Parse a trends2 reply into minute closes. */
function parseTrends(body: string): StockTrend | null {
  const v = JSON.parse(body) as { data?: { trends?: unknown[] } }
  const rows = (v.data?.trends ?? []) as unknown[]
  const points = rows
    .filter((r): r is string => typeof r === 'string')
    .map(r => Number(r.split(',')[1]))
    .filter(n => Number.isFinite(n))
  return points.length > 0 ? { code: '', points } : null
}

/** Fetch today's intraday minute closes per code; browser-dev falls back
 * to a direct fetch (sequential — watchlists are small). */
export async function stockTrends(codes: string[]): Promise<StockTrend[]> {
  const invoke = shellInvoke()
  if (invoke !== undefined) {
    try { return (await invoke('slacker_stock_trends', { codes })) as StockTrend[] }
    catch (err) { console.warn('[ui-slacker] stockTrends failed:', err); return [] }
  }
  const out: StockTrend[] = []
  for (const code of codes) {
    const s = secid(code)
    if (s === null) continue
    const url = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + s +
      '&fields1=f1,f2,f3&fields2=f51,f53&ndays=1&iscr=1'
    try {
      const t = parseTrends(await (await fetch(url)).text())
      if (t !== null) out.push({ code, points: t.points })
    } catch { /* one code failing must not void the rest */ }
  }
  return out
}

/* ── stocks: search + kline + mini window ───────────────────────── */

/** One search hit. */
export interface StockSearchItem {
  code: string
  name: string
  market: 'sh' | 'sz' | 'bj'
}

/** Parse a suggest-api reply into search hits (A-shares only). */
function parseSearch(body: string): StockSearchItem[] {
  const rows = (JSON.parse(body) as { QuotationCodeTable?: { Data?: unknown[] } })
    ?.QuotationCodeTable?.Data ?? []
  const out: StockSearchItem[] = []
  for (const raw of rows as Array<Record<string, unknown>>) {
    const code = String(raw.Code ?? '')
    const name = String(raw.Name ?? '')
    const market = String(raw.MktNum ?? '')
    let m: 'sh' | 'sz' | 'bj'
    if (market === '1') m = 'sh'
    else if (market === '0') m = 'sz'
    else if (market === '100') m = 'bj'
    else continue
    if (!/^\d{6}$/.test(code) || name === '') continue
    out.push({ code, name, market: m })
  }
  return out
}

/** Search stocks by name/code/letters; browser-dev falls back to direct fetch. */
export async function stockSearch(query: string): Promise<StockSearchItem[]> {
  const q = query.trim()
  if (q === '') return []
  const url = 'https://searchadapter.eastmoney.com/api/suggest/get?input=' +
    encodeURIComponent(q) +
    '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=15&markettype=&mktnum=&jys=&classify=&securitytype=&status=&ut=D43BF722C8E33BDC906FB84D85E326E8'
  const invoke = shellInvoke()
  if (invoke !== undefined) {
    try { return (await invoke('slacker_stock_search', { query })) as StockSearchItem[] }
    catch (err) { console.warn('[ui-slacker] stockSearch failed:', err); return [] }
  }
  try { return parseSearch(await emText(await fetch(url))) }
  catch { return [] }
}

/** One kline bar. */
export interface StockKlineItem {
  time: string
  open: number
  close: number
  high: number
  low: number
  volume: number
}

/** Kline periods: minute bars + daily/weekly/monthly (eastmoney klt). */
export type StockKlinePeriod = '5' | '15' | '30' | '60' | '101' | '102' | '103'

/** Parse a kline/get reply into bars. */
function parseKline(body: string): StockKlineItem[] {
  const klines = (JSON.parse(body) as { data?: { klines?: unknown[] } })
    ?.data?.klines ?? []
  const out: StockKlineItem[] = []
  for (const raw of klines as unknown[]) {
    if (typeof raw !== 'string') continue
    const p = raw.split(',')
    if (p.length < 6) continue
    out.push({
      time: p[0]!,
      open: Number(p[1]) || 0,
      close: Number(p[2]) || 0,
      high: Number(p[3]) || 0,
      low: Number(p[4]) || 0,
      volume: Number(p[5]) || 0,
    })
  }
  return out
}

/** Fetch the kline bars for one stock. */
export async function stockKline(
  code: string,
  period: StockKlinePeriod,
  adjust: 'qfq' | 'hfq' | 'none',
  count?: number,
): Promise<StockKlineItem[]> {
  const s = secid(code)
  if (s === null) return []
  const fqt = adjust === 'qfq' ? 1 : adjust === 'hfq' ? 2 : 0
  const lmt = count ?? 120
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + s +
    '&klt=' + period + '&fqt=' + fqt + '&lmt=' + lmt +
    '&beg=19900101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    '&ut=D43BF722C8E33BDC906FB84D85E326E8'
  const invoke = shellInvoke()
  if (invoke !== undefined) {
    try {
      return (await invoke('slacker_stock_kline', { code, period, adjust, count: lmt })) as StockKlineItem[]
    }
    catch (err) { console.warn('[ui-slacker] stockKline failed:', err); return [] }
  }
  try { return parseKline(await emText(await fetch(url))) }
  catch { return [] }
}

/** Toggle / close the persistent stock mini window. No-op outside the shell. */
export async function stockMiniOpen(action: 'toggle' | 'close'): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) return false
  try { await invoke('slacker_stock_mini', { action }); return true }
  catch (err) { console.warn('[ui-slacker] stockMini failed:', err); return false }
}

/* ── zhihu: thin proxy over the shell's zhihu commands ────────────
 * Zhihu's API is same-origin-locked, so everything rides the Rust
 * proxy (cookie + browser headers attached there). The raw JSON is
 * returned as-is; feed normalization/dedup lives in ZhihuView. */

/** One recommend-feed page (raw API JSON: { data, paging }). */
export async function zhihuFeed(args: {
  cookie: string
  pageNumber: number
  endOffset: number
  sessionToken?: string
  limit?: number
}): Promise<unknown> {
  const invoke = shellInvoke()
  if (invoke === undefined) throw new Error('zhihu feed needs the shell proxy')
  return invoke('slacker_zhihu_feed', {
    cookie: args.cookie,
    pageNumber: args.pageNumber,
    endOffset: args.endOffset,
    sessionToken: args.sessionToken ?? null,
    limit: args.limit ?? null,
  })
}

/** Full content of one target (raw API JSON; answer/article carry `content` HTML). */
export async function zhihuContent(kind: string, targetId: string, cookie: string): Promise<unknown> {
  const invoke = shellInvoke()
  if (invoke === undefined) throw new Error('zhihu content needs the shell proxy')
  return invoke('slacker_zhihu_content', { kind, targetId, cookie })
}

/** One root-comments page of one target (raw API JSON: { data, paging }). */
export async function zhihuComments(
  kind: string, targetId: string, cookie: string, offset: number, limit: number,
): Promise<unknown> {
  const invoke = shellInvoke()
  if (invoke === undefined) throw new Error('zhihu comments needs the shell proxy')
  return invoke('slacker_zhihu_comments', { kind, targetId, cookie, offset, limit })
}

/** Batch "already read" feedback; resolves false on any failure (caller
 * trips a breaker after 3 consecutive failures). */
export async function zhihuReportRead(items: unknown[], cookie: string): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) return false
  try { return (await invoke('slacker_zhihu_report_read', { items, cookie })) === true }
  catch (err) { console.warn('[ui-slacker] zhihuReportRead failed:', err); return false }
}

/** Validate a cookie via GET /api/v4/me; rejects on 401/403/network. */
export async function zhihuMe(cookie: string): Promise<unknown> {
  const invoke = shellInvoke()
  if (invoke === undefined) throw new Error('zhihu me needs the shell proxy')
  return invoke('slacker_zhihu_me', { cookie })
}

/** Proxy-fetch one zhimg image; resolves a data URL (Rust side attaches
 * Cookie + browser-ish headers, sidestepping WebView hotlink blocks). */
export async function zhihuImage(url: string, cookie: string): Promise<string> {
  const invoke = shellInvoke()
  if (invoke === undefined) throw new Error('zhihu image needs the shell proxy')
  return invoke<string>('slacker_zhihu_image', { url, cookie })
}

/** Whether an IPC error message is the shell's auth-failure marker. */
export function isZhihuAuthError(err: unknown): boolean {
  return typeof err === 'string'
    ? err.startsWith('ZHIHU_AUTH')
    : err instanceof Error && err.message.startsWith('ZHIHU_AUTH')
}
