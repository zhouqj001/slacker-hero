/**
 * The media storage domain: eight content tables plus the global KV slot,
 * opened over the deployment's routed storage backend.
 *
 * Layout is per-domain (`per-record`): every record lands as its own
 * document — right for article/plan-sized content and individually
 * disposable records. The global slot carries quota counters and cursors
 * (e.g. per-account daily publish counters keyed by `publish:counter:<id>:<date>`).
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** 账号人设：定位/语气/受众/禁忌/标签，注入所有创作与评分 prompt。order 小者在前（第一条为在岗员工）。 */
export const PersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  positioning: z.string(),
  tone: z.string(),
  audience: z.string(),
  taboos: z.array(z.string()),
  tags: z.array(z.string()),
  order: z.number().optional(),
  /** 绑定的发布账号（1:1）。缺省 = 通用人设，不绑定任何账号。 */
  accountId: z.string().optional(),
  updatedAt: z.number(),
})

/**
 * 账号概况快照：一次采集的结果，覆盖在各平台共有的维度上。
 * 字段一律 optional——不同平台后台给的东西不一样，缺就是缺，不填 0 冒充。
 */
export const AccountProfileSchema = z.object({
  /** 采集时刻。 */
  capturedAt: z.number(),
  /** 平台侧账号唯一标识（如头条号ID）。 */
  platformUserId: z.string().optional(),
  /** 平台侧展示名。 */
  displayName: z.string().optional(),
  /** 运营人（脱敏串，如 `周** (3*****7)`）。 */
  operator: z.string().optional(),

  fansTotal: z.number().optional(),
  fansGainedYesterday: z.number().optional(),
  fansLostYesterday: z.number().optional(),
  fansActiveYesterday: z.number().optional(),
  /** 活跃粉丝占比，0~1。 */
  fansActiveRatio: z.number().optional(),
  /** 粉丝地域分布，按占比降序。 */
  fansRegions: z.array(z.object({ name: z.string(), ratio: z.number() })).optional(),

  /** 总阅读(播放)量。 */
  readsTotal: z.number().optional(),
  readsYesterday: z.number().optional(),
  /** 昨日展现量。 */
  showsYesterday: z.number().optional(),
  likesYesterday: z.number().optional(),
  commentsYesterday: z.number().optional(),
  /** 累计获得的赞同/点赞总数——无展现/阅读口径的平台（如知乎）用这个体现账号量级。 */
  likesTotal: z.number().optional(),
  /** 平台侧已发内容总数（按平台口径，如知乎 = 文章 + 回答）。 */
  worksCount: z.number().optional(),

  /** 收益（元）。 */
  incomeYesterday: z.number().optional(),
  income30d: z.number().optional(),
  incomeMonth: z.number().optional(),
  incomeTotal: z.number().optional(),
  /** 可提现金额（元）。 */
  withdrawable: z.number().optional(),
  /** 平台自己给的信用分（头条 0~100）。 */
  creditScore: z.number().optional(),
  /** 安全评分（账号设置页，100 满分）。 */
  securityScore: z.number().optional(),
  /** 认证状态原文，如「未认证」。 */
  certifyStatus: z.string().optional(),
  /** 采集时页面里出现的风控/异常提示——有值说明账号状态不对，别当正常数据用。 */
  warnings: z.array(z.string()).optional(),
})

/** 平台账号：发布主体与登录态元数据（浏览器 profile 按 id 隔离）。 */
export const AccountSchema = z.object({
  id: z.string(),
  platform: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'expired', 'disabled']),
  dailyLimit: z.number().int().positive(),
  lastLoginCheckAt: z.number().nullable(),
  createdAt: z.number(),
  /** 最近一次采集到的账号概况（见 collectProfile / AccountProfile）。 */
  profile: AccountProfileSchema.optional(),
  /**
   * 发布目标：周期（周/月）+ 篇数 + 偏好时段（HH:mm）。
   * 达成率只按 publish 表里的真实成功记录统计，不推算、不补 0。缺省 = 没定目标。
   */
  cadence: z.object({
    period: z.enum(['week', 'month']),
    target: z.number().int().nonnegative(),
    slots: z.array(z.string()),
  }).optional(),
  /** 内容方向（题材栏目）：注入写作 prompt，并作为该账号选题池的规划依据。 */
  pillars: z.array(z.string()).optional(),
})

/** 账号下的单条作品及其表现（作品管理列表采集而来）。 */
export const AccountWorkSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  platform: z.string(),
  /** 作品标题。 */
  title: z.string(),
  /** 作品类型原文，如「文章」「微头条」「视频」。 */
  kind: z.string().optional(),
  /** 发布时间戳；页面只给 `MM-DD HH:mm` 时按当年补全。 */
  publishedAt: z.number().optional(),
  publishedAtText: z.string().optional(),
  shows: z.number().optional(),
  reads: z.number().optional(),
  likes: z.number().optional(),
  comments: z.number().optional(),
  collects: z.number().optional(),
  /** 作品链接（后台给得出时）。 */
  url: z.string().optional(),
  capturedAt: z.number(),
})

/** 单个人设视角下的契合度评分结果。 */
const PersonaFitSchema = z.object({
  score: z.number(),
  reason: z.string(),
  scoredAt: z.number(),
})

/** 选题：热榜抓取 / 手动录入 / 常青库（source 区分），带按人设的契合度评分。 */
export const HotspotSchema = z.object({
  id: z.string(),
  source: z.enum(['fetch', 'manual', 'evergreen']),
  title: z.string(),
  summary: z.string().optional(),
  heat: z.number().optional(),
  url: z.string().optional(),
  fetchedAt: z.number(),
  /** 旧版单值评分（通用人设视角），保留兼容旧数据；新评分一律写 personaFits。 */
  personaFit: PersonaFitSchema.optional(),
  /** 每个账号人设一份的评分（personaId → fit）；未绑人设的账号统一落在 '_default'。 */
  personaFits: z.record(z.string(), PersonaFitSchema).optional(),
  state: z.enum(['pending', 'adopted', 'rejected', 'used']),
  linkedArticleId: z.string().optional(),
  /** 归属账号：这条选题进该账号的选题池。空 = 公共池（只靠人设契合度推荐）。 */
  accountId: z.string().optional(),
})

/** 文章：markdown 正文 + 平台适配版本。 */
export const ArticleSchema = z.object({
  id: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  status: z.enum(['draft', 'generating', 'generated', 'editing', 'approved', 'failed']),
  topic: z.object({
    hotspotId: z.string().optional(),
    evergreenId: z.string().optional(),
    manual: z.boolean().optional(),
  }),
  platformVersions: z.record(z.string(), z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** 媒体资产：封面/配图文件登记（文件本体在 M6 落地）。 */
export const AssetSchema = z.object({
  id: z.string(),
  articleId: z.string().nullable(),
  kind: z.enum(['cover', 'inline']),
  origin: z.enum(['ai', 'template', 'upload']),
  file: z.string(),
  prompt: z.string().optional(),
  createdAt: z.number(),
})

/**
 * 发布计划：文章 × 平台 × 账号 × 时间，状态机含可跳过的审核闸。
 * `articleId` 可为 null = 「待排槽」：由账号发布目标推算出来的时段占位记录，
 * 表示「本期这一档期要发一篇，但还没挑文章」，出现在月历/泳道里等用户选文章填充。
 * 待排槽固定 state='planned'，不可审不可发（发布链路会明确拒绝）。
 */
export const PlanSchema = z.object({
  id: z.string(),
  articleId: z.string().nullable(),
  platform: z.string(),
  accountId: z.string(),
  scheduledAt: z.number(),
  state: z.enum(['planned', 'pending-review', 'approved', 'publishing', 'published', 'failed', 'degraded', 'skipped']),
  reviewNote: z.string().optional(),
  createdAt: z.number(),
})

/**
 * 发布记录：自动化成功 / 失败 / 降级人工回填 / 半自动待人工发布。
 * `awaiting-manual` = 内容已填进平台编辑器、等用户在浏览器里点最终发布，
 * 后台还会继续轮询确认；确认到才升级成 `success`，超时则保持待人工（绝不提前记成功）。
 */
export const PublishSchema = z.object({
  id: z.string(),
  planId: z.string(),
  platform: z.string(),
  accountId: z.string(),
  state: z.enum(['success', 'failed', 'degraded-manual', 'awaiting-manual']),
  url: z.string().optional(),
  error: z.string().optional(),
  /** 人类可读说明（半自动时写「请在浏览器点预览并发布」，确认后写检出的状态标签）。 */
  note: z.string().optional(),
  draftPackage: z.record(z.string(), z.string()).optional(),
  publishedAt: z.number().nullable(),
})

/** 复盘：发布后数据回流（自动抓取或手动录入）。 */
export const ReviewSchema = z.object({
  id: z.string(),
  publishId: z.string(),
  articleId: z.string(),
  platform: z.string(),
  metrics: z.object({
    reads: z.number().optional(),
    likes: z.number().optional(),
    comments: z.number().optional(),
    shares: z.number().optional(),
    collected: z.number().optional(),
  }),
  capturedAt: z.number(),
  manual: z.boolean(),
  note: z.string().optional(),
})

/** 全局 KV：配额计数、抓取/同步游标。不可为 null（往返哨兵约束）。 */
const GlobalSchema = z.record(z.string(), z.unknown())

/** 媒体域声明（模块加载即校验名字与版本，失配在 open 前爆掉）。 */
export const mediaDomain = defineDomain({
  name: 'media',
  version: 1,
  layout: 'per-record',
  tables: {
    persona: domainTable(PersonaSchema),
    account: domainTable(AccountSchema),
    hotspot: domainTable(HotspotSchema),
    article: domainTable(ArticleSchema),
    asset: domainTable(AssetSchema),
    plan: domainTable(PlanSchema),
    publish: domainTable(PublishSchema),
    review: domainTable(ReviewSchema),
    account_work: domainTable(AccountWorkSchema),
  },
  global: { schema: GlobalSchema, initial: {} },
})

export type MediaDomainSpec = typeof mediaDomain
/** 打开后的域句柄（表句柄从 `domain.table(name)` 取）。 */
export type MediaDomain = Domain<MediaDomainSpec>

/** 域内内容表名（global 是 spec 槽，不在 tables 里）。 */
export const MEDIA_TABLES = [
  'persona', 'account', 'hotspot', 'article', 'asset', 'plan', 'publish', 'review', 'account_work',
] as const
