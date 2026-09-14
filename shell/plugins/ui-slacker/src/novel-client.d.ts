/** @slacker/novel/client 最小类型声明（供独立窗口入口引用，避免跨包 tsconfig 问题）。 */
import type { NovelKey } from '@slacker/novel/client/locales'

declare module '@slacker/novel/client/locales' {
  export const zh: Readonly<Record<NovelKey, string>>
  export const en: Readonly<Record<NovelKey, string>>
  export type { NovelKey }
}

declare module '@slacker/novel/client/novel/NovelView' {
  import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
  import type { NovelKey } from '@slacker/novel/client/locales'
  export interface NovelViewProps extends PropsLocale<'novel'> {}
  export const NovelView: React.FC<NovelViewProps>
}