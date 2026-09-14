/**
 * Standalone local type stubs for the dsh client protocol modules.
 *
 * The standalone shell no longer embeds the dsh (deepseek-harness) package
 * tree, whose `@deepseek-ai/*` modules are *type-only* imports in this code:
 * every consumer uses `import type` (erased at build time) and the real dsh
 * packages are never loaded at runtime by `npm run shell` — the standalone
 * windows (tea.html / novel.html / stock-mini.html) mount the views directly.
 *
 * These stubs declare only the symbols the source actually consumes, keeping
 * `tsc --noEmit` green inside this standalone repo. They do not ship in the
 * bundle (tsdown strips type-only imports).
 */

declare module '@deepseek-ai/cordis' {
  /** Bare cordis context face consumed by the dsh plugin entry points. */
  export interface Context {
    effect(fn: () => unknown, name?: string): void
    locale: {
      register(namespace: string, dicts: Record<string, Record<string, string>>): void
      bind(ns: string): (key: string, params?: Record<string, unknown>) => string
    }
    slots: {
      register(spec: unknown, component: unknown): unknown
      inject(name: string, fn: () => unknown): unknown
    }
    invariants: { register(name: string, installer: unknown): Promise<() => void> }
  }
}

declare module '@deepseek-ai/dsh-invariants' {
  /** Invariant installer factory shape used by the invariant companion. */
  export type InvariantInstaller = (ctx: import('@deepseek-ai/cordis').Context) => void
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Translate a dictionary key with optional `{name}` templateUrl params. */
  export type Translate<K extends string = string> = (key: K, params?: Record<string, unknown>) => string

  /** Locale dictionary mapping for a namespace (`LocaleNamespaceMap` merge). */
  export interface LocaleNamespaceMap {}

  /** Slot contract table (`SlotMap` merge). */
  export interface SlotMap {}

  /** Props granted to a slot component bound to the given locale namespace. */
  export type PropsLocale<K extends string = string> = {
    /** Locale-aware translate; accepts any registered dictionary key. */
    t: Translate<string>
    localeKey?: string
  }

  /** Props granted to a slot component registered on a runtime slot scope. */
  export type PropsRuntime<S extends string = string> = {
    runtime: S
  }

  /** Props granted to a slot component that renders child slots. */
  export type PropsRenderSlots<S extends string = string> = {
    renderSlot: (name: S | string, props?: unknown, opts?: { fallback?: import('react').ReactNode }) => import('react').ReactNode
  }
}