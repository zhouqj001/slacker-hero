/**
 * 文章图片资产 —— 存工作文件夹 `<root>/assets/<articleId>/`，经 `/api/media/asset?id=` 路由服务。
 *
 * 两条来源：
 *   1. 自动配图（articleGenerate 完成后）：siliconflow 生图（需 apiKey）或本模块 SVG 封面兜底；
 *   2. 手动插图（编辑器上传）：本地图片经 base64 上传落盘。
 * 路由返回标准二进制 Response（ConnectionFetchRoute.fetch 本就返回 Response）。
 * 资产是文章的附属投影：失败只打日志/抛给调用方，不碰存储域事实。
 * @module @slacker/media/assets
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { z } from 'zod'
import { ArticleSchema, type MediaDomain } from './domain.ts'
import { workspaceRoot } from './workspace.ts'
import { resolveImagePlan, templateAdapter } from './imagegen.ts'

type ArticleRec = z.infer<typeof ArticleSchema>

/**
 * 资产扩展 → MIME：决定「能否服务」与 content-type。
 * svg 仅限服务端生成、不收上传；视频扩展用于素材库里用户自放素材的预览播放。
 */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
}

/** 上传白名单（不含 svg）。 */
const UPLOAD_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/** 上限：单张上传图片 4MB（base64 后约 5.3MB，低于共享通道 JSON cap）。 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024

/** 资产 id 参数格式：`<articleId>/<filename>`。 */
const ASSET_ID_RE = /^([A-Za-z0-9_-]+)\/([\w.\-\u4e00-\u9fa5]+)$/

/** 文件名消毒：去路径分隔与非法字符。 */
function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim()
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : ''
}

/** 资产落盘相对路径前缀（相对工作文件夹根）。 */
function assetRel(articleId: string, filename: string): string {
  return nodePath.join('assets', articleId, filename)
}

/** 资产引用 URL（bodyMd 里插的就是它）。 */
export function assetUrl(articleId: string, filename: string): string {
  return `/api/media/asset?id=${encodeURIComponent(`${articleId}/${filename}`)}`
}

/** 保存一张资产图（bytes 或 svg 文本），返回引用 URL。 */
export async function saveAssetFile(
  domain: MediaDomain,
  articleId: string,
  filename: string,
  data: Uint8Array | string,
): Promise<string> {
  const root = workspaceRoot(domain)
  if (root === '') throw new Error('未设置工作文件夹，无法保存图片')
  const rel = assetRel(articleId, filename)
  await mkdir(nodePath.join(root, 'assets', articleId), { recursive: true })
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  await writeFile(nodePath.join(root, rel), buf)
  return assetUrl(articleId, filename)
}

/** 删除文章的全部资产（articleDelete 时调用，失败只打日志）。 */
export async function cleanupAssets(domain: MediaDomain, articleId: string): Promise<void> {
  const root = workspaceRoot(domain)
  if (root === '') return
  await rm(nodePath.join(root, 'assets', articleId), { recursive: true, force: true })
}

// ------------------------------------------------------------------
// 自动配图
// ------------------------------------------------------------------

/** 正文里的配图占位：`![图注](gen:画面描述)`。 */
const FIG_RE = /!\[([^\]]*)\]\(gen:([^)\s]+)\)/g

/** 从正文抽出配图占位（保持出现顺序，跳过描述为空的）。 */
export interface FigureSpot {
  /** 序号，从 1 开始，用作文件名。 */
  index: number
  alt: string
  /** 画图提示词。 */
  prompt: string
}

export function listFigureSpots(bodyMd: string): FigureSpot[] {
  const spots: FigureSpot[] = []
  for (const m of bodyMd.matchAll(FIG_RE)) {
    const prompt = m[2].trim()
    if (!prompt) continue
    spots.push({ index: spots.length + 1, alt: m[1].trim(), prompt })
  }
  return spots
}

/** 正文里的普通图片引用：`![图注](URL)`。 */
const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

/** 正文里**已经生成**的配图引用（指向本文章资产的 `fig-NN.<ext>`）。 */
export interface FigureRef {
  index: number
  alt: string
  filename: string
  url: string
  ext: string
}

/**
 * 找出正文里已落盘的配图引用。
 * 用途：`gen:` 占位一旦被替换就永久消失（正文里不再有占位），靠这些引用才能「重画」。
 */
export function listFigureRefs(bodyMd: string, articleId: string): FigureRef[] {
  const refs: FigureRef[] = []
  for (const m of bodyMd.matchAll(IMG_RE)) {
    const alt = (m[1] ?? '').trim()
    const url = m[2] ?? ''
    const q = url.indexOf('?id=')
    if (!url.startsWith('/api/media/asset') || q < 0) continue
    let idPart = ''
    try { idPart = decodeURIComponent(url.slice(q + 4)) } catch { continue }
    if (!idPart.startsWith(`${articleId}/`)) continue
    const filename = idPart.slice(articleId.length + 1)
    const fm = /^fig-(\d+)\.([a-z0-9]+)$/.exec(filename)
    if (!fm) continue
    refs.push({ index: Number(fm[1]), alt, filename, url, ext: fm[2] })
  }
  return refs.sort((a, b) => a.index - b.index)
}

// ------------------------------------------------------------------
// 配图提示词清单
// ------------------------------------------------------------------

/** index → 该图的图注与原始提示词。 */
type FigurePromptMap = Record<string, { alt: string; prompt: string }>

/**
 * 每张配图的原始提示词落盘在 `assets/<articleId>/figures.json`。
 *
 * 为什么需要：出图失败回落模板图时，`gen:` 占位会被真实 URL 替换掉，提示词随之丢失，
 * 之后就没有任何办法「用原提示词重画」。这份清单是重画时的唯一依据（缺失时退回图注）。
 */
async function readFigureManifest(domain: MediaDomain, articleId: string): Promise<FigurePromptMap> {
  const root = workspaceRoot(domain)
  if (root === '') return {}
  try {
    const parsed = JSON.parse(await readFile(nodePath.join(root, 'assets', articleId, 'figures.json'), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as FigurePromptMap : {}
  } catch {
    return {} // 没写过 / 损坏一律当空，不让重画失败
  }
}

async function writeFigureManifest(domain: MediaDomain, articleId: string, patch: FigurePromptMap): Promise<void> {
  const root = workspaceRoot(domain)
  if (root === '') return
  const merged = { ...await readFigureManifest(domain, articleId), ...patch }
  const file = nodePath.join(root, 'assets', articleId, 'figures.json')
  await mkdir(nodePath.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(merged, null, 2), 'utf8')
}

/** 单张配图真实生成失败的具体原因（该张已回落 SVG 模板图）。 */
export interface FigureError {
  /** 图在正文里的序号，从 1 起。 */
  index: number
  message: string
}

/** 逐张配图进度事件（转成 SSE 帧推给前端，让用户看得见「正在画第几张」）。 */
export type IllustrateProgress =
  | { kind: 'plan'; total: number; mode: 'fill' | 'redraw'; items: { index: number; prompt: string }[] }
  | { kind: 'start'; index: number; prompt: string }
  | { kind: 'end'; index: number; ok: boolean; message: string | null }

/** 配图结果：正文 + 计数 + 失败明细（失败必须能被调用方展示，不能只打日志）。 */
export interface IllustrateResult {
  bodyMd: string
  filled: number
  failed: number
  /** 真实出图被整体挡住的原因（开关关 / 没渠道）；非空即这一批全是模板图。 */
  blocked: string | null
  /** 逐张失败原因，与 failed 等长。 */
  errors: FigureError[]
}

/** 封面结果：失败同样要带出来，否则「封面已生成」会掩盖它其实是模板图。 */
export interface CoverResult {
  url: string | null
  /** true = 真实出图失败，落的是 SVG 模板封面。 */
  usedTemplate: boolean
  error: string | null
  blocked: string | null
}

/**
 * 把正文里的 `gen:` 占位逐个画成真图并替换成真实引用。
 * 单张失败只回落该张（模板封面兜底），不影响其它图；正文永远不会被清成纯文字。
 * @param forAgent true = 系统自动补图（受「允许 agent 自动配图」开关约束）；缺省=用户手动点生成
 * @param onlyIndex 只重画第 N 张（1 起）；缺省画全部
 * @param onProgress 逐张进度回调（可选），用于把「正在画第几张」实时推给前端
 * @returns 替换后的正文 + 成功/失败计数 + 失败明细；没图或无工作文件夹时原样返回
 */
export async function illustrateSpots(
  domain: MediaDomain,
  articleId: string,
  bodyMd: string,
  opts: { onlyIndex?: number; forAgent?: boolean; onProgress?: (e: IllustrateProgress) => void } = {},
): Promise<IllustrateResult> {
  if (workspaceRoot(domain) === '') return { bodyMd, filled: 0, failed: 0, blocked: null, errors: [] }
  const spots = listFigureSpots(bodyMd)
  if (spots.length === 0) return { bodyMd, filled: 0, failed: 0, blocked: null, errors: [] }

  const plan = resolveImagePlan(domain, { forAgent: opts.forAgent === true })
  if (plan.blocked) console.warn(`[media/assets] ${plan.blocked}`)
  const adapter = plan.adapter
  let filled = 0
  let failed = 0
  const errors: FigureError[] = []
  const targets = opts.onlyIndex === undefined ? spots : spots.filter(s => s.index === opts.onlyIndex)
  opts.onProgress?.({
    kind: 'plan',
    total: targets.length,
    mode: 'fill',
    items: targets.map(s => ({ index: s.index, prompt: s.prompt })),
  })

  /** 画第 n 张；失败回落模板图，保证正文不会退回纯文字。 */
  const paint = async (n: number, alt: string, prompt: string): Promise<string> => {
    const stem = `fig-${String(n).padStart(2, '0')}`
    opts.onProgress?.({ kind: 'start', index: n, prompt })
    try {
      const out = await adapter.generate({ title: prompt.slice(0, 40), prompt }, plan.channel)
      const name = `${stem}.${out.ext}`
      await saveAssetFile(domain, articleId, name, out.data)
      filled++
      opts.onProgress?.({ kind: 'end', index: n, ok: true, message: null })
      return assetUrl(articleId, name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[media/assets] 配图 ${n} 生成失败（${adapter.id}），回落模板图:`, message)
      errors.push({ index: n, message })
      const fb = await templateAdapter.generate({ title: alt || '配图', prompt: '' }, null)
      await saveAssetFile(domain, articleId, `${stem}.svg`, fb.data)
      failed++
      opts.onProgress?.({ kind: 'end', index: n, ok: false, message })
      return assetUrl(articleId, `${stem}.svg`)
    }
  }

  // 顺序生成：文件名按图在正文里的次序，序号稳定
  let n = 0
  let outMd = ''
  let cursor = 0
  const prompts: FigurePromptMap = {}
  for (const m of bodyMd.matchAll(FIG_RE)) {
    outMd += bodyMd.slice(cursor, m.index)
    cursor = m.index! + m[0].length
    const prompt = m[2].trim()
    if (!prompt) { outMd += m[0]; continue }
    n += 1
    if (opts.onlyIndex !== undefined && opts.onlyIndex !== n) { outMd += m[0]; continue }
    // 先记提示词：占位马上就会被替换掉，不记就永久丢失（失败后想重画就没提示词了）
    prompts[String(n)] = { alt: m[1].trim(), prompt }
    const url = await paint(n, m[1].trim(), prompt)
    outMd += `![${m[1].trim()}](${url})`
  }
  outMd += bodyMd.slice(cursor)
  if (Object.keys(prompts).length > 0) {
    try {
      await writeFigureManifest(domain, articleId, prompts)
    } catch (err) {
      console.warn('[media/assets] 写入配图清单失败:', err instanceof Error ? err.message : String(err))
    }
  }
  return { bodyMd: outMd, filled, failed, blocked: plan.blocked, errors }
}

/**
 * 重画正文里**已有**的配图（把上一轮落下的模板图换成真实生图）。
 *
 * `gen:` 占位被替换后就不再存在，所以这类文章点「补齐正文配图」会无图可补——这条路是它的出口。
 * 提示词优先取 figures.json 里的原始 prompt，缺清单时退回图注 alt。
 * 只用「成功」覆盖：失败保留原图并记错误，绝不把旧图降级成模板图。
 */
export async function redrawFigures(
  domain: MediaDomain,
  articleId: string,
  bodyMd: string,
  opts: { forAgent?: boolean; onProgress?: (e: IllustrateProgress) => void } = {},
): Promise<IllustrateResult> {
  if (workspaceRoot(domain) === '') return { bodyMd, filled: 0, failed: 0, blocked: null, errors: [] }
  const refs = listFigureRefs(bodyMd, articleId)
  if (refs.length === 0) return { bodyMd, filled: 0, failed: 0, blocked: null, errors: [] }

  const plan = resolveImagePlan(domain, { forAgent: opts.forAgent === true })
  if (plan.blocked) console.warn(`[media/assets] ${plan.blocked}`)
  const adapter = plan.adapter
  const manifest = await readFigureManifest(domain, articleId)
  const errors: FigureError[] = []
  const patches: FigurePromptMap = {}
  let filled = 0
  let failed = 0
  let outMd = bodyMd
  opts.onProgress?.({
    kind: 'plan',
    total: refs.length,
    mode: 'redraw',
    items: refs.map(r => ({ index: r.index, prompt: manifest[String(r.index)]?.prompt ?? r.alt })),
  })

  for (const ref of refs) {
    const stem = `fig-${String(ref.index).padStart(2, '0')}`
    const entry = manifest[String(ref.index)]
    const alt = entry?.alt ?? ref.alt
    const prompt = entry?.prompt ?? ref.alt
    if (!prompt) continue
    opts.onProgress?.({ kind: 'start', index: ref.index, prompt })
    try {
      const out = await adapter.generate({ title: prompt.slice(0, 40), prompt }, plan.channel)
      const name = `${stem}.${out.ext}`
      await saveAssetFile(domain, articleId, name, out.data)
      // 换扩展名时清掉旧文件，避免 fig-01.svg 与新图并存（同扩展名时上面就是覆盖）
      if (name !== ref.filename) {
        await rm(nodePath.join(workspaceRoot(domain), assetRel(articleId, ref.filename)), { force: true })
      }
      outMd = outMd.replace(ref.url, assetUrl(articleId, name))
      patches[String(ref.index)] = { alt, prompt }
      filled++
      opts.onProgress?.({ kind: 'end', index: ref.index, ok: true, message: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[media/assets] 重画配图 ${ref.index} 失败（${adapter.id}），保留原图:`, message)
      errors.push({ index: ref.index, message })
      failed++
      opts.onProgress?.({ kind: 'end', index: ref.index, ok: false, message })
    }
  }
  if (filled > 0) {
    try {
      await writeFigureManifest(domain, articleId, patches)
    } catch (err) {
      console.warn('[media/assets] 写入配图清单失败:', err instanceof Error ? err.message : String(err))
    }
  }
  return { bodyMd: outMd, filled, failed, blocked: plan.blocked, errors }
}

/**
 * 为文章自动配一张封面图，返回 markdown 可用的引用 URL。
 * 生图渠道由 imagegen.ts 的多渠道配置决定（总开关关 / 无可用渠道 / 请求失败 → SVG 模板兜底）。
 * 未设置工作文件夹时返回 { url: null }（无处落盘，正文保持纯文字）。
 * @param forAgent true = 系统自动配封面（受「允许 agent 自动配图」开关约束）
 */
export async function illustrateArticle(
  domain: MediaDomain,
  article: ArticleRec,
  opts: { forAgent?: boolean } = {},
): Promise<CoverResult> {
  if (workspaceRoot(domain) === '') {
    return { url: null, usedTemplate: false, error: '未设置工作文件夹，无法保存图片', blocked: null }
  }
  const plan = resolveImagePlan(domain, { forAgent: opts.forAgent === true })
  if (plan.blocked) console.warn(`[media/assets] ${plan.blocked}`)
  const adapter = plan.adapter
  let data: Uint8Array | string
  let ext: string
  let usedTemplate = false
  let error: string | null = null
  try {
    const out = await adapter.generate({
      title: article.title,
      prompt: `${article.title}，杂志封面插画风格，简洁现代`,
    }, plan.channel)
    data = out.data
    ext = out.ext
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    console.warn(`[media/assets] 生图失败（${adapter.id}），改用模板封面:`, error)
    const fallback = await templateAdapter.generate({ title: article.title, prompt: '' }, null)
    data = fallback.data
    ext = fallback.ext
    usedTemplate = true
  }
  // 清掉旧封面（cover.png / cover.svg 互斥，避免重生成后两种格式并存）
  const dir = nodePath.join(workspaceRoot(domain), 'assets', article.id)
  try {
    for (const f of await readdir(dir)) {
      if (f.startsWith('cover.')) await rm(nodePath.join(dir, f), { force: true })
    }
  } catch { /* 目录不存在 = 首次生成 */ }
  const filename = `cover.${ext}`
  await saveAssetFile(domain, article.id, filename, data)
  return { url: assetUrl(article.id, filename), usedTemplate, error, blocked: plan.blocked }
}

// ------------------------------------------------------------------
// 路由
// ------------------------------------------------------------------

/** 资产二进制响应头（svg 额外锁 CSP，防内嵌脚本）。 */
function imageHeaders(ext: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  }
  if (ext === 'svg') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'"
  return headers
}

/** GET /api/media/asset?id=<articleId>/<filename> — 资产二进制服务（图片/视频）。 */
export function assetRoute(domain: MediaDomain): ConnectionFetchRoute {
  return {
    path: '/api/media/asset',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      const m = ASSET_ID_RE.exec(id)
      const root = workspaceRoot(domain)
      if (!m || root === '') {
        return new Response('asset not found', { status: 404 })
      }
      const [, articleId, filename] = m
      const ext = extOf(filename)
      if (!(ext in MIME)) return new Response('asset not found', { status: 404 })
      try {
        const buf = await readFile(nodePath.join(root, assetRel(articleId, filename)))
        return new Response(new Uint8Array(buf), { headers: imageHeaders(ext) })
      } catch {
        return new Response('asset not found', { status: 404 })
      }
    },
  }
}

/** 素材列表条目。 */
export type AssetItem = {
  articleId: string
  filename: string
  url: string
  bytes: number
  mtimeMs: number
  articleTitle: string
}

/** GET /api/media/assets — 遍历工作文件夹 assets/，列出全部素材图（联文章标题）。 */
export function assetsListRoute(domain: MediaDomain): ConnectionFetchRoute {
  return {
    path: '/api/media/assets',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const root = workspaceRoot(domain)
      if (root === '') {
        return new Response(JSON.stringify({ ok: true, data: { root: '', items: [] satisfies AssetItem[] } }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      const titles = new Map([...domain.table('article').entries()].map(([, v]) => [v.id, v.title]))
      const items: AssetItem[] = []
      try {
        const dirs = await readdir(nodePath.join(root, 'assets'), { withFileTypes: true })
        for (const dir of dirs) {
          if (!dir.isDirectory()) continue
          const files = await readdir(nodePath.join(root, 'assets', dir.name), { withFileTypes: true })
          for (const f of files) {
            if (!f.isFile()) continue
            if (!(extOf(f.name) in MIME)) continue // 只列图片/视频；figures.json 之类的附属文件不进素材库
            try {
              const st = await stat(nodePath.join(root, 'assets', dir.name, f.name))
              items.push({
                articleId: dir.name,
                filename: f.name,
                url: assetUrl(dir.name, f.name),
                bytes: st.size,
                mtimeMs: st.mtimeMs,
                articleTitle: titles.get(dir.name) ?? '',
              })
            } catch { /* 单文件 stat 失败跳过 */ }
          }
        }
      } catch { /* assets 目录不存在 = 尚无素材 */ }
      items.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return new Response(JSON.stringify({ ok: true, data: { root, items } }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    },
  }
}

/** POST /api/media/article/asset — 编辑器上传本地图片（base64），返回引用 URL。 */
export function articleAssetRoute(domain: MediaDomain): ConnectionFetchRoute {
  return {
    path: '/api/media/article/asset',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: { articleId?: string; filename?: string; dataBase64?: string } | null = null
      try {
        body = await request.json() as { articleId?: string; filename?: string; dataBase64?: string } | null
      } catch { /* 走下方参数校验 */ }
      const articleId = body?.articleId ?? ''
      const rawName = safeFilename(body?.filename ?? '')
      const dataBase64 = body?.dataBase64 ?? ''
      if (!articleId || !/^[A-Za-z0-9_-]+$/.test(articleId) || !rawName || !dataBase64) {
        return new Response(JSON.stringify({ ok: false, code: 'INVALID_REQUEST', message: '参数不完整' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      const ext = extOf(rawName)
      if (!UPLOAD_EXTS.includes(ext)) {
        return new Response(JSON.stringify({ ok: false, code: 'INVALID_REQUEST', message: '仅支持 png/jpg/webp/gif' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      const bytes = Buffer.from(dataBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
        return new Response(JSON.stringify({ ok: false, code: 'INVALID_REQUEST', message: '图片大小需在 4MB 以内' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      if (!domain.table('article').get(articleId)) {
        return new Response(JSON.stringify({ ok: false, code: 'ARTICLE_NOT_FOUND', message: '文章不存在' }), {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      try {
        const url = await saveAssetFile(domain, articleId, rawName, bytes)
        return new Response(JSON.stringify({ ok: true, data: { url } }), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ ok: false, code: 'ASSET_IO', message }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
    },
  }
}
