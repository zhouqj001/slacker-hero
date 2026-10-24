/**
 * The writer plugin (小说工坊), browser half. Registers the workshop as a
 * first-class main panel: a `main` seat hosts the UI, a `sidebar.panellist`
 * row (icon + label) selects it — same shape as the shipped media panel.
 *
 * Unlike the media plugin this half does NOT import the vendored dsh client
 * type packages (they are not wired into this package's devDependencies), so
 * the host services it needs are described by a local structural interface
 * and reached through one assertion. Runtime behavior is identical: cordis
 * service resolution happens on the live shell context.
 * @module @slacker/writer/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WriterPanel } from './WriterPanel.tsx'
import { WriterPanelIcon } from './WriterPanelIcon.tsx'
import { en, zh, type WriterKey } from './locales.ts'

/** Locale dictionary callback produced by `locale.bind`. */
type LocaleBinding = (key: WriterKey) => string

/**
 * Minimal structural view of the host services this half touches. The shell
 * satisfies it at runtime; it exists purely so this package compiles without
 * the vendored `@deepseek-ai/dsh-client-*` type bundles.
 */
interface ClientServices {
  effect(fn: () => void, name: string): void
  slots: {
    inject(name: string, fn: () => void): void
    register(options: Record<string, unknown>, component: (props: never) => JSX.Element): void
  }
  locale: {
    register(ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }): void
    bind(ns: string): LocaleBinding
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'writer'

/** Sidebar row id and its `main`-slot key; the two registrations must match. */
const PANEL_ID = 'writer'

/** Services required by the writer browser half. */
export const inject = ['slots', 'locale']

/** Registers the novel workshop as a sidebar-selectable main panel.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const c = ctx as unknown as ClientServices
  c.effect(() => c.locale.register(NS, { zh, en }), 'writer: dictionaries')
  const t = c.locale.bind(NS)

  // Central workbench, dispatched by PANEL_ID (the sidebar row's target).
  c.effect(
    () => c.slots.inject('main', () =>
      c.slots.register({ name: 'main', key: PANEL_ID }, WriterPanel)),
    'writer: main panel registration',
  )

  // Sidebar row (after media's 20): clicking it selects the panel above.
  c.effect(
    () => c.slots.inject('sidebar.panellist', () =>
      c.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 21,
        label: () => t('panel.nav'),
        locale: NS,
      }, WriterPanelIcon)),
    'writer: sidebar row registration',
  )
}

export type { WriterKey }
