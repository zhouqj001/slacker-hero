/** 独立窗口用的简易 locale provider（替代 dsh 的 ctx.locale）。 */
import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { zh, en, type SlackerKey } from './locales.ts'

type Lang = 'zh' | 'en'
const dict = { zh, en } as const

interface LocaleCtx {
  t: (key: SlackerKey) => string
  lang: Lang
  setLang: (l: Lang) => void
}

const LocaleContext = createContext<LocaleCtx | null>(null)

export function LocaleProvider({ children, initialLang = 'zh' }: { children: ReactNode; initialLang?: Lang }) {
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem('slacker:lang') as Lang) ?? initialLang } catch { return initialLang }
  })
  const t = (key: SlackerKey): string => dict[lang][key] ?? key
  useEffect(() => { try { localStorage.setItem('slacker:lang', lang) } catch {} }, [lang])
  return <LocaleContext.Provider value={{ t, lang, setLang }}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleCtx {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider')
  return ctx
}