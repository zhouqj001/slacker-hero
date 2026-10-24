/**
 * 小说工坊主壳：左侧三页导航（书架/发布/账号）+ 页面切换 + 全局 toast。
 * 打开作品时由 BookPage 接管主区（自含顶栏与返回）。账号列表在此层载入并下发。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WriterAccount } from './common.ts'
import { apiGet, s } from './common.ts'
import { AccountsPage } from './pages/AccountsPage.tsx'
import { BookPage } from './pages/BookPage.tsx'
import { PublishPage } from './pages/PublishPage.tsx'
import { ShelfPage } from './pages/ShelfPage.tsx'

type Nav = 'shelf' | 'publish' | 'accounts'

const NAV_META: { id: Nav; label: string }[] = [
  { id: 'shelf', label: '书架' },
  { id: 'publish', label: '发布' },
  { id: 'accounts', label: '账号' },
]

const NAV_TITLE: Record<Nav, string> = {
  shelf: '书架',
  publish: '发布管理',
  accounts: '番茄账号',
}

/** 全局 toast（非 err 为常规提示）。 */
interface ToastState {
  msg: string
  err: boolean
}

export function WriterPanel(_props: Record<string, never>): JSX.Element {
  const [accounts, setAccounts] = useState<WriterAccount[]>([])
  const [nav, setNav] = useState<Nav>('shelf')
  const [openBookId, setOpenBookId] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = useCallback((msg: string, err = false) => {
    setToast({ msg, err })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 4200)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const reloadAccounts = useCallback(() => {
    void apiGet<WriterAccount[]>('/api/writer/accounts')
      .then(setAccounts)
      .catch(() => {})
  }, [])

  useEffect(() => { reloadAccounts() }, [reloadAccounts])

  const openBook = useCallback((id: string) => { setOpenBookId(id) }, [])

  const backToShelf = useCallback(() => {
    setOpenBookId(null)
    reloadAccounts()
  }, [reloadAccounts])

  const navCls = (id: Nav): string => `${s.navBtn} ${nav === id ? s.navBtnActive : ''}`
  const brand = (
    <div className={s.navBrand}>小说工坊</div>
  )

  if (openBookId != null) {
    return (
      <div className={s.root}>
        <div className={s.main}>
          <BookPage bookId={openBookId} accounts={accounts} showToast={showToast} onBack={backToShelf} />
        </div>
        {toast && <div className={s.toast}>{toast.msg}</div>}
      </div>
    )
  }

  return (
    <div className={s.root}>
      <div className={s.nav}>
        {brand}
        {NAV_META.map(n => (
          <button key={n.id} className={navCls(n.id)} onClick={() => setNav(n.id)}>{n.label}</button>
        ))}
      </div>
      <div className={s.main}>
        <div className={s.topbar}>
          <div className={s.topbarTitle}>{NAV_TITLE[nav]}</div>
        </div>
        <div className={s.page}>
          {nav === 'shelf' && <ShelfPage accounts={accounts} onOpen={openBook} showToast={showToast} />}
          {nav === 'publish' && <PublishPage accounts={accounts} reloadAccounts={reloadAccounts} showToast={showToast} />}
          {nav === 'accounts' && <AccountsPage accounts={accounts} reload={reloadAccounts} showToast={showToast} />}
        </div>
      </div>
      {toast && <div className={s.toast}>{toast.msg}</div>}
    </div>
  )
}
