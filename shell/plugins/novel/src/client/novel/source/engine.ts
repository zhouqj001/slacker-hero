/**
 * 书源引擎 —— 主应用 booksource/engine.ts 的移植（search / bookInfo /
 * toc / content 全链路；规则求值与编排逻辑与原作一致，仅去掉调试日志
 * 与 doctor/browse 体检块）。错误向上抛，由 UI 层提示。
 */
import type { BookSource, BookInfo, TocItem, SearchResultItem, RequestSpec, ExploreCategory } from './types.ts'
import { evalRule, evalList, parseHtml, resolveUrl, applyTemplate, type EvalContext, type EvalEnv } from './rule.ts'
import { fetchRequestSpec, isChallengePage, type FetchOptions, type FetchResult } from './http.ts'

/** 修复域名重复的 URL（模板 {{base}}{{bookUrl}} 撞上绝对 bookUrl 时）。 */
function dedupUrl(url: string): string {
  const protoCount = (url.match(/https?:\/\//g) ?? []).length
  if (protoCount <= 1) return url
  const lastIdx = Math.max(url.lastIndexOf('http://'), url.lastIndexOf('https://'))
  return lastIdx > 0 ? url.substring(lastIdx) : url
}

/** 书源引擎。 */
export class BookSourceEngine {
  constructor(
    private readonly source: BookSource,
    private readonly opts: FetchOptions = {},
  ) {}

  get name(): string { return this.source.name }
  get base(): string { return this.source.url }

  private get fetchOpts(): FetchOptions {
    return {
      base: this.source.url,
      http: this.source.http ?? this.opts.http,
      vars: this.opts.vars,
    }
  }

  /** 通用抓取：渲染模板 + 抓取 + 挑战检测。 */
  private async fetch(spec: RequestSpec, extraVars?: Record<string, string>): Promise<FetchResult> {
    const vars = { base: this.base, ...(this.fetchOpts.vars ?? {}), ...(extraVars ?? {}) }
    const renderedUrl = dedupUrl(applyTemplate(spec.url, vars))
    const result = await fetchRequestSpec({ ...spec, url: renderedUrl }, { ...this.fetchOpts, vars })
    if (isChallengePage(result.body)) {
      throw new Error('该请求被反爬挑战拦截（如 Cloudflare），请更换书源或入口')
    }
    return result
  }

  /** 搜索。 */
  async search(keyword: string, page = 1): Promise<SearchResultItem[]> {
    const { search } = this.source
    if (search === undefined) throw new Error('该书源未配置 search')
    const result = await this.fetch(search.request, {
      key: encodeURIComponent(keyword),
      keyRaw: keyword,
      page: String(page),
      pageSize: '20',
    })
    const items = evalList(result.body, search.list, this.env())
    return items
      .filter(it => it.bookUrl !== '')
      .map(it => ({
        bookUrl: resolveUrl(it.bookUrl, result.finalUrl),
        name: it.name ?? '',
        author: it.author,
        cover: it.cover !== '' && it.cover !== undefined ? resolveUrl(it.cover, result.finalUrl) : undefined,
        intro: it.intro,
        wordCount: it.wordCount,
      }))
  }

  /** 浏览（分类入口，同原作）：static 硬编码 + fetch 动态抓取。 */
  async listExploreEntries(): Promise<ExploreCategory[]> {
    const { explore } = this.source
    if (explore === undefined) throw new Error('该书源未配置 explore')
    const out: ExploreCategory[] = []
    for (const entry of explore.entries) {
      if (entry.type === 'static') {
        out.push({ title: entry.title, vars: entry.vars ?? {} })
      } else {
        const result = await this.fetch(entry.request)
        const items = evalList(result.body, entry.list, this.env())
        for (const it of items) {
          if (it.title !== undefined) {
            out.push({ title: it.title, vars: stripNonVars(it) })
          }
        }
      }
    }
    return out
  }

  /** 浏览：取某个分类第 N 页的书（同原作）。 */
  async explorePage(category: ExploreCategory, page = 1): Promise<SearchResultItem[]> {
    const { explore } = this.source
    if (explore === undefined) throw new Error('该书源未配置 explore')
    const result = await this.fetch(explore.page.request, {
      ...category.vars,
      page: String(page),
      pageSize: '20',
    })
    return evalList(result.body, explore.page.list, this.env())
      .filter(it => it.bookUrl !== '')
      .map(it => ({
        bookUrl: resolveUrl(it.bookUrl, result.finalUrl),
        name: it.name ?? '',
        author: it.author,
        cover: it.cover !== '' && it.cover !== undefined ? resolveUrl(it.cover, result.finalUrl) : undefined,
        intro: it.intro,
        wordCount: it.wordCount,
      }))
  }

  /** 书详情。 */
  async getBookInfo(bookUrl: string): Promise<BookInfo> {
    const { bookInfo } = this.source
    const req: RequestSpec = bookInfo.request ?? { url: '{{bookUrl}}' }
    const result = await this.fetch(req, { bookUrl })
    const ctx: EvalContext = ctxFromBody(result.body)
    const env = this.env({ bookUrl: result.finalUrl })
    const info: BookInfo = {
      name: evalRule(bookInfo.name, ctx, env) || guessNameFromUrl(bookUrl),
      sourceUrl: bookUrl,
    }
    if (bookInfo.author !== undefined) info.author = evalRule(bookInfo.author, ctx, env)
    if (bookInfo.cover !== undefined) {
      const cover = evalRule(bookInfo.cover, ctx, env)
      if (cover !== '') info.cover = resolveUrl(cover, result.finalUrl)
    }
    if (bookInfo.intro !== undefined) info.intro = evalRule(bookInfo.intro, ctx, env)
    if (bookInfo.wordCount !== undefined) info.wordCount = evalRule(bookInfo.wordCount, ctx, env)
    if (bookInfo.tocUrl !== undefined) {
      const tocUrl = evalRule(bookInfo.tocUrl, ctx, env)
      if (tocUrl !== '') info.tocUrl = resolveUrl(tocUrl, result.finalUrl)
    }
    return info
  }

  /** 目录。 */
  async getToc(bookInfo: BookInfo): Promise<TocItem[]> {
    const { toc } = this.source
    const tocUrl = bookInfo.tocUrl ?? bookInfo.sourceUrl ?? ''
    const req: RequestSpec = toc.request ?? { url: '{{tocUrl}}' }
    const result = await this.fetch(req, { tocUrl, bookUrl: tocUrl })
    const items = evalList(result.body, toc.list, this.env({ tocUrl: result.finalUrl }))
    return items
      .filter(it => it.name !== '' || it.url !== '')
      .map(it => ({
        name: it.name ?? '',
        url: it.url !== '' && it.url !== undefined ? resolveUrl(it.url, result.finalUrl) : '',
        isVolume: it.isVolume === 'true' || it.isVolume === '1' || it.isVolume === 'yes',
      }))
  }

  /** 正文（含 nextPage 分页拼接，同原作）。 */
  async getContent(chapterUrl: string): Promise<string> {
    const { content } = this.source
    const req: RequestSpec = content.request ?? { url: '{{chapterUrl}}' }
    const result = await this.fetch(req, { chapterUrl, bookUrl: chapterUrl })
    const ctx: EvalContext = ctxFromBody(result.body)
    const env = this.env({ chapterUrl: result.finalUrl })
    let text = evalRule(content.value, ctx, env)

    const maxPages = content.maxPages ?? 1
    let curUrl: string | null = content.nextPage !== undefined
      ? evalRule(content.nextPage, ctx, env)
      : null
    let pages = 1
    while (curUrl !== null && curUrl !== '' && pages < maxPages) {
      const nextUrl = resolveUrl(curUrl, result.finalUrl)
      try {
        const r2 = await this.fetch({ ...req, url: '{{chapterUrl}}' }, { chapterUrl: nextUrl, bookUrl: nextUrl })
        const ctx2 = ctxFromBody(r2.body)
        const env2 = this.env({ chapterUrl: r2.finalUrl })
        text += '\n' + evalRule(content.value, ctx2, env2)
        curUrl = content.nextPage !== undefined ? evalRule(content.nextPage, ctx2, env2) : null
        pages++
      } catch {
        break
      }
    }
    return text.trim()
  }

  private env(extra?: Record<string, string>): EvalEnv {
    return { base: this.source.url, vars: { ...(this.opts.vars ?? {}), ...(extra ?? {}) } }
  }
}

/** 响应体转求值上下文：HTML→dom，JSON→json，其它→text。 */
function ctxFromBody(body: string): EvalContext {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('<')) {
    const doc = parseHtml(body)
    if (doc !== null) return { kind: 'dom', node: doc }
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { kind: 'json', data: JSON.parse(body) } } catch { /* fallthrough */ }
  }
  return { kind: 'text', text: body }
}

/** 从 list item 里剔除已知非变量字段，剩下的作为 vars（同原作）。 */
function stripNonVars(it: Record<string, string>): Record<string, string> {
  const { title, name, ...rest } = it
  return rest
}

function guessNameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean).pop() ?? u.hostname
    return decodeURIComponent(seg).replace(/\.\w+$/, '')
  } catch {
    return url
  }
}
