/**
 * PublishAdapter 通用类型（plan §3.5）：每个平台一个 adapter，
 * 浏览器底座共用 browser.ts 的 persistent Edge 池。
 */
import type { z } from 'zod'
import type { AccountProfileSchema, AccountSchema, AccountWorkSchema, ArticleSchema, PlanSchema } from '../domain.ts'

export type Account = z.output<typeof AccountSchema>
export type Article = z.output<typeof ArticleSchema>
export type Plan = z.output<typeof PlanSchema>

export type PlatformId = 'wechat' | 'toutiao' | 'zhihu' | 'xiaohongshu' | 'douyin'

/** 一次发布任务的完整上下文。 */
export interface PublishJob {
  plan: Plan
  article: Article
  account: Account
  /**
   * 本机封面图的绝对路径（`<工作文件夹>/assets/<articleId>/cover.png|jpg|jpeg`）。
   * 平台支持直接上传时由 adapter 传进编辑器封面控件；缺省 = 没有可用封面。
   */
  coverPath?: string
  /** 没有可用封面文件的原因（由调用方如实写进说明，不静默、不拿别的图凑）。 */
  coverMissingReason?: string
  /**
   * 本机文章素材目录的绝对路径（`<工作文件夹>/assets/<articleId>`）。
   * 平台收不到本机地址图，正文里的 `fig-NN.*` 配图要由 adapter 读这个目录上传到平台；
   * 缺省 = 没有可用的本机素材目录（正文里的本机图只能如实去掉）。
   */
  assetDir?: string
}

/** 适配器选项（来自 Config.publish）。 */
export interface AdapterOptions {
  channel: string
  headless: boolean
  wechatDirectSend: boolean
}

/** 降级草稿包：正文/HTML/直达链接，供 UI 粘贴引导。 */
export type DraftPackage = Record<string, string>

/** 发布结果。 */
export interface PublishOutcome {
  /**
   * success=平台侧已保存（微信为草稿）；degraded-manual=失败转人工；
   * awaiting-manual=半自动：内容已填进编辑器，等用户在浏览器里点最终发布。
   */
  state: 'success' | 'degraded-manual' | 'awaiting-manual'
  /** 成功后的文章链接（草稿阶段可为空）。 */
  url?: string
  /** 降级时的草稿包。 */
  draftPackage?: DraftPackage
  /** 人类可读说明（如「已存为草稿，请到后台确认群发」）。 */
  note?: string
  /**
   * `awaiting-manual` 时必填：平台侧实际落库的标题（已被平台上限截断），
   * 供调用方在后台轮询作品列表时做匹配。
   */
  expectedTitle?: string
}

/** 稳定失败码（plan §7）：LOGIN_EXPIRED / DAILY_LIMIT / RISK_CONTROL / DOM_CHANGED。 */
export class PublishError extends Error {
  constructor(
    readonly code: 'LOGIN_EXPIRED' | 'LOGIN_CANCELLED' | 'DAILY_LIMIT' | 'RISK_CONTROL' | 'DOM_CHANGED' | 'PUBLISH_FAILED',
    message: string,
    readonly draftPackage?: DraftPackage,
  ) {
    super(message)
    this.name = 'PublishError'
  }
}

/** 登录过程进度回调的载荷（见 platforms/login.ts#LoginProgress）。 */
export interface LoginProgress {
  stage: 'launching' | 'opened' | 'waiting' | 'verifying'
  message: string
  url?: string
  elapsed?: number
}

/** ensureLogin 的可选钩子：进度回显 + 取消。 */
export interface LoginHooks {
  onProgress?: (p: LoginProgress) => void
  signal?: AbortSignal
}

export interface PublishAdapter {
  readonly platform: PlatformId
  /**
   * 是否支持自动发布。`false` = 草稿优先平台（风控强/无稳定接口），
   * 调用方会跳过登录校验直接取降级草稿包，避免无谓拉起浏览器。
   */
  readonly autoPublish?: boolean
  /**
   * 拉起有头浏览器打开登录页，等待人工扫码；登录态永续落在
   * 浏览器 profile 目录。超时未登录抛 LOGIN_EXPIRED，用户取消抛 LOGIN_CANCELLED。
   * `hooks` 用于进度回显与取消（见 platforms/login.ts）。
   */
  ensureLogin(account: Account, opts: AdapterOptions, hooks?: LoginHooks): Promise<{ loggedIn: boolean }>
  /** 静默校验登录态（不做任何写操作）。 */
  checkLogin(account: Account, opts: AdapterOptions): Promise<boolean>
  /** 主流程：失败统一抛 PublishError（调用方决定降级）。 */
  publish(job: PublishJob, opts: AdapterOptions): Promise<PublishOutcome>
  /**
   * 半自动发布的**后台确认**（可选）：`publish` 返回 `awaiting-manual` 后由调用方
   * 在 detached 任务里调用，自行轮询平台侧是否已发出。
   * 检出返回 `{ url? }`（url 尽力而为，取不到就不编，宁可空着），
   * 超时 / 未检出 / 登录态掉线一律返回 null——由调用方保持「需人工」，不谎报发布成功。
   * 实现方自己管理浏览器页面生命周期，不得阻塞 HTTP 响应路径。
   */
  confirmManualPublish?(
    account: Account,
    opts: AdapterOptions,
    expected: { title: string; since: number },
  ): Promise<{ url?: string; note?: string } | null>
  /** 降级链：组装草稿包（纯本地，不碰浏览器）。 */
  draftExport(job: PublishJob): DraftPackage
  /**
   * M6 复盘线：打开已发布文章的平台数据页，读取阅读/点赞/评论/转发。
   * 未登录抛 LOGIN_EXPIRED，DOM 解析失败抛 DOM_CHANGED（调用方按篇跳过）。
   * 可选——平台未实现时同步路由跳过该账号。
   */
  fetchMetrics?(account: Account, publishUrl: string, opts: AdapterOptions): Promise<FetchMetricsResult>
  /**
   * 采集账号概况（粉丝/作品/收益/账号标识）。纯只读：不点任何按钮、不改任何设置。
   * 未登录抛 LOGIN_EXPIRED；页面结构变了抛 DOM_CHANGED——宁可报错也不填假数。
   */
  collectProfile?(account: Account, opts: AdapterOptions): Promise<AccountProfile>
  /**
   * 采集账号下的作品列表及其表现。纯只读。
   * @param limit 最多取多少条（后台分页，按需翻页）
   */
  collectWorks?(account: Account, opts: AdapterOptions, limit?: number): Promise<AccountWork[]>
}

/** 账号概况采集结果。字段全 optional：平台给什么取什么，缺就是缺。 */
export type AccountProfile = Omit<z.infer<typeof AccountProfileSchema>, 'capturedAt'>

/** 作品采集结果（id/capturedAt 由存储层补）。 */
export type AccountWork = Omit<
  z.infer<typeof AccountWorkSchema>,
  'id' | 'accountId' | 'platform' | 'capturedAt'
>

/** fetchMetrics 返回（字段可部分缺失——平台给多少算多少）。 */
export interface FetchMetricsResult {
  reads?: number
  likes?: number
  comments?: number
  shares?: number
  collected?: number
}
