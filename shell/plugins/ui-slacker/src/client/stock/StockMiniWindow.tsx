/**
 * Persistent desktop stock mini-window (mirror of the watchlist panel).
 *
 * Runs inside its own transparent borderless always-on-top Tauri webview
 * (stock-mini.html / main-stock-mini entry). It re-reads the shared kv
 * watchlist on every refresh tick, so changes made in the break room show
 * up within a poll interval without a cross-window event bus.
 *
 * Controls: drag via the header (Tauri drag region), pin/unpin, refresh,
 * close. The window itself is created/resized shell-side.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { kvGet, stockQuotes, type StockQuote } from '../ipc.ts'
import css from './StockMiniWindow.module.css'

/** kv key — same one the break-room StockView uses. */
const WATCHLIST_KEY = 'watchlist'

/** Mini window poll interval (the persistent ticker). */
const REFRESH_MS = 5_000

/** Fallback codes before the first kv read lands. */
const DEFAULT_CODES: readonly string[] = ['600519', '300750', '510300']

/** Minimal Tauri window handle (withGlobalTauri exposes the full builder). */
interface TauriWin {
  setAlwaysOnTop: (v: boolean) => Promise<void>
  close: () => Promise<void>
}

/** Resolve the Tauri window handle inside this standalone webview. */
function currentWindow(): Promise<TauriWin | null> {
  const w = window as unknown as {
    __TAURI__?: { window?: { getCurrentWindow?: () => TauriWin } }
  }
  return Promise.resolve(w.__TAURI__?.window?.getCurrentWindow?.() ?? null)
}

/** The mini ticker's close button also maps to the OS window close. */
async function closeWindow(): Promise<void> {
  const win = await currentWindow()
  if (win !== null) {
    try { await win.close(); return } catch { /* fall through */ }
  }
  window.close()
}

/** A-share color: up is red in China. */
function colorClass(v: number): string {
  if (v > 0) return css.up
  if (v < 0) return css.down
  return css.flat
}

/** Full props: the locale share. */
export type StockMiniWindowProps = PropsLocale<'slacker'>

/** Render the persistent desktop ticker.
 * @param props - locale share carrying the typed `t` seat.
 */
export function StockMiniWindow(props: StockMiniWindowProps): JSX.Element {
  const { t } = props
  const [codes, setCodes] = useState<readonly string[]>(DEFAULT_CODES)
  const [quotes, setQuotes] = useState<ReadonlyMap<string, StockQuote>>(new Map())
  const [pinned, setPinned] = useState(true)
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState('')
  const codesRef = useRef(codes)
  codesRef.current = codes

  // Read the shared watchlist, then fetch quotes. Runs every poll tick so the
  // mini window follows shelf edits from the main view without events.
  const tick = useCallback(async () => {
    const saved = await kvGet(WATCHLIST_KEY)
    if (saved !== null) {
      try {
        const list = JSON.parse(saved) as string[]
        if (list.join() !== codesRef.current.join()) setCodes(list)
      } catch { /* keep current */ }
    }
    const list = [...codesRef.current]
    if (list.length === 0) { setUpdated(new Date().toTimeString().slice(0, 8)); return }
    setBusy(true)
    const rows = await stockQuotes(list)
    setQuotes(new Map(rows.map(q => [q.code, q] as const)))
    setUpdated(new Date().toTimeString().slice(0, 8))
    setBusy(false)
  }, [])

  useEffect(() => {
    void tick()
    const timer = window.setInterval(() => void tick(), REFRESH_MS)
    return () => { window.clearInterval(timer) }
  }, [tick])

  // Sync the header pin state with the OS window's actual always-on-top.
  useEffect(() => {
    void currentWindow().then(win => {
      if (win === null) return
      win.setAlwaysOnTop(pinned).catch(() => {})
    })
  }, [pinned])

  const togglePin = useCallback(() => setPinned(v => !v), [])

  return (
    <div className={css.root} data-tauri-drag-region>
      {/* Tauri 只在「点击目标本身」带 drag-region 时才拖窗：子元素会挡住
          根上的属性，所以 header 与标题要各自显式声明（按钮不受影响）。 */}
      <header className={css.header} data-tauri-drag-region>
        <span className={css.hTitle} data-tauri-drag-region>
          ☕ {t('stock.miniTitle')}
          <b className={css.count}>{codes.length}</b>
        </span>
        <div className={css.actions}>
          <button type="button" className={css.act + (busy ? ' ' + css.spin : '')}
            title={t('stock.refresh')} onClick={() => void tick()}>↻</button>
          <button type="button" className={css.act + (pinned ? ' ' + css.pinOn : '')}
            title={t('stock.miniPin')} onClick={togglePin}>📌</button>
          <button type="button" className={css.act + ' ' + css.close} title={t('stock.miniClose')}
            onClick={() => void closeWindow()}>✕</button>
        </div>
      </header>
      <div className={css.list}>
        {codes.length === 0 && (
          <div className={css.empty}>
            {t('stock.emptyList')}
          </div>
        )}
        {codes.map(code => {
          const q = quotes.get(code)
          const change = q?.change ?? 0
          const sign = change >= 0 ? '+' : '−'
          return (
            <div key={code} className={css.row}>
              <div className={css.rName}>
                <div className={css.rTitle}>{q?.name ?? '—'}</div>
                <div className={css.rCode}>{code}</div>
              </div>
              <div className={css.rQuote}>
                <div className={css.rPrice + ' ' + colorClass(change)}>
                  {q === undefined ? '—' : q.price.toFixed(2)}
                </div>
                <div className={css.rChg + ' ' + colorClass(change)}>
                  {q === undefined ? '' : sign + Math.abs(change).toFixed(2) + ' · ' + sign + Math.abs(q.change_pct).toFixed(2) + '%'}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <footer className={css.footer}>
        <span className={css.fTime}>{updated === '' ? '' : t('stock.updated') + ' ' + updated}</span>
        <span className={css.fHint}>{t('stock.miniHint')}</span>
      </footer>
    </div>
  )
}

export default StockMiniWindow