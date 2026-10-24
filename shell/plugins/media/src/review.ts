/**
 * 复盘线：review 表聚合统计 + 反哺创作的「统计一句话」。
 * 连接关系：review.articleId → article.topic → hotspot.source（追热点 vs 常青）。
 */
import type { z } from 'zod'
import type { AccountSchema, AccountWorkSchema, ArticleSchema, HotspotSchema, ReviewSchema } from './domain.ts'
import type { MediaDomain } from './domain.ts'

type Review = z.output<typeof ReviewSchema>
type Article = z.output<typeof ArticleSchema>
type Hotspot = z.output<typeof HotspotSchema>
type Account = z.output<typeof AccountSchema>
type AccountWork = z.output<typeof AccountWorkSchema>

/** 一组指标的聚合。 */
export interface MetricsAgg {
  count: number
  reads: number
  likes: number
  comments: number
  shares: number
  avgReads: number
}

/** 单个账号的采集结果汇总（全部来自平台后台，字段缺就是缺，不填 0）。 */
export interface AccountStats {
  id: string
  platform: string
  displayName: string
  status: Account['status']
  /** false = 从没采集过，下面的字段全是 undefined（不是 0）。 */
  collected: boolean
  capturedAt?: number
  platformUserId?: string
  fansTotal?: number
  fansGainedYesterday?: number
  fansLostYesterday?: number
  fansActiveYesterday?: number
  fansActiveRatio?: number
  readsTotal?: number
  readsYesterday?: number
  showsYesterday?: number
  likesYesterday?: number
  commentsYesterday?: number
  incomeYesterday?: number
  income30d?: number
  incomeMonth?: number
  incomeTotal?: number
  withdrawable?: number
  creditScore?: number
  securityScore?: number
  certifyStatus?: string
  /** account_work 里该账号的作品汇总。 */
  workCount: number
  workShows: number
  workReads: number
  workLikes: number
  workComments: number
  /** 阅读最高的若干篇。 */
  topWorks: AccountWork[]
  /** 平台自己说的风险提示。 */
  warnings: string[]
}

/** GET /api/media/stats 的载荷。 */
export interface StatsPayload {
  total: { articles: number; plans: number; reviews: number; accounts: number; works: number }
  /** 追热点 vs 常青 vs 手动 表现对比（来自 review；没同步过就是空对象，不是 0） */
  bySource: Record<string, MetricsAgg>
  /** 按平台聚合（来自 review） */
  byPlatform: Record<string, MetricsAgg>
  /** 账号维度：平台后台采集的真实数据 */
  accounts: AccountStats[]
  /** 只汇总「已采集」的账号，UI 用来显示"已汇集 N/M 个账号"。 */
  collectedCount: number
}

function emptyAgg(): MetricsAgg {
  return { count: 0, reads: 0, likes: 0, comments: 0, shares: 0, avgReads: 0 }
}

function addTo(agg: MetricsAgg, r: Review): void {
  agg.count++
  agg.reads += r.metrics.reads ?? 0
  agg.likes += r.metrics.likes ?? 0
  agg.comments += r.metrics.comments ?? 0
  agg.shares += r.metrics.shares ?? 0
}

function finalize(agg: MetricsAgg): MetricsAgg {
  agg.avgReads = agg.count > 0 ? Math.round(agg.reads / agg.count) : 0
  return agg
}

/** 选题来源标签：hotspot / evergreen / manual。 */
function sourceOf(article: Article | undefined, hotspots: Map<string, Hotspot>): string {
  if (!article) return 'unknown'
  if (article.topic.evergreenId) return 'evergreen'
  if (article.topic.hotspotId) {
    const h = hotspots.get(article.topic.hotspotId)
    return h?.source === 'evergreen' ? 'evergreen' : 'hotspot'
  }
  return 'manual'
}

/** 按账号汇总采集到的数据 + 该账号的作品表现。 */
export function computeAccountStats(domain: MediaDomain, topN = 5): AccountStats[] {
  const works = [...domain.table('account_work').entries()].map(([, v]) => v)
  const byAccount = new Map<string, AccountWork[]>()
  for (const w of works) {
    const arr = byAccount.get(w.accountId) ?? []
    arr.push(w)
    byAccount.set(w.accountId, arr)
  }
  return [...domain.table('account').entries()].map(([, a]) => {
    const mine = (byAccount.get(a.id) ?? []).sort((x, y) => (y.reads ?? 0) - (x.reads ?? 0))
    const sum = (pick: (w: AccountWork) => number | undefined): number =>
      mine.reduce((acc, w) => acc + (pick(w) ?? 0), 0)
    const p = a.profile
    return {
      id: a.id,
      platform: a.platform,
      displayName: a.displayName,
      status: a.status,
      collected: p !== undefined,
      capturedAt: p?.capturedAt,
      platformUserId: p?.platformUserId,
      fansTotal: p?.fansTotal,
      fansGainedYesterday: p?.fansGainedYesterday,
      fansLostYesterday: p?.fansLostYesterday,
      fansActiveYesterday: p?.fansActiveYesterday,
      fansActiveRatio: p?.fansActiveRatio,
      readsTotal: p?.readsTotal,
      readsYesterday: p?.readsYesterday,
      showsYesterday: p?.showsYesterday,
      likesYesterday: p?.likesYesterday,
      commentsYesterday: p?.commentsYesterday,
      incomeYesterday: p?.incomeYesterday,
      income30d: p?.income30d,
      incomeMonth: p?.incomeMonth,
      incomeTotal: p?.incomeTotal,
      withdrawable: p?.withdrawable,
      creditScore: p?.creditScore,
      securityScore: p?.securityScore,
      certifyStatus: p?.certifyStatus,
      workCount: mine.length,
      workShows: sum(w => w.shows),
      workReads: sum(w => w.reads),
      workLikes: sum(w => w.likes),
      workComments: sum(w => w.comments),
      topWorks: mine.slice(0, topN),
      warnings: p?.warnings ?? [],
    }
  })
}

/** 聚合全部 review 记录。 */
export function computeStats(domain: MediaDomain): StatsPayload {
  const reviews = [...domain.table('review').entries()].map(([, v]) => v)
  const articles = new Map([...domain.table('article').entries()])
  const hotspots = new Map([...domain.table('hotspot').entries()])

  const bySource: Record<string, MetricsAgg> = {}
  const byPlatform: Record<string, MetricsAgg> = {}

  for (const r of reviews) {
    const src = sourceOf(articles.get(r.articleId), hotspots)
    addTo(bySource[src] ??= emptyAgg(), r)
    addTo(byPlatform[r.platform] ??= emptyAgg(), r)
  }
  for (const k of Object.keys(bySource)) finalize(bySource[k])
  for (const k of Object.keys(byPlatform)) finalize(byPlatform[k])

  const accounts = computeAccountStats(domain)

  return {
    total: {
      articles: domain.table('article').size,
      plans: domain.table('plan').size,
      reviews: reviews.length,
      accounts: accounts.length,
      works: domain.table('account_work').size,
    },
    bySource,
    byPlatform,
    accounts,
    collectedCount: accounts.filter(a => a.collected).length,
  }
}

/** 拼进文章生成 prompt 的「最近统计一句话」（无数据时返回空串）。 */
export function buildStatsSentence(stats: StatsPayload): string {
  const parts: string[] = []
  const hs = stats.bySource.hotspot
  const eg = stats.bySource.evergreen
  if (hs && hs.count > 0) parts.push(`追热点类平均阅读 ${hs.avgReads}`)
  if (eg && eg.count > 0) parts.push(`常青类平均阅读 ${eg.avgReads}`)
  if (parts.length === 0) return ''
  return `历史表现：${parts.join('，')}。请优先参考表现更好的选题方向。`
}
