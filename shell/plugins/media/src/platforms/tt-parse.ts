/**
 * 头条后台 DOM 取数的小工具：把「标签 + 数字」的卡片文案拆成结构化数字。
 * 头条后台是 SPA，class 名带 hash 会变，**按文案匹配比按选择器稳**。
 */
import type { Page } from 'playwright-core'

/** 页面全部可见文本（压掉空白）。 */
export async function pageText(page: Page): Promise<string> {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')
}

/**
 * 「1,531」「1.24元」「23.91%」「46」→ 数值；解析不了返回 undefined。
 *
 * 头条的大数会用中文单位：`1.24万` = 12400、`3.5亿` = 350000000。
 * 只按 `[\d,]+` 匹配会把 `1.24万` 读成 **1**（数字对不上，指标就全错位了）。
 */
export function parseNum(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const m = /(-?[\d,]+(?:\.\d+)?)\s*([万亿])?/.exec(raw.replace(/\s/g, ''))
  if (!m) return undefined
  const base = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(base)) return undefined
  const unit = m[2]
  if (unit === '万') return Math.round(base * 10_000)
  if (unit === '亿') return Math.round(base * 100_000_000)
  return base
}

/** 正则元字符转义。 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 数量类字段后面跟的东西：`1,531` / `1.24万` / `1.2亿`。 */
const COUNT_RE = '(-?[\\d,]+(?:\\.\\d+)?\\s*[万亿]?)'

/**
 * 在整页文本里找「标签 + 紧跟的数字」。
 *
 * 不用 `indexOf(label)` 再往后看：头条后台导航里就有 `粉丝数据`、`评论管理`，
 * `indexOf('粉丝数')` 会先命中 `粉丝数据`，往后 40 个字符全是菜单文字，取不到数。
 * 正则要求标签后面（允许空白）立刻出现数字，从根上避开这类子串碰撞。
 */
export function numNear(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const m = new RegExp(`${esc(label)}\\s*${COUNT_RE}`).exec(text)
    if (!m) continue
    const n = parseNum(m[1])
    if (n !== undefined) return n
  }
  return undefined
}

/** 地域分布的取词黑名单：这些是指标名不是省份（否则「粉丝占比 23.91%」会被当地域）。 */
const REGION_STOPWORDS = /占比|比例|占比|粉丝|活跃|率|阅读|展现|评论|点赞/

/** 「江苏 31.82%」这类地域分布。 */
export function parseRegions(text: string, limit = 10): Array<{ name: string; ratio: number }> {
  const out: Array<{ name: string; ratio: number }> = []
  const re = /([一-龥]{2,4})\s*(\d{1,3}(?:\.\d+)?)%/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && out.length < limit) {
    if (REGION_STOPWORDS.test(m[1])) continue
    out.push({ name: m[1], ratio: Number(m[2]) / 100 })
  }
  return out
}

/**
 * 作品管理列表：每张卡片是「标题 + 时间 + 展现/阅读/点赞/评论」。
 * 按行取（后台用 div 模拟表格），避免依赖 class。
 */
export interface RawWork {
  title: string
  publishedAtText?: string
  shows?: number
  reads?: number
  likes?: number
  comments?: number
  collects?: number
  kind?: string
  url?: string
}

/**
 * 作品管理列表。
 *
 * 坑一：容器是嵌套的（一篇作品外面套了 3 层都命中 `[class*="card"]`），
 *       直接遍历会得到 3 倍重复，且外层把多篇的文案拼在一起，指标会串。
 *       解法：**只保留最内层**——即自身命中、但内部没有别的元素命中。
 * 坑二：指标是「标签」和「数字」两个独立元素，中间是换行，`\s*` 要能吃换行。
 */
export async function scrapeWorkCards(page: Page): Promise<RawWork[]> {
  const rows = await page.evaluate(() => {
    const SEL = '[class*="content-item"], [class*="work-item"], [class*="card"], [class*="publish-item"]'
    const METRIC = /(展现|阅读|播放)\s*(-?[\d,]+(?:\.\d+)?\s*[万亿]?)/
    const all = [...document.querySelectorAll(SEL)] as HTMLElement[]
    const hits = all.filter(el => METRIC.test(el.innerText || ''))
    // 只留最内层：自身命中、且不包含另一个命中的元素（外层会把多篇文案拼一起，指标串台）
    const leaves = hits.filter(el => !hits.some(other => other !== el && el.contains(other)))

    return leaves.map((el) => {
      const text = (el.innerText || '').replace(/[^\S\n]+/g, ' ')
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
      const pick = (label: string): string | undefined => {
        const m = new RegExp(label + '\\s*(-?[\\d,]+(?:\\.\\d+)?\\s*[万亿]?)').exec(text)
        return m ? m[1].trim() : undefined
      }
      const timeM = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})|(\d{2}-\d{2}\s+\d{2}:\d{2})/.exec(text)
      const title = lines.find(l =>
        l.length >= 4 &&
        !/^(展现|阅读|播放|点赞|评论|收藏|全部|文章|视频|微头条|小视频|音频)/.test(l) &&
        !/^\d{2}-\d{2}$/.test(l) &&
        !/^\d{2}:\d{2}$/.test(l)) ?? ''
      return {
        title,
        publishedAtText: timeM ? (timeM[1] ?? timeM[2]) : undefined,
        showsRaw: pick('展现'),
        readsRaw: pick('阅读'),
        likesRaw: pick('点赞'),
        commentsRaw: pick('评论'),
        collectsRaw: pick('收藏'),
        url: el.querySelector('a[href]')?.getAttribute('href') ?? undefined,
      }
    })
  }).catch((err: unknown) => {
    // 以前这里静默返回空数组，页面一改版就表现为「一条都没抓到」，看不出是代码崩了还是没数据
    console.warn('[media/tt-parse] 作品列表解析异常:', err instanceof Error ? err.message : String(err))
    return [] as RawWorkRaw[]
  })
  // 三层嵌套（article-card / -wrap / -bone）文案完全一样，按「标题+时间」去重
  const seen = new Set<string>()
  const out: RawWork[] = []
  for (const r of rows as RawWorkRaw[]) {
    if (!r.title) continue
    const key = `${r.title}@${r.publishedAtText ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      title: r.title,
      publishedAtText: r.publishedAtText,
      shows: parseNum(r.showsRaw),
      reads: parseNum(r.readsRaw),
      likes: parseNum(r.likesRaw),
      comments: parseNum(r.commentsRaw),
      collects: parseNum(r.collectsRaw),
      url: r.url,
    })
  }
  return out
}

interface RawWorkRaw {
  title: string
  publishedAtText?: string
  showsRaw?: string
  readsRaw?: string
  likesRaw?: string
  commentsRaw?: string
  collectsRaw?: string
  url?: string
}

/** 「26.12%」→ 0.2612 */
export function ratio(raw: string | undefined): number | undefined {
  const n = parseNum(raw)
  return n === undefined ? undefined : n / 100
}