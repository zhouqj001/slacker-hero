/**
 * 茶水间设置页：注册进 dsh 设置面板（settings.section）——快速进入按钮 +
 * 小说阅读弹窗透明度（与 novel 插件共用 kv `novel.settings`）+ 弹窗配色
 * （茶水间/小说/游戏/股票各自可覆盖背景、文字、强调色，留空跟随主题）。
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  POPUP_PALETTE_KEY,
  refreshThemeBridge,
  type PopupBlockColors,
  type PopupBlockId,
  type PopupPalette,
} from './theme-bridge.ts'
import css from './TeaSettings.module.css'

/** Tauri invoke 桥的形态（withGlobalTauri 暴露）。 */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** 解析 Tauri invoke 桥；壳外（纯浏览器）为 undefined。 */
function shellInvoke(): Invoke | undefined {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke }
  }
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke
}

/** 与 novel 插件共用的持久化配置 key 与最小值。 */
const NOVEL_SETTINGS_KEY = 'novel.settings'
const OPACITY_MIN_PCT = 40
const OPACITY_MAX_PCT = 100

/** 茶水间设置页 props：设置页 owner 份额 + 本插件 locale（无子 slot）。 */
export type TeaSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'slacker'>

/** 打开独立茶水窗（存在则聚焦）。 */
function openTeaWindow(): void {
  const invoke = shellInvoke()
  if (invoke === undefined) return
  // 失败只记日志：托盘/Alt+M 仍是等价入口，不打断设置操作。
  void invoke('slacker_tea_window', { action: 'open' })
    .catch((err: unknown) => console.error('[slacker] settings open tea failed:', err))
}

/**
 * 渲染茶水间设置页。
 * @param props - 带类型化 `t` 的 locale 份额。
 */
export function TeaSettings(props: TeaSettingsProps): JSX.Element {
  const { t } = props
  const [opacityPct, setOpacityPct] = useState(OPACITY_MAX_PCT)
  const [palette, setPalette] = useState<PopupPalette>({})

  // 初始值来自 novel 持久化配置 + 弹窗配色表。
  useEffect(() => {
    const invoke = shellInvoke()
    if (invoke === undefined) return
    void invoke('slacker_kv_get', { key: NOVEL_SETTINGS_KEY })
      .then(raw => {
        if (typeof raw !== 'string' || raw === '') return
        const saved = JSON.parse(raw) as { windowOpacity?: number }
        const v = saved.windowOpacity
        if (typeof v === 'number' && v > 0) {
          setOpacityPct(Math.round(v * 100))
        }
      })
      .catch(err => console.error('[slacker] read tea settings failed:', err))
    void invoke('slacker_kv_get', { key: POPUP_PALETTE_KEY })
      .then(raw => {
        if (typeof raw !== 'string' || raw === '') return
        try {
          const parsed = JSON.parse(raw) as PopupPalette
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) setPalette(parsed)
        } catch { /* ignore */ }
      })
      .catch(err => console.error('[slacker] read popup palette failed:', err))
  }, [])

  /** 透明度滑条：即时合并写回 novel 配置。 */
  function onOpacity(pct: number): void {
    setOpacityPct(Math.min(OPACITY_MAX_PCT, Math.max(OPACITY_MIN_PCT, pct)))
    const invoke = shellInvoke()
    if (invoke === undefined) return
    void invoke('slacker_kv_get', { key: NOVEL_SETTINGS_KEY })
      .then(raw => {
        const saved = typeof raw === 'string' && raw !== ''
          ? JSON.parse(raw) as { windowOpacity?: number }
          : {} as { windowOpacity?: number }
        const value = pct / 100
        void invoke('slacker_kv_set', {
          key: NOVEL_SETTINGS_KEY,
          value: JSON.stringify({ ...saved, windowOpacity: value }),
        })
      })
      .catch(err => console.error('[slacker] write tea settings failed:', err))
  }

  /** 弹窗配色持久化：写 kv 并让主题桥立即重采样（独立窗/浮层实时跟随）。 */
  function persistPalette(next: PopupPalette): void {
    setPalette(next)
    const invoke = shellInvoke()
    if (invoke === undefined) return
    void invoke('slacker_kv_set', { key: POPUP_PALETTE_KEY, value: JSON.stringify(next) })
      .catch(err => console.error('[slacker] write popup palette failed:', err))
    refreshThemeBridge()
  }

  /** 修改某模块某字段的色值。 */
  function onColor(block: PopupBlockId, field: keyof PopupBlockColors, value: string): void {
    persistPalette({ ...palette, [block]: { ...palette[block], [field]: value } })
  }

  /** 清空某模块某字段（该维度假回跟随主题）。 */
  function onResetColor(block: PopupBlockId, field: keyof PopupBlockColors): void {
    const current = palette[block]
    const nextBlock = current ? { ...current } : {}
    delete nextBlock[field]
    const next = { ...palette, [block]: nextBlock }
    if (Object.keys(nextBlock).length === 0) delete next[block]
    persistPalette(next)
  }

  const blocks: Array<{ id: PopupBlockId; label: string }> = [
    { id: 'tea', label: t('tea.blockTea') },
    { id: 'novel', label: t('tea.blockNovel') },
    { id: 'game', label: t('tea.blockGame') },
    { id: 'stock', label: t('tea.blockStock') },
    { id: 'zhihu', label: t('tea.blockZhihu') },
  ]
  const colorFields: Array<{ field: keyof PopupBlockColors; label: string }> = [
    { field: 'bg', label: t('tea.colorBg') },
    { field: 'fg', label: t('tea.colorFg') },
    { field: 'fg2', label: t('tea.colorFg2') },
    { field: 'accent', label: t('tea.colorAccent') },
  ]

  return (
    <div className={css.page}>
      <section className={css.card}>
        <button type="button" className={css.openBtn} onClick={openTeaWindow}>
          <span aria-hidden="true">☕</span>{t('tea.enter')}
        </button>
        <p className={css.dim}>{t('tea.ways')}</p>
      </section>
      <section className={css.card}>
        <label className={css.row} htmlFor="slacker-tea-opacity">
          <span>{t('tea.opacity')}</span>
          <span className={css.val}>{opacityPct}%</span>
        </label>
        <input
          id="slacker-tea-opacity"
          className={css.range}
          type="range"
          min={OPACITY_MIN_PCT}
          max={OPACITY_MAX_PCT}
          step={5}
          value={opacityPct}
          onChange={e => { onOpacity(Number(e.target.value)) }}
        />
      </section>
      <section className={css.card}>
        <div className={css.sectHead}>
          <span>{t('tea.popupColors')}</span>
          <span className={css.dim}>{t('tea.popupHint')}</span>
        </div>
        {blocks.map(({ id: block, label }) => (
          <div key={block} className={css.colorGroup}>
            <div className={css.colorGroupLabel}>{label}</div>
            {colorFields.map(({ field, label: fieldLabel }) => {
              const value = palette[block]?.[field]
              return (
                <label key={field} className={css.colorRow} htmlFor={`slacker-c${block}-${field}`}>
                  <span className={css.colorName}>{fieldLabel}</span>
                  <span className={css.colorCtrls}>
                    <input
                      id={`slacker-c${block}-${field}`}
                      type="color"
                      className={css.colorInput}
                      value={value ?? '#808080'}
                      onChange={e => { onColor(block, field, e.target.value) }}
                    />
                    {value !== undefined && (
                      <button
                        type="button"
                        className={css.colorReset}
                        title={t('tea.colorReset')}
                        onClick={() => { onResetColor(block, field) }}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        ))}
      </section>
    </div>
  )
}