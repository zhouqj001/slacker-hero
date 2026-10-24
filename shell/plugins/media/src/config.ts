/**
 * zod Config schema（cordis StandardSchemaV1）。形状与 plan §6 定稿一致；
 * M3 消费 review/hotspot/llm，publish/imageGen 为 M4/M6 预留（仅默认值，无副作用）。
 */
import { z } from 'zod'

export const Config = z.object({
  llm: z.object({
    // 默认走登录账号额度（deepseek-account）：与 dsh 会话同源、无需单独配 API Key；
    // deepseek-official 需要在 credentials 服务存 DEEPSEEK_API_KEY
    provider: z.enum(['deepseek-official', 'deepseek-account']).default('deepseek-account'),
    model: z.string().optional(),
  }).default({ provider: 'deepseek-account' }),
  review: z.object({
    /** 发布前审核总闸：开 → 新计划 pending-review；关 → 直接 approved。 */
    requireApproval: z.boolean().default(true),
  }).default({ requireApproval: true }),
  hotspot: z.object({
    /** personaFit 推荐阈值（低于不硬拦，仅标记不建议）。 */
    personaFitThreshold: z.number().min(0).max(1).default(0.6),
    /** 聚合热榜抓取源（name + URL），解析失败只记日志。 */
    fetchers: z.array(z.object({ name: z.string(), url: z.string() })).default([]),
  }).default({ personaFitThreshold: 0.6, fetchers: [] }),
  publish: z.object({
    browserChannel: z.string().default('msedge'),
    headless: z.boolean().default(false),
    dailyLimitPerAccount: z.number().default(3),
    minGapMinutes: z.number().default(30),
    wechatDirectSend: z.boolean().default(false),
    /** 定时调度：到点自动执行已审核通过的计划（默认关，避免误发）。 */
    autoRun: z.boolean().default(false),
    /** 调度轮询间隔（秒，最小 15）。 */
    tickSeconds: z.number().default(60),
  }).default({
    browserChannel: 'msedge', headless: false,
    dailyLimitPerAccount: 3, minGapMinutes: 30, wechatDirectSend: false,
    autoRun: false, tickSeconds: 60,
  }),
  imageGen: z.object({
    /** 生图总开关：关掉后一律走 SVG 模板，不发外部请求。 */
    enabled: z.boolean().default(false),
    /** 允许 agent 自动配图（agent 自行决定要图会花钱，默认必须显式授权）。 */
    allowAgent: z.boolean().default(false),
    /** 默认渠道 id；为空则取第一个可用渠道。 */
    defaultChannelId: z.string().default(''),
  }).default({
    enabled: false,
    allowAgent: false,
    defaultChannelId: '',
  }),
}).prefault({})

/** 校验后的运行时配置类型。 */
export type MediaConfig = z.output<typeof Config>
