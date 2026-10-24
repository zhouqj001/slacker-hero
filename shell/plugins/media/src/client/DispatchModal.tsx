/**
 * 派活确认轻弹窗：NL 解析失败时的降级入口，也是快捷按钮的确认界面。
 * 选题（可从热点库回填）+ 员工下拉（默认在岗 = 排序第一条人设）+ 平台 pill 多选。
 */
import { useEffect, useState } from 'react'
import type { Account, Hotspot, Persona, PersonaFit } from './common.ts'
import { PLATFORM_IDS, PLATFORM_LABEL, apiGet, s } from './common.ts'

/** 打开弹窗时的初始请求。 */
export interface DispatchRequest {
  topic: string
  articleId?: string
  /** 热点写作模式：确认后走热点采纳回链（state → adopted + 关联文章），而不是另建空白稿。 */
  hotspotId?: string
  /** 该热点各人设的契合分（personaId → fit），用于默认预选最契合账号并在选项里展示。 */
  hotspotFits?: Record<string, PersonaFit>
  /** 已选平台（单选）。 */
  platform?: string
  /** 已选账号（人设由它带出）。 */
  accountId?: string
  /** NL 派活点名到的员工（人设）id；undefined = 用该账号绑定的人设。 */
  personaId?: string
  /**
   * 为什么要落到手动表单——AI 不可用 / 没解析出平台 / 没听懂。
   * 静默降级会让人以为「本来就该填表」，所以这里必须说明白。
   */
  note?: DispatchNote
}

/** 降级原因分类。 */
export type DispatchNoteKind = 'ai-unavailable' | 'need-platform' | 'unparsable'

export interface DispatchNote {
  kind: DispatchNoteKind
  text: string
}

/** 确认后交给工作台的派活单。 */
export interface DispatchConfirmPayload {
  topic: string
  articleId?: string
  /** 热点写作模式：壳据此走 /hotspot/adopt 回链而不是新建空白稿。 */
  hotspotId?: string
  /** 单个平台。 */
  platform: string
  /** 发布账号（人设 1:1 绑定）。 */
  accountId: string
  personaId?: string
  /** 点名到的员工名（仅用于生成中的状态展示）。 */
  personaName?: string
}

export function DispatchModal(props: {
  request: DispatchRequest
  accounts: Account[]
  personas: Persona[]
  onClose: () => void
  onConfirm: (payload: DispatchConfirmPayload) => void
}): JSX.Element {
  const { request, accounts, personas, onClose, onConfirm } = props
  /** 热点写作模式：话题固定，选账号即同时定了人设与平台；默认预选契合分最高的账号。 */
  const isHotspot = request.hotspotId !== undefined
  /** 账号 → 人设 id（未绑人设走通用人设 '_default'，与服务端 genericPersona 对齐）。 */
  const personaIdOf = (accountId: string): string =>
    personas.find(p => p.accountId === accountId)?.id ?? '_default'
  const fitOf = (a: Account): PersonaFit | undefined =>
    request.hotspotFits?.[personaIdOf(a.id)]
  const initialAccount = (() => {
    if (request.accountId) return request.accountId
    if (!isHotspot) return ''
    const ranked = [...accounts].sort(
      (a, b) => (fitOf(b)?.score ?? -1) - (fitOf(a)?.score ?? -1))
    return ranked[0]?.id ?? ''
  })()
  const [topic, setTopic] = useState(request.topic)
  const [platform, setPlatform] = useState(
    request.platform ?? accounts.find(a => a.id === initialAccount)?.platform ?? '')
  const [accountId, setAccountId] = useState(initialAccount)
  const [hotspots, setHotspots] = useState<Hotspot[]>([])
  const [loading, setLoading] = useState(false)

  // 待用热点（供下拉回填选题）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        const list = await apiGet<Hotspot[]>('/api/media/hotspots?state=pending')
        if (!cancelled) setHotspots(list.slice(0, 30))
      } catch { /* 热点拉取失败不阻塞弹窗 */ } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const activePlatforms = new Set(accounts.filter(a => a.status === 'active').map(a => a.platform))
  /** 切平台时清掉不再属于该平台的账号 */
  const pickPlatform = (id: string): void => {
    setPlatform(id)
    setAccountId(cur => (accounts.find(a => a.id === cur)?.platform === id ? cur : ''))
  }
  /** 热点写作模式：选账号的同时把平台带上（平台由账号决定，不再单独选）。 */
  const pickAccount = (id: string): void => {
    setAccountId(id)
    const a = accounts.find(x => x.id === id)
    if (a) setPlatform(a.platform)
  }
  const platformAccounts = accounts.filter(a => a.platform === platform)
  /** 热点模式下账号不按平台过滤（选哪个账号就用哪个平台）。 */
  const selectableAccounts = isHotspot ? accounts : platformAccounts
  const account = accounts.find(a => a.id === accountId)
  /** 人设由账号 1:1 带出；账号未绑人设时给通用兜底 */
  const boundPersona = personas.find(p => p.accountId === accountId)
  const writer = boundPersona
    ?? { id: '_default', name: '默认（该账号未绑定人设）' }
  const valid = topic.trim() !== '' && platform !== '' && accountId !== ''

  const confirm = (): void => {
    onConfirm({
      topic: topic.trim(),
      articleId: request.articleId,
      hotspotId: request.hotspotId,
      platform,
      accountId,
      personaId: request.personaId ?? boundPersona?.id,
      personaName: writer.name,
    })
  }

  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} onClick={e => e.stopPropagation()}>
        <div className={s.modalHead}>
          <div className={s.h2}>{isHotspot ? '热点写作 · 选择账号' : '派活确认'}</div>
        </div>

        {request.note && (
          <div className={`${s.noteBox} ${request.note.kind === 'ai-unavailable' ? s.noteWarn : s.noteInfo}`}>
            <div className={s.noteTitle}>
              {request.note.kind === 'ai-unavailable' ? 'AI 派活没生效，下面是手动填写' : '还差一点信息'}
            </div>
            <div>{request.note.text}</div>
          </div>
        )}

        {request.articleId ? (
          <div className={s.muted}>为已有草稿「{request.topic}」选择要发布的平台</div>
        ) : isHotspot ? (
          <>
            <label className={s.fieldLabel}>选题（来自热点库）</label>
            <input className={s.input} value={topic} readOnly />
            <div className={s.muted}>
              先确认用哪个账号来写：账号决定写作人设和发布平台，默认已选最契合的一个。
            </div>
          </>
        ) : (
          <>
            <label className={s.fieldLabel}>选题</label>
            <input
              className={s.input}
              value={topic}
              placeholder="这篇文章要写什么"
              onChange={e => setTopic(e.target.value)}
              autoFocus
            />
            {hotspots.length > 0 && (
              <select
                className={s.select}
                value=""
                onChange={e => {
                  const h = hotspots.find(x => x.id === e.target.value)
                  if (h) setTopic(h.title)
                }}
              >
                <option value="">{loading ? '热点加载中…' : '从热点库选择…'}</option>
                {hotspots.map(h => (
                  <option key={h.id} value={h.id}>{h.title}</option>
                ))}
              </select>
            )}
          </>
        )}

        {!isHotspot && (
          <div className={s.col}>
            <label className={s.fieldLabel}>发到哪个平台（单选）</label>
            <div className={s.rowWrap}>
              {PLATFORM_IDS.map(id => (
                <button
                  key={id}
                  type="button"
                  className={platform === id ? `${s.pill} ${s.pillActive}` : s.pill}
                  onClick={() => pickPlatform(id)}
                >
                  {PLATFORM_LABEL[id]}
                  {!activePlatforms.has(id) && <span className={s.tiny}>未登录</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={s.col}>
          <label className={s.fieldLabel}>{isHotspot ? '用哪个账号写作并发布' : '用哪个账号发布'}</label>
          <select
            className={s.select}
            value={accountId}
            disabled={!isHotspot && platform === ''}
            onChange={e => (isHotspot ? pickAccount(e.target.value) : setAccountId(e.target.value))}
          >
            <option value="">
              {!isHotspot && platform === ''
                ? '请先选平台'
                : selectableAccounts.length === 0
                  ? (isHotspot ? '还没有接入账号' : '该平台还没有接入账号')
                  : '选择一个账号'}
            </option>
            {selectableAccounts.map(a => {
              const fit = fitOf(a)
              return (
                <option key={a.id} value={a.id}>
                  {a.displayName}{a.status !== 'active' ? '（未登录）' : ''}
                  {isHotspot && fit ? ` · 契合 ${Math.round(fit.score * 100)}%` : ''}
                </option>
              )
            })}
          </select>
          {isHotspot && account && fitOf(account)?.reason && (
            <div className={s.tiny}>为什么契合：{fitOf(account)!.reason}</div>
          )}
          <div className={s.tiny}>
            {account
              ? <>由「{account.displayName}」的专属人设撰写：<b>{writer.name}</b>{boundPersona ? '' : '（可在设置页给它绑定人设）'}</>
              : '选定账号后自动带出该账号的人设'}
          </div>
        </div>

        <div className={s.rowWrap}>
          <button
            className={`${s.btn} ${s.btnPrimary}`}
            disabled={!valid}
            onClick={confirm}
          >
            开干
          </button>
          <button className={s.btn} onClick={onClose}>取消</button>
        </div>
        <div className={s.tiny}>
          确认后我会：生成正文 → 建发布计划（需审核）→ 生成完成后回来审批。
        </div>
      </div>
    </div>
  )
}
