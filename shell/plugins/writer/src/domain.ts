/**
 * The writer storage domain: novel workshop tables opened over the
 * deployment's routed storage backend.
 *
 * Layout is per-record (`per-record`): every record lands as its own
 * document — right for chapter-sized content and individually disposable
 * records. Schema mirrors plan §3 + §11（docs/writer-plugin-plan.md）：
 *   account / book（含大纲与记忆 + 风格原型与叙述契约）/ setting / foreshadow /
 *   chapter / pending（定稿回写待确认）/ publish_log（发布台账）/
 *   log（创作日志：各 LLM 阶段一条，排障 + 成本可见）。
 * global KV 存杂项游标与作者档案（二期）。
 * v2（§11.8）：全部新增字段 optional，读侧对旧记录缺字段容错，无迁移脚本。
 */
import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** 番茄账号：发布主体（浏览器 profile 按 id 隔离，登录态互不共享）。 */
export const AccountSchema = z.object({
  id: z.string(),
  /** 展示名（默认「番茄账号 N」，可改）。 */
  name: z.string(),
  platform: z.literal('fanqie'),
  /** 平台侧用户唯一标识（登录成功后回填）。 */
  fanqieUserId: z.string().optional(),
  status: z.enum(['active', 'expired', 'disabled']),
  lastLoginCheckAt: z.number().nullable(),
  createdAt: z.number(),
})

/** 章 beat（章纲条目，滚动续排）。 */
export const BeatSchema = z.object({
  no: z.number().int(),
  title: z.string(),
  /** 本章任务描述（这一章发生什么）。 */
  beat: z.string(),
  /** 章末钩子要求。 */
  hook: z.string(),
  /** 本章给读者的承诺（期待会发生什么）。 */
  promise: z.string().optional(),
  /** 本章新增的不确定点（信息差/反常/两难…）。 */
  uncertainty: z.string().optional(),
  /** 回收哪一章的 promise（章号；与伏笔账联动）。 */
  payoffOf: z.number().int().optional(),
  /** 爽点标记（十章一爽点）。 */
  isCool: z.boolean().optional(),
  /** 高潮标记（三十章一高潮）。 */
  isClimax: z.boolean().optional(),
  status: z.enum(['pending', 'drafted', 'finalized']),
})

/** 作品档案（大纲与记忆挂书级；章节/设定/伏笔独立成表按 bookId 关联）。 */
export const BookSchema = z.object({
  id: z.string(),
  /** 所属账号（必填，作品与账号强绑定；换绑需先清台账）。 */
  accountId: z.string(),
  name: z.string(),
  /** 题材（都市/玄幻/悬疑…）。 */
  genre: z.string(),
  /** 简介（150–300 字）。 */
  intro: z.string(),
  status: z.enum(['planning', 'writing', 'finished']),
  /** 平台书 id（书单绑定后回填）。 */
  fanqieBookId: z.string().optional(),
  /** 默认分卷 id（建稿时用，书单/分卷拉取后回填）。 */
  fanqieVolumeId: z.string().optional(),
  /** 单章目标字数（番茄口径 2200–2800，默认 2400）。 */
  chapterWords: z.number().int().positive().default(2400),
  targetWords: z.number().int().positive().optional(),
  /** 文风卡（固定人设提示词，置顶注入所有生成）。 */
  styleCard: z.string(),
  /** 风格原型 id（style.ts ARCHETYPES 键，管「怎么写」；缺省 = 一期通用腔）。 */
  archetype: z.string().optional(),
  /** 叙述契约：人称/限知范围/时距/时态（书级固定）。 */
  narrator: z.string().optional(),
  outline: z.object({
    /** 一句话故事。 */
    logline: z.string(),
    /** 核心矛盾。 */
    coreConflict: z.string(),
    /** 卷纲摘要（index 从 1 起）。 */
    volumes: z.array(z.object({ index: z.number().int(), title: z.string(), summary: z.string() })),
    /** 章 beat 列表（滚动续排）。 */
    beats: z.array(BeatSchema),
  }),
  /** 全局滚动摘要（定稿回写确认后更新，≤300 字）。 */
  memorySummary: z.string().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** 设定集条目（人物/世界观/物品/阵营/关系）。 */
export const SettingSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  kind: z.enum(['character', 'world', 'item', 'faction', 'relation']),
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  /** 人物当前状态（定稿回写更新）。 */
  state: z.string().optional(),
  /** 按卷渐进开放的可见性（装配时过滤未开放条目）。 */
  visibleFromVolume: z.number().int().optional(),
  /** kind=relation：有向关系（A 信任 B ≠ B 信任 A，单向记录）。 */
  relation: z
    .object({
      /** 发起方设定名。 */
      from: z.string(),
      /** 指向方设定名。 */
      to: z.string(),
      /** 公开身份（对外呈现的关系）。 */
      publicLabel: z.string(),
      /** 真实联系（仅作者视角的真相，可不填）。 */
      realBond: z.string().optional(),
      /** from 已知晓的关键事实。 */
      fromKnows: z.array(z.string()).default([]),
      /** to 已知晓的关键事实。 */
      toKnows: z.array(z.string()).default([]),
    })
    .optional(),
  /** 该角色知晓的关键事实清单（character 专用，审稿 KNOWLEDGE_LEAK 边界）。 */
  knownBy: z.array(z.string()).optional(),
  /** 出处：提取自哪一章（定稿回写回填）。 */
  sourceChapterNo: z.number().int().optional(),
  /** 出处原文摘录（≤60 字，待复核对照用）。 */
  quote: z.string().optional(),
  /** 失效标记：出处章节被重写/大改后置 true，人工复核前召回降级。 */
  stale: z.boolean().optional(),
  updatedAt: z.number(),
})

/** 伏笔账：埋设章 → 回收章。 */
export const ForeshadowSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  desc: z.string(),
  plantedAt: z.number().int(),
  suggestPayoffAt: z.number().int().optional(),
  paidAt: z.number().int().optional(),
  /** 出处：提取自哪一章（定稿回写回填）。 */
  sourceChapterNo: z.number().int().optional(),
  /** 出处原文摘录（≤60 字，待复核对照用）。 */
  quote: z.string().optional(),
  /** 失效标记：出处章节被重写/大改后置 true，人工复核前召回降级。 */
  stale: z.boolean().optional(),
  createdAt: z.number(),
})

/** 定稿回写产物先落「待确认」区，人工确认才入册（fail-closed，不静默改记忆）。 */
export const PendingSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  chapterNo: z.number().int(),
  kind: z.enum(['setting', 'foreshadow', 'state', 'summary', 'knowledge', 'timeline']),
  /**
   * kind=setting → 设定条目字段；foreshadow → {desc,suggestPayoffAt?}；
   * state → {name,state}；summary → {text}；
   * knowledge → {name,fact}（角色新知晓的事实，入册并入 knownBy）；
   * timeline → {anchors:[TimelineAnchor]}（整章场景时间锚，入册覆盖 chapter.timeline）。
   * 二期各 kind 通用追加出处：sourceChapterNo（章号）+ quote（原文摘录 ≤60 字）。
   */
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
})

/** 章稿快照（重生成前的旧稿，一层 undo）。 */
export const ChapterSnapshotSchema = z.object({
  content: z.string(),
  words: z.number().int(),
  savedAt: z.number(),
  reason: z.string(),
})

/** 场景时间锚（相对表述；审稿程序据此检测时间推进矛盾 TIMELINE_DRIFT）。 */
export const TimelineAnchorSchema = z.object({
  /** 场景名（可选）。 */
  scene: z.string().optional(),
  /** 场景起点（相对表述，如「婚礼当晚」）。 */
  start: z.string(),
  /** 与上一场景的间隔（如「次日」「三天后」）。 */
  gap: z.string(),
  /** 场景历时（如「一晚」「半小时」）。 */
  duration: z.string(),
  /** 场景终点（相对表述）。 */
  end: z.string(),
})

/** 章稿。id 确定性生成 `ch_<bookId>_<no>`，路由直接构造。 */
export const ChapterSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  no: z.number().int(),
  title: z.string(),
  content: z.string().default(''),
  words: z.number().int().default(0),
  /** 本章摘要（定稿回写产出；手动改稿后 stale）。 */
  summary: z.string().optional(),
  summaryStale: z.boolean().optional(),
  snapshots: z.array(ChapterSnapshotSchema).default([]),
  /** 发布状态机：local → queued → draft → submitted → live / rejected。 */
  publishState: z.enum(['local', 'queued', 'draft', 'submitted', 'live', 'rejected']),
  /** 平台侧章节 id（建稿后回填，重试复用）。 */
  itemId: z.string().optional(),
  /** 生成时模型自评的结尾钩子是否达标。 */
  hookOk: z.boolean().optional(),
  /** 各场景时间锚（定稿回写提取，审稿时间连续性依据）。 */
  timeline: z.array(TimelineAnchorSchema).optional(),
  /** 质量闸结果（analyzeChapter 产物 / 审稿合并结果）。 */
  quality: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/**
 * 发布台账（按账号记账）。额度全部由本表聚合：
 * 立即发布记 ts 当日；草稿不占额度；failed/refunded 不占额度。
 */
export const PublishLogSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  bookId: z.string(),
  chapterNo: z.number().int(),
  itemId: z.string().optional(),
  mode: z.enum(['draft', 'now']),
  /** 定时发布目标日（YYYY-MM-DD；一期仅保留字段）。 */
  targetDate: z.string().optional(),
  words: z.number().int(),
  status: z.enum(['success', 'failed', 'refunded']),
  /** 幂等键 accountId+bookId+chapterNo+contentHash。 */
  idempotencyKey: z.string(),
  error: z.string().optional(),
  ts: z.number(),
})

/**
 * 创作日志：各 LLM 阶段收尾落一条（排障 + 成本可见，见计划 §11.6）。
 */
export const LogSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  /** 关联章号（卷级操作如续排/向导可缺省）。 */
  no: z.number().int().optional(),
  stage: z.enum(['generate', 'beats', 'finalize', 'review', 'rewrite']),
  ok: z.boolean(),
  tokens: z.number().int().optional(),
  ms: z.number().int(),
  issueCount: z.number().int().optional(),
  err: z.string().optional(),
  ts: z.number(),
})

/** 全局 KV（杂项游标 + 二期作者档案 author_profile）。不可为 null（往返哨兵约束）。 */
const GlobalSchema = z.record(z.string(), z.unknown())

/** 小说工坊域声明（模块加载即校验名字与版本，失配在 open 前爆掉）。 */
export const writerDomain = defineDomain({
  name: 'writer',
  version: 2,
  layout: 'per-record',
  tables: {
    account: domainTable(AccountSchema),
    book: domainTable(BookSchema),
    setting: domainTable(SettingSchema),
    foreshadow: domainTable(ForeshadowSchema),
    pending: domainTable(PendingSchema),
    chapter: domainTable(ChapterSchema),
    publish_log: domainTable(PublishLogSchema),
    log: domainTable(LogSchema),
  },
  global: { schema: GlobalSchema, initial: {} },
})

export type WriterDomainSpec = typeof writerDomain
/** 打开后的域句柄（表句柄从 `domain.table(name)` 取）。 */
export type WriterDomain = Domain<WriterDomainSpec>

/** 章稿确定性 id（路由 /chapters?bookId=&no= 直接构造）。 */
export function chapterId(bookId: string, no: number): string {
  return `ch_${bookId}_${no}`
}
