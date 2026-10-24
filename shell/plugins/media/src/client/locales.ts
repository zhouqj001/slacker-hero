/** Locale dictionaries for the media studio plugin (namespace `media`).
 *
 * The studio's own copy is written inline (it targets a Chinese-first
 * operator); the dictionary only carries the chrome text the shell renders
 * on the plugin's behalf — currently just the sidebar row label.
 */

export const zh = {
  'panel.nav': '媒体工作台',
} as const

export const en: Record<MediaKey, string> = {
  'panel.nav': 'Media Workbench',
}

export type MediaKey = keyof typeof zh
