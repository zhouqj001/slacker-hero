/**
 * The snake arcade game — second slacker view, same family as the 2048
 * CRT: a CSS-drawn phosphor screen with a glowing grid; the snake glides
 * on absolutely-positioned cells via CSS transition. Board/score/best/
 * pause survive through the shell kv (`gsnake`), so tab switches and app
 * restarts never wipe a run. Pure component: locale share in only.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { kvGet, kvSet } from '../ipc.ts'
import css from './GameSnake.module.css'

/** Persistence key under the shell kv. */
const KV_KEY = 'gsnake'

const COLS = 20
const ROWS = 20
const CELLS = COLS * ROWS

/** A movement vector (dx, dy) in cell units. */
type Dir = readonly [dx: number, dy: number]

const UP: Dir = [0, -1]
const DOWN: Dir = [0, 1]
const LEFT: Dir = [-1, 0]
const RIGHT: Dir = [1, 0]

const KEY_DIRS: Record<string, Dir> = {
  ArrowUp: UP,
  ArrowDown: DOWN,
  ArrowLeft: LEFT,
  ArrowRight: RIGHT,
}

/** Persisted game shape (snake is cell indices, head first). */
interface Saved {
  snake: number[]
  food: number
  dir: Dir
  score: number
  best: number
  over: boolean
  paused: boolean
}

/** True when the index is a board cell. */
function inBoard(i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < CELLS
}

/** Random empty cell for the next fruit; -1 when the board is full. */
function spawnFood(snake: readonly number[]): number {
  const empty: number[] = []
  for (let i = 0; i < CELLS; i++) if (!snake.includes(i)) empty.push(i)
  return empty.length === 0 ? -1 : empty[Math.floor(Math.random() * empty.length)]!
}

/** A fresh run: a 3-segment snake heading right from mid-board. */
function newGame(): { snake: number[]; food: number } {
  const row = Math.floor(ROWS / 2)
  const snake = [row * COLS + 6, row * COLS + 5, row * COLS + 4]
  return { snake, food: spawnFood(snake) }
}

/** Advance one tick; `over` leaves the snake untouched for the replay. */
function step(
  snake: readonly number[],
  food: number,
  dir: Dir,
): { snake: number[]; food: number; ate: boolean; over: boolean } {
  const [dx, dy] = dir
  const head = snake[0] ?? -1
  const nx = (head % COLS) + dx
  const ny = Math.floor(head / COLS) + dy
  if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
    return { snake: [...snake], food, ate: false, over: true }
  }
  const nextHead = ny * COLS + nx
  const grow = nextHead === food
  // The tail vacates its cell this tick unless the head grows into food.
  const body = grow ? snake : snake.slice(0, -1)
  if (body.includes(nextHead)) {
    return { snake: [...snake], food, ate: false, over: true }
  }
  const next = [nextHead, ...snake]
  if (!grow) next.pop()
  const nextFood = grow ? spawnFood(next) : food
  return { snake: next, food: nextFood, ate: grow, over: nextFood < 0 }
}

/** Full props: the locale share (typed `t`). */
export type GameSnakeProps = PropsLocale<'slacker'>

/** The snake panel.
 * @param props - the locale share carrying the typed `t` seat.
 */
export function GameSnake({ t }: GameSnakeProps): JSX.Element {
  const [snake, setSnake] = useState<readonly number[]>([])
  const [food, setFood] = useState(-1)
  const [dir, setDir] = useState<Dir>(RIGHT)
  const [score, setScore] = useState(0)
  const [best, setBest] = useState(0)
  const [over, setOver] = useState(false)
  const [paused, setPaused] = useState(false)
  const [ready, setReady] = useState(false)
  /** Direction the snake is actually moving (mirror of `dir`). */
  const dirRef = useRef<Dir>(RIGHT)
  /** Direction applied by the last tick. */
  const appliedRef = useRef<Dir>(RIGHT)
  /** One turn consumed between ticks — stops self-clip from double-input. */
  const turnedRef = useRef(false)
  /** Mirror of `food`, so the ticker reads the committed value. */
  const foodRef = useRef(-1)

  useEffect(() => { dirRef.current = dir }, [dir])
  useEffect(() => { foodRef.current = food }, [food])

  // Restore the persisted game once on mount.
  useEffect(() => {
    void kvGet(KV_KEY).then(saved => {
      if (saved !== null) {
        try {
          const parsed = JSON.parse(saved) as Saved
          const ok = Array.isArray(parsed.snake) && parsed.snake.length >= 2 &&
            parsed.snake.every(i => inBoard(i)) &&
            typeof parsed.food === 'number' && inBoard(parsed.food)
          if (ok) {
            setSnake(parsed.snake)
            setFood(parsed.food)
            setDir([parsed.dir[0] ?? 0, parsed.dir[1] ?? 0])
            setScore(Number(parsed.score) || 0)
            setBest(Number(parsed.best) || 0)
            setOver(!!parsed.over)
            setPaused(!!parsed.paused)
            appliedRef.current = [parsed.dir[0] ?? 0, parsed.dir[1] ?? 0]
            setReady(true)
            return
          }
        } catch { /* malformed save: fall through to a fresh game */ }
      }
      const fresh = newGame()
      setSnake(fresh.snake)
      setFood(fresh.food)
      setScore(0)
      setOver(false)
      setPaused(false)
      setDir(RIGHT)
      appliedRef.current = RIGHT
      setReady(true)
    })
  }, [])

  // Persist after every state change (the kv file is tiny and local).
  useEffect(() => {
    if (!ready) return
    const saved: Saved = { snake: [...snake], food, dir, score, best, over, paused }
    void kvSet(KV_KEY, JSON.stringify(saved))
  }, [ready, snake, food, dir, score, best, over, paused])

  const restart = useCallback(() => {
    const fresh = newGame()
    setSnake(fresh.snake)
    setFood(fresh.food)
    setScore(0)
    setOver(false)
    setPaused(false)
    setDir(RIGHT)
    appliedRef.current = RIGHT
    turnedRef.current = false
  }, [])

  // The ticker; halts on pause, game over, or before the restore lands.
  useEffect(() => {
    if (!ready || over || paused) return
    const id = setInterval(() => {
      const pending = dirRef.current
      setSnake(prev => {
        const res = step(prev, foodRef.current, pending)
        if (res.over) { setOver(true); return prev }
        if (res.ate) {
          setScore(s => s + 1)
          setFood(res.food)
        }
        return res.snake
      })
      appliedRef.current = pending
      turnedRef.current = false
    }, 130)
    return () => clearInterval(id)
  }, [ready, over, paused])

  // Best tracks the run best (kept out of the ticker updater: pure).
  useEffect(() => { setBest(b => Math.max(b, score)) }, [score])

  // Keyboard: arrows steer, space pauses, R restarts. The zone owns Alt+M/Esc.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const candidate = KEY_DIRS[ev.key]
      if (candidate !== undefined) {
        ev.preventDefault()
        const [cax, cay] = candidate
        const [ax, ay] = appliedRef.current
        // Reject 180° flips and second turns inside one tick (self-clip guard).
        if (cax === -ax && cay === -ay) return
        if (turnedRef.current) return
        turnedRef.current = true
        setDir(candidate)
        return
      }
      if (ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault()
        setPaused(p => !p)
        return
      }
      if (ev.key === 'r' || ev.key === 'R') restart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [restart])

  const head = snake[0]

  return (
    <div className={css.root}>
      <div className={css.bar}>
        <div className={css.stats}>
          <span className={css.stat}>
            <span className={css.statLabel}>{t('game.snake.score')}</span>
            <b>{score.toLocaleString()}</b>
          </span>
          <span className={css.stat}>
            <span className={css.statLabel}>{t('game.snake.best')}</span>
            <b>{best.toLocaleString()}</b>
          </span>
        </div>
        <button type="button" className={css.new} onClick={restart}>{t('game.snake.new')}</button>
      </div>
      <div className={css.board}>
        {food >= 0 && (
          <span
            className={css.food}
            style={{ left: `${(food % COLS) * 5}%`, top: `${Math.floor(food / COLS) * 5}%` }}
          />
        )}
        {head !== undefined && snake.map((i, k) => (
          <span
            key={k}
            className={k === 0 ? css.head : css.cell}
            style={{
              left: `${(i % COLS) * 5}%`,
              top: `${Math.floor(i / COLS) * 5}%`,
              opacity: k === 0 ? 1 : Math.max(0.55, 0.95 - 0.5 * (k / (snake.length - 1))),
            }}
          />
        ))}
        {over && (
          <div className={css.over}>
            <span>{t('game.snake.over')}</span>
            <button type="button" className={css.new} onClick={restart}>{t('game.snake.new')}</button>
          </div>
        )}
        {paused && !over && (
          <div className={css.paused}>
            <span>{t('game.snake.paused')}</span>
            <span className={css.pausedSub}>{t('game.snake.hint')}</span>
          </div>
        )}
      </div>
      <div className={css.hint}>{t('game.snake.hint')}</div>
    </div>
  )
}