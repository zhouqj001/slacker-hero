/**
 * zod Config schema（cordis StandardSchemaV1）。
 * 额度默认值按番茄发文规则第二版口径预填（日 <5 万 / 月 <100 万 / 日更新作品数保守取 2）；
 * 登录后若能从后台读到真实值则运行期覆盖（读不到沿用默认并在 UI 标注「按默认估算」）。
 */
import { z } from 'zod'

/** 单个任务的模型引用（provider + model；reasoningEffort 可选）。 */
export const ModelRefSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})
export type ModelRef = z.output<typeof ModelRefSchema>

export const Config = z.object({
  publish: z.object({
    /** 托管浏览器渠道（不可用时按 chrome → msedge → chromium 回退）。 */
    browserChannel: z.string().default('msedge'),
    headless: z.boolean().default(false),
    /** 每账号每日可提交字数（平台口径 <50000，本地保守取 50000）。 */
    dailyWordLimit: z.number().int().positive().default(50_000),
    /** 每账号每自然月可提交字数（平台口径 <1000000）。 */
    monthlyWordLimit: z.number().int().positive().default(1_000_000),
    /** 每账号每日可更新作品数（平台按作品计，保守默认 2）。 */
    dailyUpdateWorksLimit: z.number().int().positive().default(2),
  }).default({
    browserChannel: 'msedge', headless: false,
    dailyWordLimit: 50_000, monthlyWordLimit: 1_000_000, dailyUpdateWorksLimit: 2,
  }),
  /** 分级门禁策略（plan ①）：minGrade 以下才返工，maxRewrites 为全局重写上限。 */
  quality: z.object({
    minGrade: z.enum(['gold', 'silver', 'bronze']).default('silver'),
    maxRewrites: z.number().int().min(0).max(3).default(2),
  }).default({ minGrade: 'silver', maxRewrites: 2 }),
  /** 按任务分模型（plan ③）：未配置即沿用 dsh 默认模型。 */
  llm: z.object({
    write: ModelRefSchema.optional(),
    review: ModelRefSchema.optional(),
    utility: ModelRefSchema.optional(),
  }).default({}),
}).prefault({})

/** 校验后的运行时配置类型。 */
export type WriterConfig = z.output<typeof Config>
