/**
 * The media studio plugin, browser half. Registers the studio as a first-class
 * main panel: a `main` seat hosts the workbench UI, a `sidebar.panellist` row
 * (icon + label) selects it, mirroring the shipped schedule/plugin panels.
 * @module @slacker/media/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the SlotMap entries for the two seats below ('main' and
// the layout geometry the panel lives in).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the SlotMap entry for 'sidebar.panellist'.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MediaStudioPanel } from './MediaStudioPanel.tsx'
import { MediaPanelIcon } from './MediaPanelIcon.tsx'
import { en, zh, type MediaKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Media studio controls copy. */
    media: MediaKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'media'

/** Sidebar row id and its `main`-slot key; the two registrations must match. */
const PANEL_ID = 'media'

/** Services required by the media browser half. */
export const inject = ['slots', 'locale']

/** Registers the media workbench as a sidebar-selectable main panel.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'media: dictionaries')
  const t = ctx.locale.bind(NS)

  // Central workbench, dispatched by PANEL_ID (the sidebar row's target).
  ctx.effect(
    () => ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: PANEL_ID }, MediaStudioPanel)),
    'media: main panel registration',
  )

  // Sidebar row (after schedules' 10): clicking it selects the panel above.
  ctx.effect(
    () => ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('panel.nav'),
        locale: NS,
      }, MediaPanelIcon)),
    'media: sidebar row registration',
  )
}

export type { MediaKey }
