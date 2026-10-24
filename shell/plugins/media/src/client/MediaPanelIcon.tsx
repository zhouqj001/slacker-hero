/**
 * Sidebar row glyph for the media workbench: a small "newspaper" — the
 * feed/article imagery the studio is built around. Strokes follow
 * `currentColor` so the sidebar's selected/hover tinting applies for free.
 * @module @slacker/media/client
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props the sidebar hands its panel-row icons. */
export type MediaPanelIconProps = PropsRuntime<'sidebar.panellist'>

/** Renders the row glyph at the edge the sidebar asks for.
 * @param props - sidebar icon share (`size`, `active`).
 * @returns decorative newspaper icon.
 */
export function MediaPanelIcon({ size }: MediaPanelIconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M7 9.5h6.5" />
      <path d="M7 12.5h10" />
      <path d="M7 15.5h10" />
    </svg>
  )
}
