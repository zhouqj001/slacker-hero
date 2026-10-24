/**
 * 选题与热点页：热点/常青列表（契合度评分 + 采纳 / 一键写作）+ 热榜抓取 + 来源监控。
 * 「写作」走壳的 onWriteHotspot（采纳 → 建发布计划 → 流式生成正文）。
 * 支持账号视角：选中账号后按该账号人设的契合度排序/展示；默认视角展示「适合账号」chips。
 * 布局：单列全宽 —— 监控/Top 榜横向并排在列表上方，热点卡片 3 列网格，避免左列被挤压缩出长滚动。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiPost, s, type Hotspot, type HotspotAccountMeta, type PersonaFit } from '../common.ts'

const SOURCE_LABEL: Record<string, string> = { fetch: '热榜', manual: '手动', evergreen: '常青' }
const SOURCE_BADGE: Record<string, string> = {
  fetch: `${s.badge} ${s.badgeWarn}`,
  manual: `${s.badge} ${s.badgeNeutral}`,
  evergreen: `${s.badge} ${s.badgeSuccess}`,
}
const STATE_LABEL: Record<string, string> = { pending: '待评估', adopted: '已采纳', rejected: '已拒绝', used: '已使用' }

/** 读某个人设视角下的契合度：personaFits 优先，旧数据 personaFit 视为 '_default'。 */
function fitOf(h: Hotspot, personaId: string | undefined): PersonaFit | undefined {
  if (!personaId) return undefined
  return h.personaFits?.[personaId] ?? (personaId === '_default' ? h.personaFit : undefined)
}

type StateFilter = 'all' | 'pending' | 'adopted' | 'pool'
const STATE_FILTERS: { key: StateFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待评估' },
  { key: 'adopted', label: '已采纳' },
]

export function TopicsPage(props: {
  /** 打开「选择写作账号」弹窗（壳处理后续采纳/建计划/生成）。 */
  onWriteHotspot: (h: Hotspot) => void
  /** 正在为其建计划/生成的热点 id（按钮转圈用）。 */
  writeBusyId: string | null
  onError: (msg: string) => void
}): JSX.Element {
  const { onWriteHotspot, writeBusyId, onError } = props
  const [list, setList] = useState<Hotspot[]>([])
  const [threshold, setThreshold] = useState(0.6)
  const [accounts, setAccounts] = useState<HotspotAccountMeta[]>([])
  const [viewAccountId, setViewAccountId] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [sources, setSources] = useState<{ name: string; added: number; error?: string }[]>([])
  const [title, setTitle] = useState('')
  const [scoringId, setScoringId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [adoptingId, setAdoptingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const qs = viewAccountId ? `?accountId=${encodeURIComponent(viewAccountId)}` : ''
      const res = await fetch(`/api/media/hotspots${qs}`)
      const data = await res.json() as {
        ok: boolean
        data: Hotspot[]
        meta?: { threshold: number; accounts?: HotspotAccountMeta[] }
      }
      if (data.ok) {
        setList(data.data)
        if (data.meta?.threshold !== undefined) setThreshold(data.meta.threshold)
        if (data.meta?.accounts) setAccounts(data.meta.accounts)
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [viewAccountId, onError])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async () => {
    if (!title.trim()) return
    try {
      await apiPost<Hotspot>('/api/media/hotspot/save', {
        title: title.trim(),
        source: 'manual',
        // 账号视角下录入即入该账号的选题池
        ...(viewAccountId ? { accountId: viewAccountId } : {}),
      })
      setTitle('')
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [title, viewAccountId, load, onError])

  const [poolBusyId, setPoolBusyId] = useState<string | null>(null)

  /** 加入/移出账号选题池（`accountId` 传空 = 出池，回到公共池）。 */
  const togglePool = useCallback(async (h: Hotspot): Promise<void> => {
    if (!viewAccountId) return
    setPoolBusyId(h.id)
    onError('')
    try {
      await apiPost('/api/media/hotspot/save', {
        id: h.id,
        title: h.title,
        accountId: h.accountId === viewAccountId ? '' : viewAccountId,
      })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPoolBusyId(null)
    }
  }, [viewAccountId, load, onError])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    onError('')
    try {
      const data = await apiPost<{ results: { name: string; added: number; error?: string }[]; hint?: string }>(
        '/api/media/hotspot/refresh', {},
      )
      setSources(data.results)
      if (data.hint) onError(data.hint)
      const failed = data.results.filter(r => r.error)
      if (failed.length > 0) onError(`部分源失败：${failed.map(f => `${f.name}(${f.error})`).join('；')}`)
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [load, onError])

  const score = useCallback(async (id: string) => {
    setScoringId(id)
    onError('')
    try {
      // 账号视角下按该账号的人设评分；默认视角落通用人设（'_default'）
      await apiPost('/api/media/hotspot/score', viewAccountId ? { id, accountId: viewAccountId } : { id })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setScoringId(null)
    }
  }, [viewAccountId, load, onError])

  const [deletingId, setDeletingId] = useState<string | null>(null)

  /** 抓来的热榜会一直累积，给一条清理入口。已采纳生成的文章不受影响。 */
  const remove = useCallback(async (id: string) => {
    setDeletingId(id)
    onError('')
    try {
      await apiPost('/api/media/hotspot/delete', { id })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }, [load, onError])

  const adopt = useCallback(async (id: string) => {
    setAdoptingId(id)
    onError('')
    try {
      await apiPost('/api/media/hotspot/adopt', { id })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdoptingId(null)
    }
  }, [load, onError])

  const maxHeat = Math.max(...list.map(h => h.heat ?? 0), 1)
  const viewMeta = accounts.find(a => a.id === viewAccountId)
  const viewPersonaId = viewAccountId ? (viewMeta?.personaId ?? '_default') : undefined
  const poolCount = viewAccountId ? list.filter(h => h.accountId === viewAccountId).length : 0
  const filtered = stateFilter === 'all'
    ? list
    : stateFilter === 'pool'
      ? list.filter(h => h.accountId === viewAccountId)
      : list.filter(h => h.state === stateFilter)
  const pendingCount = list.filter(h => h.state === 'pending').length
  const adoptedCount = list.filter(h => h.state === 'adopted').length

  return (
    <div className={`${s.page} ${s.col}`}>
      <div className={s.pageHead}>
        <div>
          <div className={s.pageTitle}>选题与热点</div>
          <div className={s.pageDesc}>
            {viewAccountId
              ? `账号视角：按「${accounts.find(a => a.id === viewAccountId)?.displayName ?? ''}」绑定人设的契合度排序。`
              : '热榜自动抓取 + 手动/常青录入，抓完自动按各账号人设批量评分。'}
          </div>
          {viewMeta && viewMeta.pillars.length > 0 && (
            <div className={s.pfChips}>
              <span className={s.tiny}>内容方向</span>
              {viewMeta.pillars.map(p => <span key={p} className={s.pfChip}>{p}</span>)}
            </div>
          )}
        </div>
        <div className={s.acts}>
          <select
            className={s.select}
            style={{ fontSize: 12 }}
            value={viewAccountId}
            onChange={e => setViewAccountId(e.target.value)}
            title="切换账号视角，按该账号人设的契合度看选题"
          >
            <option value="">全部热点</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.displayName}（{a.personaName}）</option>
            ))}
          </select>
          <span className={s.tiny} style={{ whiteSpace: 'nowrap' }}>推荐阈值 {threshold}</span>
          <button
            className={`${s.btn} ${s.btnPrimary}`}
            type="button"
            disabled={refreshing}
            onClick={() => { void refresh() }}
          >
            {refreshing ? '抓取中…' : '抓取热榜'}
          </button>
        </div>
      </div>

      <div className={s.composer}>
        <input
          className={s.composerInput}
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="手动录入选题标题，回车保存…"
          onKeyDown={e => { if (e.key === 'Enter') void save() }}
        />
        <button className={s.composerSend} type="button" disabled={!title.trim()} onClick={() => { void save() }}>
          录入
        </button>
      </div>

      {/* 监控 + Top 榜：横向并排一行，不再占右侧整列挤压热点列表 */}
      <div className={s.railRow}>
        <div className={s.railCard}>
          <div className={s.railTitle}>热榜监控</div>
          {sources.length === 0 && <div className={s.muted}>还没抓取过。点右上「抓取热榜」拉一轮各平台热榜。</div>}
          <div className={s.monitorList}>
            {sources.map((src, i) => (
              <div key={i} className={s.mlRow}>
                <span className={s.mlMt}>{src.name}</span>
                <span className={s.mlVv}>{src.error ? `失败：${src.error}` : `新增 ${src.added} 条`}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={s.railCard}>
          <div className={s.railTitle}>今日热点 Top</div>
          {list.filter(h => h.source === 'fetch').length === 0 && (
            <div className={s.muted}>热榜抓取后这里出现 Top 榜。</div>
          )}
          {list.filter(h => h.source === 'fetch').slice(0, 6).map((h, i) => (
            <div key={h.id} className={s.heatRow}>
              <div className={s.heatNo}>{i + 1}</div>
              <div className={s.heatMain}>
                <div className={s.heatTitle}>{h.title}</div>
                <div className={s.heatBar}>
                  <div className={s.heatFill} style={{ width: `${Math.round(((h.heat ?? 0) / maxHeat) * 100)}%` }} />
                </div>
              </div>
              <div className={s.heatVal}>{h.heat !== undefined ? h.heat.toLocaleString() : '—'}</div>
            </div>
          ))}
        </div>
      </div>

      {list.length === 0 && (
        <div className={s.cmEmpty}>暂无选题。上方录入，或配置 fetchers 后抓取热榜。</div>
      )}

      {list.length > 0 && (
        <div className={s.filterRow}>
          {STATE_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={stateFilter === key ? `${s.chipBtn} ${s.chipBtnOn}` : s.chipBtn}
              onClick={() => setStateFilter(key)}
            >
              {label} {key === 'all' ? list.length : key === 'pending' ? pendingCount : adoptedCount}
            </button>
          ))}
          {viewAccountId !== '' && (
            <button
              type="button"
              className={stateFilter === 'pool' ? `${s.chipBtn} ${s.chipBtnOn}` : s.chipBtn}
              onClick={() => setStateFilter('pool')}
            >
              该账号选题池 {poolCount}
            </button>
          )}
        </div>
      )}

      <div className={s.topicGrid}>
        {filtered.map(h => {
          const viewFit = fitOf(h, viewPersonaId)
          // 默认视角：按账号聚合契合度，得出「适合账号」chips
          const accountFits = viewAccountId ? [] : accounts
            .map(a => ({ a, fit: fitOf(h, a.personaId) }))
            .filter((x): x is { a: HotspotAccountMeta; fit: PersonaFit } => x.fit !== undefined)
            .sort((x, y) => y.fit.score - x.fit.score)
          const fitChips = accountFits.filter(x => x.fit.score >= threshold).slice(0, 3)
          const best = accountFits[0]
          const recommended = viewAccountId
            ? viewFit !== undefined && viewFit.score >= threshold
            : fitChips.length > 0
          const writable = h.state === 'pending' || h.state === 'adopted'
          return (
            <div key={h.id} className={s.topicItem}>
              <div className={s.topicMeta}>
                <span className={SOURCE_BADGE[h.source] ?? `${s.badge} ${s.badgeNeutral}`}>
                  {SOURCE_LABEL[h.source] ?? h.source}
                </span>
                <span className={s.badge + ' ' + s.badgeNeutral}>{STATE_LABEL[h.state] ?? h.state}</span>
                {viewAccountId !== '' && h.accountId === viewAccountId && (
                  <span className={`${s.badge} ${s.badgeAccent}`}>已入池</span>
                )}
                {viewAccountId === '' && h.accountId && (
                  <span className={s.badge + ' ' + s.badgeNeutral} title="归属账号的选题池">
                    池 {accounts.find(a => a.id === h.accountId)?.displayName ?? '账号已删除'}
                  </span>
                )}
                {recommended && <span className={`${s.badge} ${s.badgeAccent}`}>推荐</span>}
                {h.heat !== undefined && (
                  <span className={s.badge + ' ' + s.badgeNeutral} title="平台热度值">
                    热度 {h.heat.toLocaleString('zh-CN')}
                  </span>
                )}
              </div>
              <div className={s.topicT} title={h.title}>{h.title}</div>
              {h.summary && <div className={s.topicSummary}>{h.summary}</div>}
              {viewAccountId && viewFit && (
                <div className={s.topicFit}>
                  契合度 {(viewFit.score * 100).toFixed(0)}%
                  {viewFit.score >= threshold ? ' · 值得写' : ' · 不太合适'} · {viewFit.reason}
                </div>
              )}
              {!viewAccountId && fitChips.length > 0 && (
                <div className={s.fitChips}>
                  <span className={s.tiny}>适合账号</span>
                  {fitChips.map(({ a, fit }) => (
                    <span key={a.id} className={s.fitChipHi} title={`${a.personaName}：${fit.reason}`}>
                      {a.displayName} {(fit.score * 100).toFixed(0)}%
                    </span>
                  ))}
                  {accountFits.length > fitChips.length && (
                    <span className={s.tiny}>+{accountFits.length - fitChips.length}</span>
                  )}
                </div>
              )}
              {!viewAccountId && fitChips.length === 0 && best && (
                <div className={s.topicFit}>
                  暂无高契合账号 · 最接近 {best.a.displayName} {(best.fit.score * 100).toFixed(0)}%（{best.fit.reason}）
                </div>
              )}
              <div className={s.rowActs}>
                {h.source !== 'evergreen' && h.state === 'pending' && (
                  <button
                    className={s.chipBtn}
                    type="button"
                    disabled={scoringId === h.id}
                    onClick={() => { void score(h.id) }}
                  >
                    {scoringId === h.id ? '评分中…' : viewFit ? '重评' : '评分'}
                  </button>
                )}
                {h.state === 'pending' && (
                  <button
                    className={s.chipBtn}
                    type="button"
                    disabled={adoptingId === h.id}
                    onClick={() => { void adopt(h.id) }}
                  >
                    {adoptingId === h.id ? '采纳中…' : '仅采纳'}
                  </button>
                )}
                {viewAccountId !== '' && (
                  <button
                    className={s.chipBtn}
                    type="button"
                    disabled={poolBusyId === h.id}
                    title="放进该账号的选题池 / 移出回到公共池"
                    onClick={() => { void togglePool(h) }}
                  >
                    {poolBusyId === h.id ? '…' : h.accountId === viewAccountId ? '移出选题池' : '加入选题池'}
                  </button>
                )}
                {writable && (
                  <button
                    className={s.hotWrite}
                    type="button"
                    disabled={writeBusyId === h.id}
                    onClick={() => { void onWriteHotspot(h) }}
                  >
                    {writeBusyId === h.id ? '…' : '写'}
                  </button>
                )}
                <button
                  className={`${s.chipBtn} ${s.chipBtnDanger}`}
                  type="button"
                  disabled={deletingId === h.id}
                  title="从选题池移除（不影响已采纳生成的文章）"
                  onClick={() => { void remove(h.id) }}
                >
                  {deletingId === h.id ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {list.length > 0 && filtered.length === 0 && (
        <div className={s.cmEmpty}>该状态下暂无选题。</div>
      )}
      <div className={s.footNote}>「写」= 采纳回链 → 为已登录平台建发布计划 → 流式生成正文，回到工作台看进度。</div>
    </div>
  )
}
