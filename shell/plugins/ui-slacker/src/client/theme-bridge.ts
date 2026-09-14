/**
 * 主题桥：dsh 主窗 → 壳 → 独立窗。
 * 把 dsh 生效的根 CSS 变量（:root 规则声明的自定义属性，取解析后的计算值）
 * 连同根/体类名与 color-scheme 一起采样，再叠加「弹窗配色」自定义覆盖表，
 * 广播给壳缓存；茶水间 / 小说独立窗启动时拉取并订阅实时更新。
 * 仅 dsh 主窗（client 挂载点）会安装。
 */

interface ThemeBridgeGlobal {
  __TAURI__?: {
    core?: { invoke?: Invoke }
    invoke?: Invoke
    event?: { emit?: (evt: string, payload: unknown) => Promise<void> }
  }
}

/** Tauri invoke 桥的形态（withGlobalTauri 暴露）。 */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

export interface ThemeSnapshot {
  /** 根上生效的自定义属性快照（计算值，已解析为最终颜色/数值）。 */
  vars: Record<string, string>
  /** dsh 根元素挂的类名（类名分支类主题据此同步）。 */
  rootClass: string[]
  /** dsh body 挂的类名。 */
  bodyClass: string[]
  /** 显式 color-scheme；缺省时取 prefers-color-scheme 决出的 light/dark。 */
  colorScheme: string | null
  /** 弹窗配色自定义覆盖表（来自 kv，留空段即跟随主题）。 */
  custom: PopupPalette
}

/** 内部弹窗模块 id（独立窗/主窗浮层共用同一套 kv 表）。 */
export type PopupBlockId = 'tea' | 'novel' | 'game' | 'stock' | 'zhihu'

/** 单个模块的自定义配色：字段留空/缺省即跟随主题。 */
export interface PopupBlockColors {
  bg?: string
  fg?: string
  fg2?: string
  accent?: string
}

/** 全部模块的自定义配色表。 */
export type PopupPalette = Partial<Record<PopupBlockId, PopupBlockColors>>

/** 弹窗配色在 kv 里的持久化 key。 */
export const POPUP_PALETTE_KEY = 'slacker.popupColors'

/** 弹窗配色字段 → 覆盖的根 CSS 变量（独立窗与主窗浮层共用）。 */
export const POPUP_VAR_MAP: Readonly<Record<keyof PopupBlockColors, string>> = {
  bg: '--dsw-alias-bg-base',
  fg: '--dsw-alias-label-primary',
  fg2: '--dsw-alias-label-secondary',
  accent: '--dsw-alias-state-business-primary',
}

/** 收集在 :root 上声明过的自定义属性名（样式表 :root 规则 + 根内联样式）。 */
function collectVarNames(): Set<string> {
  const names = new Set<string>()
  const pushText = (cssText: string): void => {
    for (const m of cssText.matchAll(/--[\w-]+/g)) names.add(m[0])
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try { rules = sheet.cssRules } catch { continue }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && /^:root$/i.test(rule.selectorText)) {
        pushText(rule.style.cssText)
      }
    }
  }
  pushText(document.documentElement.getAttribute('style') ?? '')
  return names
}

/** 采样根上生效的自定义属性快照（计算值，已解析为最终颜色/数值）。 */
function snapshotThemeVars(): Record<string, string> {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  const vars: Record<string, string> = {}
  for (const name of collectVarNames()) {
    const value = cs.getPropertyValue(name).trim()
    if (value !== '') vars[name] = value
  }
  return vars
}

/** 决出 dsh 当前 color-scheme：显式 style > 计算值 > prefers-color-scheme。 */
function resolveColorScheme(): string | null {
  const explicit = document.documentElement.style.getPropertyValue('color-scheme').trim()
  if (explicit !== '') return explicit.split(/\s+/)[0] ?? null
  const computed = getComputedStyle(document.documentElement).getPropertyValue('color-scheme').trim()
  if (computed !== '' && computed !== 'normal') return computed.split(/\s+/)[0] ?? null
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** 采样完整主题快照（不含自定义覆盖，custom 由调用方合并）。 */
function snapshotTheme(): Omit<ThemeSnapshot, 'custom'> {
  const root = document.documentElement
  return {
    vars: snapshotThemeVars(),
    rootClass: Array.from(root.classList),
    bodyClass: document.body ? Array.from(document.body.classList) : [],
    colorScheme: resolveColorScheme(),
  }
}

/** 读取 kv 里的弹窗配色表；缺失或非法时回落空表。 */
export function readPopupPalette(invoke: Invoke): Promise<PopupPalette> {
  return invoke('slacker_kv_get', { key: POPUP_PALETTE_KEY })
    .then(raw => {
      if (typeof raw !== 'string' || raw === '') return {} as PopupPalette
      try {
        const parsed = JSON.parse(raw) as PopupPalette
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} as PopupPalette
      } catch { return {} as PopupPalette }
    })
    .catch(() => ({} as PopupPalette))
}

/** 安装成功的采样/广播 push（供设置页改配置后主动刷新）。 */
let refreshThemeBridgeRef: (() => void) | null = null

/** 让主窗立即重采样并广播最新主题 + 配色（改 kv 后调用）。 */
export function refreshThemeBridge(): void {
  refreshThemeBridgeRef?.()
}

/** 在 dsh 主窗安装采样/广播：启动即发一次，此后主题变动去抖 200ms 再发。 */
export function installThemeBridge(): void {
  const bridge = (window as unknown as ThemeBridgeGlobal).__TAURI__
  const emit = bridge?.event?.emit
  const invoke = bridge?.core?.invoke ?? bridge?.invoke
  if (emit === undefined || invoke === undefined) return
  const root = document.documentElement
  let timer: number | undefined
  const push = (): void => {
    const base = snapshotTheme()
    if (Object.keys(base.vars).length === 0) return
    void readPopupPalette(invoke)
      .then(custom => { void emit('slacker:theme', { ...base, custom }) })
      .catch(() => { void emit('slacker:theme', { ...base, custom: {} }) })
  }
  const debounce = (): void => {
    if (timer !== undefined) return
    timer = window.setTimeout(() => { timer = undefined; push() }, 200)
  }
  refreshThemeBridgeRef = push
  push()
  const mo = new MutationObserver(debounce)
  mo.observe(root, { attributes: true, attributeFilter: ['style', 'class'] })
  if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  for (const el of Array.from(document.querySelectorAll('style'))) {
    mo.observe(el, { childList: true, characterData: true, subtree: true })
  }
  mo.observe(document.head, { childList: true, subtree: true })
  // 系统深浅色切换（同一 root 变量下由 prefers-color-scheme 决定时也要跟上）。
  const mq = matchMedia('(prefers-color-scheme: dark)')
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', debounce)
  } else if (typeof mq.addListener === 'function') {
    mq.addListener(debounce)
  }
}