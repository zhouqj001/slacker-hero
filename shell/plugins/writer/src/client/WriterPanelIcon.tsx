/**
 * Sidebar row glyph for the writer panel: an open book — 侧栏行图标，
 * currentColor 描边以免费获得选中/悬停着色。
 * @module @slacker/writer/client
 */

/** Props the sidebar hands its panel-row icons（本地最小面，见 index.ts）。 */
export interface WriterPanelIconProps {
  size?: number
  active?: boolean
}

/** Renders the row glyph at the edge the sidebar asks for.
 * @param props - sidebar icon share (`size`, `active`).
 * @returns decorative open-book icon.
 */
export function WriterPanelIcon({ size }: WriterPanelIconProps): JSX.Element {
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
      <path d="M12 6.2C10.6 4.8 8.6 4 6 4H3.5v14H6c2.6 0 4.6.8 6 2.2 1.4-1.4 3.4-2.2 6-2.2h2.5V4H18c-2.6 0-4.6.8-6 2.2Z" />
      <path d="M12 6.2v14" />
    </svg>
  )
}
