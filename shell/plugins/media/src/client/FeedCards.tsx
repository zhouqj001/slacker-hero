/**
 * 工作台动态流卡片：把后端 feed 卡渲染为「数字员工的汇报」。
 * 五类：brief 热点简报 / draft 草稿待审 / receipt 发布回执 / metrics 数据回报 / event 事件。
 */
import { useState } from 'react'
import type { Article, FeedItem, Hotspot, Plan } from './common.ts'
import { PLATFORM_LABEL, s } from './common.ts'
import { MiniMarkdown } from './MiniMarkdown.tsx'

/** 卡片动作回调（由工作台面板实现）。 */
export interface FeedCardActions {
  /** 简报卡：就这条热点开写（采纳 → 生成 → 建计划）。 */
  onWrite: (hotspot: Hotspot) => void
  /** 草稿卡：通过审核并立即发布全部待发计划。 */
  onApprove: (article: Article, plans: Plan[]) => void
  /** 草稿卡：重新生成正文。 */
  onRegenerate: (article: Article) => void
  /** 草稿卡：打开编辑器。 */
  onEdit: (article: Article) => void
  /** 回执卡（降级）：人工发布后回填链接。 */
  onBackfill: (planId: string, url: string) => void
  /** 回执卡：用系统浏览器打开外链（壳里 window.open 不生效，走宿主进程代开）。 */
  onOpenUrl: (url: string) => void
  /** 事件卡：重新拉起扫码登录。 */
  onRelogin: (accountId: string) => void
}

/** 计划状态中文。 */
const PLAN_STATE: Record<string, string> = {
  planned: '已排期', 'pending-review': '待审', approved: '已批',
  publishing: '发布中', published: '已发', degraded: '需人工',
  failed: '失败', skipped: '跳过',
}

/** 计划状态 → 语义 chip 类。 */
const PLAN_CHIP: Record<string, string> = {
  'pending-review': s.chipWarn, approved: s.chipAccent, publishing: s.chipAccent,
  published: s.chipSuccess, degraded: s.chipWarn, failed: s.chipDanger,
}

/** 时间显示：今天 HH:mm，否则 M/D HH:mm。 */
function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hhmm : `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

/** 指标行：「阅读 X · 点赞 X …」（过滤未抓到的字段）。 */
function metricsLine(m: { reads?: number; likes?: number; comments?: number; shares?: number; collected?: number }): string {
  const parts: string[] = []
  if (typeof m.reads === 'number') parts.push(`阅读 ${m.reads}`)
  if (typeof m.likes === 'number') parts.push(`点赞 ${m.likes}`)
  if (typeof m.comments === 'number') parts.push(`评论 ${m.comments}`)
  if (typeof m.shares === 'number') parts.push(`分享 ${m.shares}`)
  if (typeof m.collected === 'number') parts.push(`收藏 ${m.collected}`)
  return parts.join(' · ') || '暂无数据'
}

/** 头部通用结构。tone 为可选状态点（ok/warn/bad），替代图标。 */
function CardHead(props: { tone?: 'ok' | 'warn' | 'bad'; title: string; time: number }): JSX.Element {
  return (
    <div className={s.cardHead}>
      {props.tone && (
        <span className={`${s.chipDot} ${props.tone === 'ok' ? s.chipDotOk : props.tone === 'warn' ? s.chipDotWarn : s.chipDotBad}`} />
      )}
      <span className={s.cardTitle}>{props.title}</span>
      <span className={s.cardTime}>{fmtTime(props.time)}</span>
    </div>
  )
}

/** 热点简报卡。 */
function BriefCard(props: { item: Extract<FeedItem, { kind: 'brief' }>; busy: Record<string, boolean>; actions: FeedCardActions }): JSX.Element {
  const { item, busy, actions } = props
  return (
    <div className={s.card}>
      <CardHead title={`热点简报 · ${item.total} 条新热点`} time={item.at} />
      <div className={s.col}>
        {item.hotspots.map(h => (
          <div key={h.id} className={s.row}>
            <span className={`${s.grow} ${s.ellipsis}`} style={{ fontSize: 12 }} title={h.title}>
              {h.title}
            </span>
            <span className={s.tiny}>
              {(() => {
                // 跨人设最高契合分（personaFits 优先，旧 personaFit 兜底）
                const scores = [h.personaFit?.score ?? 0, ...Object.values(h.personaFits ?? {}).map(f => f.score)]
                const best = Math.max(...scores)
                if (best > 0) return `契合 ${Math.round(best * 100)}%`
                return h.heat != null ? `热度 ${h.heat}` : ''
              })()}
            </span>
            <button
              className={s.chipBtn}
              disabled={busy[`write:${h.id}`]}
              onClick={() => actions.onWrite(h)}
            >
              {busy[`write:${h.id}`] ? '开写…' : '写'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 草稿待审卡。 */
function DraftCard(props: { item: Extract<FeedItem, { kind: 'draft' }>; busy: Record<string, boolean>; actions: FeedCardActions }): JSX.Element {
  const { item, busy, actions } = props
  const a = item.article
  const generating = a.status === 'generating'
  const pendingPlans = item.plans.filter(p => p.state === 'pending-review')
  // 卡片内展开阅读：默认预览前 160 字，展开后渲染完整 Markdown
  const [reading, setReading] = useState(false)
  const empty = !generating && a.bodyMd.trim() === ''
  return (
    <div className={s.card}>
      <CardHead title={`草稿待审：${a.title}`} time={item.at} />
      {generating
        ? <div className={s.cardBody}>正文生成中…</div>
        : reading
          ? <div className={s.mdBox}><MiniMarkdown md={a.bodyMd} /></div>
          : empty
            ? <div className={s.cardBody}>正文为空，点「编辑」或「重新生成」补全。</div>
            : <button
                className={`${s.cardBody} ${s.mdPreview}`}
                type="button"
                title="点击展开阅读全文"
                onClick={() => { setReading(true) }}
              >
                {a.bodyMd.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图] ').replace(/[#>*`]/g, '').trim().slice(0, 160)}
              </button>}
      {reading && (
        <div className={s.rowWrap}>
          <button className={s.btn} type="button" onClick={() => { setReading(false) }}>收起</button>
        </div>
      )}
      {item.plans.length > 0 && (
        <div className={s.rowWrap}>
          {item.plans.map(p => (
            <span key={p.id} className={`${s.chip} ${PLAN_CHIP[p.state] ?? ''}`}>
              {PLATFORM_LABEL[p.platform] ?? p.platform} · {PLAN_STATE[p.state] ?? p.state}
            </span>
          ))}
        </div>
      )}
      <div className={s.rowWrap}>
        {!generating && pendingPlans.length > 0 && (
          <button
            className={s.btnPrimary}
            disabled={busy[`approve:${a.id}`]}
            onClick={() => actions.onApprove(a, pendingPlans)}
          >
            {busy[`approve:${a.id}`] ? '发布中…' : `通过并发布（${pendingPlans.length} 个平台）`}
          </button>
        )}
        {!generating && (
          <button className={s.btn} disabled={busy[`gen:${a.id}`]} onClick={() => actions.onRegenerate(a)}>重新生成</button>
        )}
        <button className={s.btn} onClick={() => actions.onEdit(a)}>编辑</button>
      </div>
    </div>
  )
}

/** 发布回执卡。 */
function ReceiptCard(props: { item: Extract<FeedItem, { kind: 'receipt' }>; busy: Record<string, boolean>; actions: FeedCardActions }): JSX.Element {
  const { item, busy, actions } = props
  const pub = item.publish
  const [backfillUrl, setBackfillUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const title = item.article?.title ?? pub.planId
  const platformLabel = PLATFORM_LABEL[pub.platform] ?? pub.platform

  const copyBody = async (): Promise<void> => {
    const body = pub.draftPackage?.bodyMd ?? ''
    if (!body) return
    // 相对素材 URL（/api/media/asset?id=…）在应用外打不开，复制时补全 origin；
    // 有话题建议（小红书/抖音）时一并带上，省一次手工粘贴。
    const text = body
      .replace(/(\]\()(\/[^)\s]*)/g, (_m, head: string, path: string) => `${head}${window.location.origin}${path}`)
      + (pub.draftPackage?.topics ? `\n\n${pub.draftPackage.topics}` : '')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* 剪贴板不可用时静默 */ }
  }

  return (
    <div className={s.card}>
      {pub.state === 'success' && (
        <>
          <CardHead tone="ok" title={`已发布：${title}`} time={item.at} />
          <div className={s.muted}>平台：{platformLabel}{pub.url ? '' : ' · 未记录链接'}</div>
          {pub.note && <div className={s.tiny}>{pub.note}</div>}
          {pub.url && <div className={s.rowWrap}><button className={s.btn} onClick={() => actions.onOpenUrl(pub.url!)}>打开文章</button></div>}
        </>
      )}
      {pub.state === 'awaiting-manual' && (
        <>
          <CardHead tone="warn" title={`待你点发布：${title}`} time={item.at} />
          <div className={s.cardBody}>
            标题与正文已填进{platformLabel}的编辑器，请到托管浏览器窗口里点编辑器里的「发布」按钮。
            程序正在后台核对{platformLabel}的已发布列表，确认发出后会自动补上文章链接；没等到才需要你回填。
          </div>
          {pub.note && <div className={s.tiny}>{pub.note}</div>}
          <div className={s.composer}>
            <input
              className={s.composerInput}
              placeholder="已自行发布？粘贴文章链接回填"
              value={backfillUrl}
              onChange={e => setBackfillUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && backfillUrl.trim() !== '') actions.onBackfill(pub.planId, backfillUrl.trim())
              }}
            />
            <button
              className={s.composerSend}
              disabled={backfillUrl.trim() === '' || busy[`backfill:${pub.planId}`]}
              onClick={() => actions.onBackfill(pub.planId, backfillUrl.trim())}
            >
              {busy[`backfill:${pub.planId}`] ? '回填中…' : '回填'}
            </button>
          </div>
        </>
      )}
      {pub.state === 'degraded-manual' && (
        <>
          <CardHead tone="warn" title={`需人工发布：${title}`} time={item.at} />
          <div className={s.cardBody}>
            自动发布未完成，已打包好正文。打开平台后台粘贴发布后，把文章链接填回来。
          </div>
          {pub.draftPackage?.hint && <div className={s.tiny}>提示：{pub.draftPackage.hint}</div>}
          <div className={s.rowWrap}>
            {pub.draftPackage?.openUrl && (
              <button className={s.btn} onClick={() => actions.onOpenUrl(pub.draftPackage!.openUrl)}>打开后台</button>
            )}
            {pub.draftPackage?.bodyMd && (
              <button className={s.btn} onClick={() => { void copyBody() }}>{copied ? '已复制' : pub.draftPackage?.topics ? '复制正文+话题' : '复制正文'}</button>
            )}
          </div>
          <div className={s.composer}>
            <input
              className={s.composerInput}
              placeholder="粘贴发布后的文章链接，回填"
              value={backfillUrl}
              onChange={e => setBackfillUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && backfillUrl.trim() !== '') actions.onBackfill(pub.planId, backfillUrl.trim())
              }}
            />
            <button
              className={s.composerSend}
              disabled={backfillUrl.trim() === '' || busy[`backfill:${pub.planId}`]}
              onClick={() => actions.onBackfill(pub.planId, backfillUrl.trim())}
            >
              {busy[`backfill:${pub.planId}`] ? '回填中…' : '回填'}
            </button>
          </div>
        </>
      )}
      {pub.state === 'failed' && (
        <>
          <CardHead tone="bad" title={`发布失败：${title}`} time={item.at} />
          <div className={s.errorText}>{pub.error ?? '未知错误'}</div>
        </>
      )}
    </div>
  )
}

/** 数据回报卡。 */
function MetricsCard(props: { item: Extract<FeedItem, { kind: 'metrics' }>}): JSX.Element {
  const { item } = props
  return (
    <div className={s.card}>
      <CardHead title={`数据回报：${item.article?.title ?? item.review.articleId}`} time={item.at} />
      <div className={s.cardBody}>
        {PLATFORM_LABEL[item.review.platform] ?? item.review.platform} · {metricsLine(item.review.metrics)}
      </div>
      {item.review.note && <div className={s.tiny}>{item.review.note}</div>}
    </div>
  )
}

/** 事件卡（登录过期）。 */
function EventCard(props: { item: Extract<FeedItem, { kind: 'event' }>; busy: Record<string, boolean>; actions: FeedCardActions }): JSX.Element {
  const { item, busy, actions } = props
  return (
    <div className={s.card}>
      <CardHead icon="◇" title={`「${item.displayName}」登录过期`} time={item.at} />
      <div className={s.cardBody}>
        {PLATFORM_LABEL[item.platform] ?? item.platform} 账号的登录态已失效，发布前需要重新扫码。
      </div>
      <div className={s.rowWrap}>
        <button
          className={s.btnPrimary}
          disabled={busy[`relogin:${item.accountId}`]}
          onClick={() => actions.onRelogin(item.accountId)}
        >
          {busy[`relogin:${item.accountId}`] ? '等待扫码…' : '重新扫码'}
        </button>
      </div>
    </div>
  )
}

/** 单张动态卡（按 kind 分发）。 */
export function FeedCard(props: { item: FeedItem; busy: Record<string, boolean>; actions: FeedCardActions }): JSX.Element {
  const { item, busy, actions } = props
  switch (item.kind) {
    case 'brief':
      return <BriefCard item={item} busy={busy} actions={actions} />
    case 'draft':
      return <DraftCard item={item} busy={busy} actions={actions} />
    case 'receipt':
      return <ReceiptCard item={item} busy={busy} actions={actions} />
    case 'metrics':
      return <MetricsCard item={item} />
    case 'event':
      return <EventCard item={item} busy={busy} actions={actions} />
  }
}
