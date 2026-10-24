/**
 * 主窗自绘标题栏（主窗 decorations:false）：标题、⋯ 运维菜单与
 * 最小化/最大化/关闭同一行；整条是拖拽区（双击最大化由 Tauri 处理）。
 * 直接挂 body（不进 dsh 布局树），并给页面预留等高的顶部空间。
 * 仅壳内渲染（无 __TAURI__ 的纯浏览器 dev 不挂，页面保持全高）。
 */
import { useEffect, useRef, useState } from 'react'
import type { SlackerKey } from './locales.ts'
import css from './MainTitlebar.module.css'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** Tauri invoke 桥（withGlobalTauri 暴露）。 */
function shellInvoke(): Invoke | undefined {
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }
  return w.__TAURI__?.core?.invoke
}

/** 当前窗控制柄形态（仅用到的方法）。 */
interface WinHandle {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  onResized(handler: () => void): Promise<() => void>
}

/** 取当前窗控制柄；壳外为 undefined。 */
function winHandle(): WinHandle | undefined {
  const w = window as unknown as {
    __TAURI__?: { window?: { getCurrentWindow?: () => WinHandle } }
  }
  return w.__TAURI__?.window?.getCurrentWindow?.()
}

/** 重启 dsh harness：壳杀掉旧 runtime 重拉新端口；主窗由壳导航到新地址
 *  （标题栏随新文档重新挂载），茶水窗/阅读窗被壳一并关闭。壳外无桥。 */
async function restartHarness(): Promise<void> {
  const invoke = shellInvoke()
  if (invoke === undefined) return
  try {
    await invoke('shell_boot')
  } catch (err) {
    console.error('[slacker] restart harness failed:', err)
  }
}

/** 标题栏高度（px）；启动页 index.html 的 padding-top 与此同步。 */
export const TITLEBAR_PX = 38

/** 页面顶部预留标题栏空间：body 显式定高 + box-sizing，#root 跟随 100%。
 *  dsh 的 AppFrame 是 height:100% 链，body 缩了它跟着缩。 */
function reservePageSpace(): void {
  if (document.querySelector('style[data-slacker-titlebar]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.slackerTitlebar = ''
  tag.textContent =
    'body{margin:0!important;box-sizing:border-box!important;' +
    `height:100dvh!important;padding-top:${TITLEBAR_PX}px!important}` +
    '#root{height:100%}'
  document.head.appendChild(tag)
}

/** 完整 props：locale 绑定（由 index.ts 手动传入）。 */
export type MainTitlebarProps = { t: (key: SlackerKey) => string }

/** 主窗标题栏：拖拽区 + ⋯ 菜单 + 窗控（─ □ ✕）。 */
export function MainTitlebar({ t }: MainTitlebarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement | null>(null)

  // 挂载即预留页面空间，并跟随窗口尺寸同步最大化态（□/❐ 图标）。
  useEffect(() => {
    reservePageSpace()
    const win = winHandle()
    if (win === undefined) return
    let alive = true
    const sync = (): void => {
      void win.isMaximized().then(v => { if (alive) setMaximized(v) }).catch(() => {})
    }
    sync()
    const unlisten = win.onResized(sync).catch(() => undefined)
    return () => {
      alive = false
      void unlisten.then(f => f?.()).catch(() => {})
    }
  }, [])

  // ⋯ 菜单开着时点外面收起。
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (ev: MouseEvent): void => {
      if (moreRef.current && ev.target instanceof Node && !moreRef.current.contains(ev.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // ⋯ 菜单开着时 Esc 只收菜单（capture 截断，不传给 dsh 快捷键）。
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        ev.preventDefault()
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menuOpen])

  return (
    <div className={css.bar} data-tauri-drag-region>
      <div className={css.title} data-tauri-drag-region>浮生半日</div>
      <div className={css.controls}>
        <div className={css.moreWrap} ref={moreRef}>
          <button
            type="button"
            className={css.moreBtn}
            title={t('zone.more')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen(v => !v) }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {menuOpen && (
            <div className={css.menu} role="menu">
              <button
                type="button"
                role="menuitem"
                className={css.menuItem}
                onClick={() => { setMenuOpen(false); void restartHarness() }}
              >
                {t('zone.restartHarness')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className={css.winBtn}
          title="最小化"
          onClick={() => { void winHandle()?.minimize().catch(() => {}) }}
        >
          <span aria-hidden="true">─</span>
        </button>
        <button
          type="button"
          className={css.winBtn}
          title={maximized ? '还原' : '最大化'}
          onClick={() => { void winHandle()?.toggleMaximize().catch(() => {}) }}
        >
          <span aria-hidden="true">{maximized ? '❐' : '□'}</span>
        </button>
        <button
          type="button"
          className={`${css.winBtn} ${css.closeBtn}`}
          title="关闭"
          onClick={() => { void winHandle()?.close().catch(() => {}) }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  )
}
