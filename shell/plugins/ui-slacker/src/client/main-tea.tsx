// @ts-nocheck
/**
 * 茶水间独立窗口入口：直挂载 SlackerOverlay(TEA_MODE)，
 * 以内置 locale 替代 dsh ctx.locale，novel 标签直引 NovelView。
 */
import { createRoot } from 'react-dom/client'
import { LocaleProvider, useLocale } from './locale-provider'
import { SlackerOverlay } from './SlackerOverlay'
import { useState, useEffect } from 'react'

/** 通过 ModuleLoader 获取 novel 插件主入口的导出（client.js 已注册 factory）。 */
function loadNovelModule() {
  return window.__ModuleLoader__.require('@slacker/novel')
}

/** 茶水间根组件：异步加载 novel 模块后渲染。 */
function TeaRoot() {
  const { t: tSlacker, lang } = useLocale()
  // novel 插件 client 入口导出：{ NovelView, zh, en, apply, inject }
  const [novel, setNovel] = useState<{
    NovelView: React.ComponentType<any>
    zh?: Record<string, string>
    en?: Record<string, string>
  } | null>(null)

  useEffect(() => {
    try {
      const mod = loadNovelModule()
      if (!mod || !mod.NovelView) throw new Error('novel module exports NovelView')
      setNovel({ NovelView: mod.NovelView, zh: mod.zh, en: mod.en })
    } catch (err) {
      console.error('[slacker] load novel module failed:', err)
    }
  }, [])

  if (!novel || !novel.NovelView) {
    return <div className="loading" style={{padding: 20, color: '#888'}}>加载中…</div>
  }

  const { NovelView, zh: novelZh = {}, en: novelEn = {} } = novel
  const novelDict = lang === 'zh' ? novelZh : novelEn
  const tNovel = (key: any): string => novelDict[key] ?? key

  const renderSlot = (name: string, _props: unknown, _opts?: { fallback?: React.ReactNode }) => {
    if (name === 'slacker.novel') return <NovelView t={tNovel} />
    return _opts?.fallback ?? null
  }

  return <SlackerOverlay t={tSlacker as any} renderSlot={renderSlot} />
}

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <TeaRoot />
  </LocaleProvider>
)