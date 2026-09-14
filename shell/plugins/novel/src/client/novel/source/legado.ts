/**
 * Legado(阅读) 书源格式 → trnovel-booksource/v2 转换器
 *
 * 面向用户导入的社区书源数组（legado 官方导出），还原最常见的 Legado 语法：
 * - 支持 CSS 容器链：a.1 索引 / id.x / class.x / a@href / id.sitebox@dl
 * - 支持 ##regex##replacement### 尾部清洗（正文反爬置空、章节名前缀等）
 * - 支持 text/ownText/textNodes 自引用与 @css: 前缀
 * - 不支持 @js: <js> @XPath: @get: @put:（字段跳过），
 *   JSONPath/paginate/webView/cookie 类规则转成基础版并提示。
 *
 * 转换失败的字段回退 v2 RMB 默认规则（如 h1 / 通用目录选择器），
 * 保证导入后书源结构完整、能在管理页点击即测，而不报 schema 错。
 */
import {
  BOOKSOURCE_SCHEMA,
  type BookSource,
  type Rule,
  type CssRule,
  type CleanOp,
  type Extract,
  type RequestSpec,
} from './types.ts'

/** 自引用/文本/HTML 提取：映射到 v2 extract 值。 */
const SELF_WORDS = new Set(['text', 'ownText', 'textNodes', 'textContent'])
const HTML_WORDS = new Set(['html', 'textHtml', 'allHtml'])
/** 属性型提取词：映射到 CSS attr 提取。 */
const ATTR_WORDS = new Set([
  'href', 'src', 'srcset', 'data-src', 'src2', 'title', 'alt', 'content', 'value',
  'background', 'poster', 'data_id', 'data-id', 'data-url',
])

/** Legado 书源原始结构（仅标注用到的字段）。 */
interface LegadoSource {
  bookSourceName?: string
  bookSourceUrl?: string
  bookSourceType?: number
  searchUrl?: string
  ruleSearch?: {
    bookList?: string
    name?: string
    author?: string
    bookUrl?: string
    coverUrl?: string
    intro?: string
    kind?: string
    lastChapter?: string
    wordCount?: string
  }
  ruleBookInfo?: {
    name?: string
    author?: string
    coverUrl?: string
    intro?: string
    tocUrl?: string
  }
  ruleToc?: {
    chapterList?: string
    chapterName?: string
    chapterUrl?: string
    isVolume?: string
    updateTime?: string
  }
  ruleContent?: {
    content?: string
    nextContentUrl?: string
    replaceRegex?: string
  }
  httpUserAgent?: string
  customOrder?: number
  enabled?: boolean
  bookSourceComment?: string
  bookSourceGroup?: string
}

/** 检测是否为 Legado 格式。 */
export function isLegadoSource(obj: unknown): boolean {
  if (Array.isArray(obj)) return obj.length > 0 && isLegadoSource(obj[0])
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as Record<string, unknown>).bookSourceName === 'string'
  )
}

/**
 * 解析 Legado 规则字符串为 v2 Rule。
 *
 * 覆盖最常见的语法（社区书源统计）：
 *   "div.bookname@text"           → css div.bookname + extract text
 *   "a@href"                      → css a + extract {attr:"href"}
 *   "a.1@text"                    → css a:nth-of-type(2)（索引从 0 起）
 *   "a.1@href##^##https://x.com"  → css a:nth-of-type(2) + clean 前缀补全
 *   "id.sitebox@dl"               → css #sitebox dl（容器链级联）
 *   "text##正文卷.|正文."         → :scope 自身文本 + clean 前缀清洗
 *   "##regex##replacement##"      → 整串正则 → regex 规则
 *
 * 不可转换：<js> @js: @JS: @XPath: @get: @put: → undefined（字段跳过）。
 */
export function parseLegadoRule(raw: string | undefined): Rule | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  let s = raw.trim()
  if (!s) return undefined

  // 无 JS 桥的高危语法 → 转换不了，留空让调用方回退默认
  if (s.includes('<js>') || s.includes('@js:') || s.includes('@JS:')) return undefined
  if (s.startsWith('@XPath:') || s.startsWith('@xPath:') || s.startsWith('@xml:')) return undefined
  if (s.includes('@get:') || s.includes('@put:')) return undefined

  // 纯正则规则
  if (s.startsWith('##')) {
    const parts = s.split('##').filter(Boolean)
    if (parts.length > 0) return { via: 'regex', pattern: parts[0], group: 1 }
  }

  // 尾部清洗 ##pattern##replacement### 或 ##pattern##replacement 或 ##pattern###（替换为空）
  let clean: CleanOp[] | undefined
  const mPair = s.match(/##(.+?)##(.+)$/)
  if (mPair !== null) {
    let withStr = mPair[2]
    // 结尾 ### 结束符剥掉（replacement 里可能有 #）
    if (withStr.endsWith('###')) withStr = withStr.slice(0, -3)
    // 剥不可执行的 Legado JS 表达式模板（{{'...'}} 等），保留纯净 {{key}} 变量
    withStr = stripJsTemplates(withStr)
    clean = [{ replace: { pattern: mPair[1], flags: 'g', with: withStr } }]
    s = s.slice(0, s.indexOf('##')).trim()
    if (!s) return { via: 'css', select: ':scope', extract: 'text', clean }
  } else {
    const mOne = s.match(/##(.+?)$/)
    if (mOne !== null) {
      clean = [{ replace: { pattern: mOne[1], flags: 'g', with: '' } }]
      s = s.slice(0, s.indexOf('##')).trim()
      if (!s) return { via: 'css', select: ':scope', extract: 'text', clean }
    }
  }

  // 前置指令
  if (s.startsWith('@css:')) s = s.slice(5).trim()

  const mkCss = (selector: string, extract: Extract): Rule => {
    const r: CssRule = { via: 'css', select: selector, extract }
    if (clean !== undefined) r.clean = clean
    return r
  }

  // 自引用文本
  if (SELF_WORDS.has(s)) return { via: 'css', select: ':scope', extract: 'text', clean }
  // 自身 HTML
  if (HTML_WORDS.has(s)) return { via: 'css', select: ':scope', extract: 'html', clean }

  // 一次性把整条当提取：id.x / class.x → CSS
  if (s.startsWith('id.')) s = '#' + s.slice(3)
  else if (s.startsWith('class.')) s = '.' + s.slice(6)

  // 去 !index:index 遍历跳过（`tbody@tr!0`）
  s = s.replace(/!\d+(:\d+)*/g, '')
  if (!s) return undefined

  // 含 @ 提取？取最后一个 @ 段判定提取词
  const lastAt = s.lastIndexOf('@')
  if (lastAt > 0) {
    const tail = s.slice(lastAt + 1).trim()
    const head = s.slice(0, lastAt)
    if (SELF_WORDS.has(tail)) return mkCss(cssChain(head), 'text')
    if (HTML_WORDS.has(tail)) return mkCss(cssChain(head), 'html')
    if (ATTR_WORDS.has(tail)) return mkCss(cssChain(head), { attr: tail })
  }
  // 无 @：裸属性词（chapterUrl="href"）→ 自身取属性
  if (ATTR_WORDS.has(s)) return mkCss(':scope', { attr: s })
  // 无提取 → 整串容器链 + text
  return mkCss(cssChain(s), 'text')
}

/**
 * Legado 容器链 → CSS 后代选择器：
 *   a.1 → a:nth-of-type(2)；a.0 → a；id.x@dl → #x dl；@ 空格式级联。
 */
function cssChain(raw: string): string {
  return raw
    /** 去 !index:index 遍历跳过（`tbody.0@td@a!0`） */
    .replace(/!\d+(:\d+)*/g, '')
    .split('@')
    .map(seg => {
      let x = seg.trim()
      if (!x) return ''
      if (x.startsWith('id.')) x = '#' + x.slice(3)
      else if (x.startsWith('class.')) x = '.' + x.slice(6)
      const idx = x.match(/^([a-zA-Z][\w-]*|\.[\w-]+|#[\w-]+)\.(\d+)$/)
      if (idx !== null) {
        const n = Number(idx[2])
        return n === 0 ? idx[1] : idx[1] + ':nth-of-type(' + (n + 1) + ')'
      }
      return x
    })
    .filter(Boolean)
    .join(' ')
}

/** 多规则 firstOf：`a.0@text||a.1@text` 依次尝试。 */
export function parseLegadoRuleFirstOf(raw: string | undefined): Rule | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  const parts = raw.split('||').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) return undefined
  if (parts.length === 1) return parseLegadoRule(parts[0])
  const rules = parts.map(parseLegadoRule).filter(Boolean) as Rule[]
  if (rules.length === 0) return undefined
  return { via: 'firstOf', rules }
}

/**
 * 解析 Legado searchUrl：
 *   "https://example.com/search?q={{key}}"
 *   "https://example.com/search, {\"method\":\"POST\",\"body\":\"key={{key}}\",\"charset\":\"gbk\"}"
 */
function parseLegadoSearchUrl(
  searchUrl: string | undefined,
  baseUrl: string,
): { url: string; method: 'GET' | 'POST'; body?: string; charset?: string } | undefined {
  if (!searchUrl || typeof searchUrl !== 'string') return undefined
  let s = searchUrl.trim()
  if (!s) return undefined

  // 去掉 webView / 分页方案 << 兑现
  if (s.includes('webView') || s.includes('{webView')) return undefined

  let method: 'GET' | 'POST' = 'GET'
  let body: string | undefined
  let charset: string | undefined
  let url = s

  const commaIdx = s.indexOf(',')
  if (commaIdx > 0 && s.slice(commaIdx + 1).trim().startsWith('{')) {
    url = s.slice(0, commaIdx).trim()
    try {
      const config = JSON.parse(s.slice(commaIdx + 1).trim())
      if (config.method) method = config.method.toUpperCase() === 'POST' ? 'POST' : 'GET'
      if (config.body) body = config.body
      if (config.charset) charset = config.charset
    } catch {
      // JSON 解析失败，忽略配置部分
    }
  }

  if (url.startsWith('/')) url = baseUrl + url
  return { url, method, body, charset }
}

/** 把单个 Legado 书源转成 v2。 */
export function convertLegadoToV2(legado: LegadoSource): BookSource | null {
  const name = legado.bookSourceName
  const url = legado.bookSourceUrl
  if (!name || !url) return null

  const baseUrl = url.replace(/\/$/, '')
  const source: BookSource = {
    schema: BOOKSOURCE_SCHEMA,
    name,
    url: baseUrl,
    http: { charset: 'auto' },
  } as BookSource

  if (legado.httpUserAgent) source.http!.userAgent = legado.httpUserAgent

  // ── 搜索 ──
  const searchUrl = parseLegadoSearchUrl(legado.searchUrl, baseUrl)
  if (searchUrl) {
    const searchReq: RequestSpec = {
      url: searchUrl.url,
    } as RequestSpec
    if (searchUrl.method === 'POST') {
      searchReq.method = 'POST'
      if (searchUrl.body) searchReq.body = searchUrl.body
    }
    if (searchUrl.charset) searchReq.charset = normCharset(searchUrl.charset)

    const rs = legado.ruleSearch
    const listSelect = rs?.bookList
    if (listSelect) {
      source.search = {
        request: searchReq,
        list: {
          via: 'css',
          select: cssChain(listSelect.replace(/^@css:/, '')),
          item: buildSearchItem(rs),
        },
      }
    }
  }

  // ── 书详情 ──
  const rb = legado.ruleBookInfo
  const bookInfo: { request: { url: string }; name: Rule; author?: Rule; cover?: Rule; intro?: Rule; tocUrl?: Rule } =
    { request: { url: '{{bookUrl}}' }, name: { via: 'css', select: 'h1', extract: 'text' } }
  if (rb) {
    const nr = parseLegadoRuleFirstOf(rb.name)
    if (nr) bookInfo.name = nr
    const ar = parseLegadoRuleFirstOf(rb.author)
    if (ar) bookInfo.author = ar
    const cr = parseLegadoRule(rb.coverUrl)
    if (cr) bookInfo.cover = cr
    const ir = parseLegadoRule(rb.intro)
    if (ir) bookInfo.intro = ir
    const tr = parseLegadoRule(rb.tocUrl)
    if (tr) bookInfo.tocUrl = tr
  }
  if (!bookInfo.tocUrl) bookInfo.tocUrl = { via: 'template', template: '{{bookUrl}}' }
  source.bookInfo = bookInfo

  // ── 目录 ──
  const rt = legado.ruleToc
  const toc: { request: { url: string }; list: { via: 'css'; select: string; item: Record<string, Rule> } } = {
    request: { url: '{{tocUrl}}' },
    list: {
      via: 'css',
      select: 'li a, dd a, .chapter-list li',
      item: {
        name: { via: 'css', select: 'a', extract: 'text' },
        url: { via: 'css', select: 'a', extract: { attr: 'href' } },
      },
    },
  }
  if (rt?.chapterList) {
    toc.list.select = cssChain(rt.chapterList.replace(/^@css:/, ''))
    const item: Record<string, Rule> = {}
    const nn = parseLegadoRule(rt.chapterName)
    if (nn) item.name = nn
    const un = parseLegadoRule(rt.chapterUrl)
    if (un) item.url = un
    if (Object.keys(item).length > 0) toc.list.item = item
  }
  source.toc = toc

  // ── 正文 ──
  const rc = legado.ruleContent
  const content: { request: { url: string }; value: Rule; nextPage?: Rule; maxPages?: number } = {
    request: { url: '{{chapterUrl}}' },
    value: {
      via: 'css',
      select: '#content, .content, .read-content, .chapter-content',
      extract: 'html',
    },
  }
  if (rc) {
    const cr = parseLegadoRule(rc.content)
    if (cr) content.value = cr
    const nr = parseLegadoRule(rc.nextContentUrl)
    if (nr) {
      content.nextPage = nr
      content.maxPages = 3
    }
  }
  source.content = content

  return source
}

/** 归一 charset 为 v2 枚举。 */
function normCharset(cs: string): 'auto' | 'utf-8' | 'gbk' | 'gb18030' {
  const v = (cs || '').toLowerCase().replace(/[_-]/g, '')
  if (v.includes('utf')) return 'utf-8'
  if (v.includes('18030')) return 'gb18030'
  if (v.includes('2312')) return 'gbk'
  if (v.includes('gbk')) return 'gbk'
  return 'auto'
}

/** 组装搜索条目字段规则。 */
function buildSearchItem(rs: NonNullable<LegadoSource['ruleSearch']>): Record<string, Rule> {
  const item: Record<string, Rule> = {}
  const urlRule = parseLegadoRule(rs.bookUrl)
  if (urlRule) item.bookUrl = urlRule
  const nameRule = parseLegadoRuleFirstOf(rs.name)
  if (nameRule) item.name = nameRule
  const authorRule = parseLegadoRuleFirstOf(rs.author)
  if (authorRule) item.author = authorRule
  const coverRule = parseLegadoRule(rs.coverUrl)
  if (coverRule) item.cover = coverRule
  const introRule = parseLegadoRule(rs.intro)
  if (introRule) item.intro = introRule
  return item
}

/** 剥 Legado 不可执行的 JS 表达式模板（{{'...'}}/{{page-1}}/{{$.x}}），保留纯 {{word}} 变量。 */
function stripJsTemplates(s: string): string {
  return s.replace(/\{\{[^}]*[^A-Za-z0-9_][^}]*\}\}/g, '')
}

/**
 * 检查转换结果是否仍残留引擎无法处理的 Legado 语法（JSONPath `@xx$.x`、JS/表达式模板、java. 调用）。
 * 用于导入前把不可用量源剔除，避免坏源拖低搜索体验。
 */
export function isLegadoUnsupported(v2: BookSource): string | null {
  const checks: Array<[string, RegExp]> = [
    ['JSONPath 列表/字段', /\$\.[A-Za-z_\[(]|@json|via:"json"/],
    ['JS 模板', /\{\{[^}]*[^A-Za-z0-9_][^}]*\}\}/],
    ['java 调用', /java\.[A-Za-z]+/],
    ['webView', /webView/i],
    ['cookie 注入', /cookie\.[A-Za-z]+/i],
  ]
  const walk = (o: unknown, reason: string): string | null => {
    if (typeof o === 'string') {
      for (const [label, re] of checks) if (re.test(o)) return label
      return null
    }
    if (Array.isArray(o)) {
      for (const v of o) {
        const r = walk(v, reason)
        if (r) return r
      }
      return null
    }
    if (o !== null && typeof o === 'object') {
      for (const v of Object.values(o as Record<string, unknown>)) {
        const r = walk(v, reason)
        if (r) return r
      }
    }
    return null
  }
  return walk(v2, '')
}

/** 批量转换 Legado 书源数组。 */
export function convertLegadoArray(arr: unknown[]): { sources: BookSource[]; skipped: number } {
  const sources: BookSource[] = []
  let skipped = 0
  for (const item of arr) {
    try {
      const converted = convertLegadoToV2(item as LegadoSource)
      if (converted) sources.push(converted)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { sources, skipped }
}