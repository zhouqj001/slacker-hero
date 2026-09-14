/**
 * The game launcher, arcade-cabinet style: each game is a mini CRT
 * screen (scanlines + phosphor glow, CSS-drawn — no emoji), with the
 * marquee strip below carrying title/desc and the start pill.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlackerKey } from '../locales.ts'
import css from './GameList.module.css'

/** One launchable game. */
export type GameId = '2048' | 'snake'

/** Static card descriptor (copy keys ride the locale namespace). */
interface GameCard {
  readonly id: GameId
  readonly title: SlackerKey
  readonly desc: SlackerKey
  readonly ready: boolean
}

/** The roster. */
const GAMES: readonly GameCard[] = [
  { id: '2048', title: 'game.2048.title', desc: 'game.2048.desc', ready: true },
  { id: 'snake', title: 'game.snake.title', desc: 'game.snake.desc', ready: true },
]

/** Decorative mini-board pattern on the 2048 cabinet screen (attract mode). */
const MINI: readonly boolean[] = [
  true, false, true, false,
  false, true, false, true,
  true, false, false, true,
  false, true, true, false,
]

/** Decorative snake body on the snake cabinet screen (an "S" curl). */
const SNAKE: readonly boolean[] = [
  true, true, true, false,
  false, false, true, false,
  true, false, false, false,
  true, true, true, false,
]

/** Full props: locale share plus the pick callback. */
export type GameListProps = PropsLocale<'slacker'> & { onPick: (id: GameId) => void }

/** Render the arcade row.
 * @param props - the locale share and the pick callback.
 */
export function GameList({ t, onPick }: GameListProps): JSX.Element {
  return (
    <div className={css.root}>
      <div className={css.row}>
        {GAMES.map((g, i) => (
          <button
            key={g.id}
            type="button"
            className={css.card + (g.ready ? '' : ' ' + css.off)}
            disabled={!g.ready}
            style={{ animationDelay: i * 0.06 + 's' }}
            onClick={() => { if (g.ready) onPick(g.id) }}
          >
            <span className={css.screen} aria-hidden="true">
              {g.id === 'snake'
                ? (
                    <span className={css.miniGrid}>
                      {SNAKE.map((on, k) => (
                        <i key={k} className={(on ? css.on : '') + (k === 15 ? ' ' + css.fruit : '')} />
                      ))}
                    </span>
                  )
                : (
                    <span className={css.miniGrid}>
                      {MINI.map((on, k) => <i key={k} className={on ? css.on : ''} />)}
                    </span>
                  )}
              <b className={css.bezel}>
                {g.id === '2048' ? '2048' : 'SNAKE'}
                <small>{g.id === '2048' ? 'CLASSIC MODE' : 'EAT · GROW'}</small>
              </b>
            </span>
            <span className={css.marquee}>
              <span className={css.meta}>
                <b>{t(g.title)}</b>
                <span>{t(g.desc)}</span>
              </span>
              <span className={css.press}>{g.ready ? '▶ PRESS START' : t('game.coming')}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
