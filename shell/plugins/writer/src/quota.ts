/**
 * 配额台账（plan §5.4）：额度全部从 publish_log 表按账号+日期聚合，
 * 不另设计数器（单一事实来源，崩溃/重启不漂移）。
 *
 * 记账口径（一期）：
 *   - 立即发布 → words 记当日，该书占当日 1 个「更新」名额；
 *   - 存草稿箱 → 不占额度；
 *   - failed / refunded → 不占额度（refunded 即「标记返还」）。
 */
import type { WriterDomain } from './domain.ts'
import type { WriterConfig } from './config.ts'

/** 本地日期键 YYYY-MM-DD。 */
export function dateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 本地月份键 YYYY-MM。 */
export function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 某账号的额度用量（实时聚合）。 */
export interface QuotaUsage {
  dailyWords: number
  monthlyWords: number
  /** 当日已占「更新」名额的作品 id。 */
  updatedWorksToday: string[]
}

export function quotaUsage(domain: WriterDomain, accountId: string, now = new Date()): QuotaUsage {
  const today = dateKey(now)
  const month = monthKey(now)
  const usage: QuotaUsage = { dailyWords: 0, monthlyWords: 0, updatedWorksToday: [] }
  for (const [, log] of domain.table('publish_log').entries()) {
    if (log.accountId !== accountId) continue
    if (log.mode === 'draft') continue // 存草稿箱不占额度
    if (log.status !== 'success') continue // failed/refunded 不占
    // 定时发布字数占目标日期（一期无 timer，字段保留）
    const day = log.targetDate ?? dateKey(new Date(log.ts))
    if (day === today) {
      usage.dailyWords += log.words
      if (!usage.updatedWorksToday.includes(log.bookId)) usage.updatedWorksToday.push(log.bookId)
    }
    if (day.startsWith(month)) usage.monthlyWords += log.words
  }
  return usage
}

/** 额度校验结果。 */
export type QuotaCheck =
  | { ok: true; usage: QuotaUsage }
  | { ok: false; reason: 'daily_words' | 'monthly_words' | 'daily_works'; usage: QuotaUsage; message: string }

/**
 * 发前校验：字数（日/月）+ 当日更新作品数。
 * 注意「按作品计不按章计」：同书当日第 2 章不新增作品名额。
 */
export function checkQuota(
  domain: WriterDomain,
  accountId: string,
  config: WriterConfig,
  words: number,
  bookId: string,
  now = new Date(),
): QuotaCheck {
  const usage = quotaUsage(domain, accountId, now)
  if (usage.dailyWords + words > config.publish.dailyWordLimit) {
    return {
      ok: false, reason: 'daily_words', usage,
      message: `该账号今日字数额度不足：已用 ${usage.dailyWords} / 上限 ${config.publish.dailyWordLimit}，本次需 ${words} 字`,
    }
  }
  if (usage.monthlyWords + words > config.publish.monthlyWordLimit) {
    return {
      ok: false, reason: 'monthly_words', usage,
      message: `该账号本月字数额度不足：已用 ${usage.monthlyWords} / 上限 ${config.publish.monthlyWordLimit}`,
    }
  }
  if (!usage.updatedWorksToday.includes(bookId) &&
      usage.updatedWorksToday.length >= config.publish.dailyUpdateWorksLimit) {
    return {
      ok: false, reason: 'daily_works', usage,
      message: `该账号今日「可更新作品数」已用满（${usage.updatedWorksToday.length} 部作品已更新 / 上限 ${config.publish.dailyUpdateWorksLimit}）。额度按作品计：同一本书今日内再发多章不占新名额`,
    }
  }
  return { ok: true, usage }
}

/** 幂等键：accountId + bookId + chapterNo + contentHash。 */
export function idempotencyKey(accountId: string, bookId: string, chapterNo: number, content: string): string {
  // 轻量内容指纹（djb2）：足够识别「同章同稿」，不引入 crypto 依赖
  let hash = 5381
  for (let i = 0; i < content.length; i++) hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0
  return `${accountId}:${bookId}:${chapterNo}:${(hash >>> 0).toString(36)}:${content.length}`
}

/** 查同幂等键的成功记录；命中 → 拒绝重复提交（DUPLICATE_SUBMIT）。 */
export function findSuccessLog(
  domain: WriterDomain,
  key: string,
): { id: string; itemId?: string } | null {
  for (const [id, log] of domain.table('publish_log').entries()) {
    if (log.idempotencyKey === key && log.status === 'success') return { id, itemId: log.itemId }
  }
  return null
}

/** 查同章最近一次成功的非草稿记录（状态回查/显示用）。 */
export function findLatestLog(
  domain: WriterDomain,
  accountId: string,
  bookId: string,
  chapterNo: number,
): { id: string; mode: string; status: string; itemId?: string; ts: number; words: number } | null {
  let latest: { id: string; mode: string; status: string; itemId?: string; ts: number; words: number } | null = null
  for (const [id, log] of domain.table('publish_log').entries()) {
    if (log.accountId !== accountId || log.bookId !== bookId || log.chapterNo !== chapterNo) continue
    if (log.mode === 'draft') continue
    if (!latest || log.ts > latest.ts) {
      latest = { id, mode: log.mode, status: log.status, itemId: log.itemId, ts: log.ts, words: log.words }
    }
  }
  return latest
}
