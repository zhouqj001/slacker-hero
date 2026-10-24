/**
 * 媒体工具集 —— 注册给 dsh agent 调用，让「写文章」「排计划」都走 agent 而非手搓 prompt。
 *
 * 设计约束：
 *   - 本文件只放**只读**工具（第一阶段地基）：让 agent 能自己查账号/人设/选题/历史，
 *     从而自己判断「这条该派给谁」，而不是由代码替它猜。
 *   - 写操作（建稿/建计划/落库）留到后续阶段，并以「先预览后提交」两段式开放，
 *     避免 agent 判断失误时留下脏数据。
 *   - 工具一律返回结构化 JSON，由 `output.schema` 保证形状，不依赖模型解析自由文本。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MediaDomain } from './domain.ts'

type Account = ReturnType<typeof accountRows>[number]
type Hotspot = ReturnType<typeof hotspotRows>[number]

/** 账号 + 绑定人设（agent 判断「这条该给谁」的依据）。 */
function accountRows(domain: MediaDomain) {
  const personas = [...domain.table('persona').entries()].map(([, v]) => v)
  const byAccount = new Map<string, (typeof personas)[number]>()
  for (const p of personas) {
    if (p.accountId) byAccount.set(p.accountId, p)
  }
  return [...domain.table('account').entries()].map(([, a]) => {
    const persona = byAccount.get(a.id)
    return {
      id: a.id,
      displayName: a.displayName,
      platform: a.platform,
      status: a.status,
      dailyLimit: a.dailyLimit,
      /** 绑定的专属人设；未绑定为 null，agent 需按通用人设理解。 */
      persona: persona
        ? {
            name: persona.name,
            positioning: persona.positioning,
            tone: persona.tone,
            audience: persona.audience,
            taboos: persona.taboos,
            tags: persona.tags,
          }
        : null,
    }
  })
}

/** 待用选题。 */
function hotspotRows(domain: MediaDomain) {
  return [...domain.table('hotspot').entries()]
    .map(([, h]) => h)
    .filter(h => h.state === 'pending')
    .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || b.fetchedAt - a.fetchedAt)
    .slice(0, 30)
    .map(h => ({
      id: h.id,
      title: h.title,
      summary: h.summary ?? '',
      source: h.source,
      heat: h.heat ?? null,
      url: h.url ?? null,
    }))
}

/** 某账号最近发过的选题——用于去重，别把写过的题再派一次。 */
function recentTopicRows(domain: MediaDomain, accountId: string, limit: number) {
  const plans = [...domain.table('plan').entries()].map(([, v]) => v)
    // 待排槽（还没选文章）不算「发过的选题」，跳过
    .filter(p => p.accountId === accountId && p.articleId !== null)
    .sort((a, b) => b.scheduledAt - a.scheduledAt)
    .slice(0, limit)
  const articles = new Map([...domain.table('article').entries()].map(([, v]) => [v.id, v]))
  return plans
    .map(p => {
      const art = articles.get(p.articleId!)
      return {
        articleId: p.articleId,
        title: art?.title ?? '(文章已删除)',
        platform: p.platform,
        state: p.state,
        scheduledAt: p.scheduledAt,
      }
    })
    .filter(r => r.title !== '(文章已删除)')
}

/** 统一的输出投影：把值 JSON 化成模型可读文本。 */
function jsonOut<S extends Parameters<typeof defineTool>[0]['parameters']>(
  properties: S,
) {
  return {
    schema: { type: 'object' as const, properties, additionalProperties: false as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}

/**
 * 注册媒体只读工具组。
 * @returns disposer（随插件卸载一并回收）
 */
export function registerMediaTools(ctx: Context, domain: MediaDomain): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'media_list_accounts',
    description:
      '列出所有发布账号及其绑定的专属人设（定位/语气/受众/禁忌/标签）。'
      + '派活前先调用它，判断「这条内容该发给哪个号」。',
    parameters: {
      platform: {
        type: 'string',
        description: '只返回该平台的账号；留空返回全部。取值如 wechat / toutiao / zhihu / xiaohongshu / douyin。',
      },
    },
    output: jsonOut({
      accounts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            platform: { type: 'string' },
            status: { type: 'string' },
            dailyLimit: { type: 'integer' },
            persona: {
              type: 'json',
              description: '绑定的专属人设；null 表示该账号没有专属人设，按通用人设处理。',
            },
          },
        },
      },
    }),
    async execute(args: { platform?: string }) {
      const rows = accountRows(domain)
      const filtered = args.platform ? rows.filter(r => r.platform === args.platform) : rows
      return { accounts: filtered }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'media_list_hotspots',
    description:
      '列出待用选题（热榜抓取 / 手动录入 / 常青），按热度排序。排计划时用来挑题，避免同一选题重复派发。',
    parameters: {
      limit: { type: 'integer', description: '返回条数，默认 20，上限 30。' },
    },
    output: jsonOut({
      hotspots: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            summary: { type: 'string' },
            source: { type: 'string' },
            heat: { type: 'json' },
            url: { type: 'json' },
          },
        },
      },
    }),
    async execute(args: { limit?: number }) {
      const limit = Math.max(1, Math.min(30, Math.round(args.limit ?? 20)))
      return { hotspots: hotspotRows(domain).slice(0, limit) }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'media_recent_topics',
    description:
      '查询某个账号最近发过什么（用于去重：别把已经写过的选题再派给它）。',
    parameters: {
      accountId: { type: 'string', required: true, description: '账号 id，来自 media_list_accounts。' },
      limit: { type: 'integer', description: '返回条数，默认 10。' },
    },
    output: jsonOut({
      accountId: { type: 'string' },
      recent: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            articleId: { type: 'string' },
            title: { type: 'string' },
            platform: { type: 'string' },
            state: { type: 'string' },
            scheduledAt: { type: 'integer' },
          },
        },
      },
    }),
    async execute(args: { accountId: string; limit?: number }) {
      const limit = Math.max(1, Math.min(30, Math.round(args.limit ?? 10)))
      return { accountId: args.accountId, recent: recentTopicRows(domain, args.accountId, limit) }
    },
  })))

  return () => { for (const d of disposers) { try { d() } catch { /* 已卸载 */ } } }
}

/** 仅供类型检查：确保上面的行投影与表结构不脱节。 */
export type _RowTypes = [Account, Hotspot]