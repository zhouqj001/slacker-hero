/**
 * 数据看板页：总览数字 + 来源/平台对比 + 阅读趋势 + TOP 文章 + 对话式复盘录入。
 * 纯 CSS 图表零依赖；功能自 DashboardTab + ReviewTab 合并迁移。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  apiGet, apiPost, s,
  type Article, type Review, type StatsPayload,
} from '../common.ts'
import { NlChatView, NlField, useNlChat } from '../NlChat.tsx'

const SOURCE_LABEL: Record<string, string> = { hotspot: '追热点', evergreen: '常青', manual: '手动', unknown: '未知' }
const PLATFORM_LABEL: Record<string, string> = { wechat: '微信公众号', toutiao: '今日头条', zhihu: '知乎专栏', xiaohongshu: '小红书' }
const SOURCE_COLORS: Record<string, string> = { hotspot: '#fa8c16', evergreen: '#22a06b', manual: '#1668dc', unknown: '#8a90a0' }
const PLATFORM_COLORS: Record<string, string> = { wechat: '#07c160', toutiao: '#fe2c55', zhihu: '#0066ff', xiaohongshu: '#ff2442' }

/** 没采到的字段显示「—」，不显示 0：0 和「平台没给这个数」是两回事。 */
function fmtN(v: number | undefined): string {
  return v === undefined ? '—' : v.toLocaleString('zh-CN')
}
function fmtMoney(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toFixed(2)} 元`
}
/** 合计：全都没数据时返回 undefined（而不是 0），让上层显示「—」。 */
function sumDefined(vals: (number | undefined)[]): number | undefined {
  const nums = vals.filter((v): v is number => v !== undefined)
  return nums.length === 0 ? undefined : nums.reduce((a, b) => a + b, 0)
}

/** 「标签 ── 值」一行。 */
function Row(props: { k: string; v: string; extra?: string }): JSX.Element {
  return (
    <div className={s.acctWorkRow}>
      <span className={s.tiny} style={{ flex: '0 0 68px' }}>{props.k}</span>
      <span style={{ fontWeight: 600, flex: '0 0 auto' }}>{props.v}</span>
      {props.extra && <span className={s.tiny}>· {props.extra}</span>}
    </div>
  )
}

interface ReviewFields {
  articleId: string
  platform: string
  metrics: { reads?: unknown; likes?: unknown; comments?: unknown; shares?: unknown }
  note?: string
}

/** 归一化到 100% 的条形。 */
function Bar(props: { value: number; max: number; color: string; label: string; suffix?: string }): JSX.Element {
  const pct = props.max > 0 ? Math.round((props.value / props.max) * 100) : 0
  return (
    <div className={s.barRow}>
      <span className={s.barLabel}>{props.label}</span>
      <div className={s.barTrack}>
        <div className={s.barFill} style={{ width: `${pct}%`, background: props.color }} />
      </div>
      <span className={s.barValue}>{props.value.toLocaleString()}{props.suffix ?? ''}</span>
    </div>
  )
}

/** 迷你柱状趋势图（最近 14 天阅读量）。 */
function TrendChart(props: { reviews: Review[] }): JSX.Element {
  const reviews = props.reviews
  const days: { label: string; reads: number }[] = []
  const now = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, reads: 0 })
  }
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  for (const r of reviews) {
    const reads = r.metrics.reads ?? 0
    if (reads <= 0) continue
    for (let i = 0; i < 14; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13 + i)
      if (r.capturedAt >= dayStart(d) && r.capturedAt < dayStart(d) + 86400_000) {
        days[i].reads += reads
        break
      }
    }
  }
  const maxReads = Math.max(...days.map(d => d.reads), 1)
  return (
    <div className={s.trend}>
      {days.map((d, i) => (
        <div key={i} className={s.trendCol} title={`${d.label}: ${d.reads} 阅读`}>
          <div
            className={s.trendBar}
            style={{
              height: `${Math.round((d.reads / maxReads) * 100)}%`,
              minHeight: d.reads > 0 ? 4 : 2,
              background: d.reads > 0 ? 'var(--ms-accent)' : 'var(--ms-hover)',
            }}
          />
          {(i % 3 === 1 || i === 0) && <span className={s.trendLabel}>{d.label}</span>}
        </div>
      ))}
    </div>
  )
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

const pickNum = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

const showNum = (v: unknown): string =>
  v === undefined || v === null || v === '' ? '' : String(v)

export function MetricsPage(): JSX.Element {
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [articles, setArticles] = useState<Article[]>([])
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  const chat = useNlChat<ReviewFields>('review')

  const load = useCallback(async () => {
    try {
      const [st, r, a] = await Promise.all([
        apiGet<StatsPayload>('/api/media/stats'),
        apiGet<Review[]>('/api/media/review'),
        apiGet<Article[]>('/api/media/articles'),
      ])
      setStats(st)
      setReviews(r)
      setArticles(a)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const articleTitle = (id: string): string => articles.find(a => a.id === id)?.title ?? id

  const sync = useCallback(async () => {
    setSyncing(true); setSyncResult(null); setError(null)
    try {
      const r = await apiPost<{ synced: number; failed: number; skipped: number }>(
        '/api/media/review/sync', {},
      )
      setSyncResult(`同步完成：${r.synced} 成功 / ${r.failed} 失败 / ${r.skipped} 跳过`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }, [load])

  const fields = chat.pending
  const metrics = asRecord(fields.metrics)
  const hasFields = Object.keys(fields).length > 0
  const note = typeof fields.note === 'string' ? fields.note.trim() : ''

  const confirm = async (): Promise<void> => {
    if (!fields.articleId) return
    try {
      await apiPost<Review>('/api/media/review/save', {
        articleId: fields.articleId,
        platform: fields.platform || 'wechat',
        metrics: {
          reads: pickNum(metrics.reads),
          likes: pickNum(metrics.likes),
          comments: pickNum(metrics.comments),
          shares: pickNum(metrics.shares),
        },
        note: note || undefined,
      })
      chat.reset()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!stats && !error) return <div className={s.cmEmpty}>加载中…</div>

  const sourceEntries = Object.entries(stats?.bySource ?? {})
  const platformEntries = Object.entries(stats?.byPlatform ?? {})
  const maxSourceReads = Math.max(...sourceEntries.map(([, v]) => v.avgReads), 1)
  const maxPlatformReads = Math.max(...platformEntries.map(([, v]) => v.avgReads), 1)
  const totalReads = reviews.reduce((sum, r) => sum + (r.metrics.reads ?? 0), 0)
  const totalLikes = reviews.reduce((sum, r) => sum + (r.metrics.likes ?? 0), 0)
  const totalComments = reviews.reduce((sum, r) => sum + (r.metrics.comments ?? 0), 0)
  const totalShares = reviews.reduce((sum, r) => sum + (r.metrics.shares ?? 0), 0)

  const articleReads = new Map<string, number>()
  for (const r of reviews) {
    articleReads.set(r.articleId, (articleReads.get(r.articleId) ?? 0) + (r.metrics.reads ?? 0))
  }
  const topArticles = [...articleReads.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, reads]) => ({ title: articles.find(a => a.id === id)?.title ?? id, reads }))

  return (
    <div className={`${s.page} ${s.col}`}>
      <div className={s.pageHead}>
        <div>
          <div className={s.pageTitle}>数据看板</div>
          <div className={s.pageDesc}>发布后的阅读/互动数据一目了然，追热点 vs 常青效果对比。</div>
        </div>
        <div className={s.acts}>
          <button className={s.btnPrimary} type="button" disabled={syncing} onClick={() => { void sync() }}>
            {syncing ? '同步中…' : '同步平台数据'}
          </button>
        </div>
      </div>

      {error && <div className={s.errorText}>{error}</div>}
      {syncResult && <div className={s.tiny}>{syncResult}</div>}

      {stats && (
        <div className={s.statGrid}>
          {[
            { label: '文章', value: stats.total.articles },
            { label: '计划', value: stats.total.plans },
            { label: '复盘记录', value: stats.total.reviews },
            { label: '总阅读', value: totalReads },
            { label: '总点赞', value: totalLikes },
            { label: '总评论', value: totalComments },
            { label: '总转发', value: totalShares },
          ].map(k => (
            <div key={k.label} className={s.statCard}>
              <div className={s.statValue}>{k.value.toLocaleString()}</div>
              <div className={s.statK}>{k.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── 账号数据（平台后台采集，真实数据）──────────────────────── */}
      {stats && stats.accounts.length > 0 && (
        <div className={s.setSec} style={{ marginTop: 18 }}>
          <div className={s.secTitle}>
            账号数据
            <small>
              Account data · 来自各平台后台
              {stats.collectedCount < stats.accounts.length
                ? `（已采集 ${stats.collectedCount}/${stats.accounts.length}，其余账号去「账号管理」点采集）`
                : '（全部已采集）'}
            </small>
          </div>
          <div className={s.statGrid}>
            {[
              { label: '账号总数', value: stats.accounts.length },
              { label: '已采集', value: stats.collectedCount },
              { label: '粉丝合计', value: sumDefined(stats.accounts.map(a => a.fansTotal)) },
              { label: '总阅读合计', value: sumDefined(stats.accounts.map(a => a.readsTotal)) },
              { label: '累计收益', value: sumDefined(stats.accounts.map(a => a.incomeTotal)) },
              { label: '作品合计', value: stats.total.works },
              { label: '作品阅读', value: sumDefined(stats.accounts.map(a => a.workReads)) },
            ].map(k => (
              <div key={k.label} className={s.statCard}>
                <div className={s.statValue}>{k.value === undefined ? '—' : k.value.toLocaleString()}</div>
                <div className={s.statK}>{k.label}</div>
              </div>
            ))}
          </div>

          <div className={s.acctGrid} style={{ marginTop: 10 }}>
            {stats.accounts.map(a => (
              <div key={a.id} className={s.acctCard}>
                <div className={s.nmRow}>
                  <div className={s.grow} style={{ minWidth: 0 }}>
                    <div className={s.ellipsis} style={{ fontWeight: 600 }}>{a.displayName}</div>
                    <div className={s.acctSub}>{PLATFORM_LABEL[a.platform] ?? a.platform}</div>
                  </div>
                  {!a.collected
                    ? <span className={`${s.badge} ${s.badgeNeutral}`}>未采集</span>
                    : <span className={`${s.badge} ${s.badgeSuccess}`}>已采集</span>}
                </div>
                {a.collected ? (
                  <>
                    <div className={s.acctProfile}>
                      <div className={s.tiny}>
                        采集于 {a.capturedAt ? new Date(a.capturedAt).toLocaleString('zh-CN') : '—'}
                        {a.platformUserId && ` · ID ${a.platformUserId}`}
                      </div>
                      <Row k="粉丝" v={fmtN(a.fansTotal)} extra={a.fansGainedYesterday !== undefined ? `昨日 +${a.fansGainedYesterday} / -${a.fansLostYesterday ?? 0}` : undefined} />
                      <Row k="总阅读" v={fmtN(a.readsTotal)} extra={a.readsYesterday !== undefined ? `昨日 ${fmtN(a.readsYesterday)}` : undefined} />
                      <Row k="昨日展现" v={fmtN(a.showsYesterday)} extra={a.commentsYesterday !== undefined ? `赞 ${fmtN(a.likesYesterday)} · 评 ${fmtN(a.commentsYesterday)}` : undefined} />
                      <Row k="收益" v={fmtMoney(a.incomeTotal)} extra={a.incomeYesterday !== undefined ? `昨日 ${fmtMoney(a.incomeYesterday)} · 可提现 ${fmtMoney(a.withdrawable)}` : undefined} />
                      <Row k="作品" v={String(a.workCount)} extra={`阅读 ${fmtN(a.workReads)} · 展现 ${fmtN(a.workShows)}`} />
                      <Row k="评分" v={a.creditScore !== undefined ? `信用 ${a.creditScore}` : '—'} extra={a.securityScore !== undefined ? `安全 ${a.securityScore}${a.certifyStatus ? ` · ${a.certifyStatus}` : ''}` : undefined} />
                    </div>
                    {a.warnings.map((w, i) => <div key={i} className={s.noteWarn}>{w}</div>)}
                    {a.topWorks.length > 0 && (
                      <div className={s.tiny} style={{ marginTop: 4 }}>
                        阅读最高：{a.topWorks[0].title}（{fmtN(a.topWorks[0].reads)}）
                      </div>
                    )}
                  </>
                ) : (
                  <div className={s.tiny} style={{ marginTop: 6 }}>该账号还没采集过平台数据</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={s.twoCol}>
        <div className={s.col}>
          {sourceEntries.length > 0 && (
            <div className={s.card}>
              <div className={s.railTitle}>选题来源对比（平均阅读）</div>
              {sourceEntries.map(([k, v]) => (
                <Bar
                  key={k}
                  label={SOURCE_LABEL[k] ?? k}
                  value={v.avgReads}
                  max={maxSourceReads}
                  color={SOURCE_COLORS[k] ?? '#8a90a0'}
                  suffix={` · ${v.count} 篇`}
                />
              ))}
            </div>
          )}
          {platformEntries.length > 0 && (
            <div className={s.card}>
              <div className={s.railTitle}>平台对比（平均阅读）</div>
              {platformEntries.map(([k, v]) => (
                <Bar
                  key={k}
                  label={PLATFORM_LABEL[k] ?? k}
                  value={v.avgReads}
                  max={maxPlatformReads}
                  color={PLATFORM_COLORS[k] ?? '#8a90a0'}
                  suffix={` · ${v.count} 条`}
                />
              ))}
            </div>
          )}
          {reviews.some(r => (r.metrics.reads ?? 0) > 0) && (
            <div className={s.card}>
              <div className={s.railTitle}>近 14 天阅读趋势</div>
              <TrendChart reviews={reviews} />
            </div>
          )}
        </div>

        <div className={s.railCol}>
          <div className={s.railCard}>
            <div className={s.railTitle}>阅读 TOP 文章</div>
            {topArticles.length === 0 && <div className={s.muted}>暂无复盘数据。</div>}
            {topArticles.map((a, i) => (
              <div key={i} className={s.heatRow}>
                <span className={s.heatNo}>{i + 1}</span>
                <span className={s.heatMain}><span className={s.heatTitle}>{a.title}</span></span>
                <span className={s.heatVal}>{a.reads.toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div className={s.railCard}>
            <div className={s.railTitle}>一句话录复盘</div>
            <NlChatView
              turns={chat.turns}
              busy={chat.busy}
              input={chat.input}
              setInput={chat.setInput}
              onSend={() => { void chat.send(chat.input, { articles: articles.map(a => ({ id: a.id, title: a.title })) }) }}
              placeholder="如：《AI 浏览器》阅读 1.2 万，赞 300…"
              emptyHint="用一句话录入复盘数据，没说是哪篇时大模型会列出候选反问。"
            >
              {hasFields && (
                <div className={s.nlCard}>
                  <div className={s.nlCardTitle}>确认录入复盘</div>
                  <NlField
                    k="文章"
                    v={fields.articleId
                      ? articleTitle(String(fields.articleId))
                      : <span className={s.nlCardHint}>补一句文章标题就行</span>}
                  />
                  <NlField k="平台" v={PLATFORM_LABEL[String(fields.platform ?? 'wechat')] ?? '微信公众号'} />
                  {showNum(metrics.reads) && <NlField k="阅读" v={showNum(metrics.reads)} />}
                  {showNum(metrics.likes) && <NlField k="点赞" v={showNum(metrics.likes)} />}
                  {showNum(metrics.comments) && <NlField k="评论" v={showNum(metrics.comments)} />}
                  {showNum(metrics.shares) && <NlField k="转发" v={showNum(metrics.shares)} />}
                  {note && <NlField k="备注" v={note} />}
                  <div className={s.rowWrap}>
                    <button
                      className={`${s.btn} ${s.btnPrimary}`}
                      type="button"
                      disabled={!fields.articleId || chat.busy}
                      onClick={() => { void confirm() }}
                    >
                      录入
                    </button>
                    <button className={s.btn} type="button" onClick={() => { chat.clearPending() }}>重新说</button>
                  </div>
                </div>
              )}
            </NlChatView>
          </div>
        </div>
      </div>

      <div className={s.card}>
        <div className={s.railTitle}>复盘记录</div>
        {reviews.length === 0 && (
          <div className={s.muted}>暂无复盘记录。右侧一句话录入，或点右上「同步平台数据」自动拉取。</div>
        )}
        {reviews.map(r => (
          <div key={r.id} className={s.rowItem}>
            <span className={s.rowT}>{articleTitle(r.articleId)}</span>
            <span className={s.rowMeta}>{PLATFORM_LABEL[r.platform] ?? r.platform}</span>
            <span className={s.rowMeta}>阅 {r.metrics.reads ?? '-'}</span>
            <span className={s.rowMeta}>赞 {r.metrics.likes ?? '-'}</span>
            <span className={s.rowMeta}>{new Date(r.capturedAt).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
