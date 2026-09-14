// @ts-nocheck
/**
 * 小说阅读独立窗口入口：直挂载 NovelView，
 * 以内置 locale 替代 dsh ctx.locale。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, useLocale } from './locale-provider'
import { NovelView } from './novel/NovelView'

function NovelRoot() {
  const { t } = useLocale()
  return <NovelView t={t as any} />
}

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <NovelRoot />
  </LocaleProvider>
)