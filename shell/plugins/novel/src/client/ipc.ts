/**
 * The shell IPC seam: the novel view persists through the Rust shell
 * (Tauri `slacker_*` commands), never localStorage — the dsh webview
 * origin changes on every boot (fresh port + token), which voids
 * browser storage. Outside the shell (plain-browser dsh dev) the same
 * API falls back to localStorage so components stay testable.
 * @module @slacker/novel/client/ipc
 */

/** Shape of Tauri's global invoke (exposed via withGlobalTauri). */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

import { getChapterText, splitChapters } from './novel/local-toc.ts'

/** Resolve the Tauri invoke bridge, if running inside the shell. */
export function shellInvoke(): Invoke | undefined {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke?: Invoke }; invoke?: Invoke }
  }
  return w.__TAURI__?.core?.invoke ?? w.__TAURI__?.invoke
}

/** Whether the novel view is running inside the Rust shell. */
export function inShell(): boolean {
  return shellInvoke() !== undefined
}

/** 独立阅读弹窗：开（带书）。成功/弹窗可用返回 true；壳外或失败 false。 */
export async function novelWindowOpen(book: unknown): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) return false
  try { await invoke('slacker_novel_window', { action: 'open', book }); return true }
  catch (err) { console.error('[novel] open reader window failed:', err); return false }
}

/** 独立阅读弹窗：关。成功/壳外均返回 true（无弹窗可关也是落定）。 */
export async function novelWindowClose(): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) return false
  try { await invoke('slacker_novel_window', { action: 'close' }); return true }
  catch (err) { console.error('[novel] close reader window failed:', err); return false }
}

/** 悬浮小窗：把阅读弹窗收成屏幕底部细条（置顶）；false 还原。 */
export async function novelFloatMode(float: boolean): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) return false
  try { await invoke('slacker_novel_float', { float }); return true }
  catch (err) { console.error('[novel] float mode failed:', err); return false }
}

/** 阅读弹窗尺寸：文档皮肤切大窗（类 Office），其他皮肤切回默认小窗。 */
export async function novelWindowResize(wide: boolean): Promise<boolean> {
  const invoke = shellInvoke()
  if (invoke === undefined) return false
  try { await invoke('slacker_novel_resize', { wide }); return true }
  catch (err) { console.error('[novel] resize reader window failed:', err); return false }
}

/** Read one persisted novel value; null when absent. */
export async function kvGet(key: string): Promise<string | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    try { return localStorage.getItem('slacker:' + key) } catch { return null }
  }
  try { return (await invoke('slacker_kv_get', { key })) as string | null }
  catch (err) { console.warn('[novel] kvGet failed:', err); return null }
}

/** Persist one novel value (fire-and-forget; failures only log). */
export async function kvSet(key: string, value: string): Promise<void> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    try { localStorage.setItem('slacker:' + key, value) } catch { /* storage full/blocked */ }
    return
  }
  try { await invoke('slacker_kv_set', { key, value }) }
  catch (err) { console.warn('[novel] kvSet failed:', err) }
}

/* ── novels ─────────────────────────────────────────────────────── */

/** Browser-dev fallback shelf: name → full text, in one localStorage blob. */
function devShelf(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('slacker:novels') ?? '{}') as Record<string, string> }
  catch { return {} }
}

function devShelfWrite(shelf: Record<string, string>): void {
  try { localStorage.setItem('slacker:novels', JSON.stringify(shelf)) } catch { /* ignore */ }
}

/** List shelf names. */
export async function novelList(): Promise<string[]> {
  const invoke = shellInvoke()
  if (invoke === undefined) return Object.keys(devShelf()).sort()
  try { return (await invoke('slacker_novel_list')) as string[] }
  catch (err) { console.warn('[novel] novelList failed:', err); return [] }
}

/** Save (or overwrite) a novel. */
export async function novelSave(name: string, content: string): Promise<void> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    const shelf = devShelf(); shelf[name] = content; devShelfWrite(shelf); return
  }
  await invoke('slacker_novel_save', { name, content })
}

/** Load a novel's full text (chapter splitting is client-side). */
export async function novelLoad(name: string): Promise<string | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) return devShelf()[name] ?? null
  try { return (await invoke('slacker_novel_load', { name })) as string }
  catch (err) { console.warn('[novel] novelLoad failed:', err); return null }
}

/** 一条目录（本地章：只有展示字段；切章在 Rust，前端不持有全文）。 */
export interface NovelTocEntry {
  name: string
  isVolume: boolean
}

/** 章节目录（Rust 同款正则切章）。浏览器调试回落客户端切章。 */
export async function novelToc(name: string): Promise<NovelTocEntry[] | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    const full = devShelf()[name]
    if (full === undefined) return null
    return splitChapters(full).items.map(x => ({ name: x.name, isVolume: x.isVolume }))
  }
  try { return (await invoke('slacker_novel_toc', { name })) as NovelTocEntry[] }
  catch (err) { console.warn('[novel] novelToc failed:', err); return null }
}

/** 按章读取正文（Rust 定点读取，超大 TXT 也不整本进内存）。 */
export async function novelChapter(name: string, index: number): Promise<string> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    const full = devShelf()[name]
    if (full === undefined) return ''
    return getChapterText(full, splitChapters(full), index)
  }
  try { return (await invoke('slacker_novel_chapter', { name, index })) as string }
  catch (err) { console.warn('[novel] novelChapter failed:', err); return '' }
}

/** Delete a novel. */
export async function novelDelete(name: string): Promise<void> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    const shelf = devShelf(); delete shelf[name]; devShelfWrite(shelf); return
  }
  await invoke('slacker_novel_delete', { name })
}

/** 当前生效的小说下载目录（绝对路径）；壳外返回 null。 */
export async function novelDir(): Promise<string | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) return null
  try { return (await invoke('slacker_novel_dir')) as string }
  catch (err) { console.warn('[novel] novelDir failed:', err); return null }
}

/** 设置小说下载目录；传空字符串恢复默认（启动 exe 同目录）。
 * 路径无效/不可写时 reject（Rust 侧校验文案），由调用方展示。 */
export async function novelSetDir(dir: string): Promise<void> {
  const invoke = shellInvoke()
  if (invoke === undefined) {
    localStorage.setItem('slacker:novel.downloadDir', dir)
    return
  }
  await invoke('slacker_novel_set_dir', { dir })
}

/** 原生「选择文件夹」对话框；取消/null，壳外返回 null。 */
export async function novelPickDir(): Promise<string | null> {
  const invoke = shellInvoke()
  if (invoke === undefined) return null
  try { return (await invoke('slacker_novel_pick_dir')) as string | null }
  catch (err) { console.warn('[novel] novelPickDir failed:', err); return null }
}
