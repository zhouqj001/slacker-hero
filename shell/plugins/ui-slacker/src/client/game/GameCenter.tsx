/**
 * The game tab body: launcher → game → back. Selection is local state;
 * the zone unmounts on close, so every entry into the tab starts at
 * the list (the games themselves restore their progress from kv).
 */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { GameList, type GameId } from './GameList.tsx'
import { Game2048 } from './Game2048.tsx'
import { GameSnake } from './GameSnake.tsx'
import css from './GameCenter.module.css'

/** Full props: the locale share. */
export type GameCenterProps = PropsLocale<'slacker'>

/** Render the launcher or the picked game.
 * @param props - the locale share carrying the typed `t` seat.
 */
export function GameCenter(props: GameCenterProps): JSX.Element {
  const [game, setGame] = useState<GameId | null>(null)
  return (
    <div className={css.root}>
      {game !== null && (
        <button type="button" className={css.back} onClick={() => { setGame(null) }}>
          {props.t('game.back')}
        </button>
      )}
      {game === '2048'
        ? <Game2048 t={props.t} />
        : game === 'snake'
          ? <GameSnake t={props.t} />
          : <GameList t={props.t} onPick={setGame} />}
    </div>
  )
}
