// @ts-nocheck
/**
 * 股票悬浮窗独立窗口入口：直挂载 StockMiniWindow，
 * 以内置 locale 替代 dsh ctx.locale。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, useLocale } from './locale-provider'
import { StockMiniWindow } from './stock/StockMiniWindow'

function StockMiniRoot() {
  const { t } = useLocale()
  return <StockMiniWindow t={t as any} />
}

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <StockMiniRoot />
  </LocaleProvider>
)