/**
 * 茶水间 ·「独立弹窗」重设计（v6）。
 * 壳（Tauri）内：主窗 ☕ / Alt+M 唤起独立的「茶」OS 窗口（同一 dsh URL
 * 加 &tea=1），插件检测到该标记即整窗渲染茶水间；✕ / Esc 关窗。
 * 纯浏览器（无壳 dev）：回落 v5 角落浮窗。配色延续 v4「原生隐身」dsh 令牌。
 * 小说页身仍由 @slacker/novel 插件注入。
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { GameCenter } from './game/GameCenter.tsx'
import { StockView } from './stock/StockView.tsx'
import { ZhihuView } from './zhihu/ZhihuView.tsx'
import {
  POPUP_VAR_MAP,
  readPopupPalette,
  type PopupBlockColors,
  type PopupPalette,
} from './theme-bridge.ts'
import type { SlackerKey } from './locales.ts'
import css from './SlackerOverlay.module.css'

/** 休闲标签 id。 */
type Tab = 'novel' | 'game' | 'stock' | 'zhihu'

/** 标签顺序。 */
const TABS: readonly Tab[] = ['novel', 'game', 'stock', 'zhihu']

/** 标签文案 key（字面量类型保证 `t` 精确）。 */
const TAB_LABELS: Readonly<Record<Tab, SlackerKey>> = {
  novel: 'tab.novel', game: 'tab.game', stock: 'tab.stock', zhihu: 'tab.zhihu',
}

/** Tauri invoke 桥的形态（withGlobalTauri 暴露）。 */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** 解析 Tauri invoke 桥；壳外（纯浏览器）为 undefined。 */
function shellInvoke(): Invoke | undefined {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke }
  }
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke
}

/** 窗口模式：壳的茶水窗带初始化脚本标记（URL 参数会被 dsh 的 token
 *  消费清掉，仅作纯浏览器 dev 的次级探测）。 */
const TEA_MODE = (window as unknown as { __SLACKER_TEA__?: boolean }).__SLACKER_TEA__ === true
  || new URLSearchParams(window.location.search).get('tea') === '1'

/** 小说阅读窗：壳注入 __SLACKER_NOVEL_READER__ 的独立只读弹窗，整窗渲染
 *  小说（无 tabs/header/footer），✕ / Esc 关窗。 */
const NOVEL_MODE = (window as unknown as { __SLACKER_NOVEL_READER__?: boolean }).__SLACKER_NOVEL_READER__ === true

/**
 * 操控独立茶水窗；壳外或调用失败返回 false（调用方回落浮窗行为，
 * 同时保证用户总能拿到可用的茶水间）。
 * @param action - "toggle"：开↔关；"close"：仅关；"minimize"：最小化。
 */
async function teaWindow(action: 'toggle' | 'close' | 'minimize'): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    console.info('[slacker] no tauri bridge — plain browser, using float')
    return false
  }
  try {
    await invoke('slacker_tea_window', { action })
    return true
  } catch (err) {
    console.error('[slacker] tea window invoke failed:', err)
    return false
  }
}

/** 操控独立小说阅读窗；壳外或调用失败返回 false。 */
async function novelWindow(action: 'open' | 'close', book?: unknown): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    console.info('[slacker] no tauri bridge — plain browser, keep inline')
    return false
  }
  try {
    await invoke('slacker_novel_window', { action, book })
    return true
  } catch (err) {
    console.error('[slacker] novel window invoke failed:', err)
    return false
  }
}

/** 完整 props：locale 份额 + 小说座位（由独立插件贡献）。 */
export type SlackerOverlayProps = PropsLocale<'slacker'> & PropsRenderSlots<'slacker.novel'>

/** 渲染茶水间：tea 窗内整窗版，主窗/浏览器内浮窗版。
 * @param props - 携带类型化 `t` 的 locale 份额。
 */
export function SlackerOverlay(props: SlackerOverlayProps): JSX.Element | null {
  const { t, renderSlot } = props
  const [open, setOpen] = useState(TEA_MODE)
  const [tab, setTab] = useState<Tab>('novel')
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [palette, setPalette] = useState<PopupPalette>({})

  // 主窗/茶水窗浮层：读 kv 里的弹窗配色表。
  useEffect(() => {
    const invoke = shellInvoke()
    if (invoke === undefined) return
    void readPopupPalette(invoke).then(setPalette).catch(() => {})
  }, [])

  // 激活（tea 窗固定为茶水间模块）的自定义配色应用到浮层根；未设置跟随主题。
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const fieldKeys = Object.keys(POPUP_VAR_MAP) as Array<keyof PopupBlockColors>
    for (const field of fieldKeys) el.style.removeProperty(POPUP_VAR_MAP[field])
    const block = palette[TEA_MODE ? 'tea' : tab]
    if (!block) return
    for (const field of fieldKeys) {
      const value = block[field]
      if (typeof value === 'string' && value !== '') el.style.setProperty(POPUP_VAR_MAP[field], value)
    }
  }, [tab, palette])

  // 主窗最小化 → 缩进托盘（hide 而非最小化，任务栏不留残影；托盘恢复
  // 走 Rust 菜单）。novel/tea 独立窗不参与：它们是自带窗口的浮层。
  useEffect(() => {
    if (TEA_MODE || NOVEL_MODE) return
    const w = window as unknown as {
      __TAURI__?: {
        window?: {
          getCurrentWindow?: () => {
            onResized?: (cb: () => void) => Promise<() => void>
            isMinimized?: () => Promise<boolean>
            hide?: () => Promise<void>
          }
        }
      }
    }
    const win = w.__TAURI__?.window?.getCurrentWindow?.()
    if (!win) return
    const { onResized, isMinimized, hide } = win
    if (!onResized || !isMinimized || !hide) return
    void onResized(() => {
      void isMinimized().then(m => { if (m) void hide() }).catch(() => {})
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        // 阅读窗内 Esc=关窗（老板键）；tea 窗内同；浮窗态只是收起。
        if (NOVEL_MODE) void novelWindow('close')
        else if (TEA_MODE) void teaWindow('close')
        else setOpen(false)
        return
      }
      if (ev.altKey && ev.code === 'KeyM') {
        ev.preventDefault()
        // 茶水窗内 Alt+M=最小化（老板键），主窗=唤/收独立窗（失败回落浮窗），
        // 纯浏览器直接浮窗开关。阅读窗 Alt+M 不介入（由阅读页自身处理）。
        if (TEA_MODE) void teaWindow('minimize')
        else if (shellInvoke() !== undefined) void teaWindow('toggle').then(ok => { if (!ok) setOpen(true) })
        else setOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 小说阅读窗：整窗只渲染阅读器（无 tabs/header/footer），无返架入口。
  if (NOVEL_MODE) {
    return (
      <div className={css.overlayNovel} data-slacker-zone>
        <main className={css.bodyNovel}>
          {renderSlot('slacker.novel', {}, { fallback: <></> })}
        </main>
      </div>
    )
  }

  // 主窗关闭态：无悬浮入口（☕ 已缩进系统托盘；Alt+M 仍可唤出）。
  if (!open) return null

  return (
    <div ref={overlayRef} className={TEA_MODE ? css.overlayTea : css.overlay} data-slacker-zone>
      {/* 壳内：头部即拖拽区（data-tauri-drag-region="deep" 使整棵子树可拖，
          交互元素（按钮等）仍自动放行），可随手移动窗口 */}
      <header className={css.header} data-tauri-drag-region={TEA_MODE ? 'deep' : undefined}>
        <span className={css.title} data-tauri-drag-region={TEA_MODE ? 'deep' : undefined}>
          <span aria-hidden="true">☕</span>{t('zone.title')}
        </span>
        <nav className={css.tabs}>
          {TABS.map(id => (
            <button
              key={id}
              type="button"
              className={id === tab ? css.tabActive : css.tab}
              onClick={() => { setTab(id) }}
            >
              <span className={css.tabDot} aria-hidden="true" />
              {t(TAB_LABELS[id])}
            </button>
          ))}
        </nav>
        <div className={css.headerRight}>
          {TEA_MODE && (
            <button
              type="button"
              className={css.winBtn}
              title={t('zone.min')}
              onClick={() => { void teaWindow('minimize') }}
            >
              <span aria-hidden="true">—</span>
            </button>
          )}
          <button
            type="button"
            className={css.winBtn}
            title={t('zone.close')}
            onClick={() => {
              if (TEA_MODE) void teaWindow('close')
              else setOpen(false)
            }}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </header>
      <main className={css.body}>
        {tab === 'game' && <GameCenter t={t} />}
        {tab === 'novel' && renderSlot('slacker.novel', {}, { fallback: <></> })}
        {tab === 'stock' && <StockView t={t} />}
        {tab === 'zhihu' && <ZhihuView t={t} />}
      </main>
      <footer className={css.footer}>
        <kbd>Alt+M</kbd>{t('zone.hint')} · <kbd>Esc</kbd>{t('zone.boss')}
      </footer>
    </div>
  )
}
