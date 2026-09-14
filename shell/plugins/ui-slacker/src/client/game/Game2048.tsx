/**
 * The 2048 tile game — first real slacker view, and the live proof of
 * the persistence seam: board/score/best persist through the shell kv
 * (`slacker_kv_get/set`) and survive both tab switches and app
 * restarts. Pure component: locale share in, no framework imports.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { kvGet, kvSet } from '../ipc.ts'
import css from './Game2048.module.css'

/** Persistence key under the shell kv. */
const KV_KEY = 'g2048'

/** Persisted game shape (board is row-major, 16 cells). */
interface Saved {
  board: readonly number[]
  score: number
  best: number
}

/** Cell index lists per move direction, each ordered start→end. */
function lineIndices(dir: 'up' | 'down' | 'left' | 'right'): number[][] {
  const lines: number[][] = []
  for (let i = 0; i < 4; i++) {
    const idx: number[] = []
    for (let j = 0; j < 4; j++) {
      if (dir === 'up') idx.push(j * 4 + i)
      if (dir === 'down') idx.push((3 - j) * 4 + i)
      if (dir === 'left') idx.push(i * 4 + j)
      if (dir === 'right') idx.push(i * 4 + (3 - j))
    }
    lines.push(idx)
  }
  return lines
}

/** Spawn one tile into a random empty cell (mutates the copy passed in). */
function spawnTile(board: number[]): number {
  const empty = board.map((v, i) => (v === 0 ? i : -1)).filter(i => i >= 0)
  if (empty.length === 0) return -1
  const i = empty[Math.floor(Math.random() * empty.length)]!
  board[i] = Math.random() < 0.9 ? 2 : 4
  return i
}

/** Whether any move is still possible. */
function movesLeft(board: readonly number[]): boolean {
  if (board.includes(0)) return true
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = board[r * 4 + c]
      if (c < 3 && board[r * 4 + c + 1] === v) return true
      if (r < 3 && board[(r + 1) * 4 + c] === v) return true
    }
  }
  return false
}

/** CSS class for one tile value (0 = empty). */
function tileClass(v: number): string {
  return css['t' + (v > 2048 ? 2048 : v)] ?? css.t0!
}

/** Fresh game: two spawned tiles on an empty board. */
function newGame(): { board: number[]; pop: number } {
  const board = new Array<number>(16).fill(0)
  spawnTile(board)
  const pop = spawnTile(board)
  return { board, pop }
}

/** Full props: the locale share (typed `t`). */
export type Game2048Props = PropsLocale<'slacker'>

/** The 2048 panel.
 * @param props - the locale share carrying the typed `t` seat.
 */
export function Game2048(props: Game2048Props): JSX.Element {
  const { t } = props
  const [board, setBoard] = useState<readonly number[]>(() => new Array<number>(16).fill(0))
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(0)
  const [over, setOver] = useState(false)
  const [pop, setPop] = useState(-1)
  const [ready, setReady] = useState(false)
  // Guards the restore race: no move before the saved state lands (or fails).
  const latest = useRef(0)

  // Restore the persisted game once on mount.
  useEffect(() => {
    const seq = ++latest.current
    void kvGet(KV_KEY).then(saved => {
      if (seq !== latest.current) return
      if (saved !== null) {
        try {
          const parsed = JSON.parse(saved) as Saved
          if (Array.isArray(parsed.board) && parsed.board.length === 16) {
            setBoard(parsed.board.map(Number))
            setScore(Number(parsed.score) || 0)
            setBest(Number(parsed.best) || 0)
            setOver(!movesLeft(parsed.board))
            setReady(true)
            return
          }
        } catch { /* malformed save: fall through to a fresh game */ }
      }
      const fresh = newGame()
      setBoard(fresh.board); setPop(fresh.pop)
      setReady(true)
    })
  }, [])

  // Persist after every state change (the kv file is tiny and local).
  useEffect(() => {
    if (!ready) return
    const saved: Saved = { board, score, best }
    void kvSet(KV_KEY, JSON.stringify(saved))
  }, [ready, board, score, best])

  const restart = useCallback(() => {
    const fresh = newGame()
    setBoard(fresh.board); setScore(0); setPop(fresh.pop); setOver(false)
  }, [])

  const move = useCallback((dir: 'up' | 'down' | 'left' | 'right') => {
    if (over) return
    setBoard(prevBoard => {
      let moved = false
      let gained = 0
      const next = [...prevBoard]
      for (const idx of lineIndices(dir)) {
        const vals = idx.map(i => next[i]!).filter(v => v !== 0)
        const merged: number[] = []
        for (let k = 0; k < vals.length; k++) {
          if (k + 1 < vals.length && vals[k] === vals[k + 1]) {
            merged.push(vals[k]! * 2)
            gained += vals[k]! * 2
            k++
          } else merged.push(vals[k]!)
        }
        while (merged.length < 4) merged.push(0)
        idx.forEach((i, k) => {
          if (next[i] !== merged[k]) moved = true
          next[i] = merged[k]!
        })
      }
      if (!moved) return prevBoard
      const popped = spawnTile(next)
      setPop(popped)
      if (gained > 0) setScore(s => s + gained)
      if (!movesLeft(next)) setOver(true)
      return next
    })
  }, [over])

  // Best tracks the running score (kept out of the move updater: pure).
  useEffect(() => { setBest(b => Math.max(b, score)) }, [score])

  // Keyboard: arrows move, R restarts. The zone itself owns Alt+M/Esc.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as
        Record<string, 'up' | 'down' | 'left' | 'right'>)[ev.key]
      if (dir !== undefined) { ev.preventDefault(); move(dir); return }
      if (ev.key === 'r' || ev.key === 'R') restart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [move, restart])

  return (
    <div className={css.root}>
      <div className={css.bar}>
        <div className={css.stats}>
          <span className={css.stat}>
            <span className={css.statLabel}>{t('game.2048.score')}</span>
            <b>{score.toLocaleString()}</b>
          </span>
          <span className={css.stat}>
            <span className={css.statLabel}>{t('game.2048.best')}</span>
            <b>{best.toLocaleString()}</b>
          </span>
        </div>
        <button type="button" className={css.new} onClick={restart}>{t('game.2048.new')}</button>
      </div>
      <div className={css.board}>
        {board.map((v, i) => (
          <div key={i} className={tileClass(v) + (i === pop ? ' ' + css.pop : '')}>{v === 0 ? '' : v}</div>
        ))}
        {over && (
          <div className={css.over}>
            <span>{t('game.2048.over')}</span>
            <button type="button" className={css.new} onClick={restart}>{t('game.2048.new')}</button>
          </div>
        )}
      </div>
      <div className={css.hint}>{t('game.2048.hint')}</div>
    </div>
  )
}
