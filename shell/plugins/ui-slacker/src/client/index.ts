/**
 * The slacker-zone overlay: a frame-wide leisure surface (novels, games,
 * stocks) over the work shell. Alt+M toggles, Esc returns to work instantly.
 * @module @deepseek-ai/dsh-client-ui-slacker/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the layout's SlotMap merge ('shell.overlay' and friends).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the settings slot declarations (settings.section) so this
// plugin's settings-page registration type-checks against the canonical owner.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SlackerOverlay } from './SlackerOverlay.tsx'
import { TeaSettings } from './TeaSettings.tsx'
import { installThemeBridge } from './theme-bridge.ts'
import { en, zh, type SlackerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Slacker zone controls copy. */
    slacker: SlackerKey
  }
  interface SlotMap {
    /** The overlay's novel seat — its body is contributed by the `@slacker/novel` plugin. */
    'slacker.novel': { kind: 'single'; scope: 'root' }
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'slacker'

/** Services required by the slacker-zone plugin. */
export const inject = ['slots', 'locale']

/** Registers the slacker-zone overlay into the layout-owned shell overlay slot.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // dsh 主窗：采样根 CSS 变量并广播，供茶水间/小说独立窗跟随主题。
  installThemeBridge()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-slacker: dictionaries')
  const t = ctx.locale.bind(NS)

  // Registering into another package's slot rides the inject-then-register
  // pattern: the contribution installs once `shell.overlay` is declared and
  // collapses with it on redeclaration.
  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({
        name: 'shell.overlay',
        id: 'slacker-zone',
        locale: NS,
        // Declaring is claiming: the novel seat renders inside this overlay,
        // and its occupant comes from the separate @slacker/novel plugin.
        children: { 'slacker.novel': { kind: 'single', scope: 'root' } },
      }, SlackerOverlay)),
    'ui-slacker: shell overlay registration',
  )

  // 茶水间设置页：占住设置面板导航的一席（settings.section 为列表槽，
  // 排序在 General 之后）。标签用 locale thunk，跟随运行时语言。
  ctx.effect(
    () => ctx.slots.inject('settings.section', () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'slacker-tea',
        order: 50,
        label: () => t('tea.settingsNav'),
        locale: NS,
      }, TeaSettings)),
    'ui-slacker: settings section registration',
  )
}

// Re-export for component-spec typing; not part of the plugin's runtime API.
export type SlackerOverlayProps = PropsLocale<'slacker'>
export type { TeaSettingsProps } from './TeaSettings.tsx'
