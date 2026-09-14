/**
 * The novel center plugin: local TXT + network book-source reading,
 * contributed into the slacker overlay's `slacker.novel` seat.
 * @module @slacker/novel/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type NovelKey } from './locales.ts'
import { NovelView } from './novel/NovelView.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Novel center controls copy. */
    novel: NovelKey
  }
  interface SlotMap {
    /** The slacker overlay's novel seat (declared by the overlay entry's children table). */
    'slacker.novel': { kind: 'single'; scope: 'root' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'novel'

/** Services required by the novel plugin. */
export const inject = ['slots', 'locale']

/** Registers the novel view into the slacker overlay's novel seat.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'novel: dictionaries')

  // The seat is declared by the ui-slacker overlay entry's children table;
  // the injection installs once it is declared and collapses with it on
  // redeclaration — the same contribution pattern the overlay itself uses
  // against `shell.overlay`.
  ctx.effect(
    () => ctx.slots.inject('slacker.novel', () =>
      ctx.slots.register({ name: 'slacker.novel', locale: NS }, NovelView)),
    'novel: slacker seat registration',
  )
}

// Re-export for component-spec typing; not part of the plugin's runtime API.
export type NovelViewProps = PropsLocale<'novel'>

// Export for standalone window usage (tea.html loads via ModuleLoader)
export { NovelView } from './novel/NovelView.tsx'
export { zh, en } from './locales.ts'
