/**
 * 媒体工作文件夹 —— 把产出落成真实文件（对齐 dsh 对话的 cwd 体验）。
 *
 * 根目录存 media 域 global 槽（key `workspace.root`，空 = 未设置）。
 * 布局：
 *   <root>/<员工名>/<日期>-<标题>.md            —— 文章（生成/编辑完成时）
 *   <root>/<员工名>/<平台>/<日期>-<标题>.md     —— 发布版本（发布成功时）
 *   <root>/规划/<日期>-<标题>.md                —— 发布规划（建计划时，按文章聚合重写）
 *
 * 员工归属与文件相对路径记在 global 槽 `file:art:<id>`（不动 ArticleSchema，
 * 旧数据兼容：无 meta 时员工按「未署名」处理）。
 * 所有 IO 失败只打日志 —— 存储域是事实来源，文件是投影，绝不阻塞主流程。
 * @module @slacker/media/workspace
 */
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { z } from 'zod'
import { ArticleSchema, PlanSchema, type MediaDomain } from './domain.ts'

type ArticleRec = z.infer<typeof ArticleSchema>
type PlanRec = z.infer<typeof PlanSchema>

/** global 槽：工作文件夹根目录。 */
const ROOT_KEY = 'workspace.root'
/** global 槽前缀：文章文件投影 meta。 */
const FILE_PREFIX = 'file:art:'

/** 文件投影 meta（rel 为相对 root 的路径）。 */
interface FileMeta {
  /** 文章文件相对路径。 */
  rel: string
  /** 撰写员工名。 */
  persona: string
  /** 规划文件相对路径（有计划时才存在）。 */
  planRel?: string
}

/** 平台 id → 目录名（与前端 PLATFORM_LABEL 一致的短名）。 */
const PLATFORM_DIR: Record<string, string> = {
  wechat: '公众号',
  toutiao: '头条',
  zhihu: '知乎',
  xiaohongshu: '小红书',
  douyin: '抖音',
}

/** 读当前工作文件夹根（'' = 未设置）。 */
export function workspaceRoot(domain: MediaDomain): string {
  const v = (domain.global.get() as Record<string, unknown>)[ROOT_KEY]
  return typeof v === 'string' ? v : ''
}

/**
 * 文章素材目录的绝对路径：`<工作文件夹>/assets/<articleId>`。
 * 未设置工作文件夹时返回 `''`（调用方据此判定「没有本机素材可用」）。
 * 用途：发布时把正文里的本机配图（`fig-NN.*`）读出来上传到平台。
 */
export function articleAssetDir(domain: MediaDomain, articleId: string): string {
  const root = workspaceRoot(domain)
  return root === '' ? '' : nodePath.join(root, 'assets', articleId)
}

/** 平台侧收的封面格式（头条明说「格式支持JPEG、PNG」）——svg 传上去只会被拒。 */
const COVER_EXTS = ['.png', '.jpg', '.jpeg']

/**
 * 解析文章封面在本机的绝对路径：`<工作文件夹>/assets/<articleId>/cover.png|jpg|jpeg`。
 * 读不到就返回 `{ path: undefined, reason }`，由调用方如实说明（不编路径、不拿别的图凑）。
 */
export async function resolveCoverFile(
  domain: MediaDomain,
  articleId: string,
): Promise<{ path?: string; reason?: string }> {
  const root = workspaceRoot(domain)
  if (root === '') return { reason: '未设置工作文件夹，找不到封面文件' }
  const dir = nodePath.join(root, 'assets', articleId)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { reason: '工作文件夹里没有这篇文章的素材目录（还没生成过封面）' }
  }
  const hit = names.find(n => COVER_EXTS.includes(nodePath.extname(n).toLowerCase()))
  if (hit) return { path: nodePath.join(dir, hit) }
  return {
    reason: names.some(n => n.startsWith('cover.'))
      ? '只有 svg 封面，头条只收 JPEG/PNG，需人工换一张'
      : '素材目录里没有封面文件',
  }
}

/** 校验并设置工作文件夹根（空串 = 清除）。目录不可建/不可写时抛错。 */
export async function setWorkspaceRoot(domain: MediaDomain, root: string): Promise<void> {
  const trimmed = root.trim()
  if (trimmed !== '') {
    await mkdir(trimmed, { recursive: true })
    const probe = nodePath.join(trimmed, '.media_write_probe')
    await writeFile(probe, '')
    await unlink(probe).catch(() => { /* 探针清理失败不影响可用性 */ })
  }
  const g = { ...(domain.global.get() as Record<string, unknown>) }
  if (trimmed === '') delete g[ROOT_KEY]
  else g[ROOT_KEY] = trimmed
  await domain.global.set(g)
}

/** 安全文件名段：去非法字符，限长 60，空则兜底 untitled。 */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim()
  return (cleaned || 'untitled').slice(0, 60)
}

/** 本地日期戳 YYYY-MM-DD。 */
function dateStamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function platformDir(platform: string): string {
  return PLATFORM_DIR[platform] ?? safeName(platform)
}

function readMeta(domain: MediaDomain, articleId: string): FileMeta | undefined {
  const v = (domain.global.get() as Record<string, unknown>)[FILE_PREFIX + articleId]
  if (!v || typeof v !== 'object') return undefined
  const m = v as Partial<FileMeta>
  return typeof m.rel === 'string' ? { rel: m.rel, persona: m.persona ?? '未署名', planRel: m.planRel } : undefined
}

async function saveMeta(domain: MediaDomain, articleId: string, meta: FileMeta): Promise<void> {
  await domain.global.set({
    ...(domain.global.get() as Record<string, unknown>),
    [FILE_PREFIX + articleId]: meta,
  })
}

/** 文章撰写员工名（无 meta 兜底「未署名」；供 article/save 编辑回写用）。 */
export function articlePersona(domain: MediaDomain, articleId: string): string {
  return readMeta(domain, articleId)?.persona ?? '未署名'
}

function articleMd(article: ArticleRec, persona: string): string {
  return [
    '---',
    `id: ${article.id}`,
    `title: ${article.title}`,
    `employee: ${persona}`,
    `status: ${article.status}`,
    `createdAt: ${new Date(article.createdAt).toISOString()}`,
    `updatedAt: ${new Date(article.updatedAt).toISOString()}`,
    '---',
    '',
    article.bodyMd,
    '',
  ].join('\n')
}

/**
 * 落盘文章文件：<root>/<员工名>/<日期>-<标题>.md。
 * 标题/员工变化导致路径变化时，删除旧文件（改名语义，不是留历史版本）。
 */
export async function writeArticleFile(domain: MediaDomain, article: ArticleRec, personaName: string): Promise<void> {
  const root = workspaceRoot(domain)
  if (root === '' || !article.bodyMd.trim()) return
  const persona = safeName(personaName || '未署名')
  const rel = nodePath.join(persona, `${dateStamp(article.createdAt)}-${safeName(article.title)}.md`)
  const meta = readMeta(domain, article.id)
  if (meta && meta.rel !== rel) {
    await unlink(nodePath.join(root, meta.rel)).catch(() => { /* 旧文件可能已不存在 */ })
  }
  await mkdir(nodePath.join(root, persona), { recursive: true })
  await writeFile(nodePath.join(root, rel), articleMd(article, persona), 'utf8')
  await saveMeta(domain, article.id, { rel, persona, planRel: meta?.planRel })
}

/**
 * 落盘发布版本：<root>/<员工名>/<平台>/<日期>-<标题>.md。
 * 正文取平台适配版本（无则用主稿）；url 记入 front-matter。
 */
export async function writePlatformFile(
  domain: MediaDomain,
  plan: PlanRec,
  article: ArticleRec,
  url?: string,
): Promise<void> {
  const root = workspaceRoot(domain)
  if (root === '') return
  const body = article.platformVersions[plan.platform] ?? article.bodyMd
  if (!body.trim()) return
  const persona = safeName(readMeta(domain, article.id)?.persona ?? '未署名')
  const rel = nodePath.join(
    persona,
    platformDir(plan.platform),
    `${dateStamp(plan.scheduledAt || Date.now())}-${safeName(article.title)}.md`,
  )
  const accountName = domain.table('account').get(plan.accountId)?.displayName ?? plan.accountId
  const md = [
    '---',
    `id: ${article.id}`,
    `title: ${article.title}`,
    `employee: ${persona}`,
    `platform: ${PLATFORM_DIR[plan.platform] ?? plan.platform}`,
    `account: ${accountName}`,
    `state: ${plan.state}`,
    ...(url ? [`url: ${url}`] : []),
    `publishedAt: ${new Date().toISOString()}`,
    '---',
    '',
    body,
    '',
  ].join('\n')
  await mkdir(nodePath.join(root, persona, platformDir(plan.platform)), { recursive: true })
  await writeFile(nodePath.join(root, rel), md, 'utf8')
}

/**
 * 落盘发布规划：<root>/规划/<日期>-<标题>.md。
 * 该文章全部计划聚合成一份（建/改计划后整体重写；标题变化清理旧文件）。
 */
export async function writePlanFile(domain: MediaDomain, article: ArticleRec): Promise<void> {
  const root = workspaceRoot(domain)
  if (root === '') return
  const plans = [...domain.table('plan').entries()].map(([, v]) => v)
    .filter(p => p.articleId === article.id)
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
  const meta = readMeta(domain, article.id)
  // 计划被清空（全部移除）：顺手删掉旧规划文件，别让工作文件夹留着已删计划的残影
  if (plans.length === 0) {
    if (meta?.planRel) {
      await unlink(nodePath.join(root, meta.planRel)).catch(() => { /* 文件可能已不存在 */ })
      await saveMeta(domain, article.id, { rel: meta.rel, persona: meta.persona })
    }
    return
  }

  const rel = nodePath.join('规划', `${dateStamp(article.createdAt)}-${safeName(article.title)}.md`)
  if (meta?.planRel && meta.planRel !== rel) {
    await unlink(nodePath.join(root, meta.planRel)).catch(() => { /* 旧文件可能已不存在 */ })
  }

  const lines = [
    '---',
    `articleId: ${article.id}`,
    `title: ${article.title}`,
    `status: ${article.status}`,
    '---',
    '',
    `# 发布规划：${article.title}`,
    '',
    ...plans.map((p) => {
      const at = new Date(p.scheduledAt).toLocaleString('zh-CN', { hour12: false })
      const platform = PLATFORM_DIR[p.platform] ?? p.platform
      const account = domain.table('account').get(p.accountId)?.displayName ?? p.accountId
      return `- [${p.state}] ${platform} · ${account} · 计划 ${at}`
    }),
    '',
  ]
  await mkdir(nodePath.join(root, '规划'), { recursive: true })
  await writeFile(nodePath.join(root, rel), lines.join('\n'), 'utf8')
  await saveMeta(domain, article.id, { rel: meta?.rel ?? '', persona: meta?.persona ?? '未署名', planRel: rel })
}

/** 存量同步：把所有非空文章按当前 meta 落盘。返回 {written, failed}。 */
export async function syncWorkspace(domain: MediaDomain): Promise<{ written: number; failed: number }> {
  if (workspaceRoot(domain) === '') return { written: 0, failed: 0 }
  let written = 0
  let failed = 0
  for (const [, article] of domain.table('article').entries()) {
    if (!article.bodyMd.trim()) continue
    try {
      await writeArticleFile(domain, article, articlePersona(domain, article.id))
      written++
    } catch (err) {
      failed++
      console.warn(`[media/workspace] 同步 ${article.id} 失败:`, err)
    }
  }
  return { written, failed }
}
