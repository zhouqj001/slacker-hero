/**
 * 草稿优先适配器 —— 抖音。
 *
 * 抖音以视频为主，没有可用的图文自动发布路径，风控与二次确认重，自动化极易触发
 * 人工验证，且 DOM 变动频繁。按 plan 决策「先做草稿导出」：
 *   - 登录态校验 / 拉起登录页：走托管浏览器（与其它平台一致）；
 *   - publish：一律明确抛 PUBLISH_FAILED 并带上草稿包 → 现有降级链把草稿包交给人工；
 *   - draftExport：纯本地生成可直接粘贴的标题 / 正文 / HTML / 话题建议。
 * （小红书已是半自动 adapter，见 xiaohongshu.ts。）
 */
import { browserPool } from './browser.ts'
import { mdToHtml } from './markdown.ts'
import { probeLogin, waitForLogin, type LoginHooks } from './login.ts'
import {
  PublishError,
  type AdapterOptions,
  type DraftPackage,
  type PlatformId,
  type PublishAdapter,
  type PublishJob,
} from './types.ts'

/** 登录超时（与微信/头条一致，留足扫码时间）。 */
const LOGIN_TIMEOUT_MS = 180_000

/** 从标题里粗提话题（去停用词 + 长度过滤），最多 5 个。 */
function suggestTopics(spec: DraftFirstSpec, title: string): string {
  const stop = new Set(['的', '了', '和', '与', '在', '是', '有', '个', '我', '你'])
  const parts = title
    .split(/[\s，。、：:；;！!？?（）()【】\[\]「」·|—\-]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !stop.has(w))
  const picked = parts.slice(0, 5)
  return picked.map(w => `#${w}`).join(' ') || `#${spec.tagPrefix}`
}

export interface DraftFirstSpec {
  platform: PlatformId
  label: string
  /** 创作中心地址（登录页也在此）。 */
  creatorUrl: string
  /** 默认话题前缀（标题提不出词时用）。 */
  tagPrefix: string
  /** 草稿粘贴指引。 */
  hint: string
}

/** 构造一个「草稿优先」适配器。 */
export function createDraftFirstAdapter(spec: DraftFirstSpec): PublishAdapter {
  const { platform, label, creatorUrl } = spec

  const draftOf = (job: PublishJob): DraftPackage => {
    const { article, plan } = job
    const version = article.platformVersions[plan.platform] ?? article.bodyMd
    return {
      platform,
      title: article.title,
      bodyMd: version,
      bodyHtml: mdToHtml(version || article.title),
      topics: suggestTopics(spec, article.title),
      openUrl: creatorUrl,
      hint: spec.hint,
    }
  }

  return {
    platform,
    // 草稿优先：publish 必然抛错，不需要登录校验（避免无谓拉浏览器）
    autoPublish: false,

    async ensureLogin(account: Account2, opts: AdapterOptions, hooks?: LoginHooks) {
      hooks?.onProgress?.({ stage: 'launching', message: '正在拉起托管浏览器…' })
      return browserPool.withPage(account.id, opts, async (page) => {
        await page.goto(creatorUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        hooks?.onProgress?.({ stage: 'opened', message: `已打开${label}创作中心，请在浏览器窗口里登录`, url: page.url() })
        const result = await waitForLogin(platform, page, LOGIN_TIMEOUT_MS, hooks)
        return { loggedIn: true, reason: result.reason }
      }, true)
    },

    async checkLogin(account: Account2, opts: AdapterOptions) {
      return browserPool.withPage(account.id, opts, async (page) => {
        await page.goto(creatorUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(3000)
        return (await probeLogin(platform, page)).loggedIn
      })
    },

    async publish(job: PublishJob) {
      throw new PublishError(
        'PUBLISH_FAILED',
        `${label}自动发布尚未实现（风控强、无稳定接口），已生成草稿包，请到创作中心手动粘贴发布`,
        draftOf(job),
      )
    },

    draftExport(job: PublishJob) {
      return draftOf(job)
    },
  }
}

/** 账号类型别名（与 types.ts 内同名结构一致，避免额外 import 噪声）。 */
type Account2 = Parameters<PublishAdapter['ensureLogin']>[0]

/** 抖音创作中心。 */
export const douyinAdapter: PublishAdapter = createDraftFirstAdapter({
  platform: 'douyin',
  label: '抖音',
  creatorUrl: 'https://creator.douyin.com/',
  tagPrefix: '涨知识',
  hint: '抖音以视频为主：本工具当前只产出图文的草稿包，建议把「口播脚本」拍成视频后发布；如需图文，可在创作中心选择「图文」发布并粘贴标题与正文。',
})