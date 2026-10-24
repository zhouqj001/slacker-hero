/**
 * 账号管理页：平台账号卡（身份 / 关键数字 / 本周期排期 / 主次操作）+ 一句话接入。
 * 账号数据由壳下发（工作台/侧栏共用同一份），增删改后回调 reloadAccounts 刷新。
 */
import { useCallback, useState, type ReactNode } from 'react'
import { ACCOUNT_STATUS_LABEL, PLATFORM_LABEL, PLATFORM_IDS, apiGet, apiPost, fmtSlot, planSlots, s, type Account, type AccountWork } from '../common.ts'
import { NlChatView, NlField, useNlChat } from '../NlChat.tsx'
import { PlanChat } from '../PlanChat.tsx'

/** /account/login/stream 的 SSE 帧。 */
type LoginFrame =
  | { type: 'stage'; stage: string; message: string; url?: string; elapsed?: number }
  | { type: 'done'; loggedIn: boolean; reason?: string; elapsed: number }
  | { type: 'error'; code: string; message: string; elapsed?: number }

interface AccountFields {
  displayName: string
  platform: string
  dailyLimit: number
}

const STATUS_BADGE: Record<string, string> = {
  active: `${s.badge} ${s.badgeSuccess}`,
  expired: `${s.badge} ${s.badgeWarn}`,
  disabled: `${s.badge} ${s.badgeNeutral}`,
}
const PLATFORM_TONE: Record<string, string> = { wechat: '#07c160', toutiao: '#fe2c55', zhihu: '#0066ff', xiaohongshu: '#ff2442' }

/** 数字显示：没采到就显示「—」，绝不显示 0（0 和「没这个数」是两回事）。 */
function fmtNum(v: number | undefined): string {
  return v === undefined ? '—' : v.toLocaleString('zh-CN')
}

/** 采集结果里带的小数（收益等），最多两位。 */
function fmtMoney(v: number | undefined): string {
  return v === undefined ? '—' : `${v.toFixed(2)} 元`
}

/** 逗号/顿号/空格分隔的一行文本 → 去空串数组（结果为空数组 = 保存时表示清空）。 */
function splitList(v: string): string[] {
  return v.split(/[、,，\s]+/).map(x => x.trim()).filter(x => x !== '')
}

/**
 * 卡内指标：键值直排（灰阶，无卡片边框、无分隔线），压低视觉噪音。
 * 一个数值一句话，不再用 4 个并排的数字卡堆在账号卡里。
 */
function Metric(props: { k: string; v: ReactNode }): JSX.Element {
  return (
    <span className={s.acctMetric}>
      <span className={s.acctMetricK}>{props.k}</span>
      <span className={s.acctMetricV}>{props.v}</span>
    </span>
  )
}

/**
 * 本周期排期块：目标进度 + 待排缺口 + 偏好时段 + 候选档期。
 * 没设目标时给一条「设定目标」入口，而不是整块消失（否则用户不知道该点哪里）。
 */
function PeriodPlan(props: {
  a: Account
  busy: boolean
  note?: string
  onGenerate: () => void
  onSetup: () => void
}): JSX.Element {
  const a = props.a
  if (!a.cadence) {
    return (
      <div className={s.periodBlock}>
        <div className={s.periodHead}>
          <span className={s.periodTitle}>本周期</span>
          <span className={s.tiny}>还没设发布目标</span>
          <div className={s.grow} />
          <button className={s.chipBtn} type="button" onClick={props.onSetup}>设定目标</button>
        </div>
      </div>
    )
  }
  const pub = a.periodPublished ?? 0
  const planned = a.periodPlanned ?? 0
  const sp = planSlots(a.cadence, pub, a.periodPlannedAt ?? [])
  const pct = a.cadence.target > 0 ? Math.min(100, (pub / a.cadence.target) * 100) : 0
  const noSlots = a.cadence.slots.length === 0
  return (
    <div className={s.periodBlock}>
      <div className={s.periodHead}>
        <span className={s.periodTitle}>{a.periodLabel ?? '本周'}</span>
        <span className={s.periodNum}><b>{pub}</b> / {a.cadence.target} 篇</span>
        {a.cadence.target > 0 && (
          <div className={s.goalBar} style={{ flex: '0 1 84px' }}>
            <div className={s.goalFill} style={{ width: `${pct}%` }} />
          </div>
        )}
        <span className={s.tiny}>待排 <b>{sp.needed}</b> · 已排 {planned}</span>
        <div className={s.grow} />
        {sp.needed > 0 && !noSlots && (
          <button className={s.chipBtn} type="button" disabled={props.busy} onClick={props.onGenerate}>
            {props.busy ? '生成中…' : `生成待排 ${sp.needed} 条`}
          </button>
        )}
      </div>
      <div className={s.tiny}>
        {noSlots
          ? '没设偏好时段，排不出候选档期（到「发布规划」里补）'
          : `偏好时段 ${a.cadence.slots.join(' · ')}`}
        {!noSlots && sp.capacity < sp.needed && ` · 本期剩余时段仅 ${sp.capacity} 个`}
      </div>
      {sp.slots.length > 0 && (
        <div className={s.slotChips}>
          {sp.slots.map(ts => <span key={ts} className={s.slotChip}>{fmtSlot(ts)}</span>)}
        </div>
      )}
      {props.note !== undefined && <div className={s.slotNote}>{props.note}</div>}
    </div>
  )
}

/** 账号已采集到的概况。字段缺就显示「—」，不补 0。 */
function AccountProfilePanel(props: { a: Account }): JSX.Element {
  const p = props.a.profile
  if (!p) {
    return <div className={s.tiny} style={{ marginTop: 6 }}>尚未采集平台数据</div>
  }
  const when = new Date(p.capturedAt).toLocaleString('zh-CN')
  return (
    <div className={s.acctProfile}>
      <div className={s.acctProfileGrid}>
        <Stat k="粉丝" v={fmtNum(p.fansTotal)} extra={p.fansGainedYesterday !== undefined ? `昨日 +${p.fansGainedYesterday}` : undefined} />
        <Stat k="总阅读" v={fmtNum(p.readsTotal)} extra={p.readsYesterday !== undefined ? `昨日 ${fmtNum(p.readsYesterday)}` : undefined} />
        <Stat k="昨日展现" v={fmtNum(p.showsYesterday)} extra={p.likesYesterday !== undefined ? `赞 ${fmtNum(p.likesYesterday)} · 评 ${fmtNum(p.commentsYesterday)}` : undefined} />
        <Stat k="累计收益" v={fmtMoney(p.incomeTotal)} extra={p.incomeYesterday !== undefined ? `昨日 ${fmtMoney(p.incomeYesterday)}` : undefined} />
      </div>
      <div className={s.acctMetaRow}>
        {p.platformUserId && <MetaIt k="平台ID" v={p.platformUserId} />}
        {p.likesTotal !== undefined && <MetaIt k="累计赞同" v={fmtNum(p.likesTotal)} />}
        {p.worksCount !== undefined && <MetaIt k="内容数" v={fmtNum(p.worksCount)} />}
        {p.certifyStatus && <MetaIt k="认证" v={p.certifyStatus} />}
        {p.creditScore !== undefined && <MetaIt k="信用分" v={String(p.creditScore)} />}
        {p.securityScore !== undefined && <MetaIt k="安全评分" v={String(p.securityScore)} />}
        <MetaIt k="采集于" v={when} />
      </div>
      {p.fansRegions && p.fansRegions.length > 0 && (
        <div className={s.acctRegionRow}>
          <span className={s.acctRegionLbl}>粉丝地域</span>
          {p.fansRegions.slice(0, 6).map(r => (
            <span key={r.name} className={s.acctRegion}>
              {r.name} <b>{(r.ratio * 100).toFixed(1)}%</b>
            </span>
          ))}
        </div>
      )}
      {p.warnings?.map((w, i) => (
        <div key={i} className={s.noteWarn}>{w}</div>
      ))}
    </div>
  )
}

/** 元信息键值对：一行一小单元，不拆行。 */
function MetaIt(props: { k: string; v: string }): JSX.Element {
  return (
    <span className={s.acctMetaIt}>
      <span className={s.acctMetaK}>{props.k}</span>
      <span className={s.acctMetaV}>{props.v}</span>
    </span>
  )
}

/** 一个小数字块。 */
function Stat(props: { k: string; v: string; extra?: string }): JSX.Element {
  return (
    <div className={s.statCard}>
      <div className={s.statK}>{props.k}</div>
      <div className={s.statValue}>{props.v}</div>
      {props.extra && <div className={s.tiny}>{props.extra}</div>}
    </div>
  )
}

export function AccountsPage(props: {
  accounts: Account[]
  reloadAccounts: () => Promise<void>
  onError: (msg: string) => void
}): JSX.Element {
  const { accounts, reloadAccounts, onError } = props
  const [adding, setAdding] = useState(false)
  const [login, setLogin] = useState<string | null>(null)
  const [loginStage, setLoginStage] = useState<{ stage: string; message: string } | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  // 账号数据采集（纯只读：打开平台后台数据页读数，不改任何东西）
  const [collecting, setCollecting] = useState<string | null>(null)
  const [collectNote, setCollectNote] = useState<string | null>(null)
  const [openWorks, setOpenWorks] = useState<string | null>(null)
  const [works, setWorks] = useState<AccountWork[]>([])
  // 发布目标规划：单值展开（与「作品明细」同款，不弹窗）
  const [planning, setPlanning] = useState<string | null>(null)
  const [draftPeriod, setDraftPeriod] = useState<'week' | 'month'>('week')
  const [draftTarget, setDraftTarget] = useState('')
  const [draftSlots, setDraftSlots] = useState('')
  const [draftPillars, setDraftPillars] = useState('')
  /** 正在物化待排档期的账号（null = 没有在生成）。 */
  const [slotBusy, setSlotBusy] = useState<string | null>(null)
  /** 待排档期生成结果（按账号记，生成后留在卡片上供回溯）。 */
  const [slotNote, setSlotNote] = useState<{ id: string; text: string } | null>(null)
  /** 「发布规划」面板内当前子页：表单设定 / 对话排期（合并入口，卡片上只留一个按钮）。 */
  const [planTab, setPlanTab] = useState<'form' | 'chat'>('form')
  /** 展开「更多」操作行（检测登录态 / 重新登录 / 作品明细 / 数据详情 / 删除）。 */
  const [moreOpen, setMoreOpen] = useState<string | null>(null)
  /** 展开采集到的平台详情（粉丝地域、平台 ID、信用分等）。 */
  const [detailOpen, setDetailOpen] = useState<string | null>(null)
  const [savingPlan, setSavingPlan] = useState(false)
  const chat = useNlChat<AccountFields>('account')

  /**
   * 任务收尾：关掉本次拉起的全部托管浏览器（不等 10 分钟空闲回收）。
   * 单账号操作也要调——否则用户看到的浏览器窗口会一直挂着，好像没关。
   */
  const closeAllBrowsers = useCallback((): void => {
    void apiPost('/api/media/browser/close-all', {}).catch(() => {})
  }, [])

  /** 采集某个账号的平台数据（概况 + 作品）。 */
  const collect = useCallback(async (a: Account): Promise<void> => {
    onError('')
    setCollectNote(null)
    setCollecting(a.id)
    try {
      const res = await apiPost<{
        id: string
        profile: Record<string, unknown>
        works: AccountWork[]
        workError?: string | null
      }>('/api/media/account/collect', { id: a.id })
      await reloadAccounts()
      const n = res.works.length
      setCollectNote(
        `「${a.displayName}」采集完成：概况 ${Object.keys(res.profile).length} 项`
        + (res.workError ? `；作品列表失败（${res.workError}）` : `，作品 ${n} 条`),
      )
      setWorks(res.works)
      setOpenWorks(a.id)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setCollecting(null)
      closeAllBrowsers()
    }
  }, [closeAllBrowsers, onError, reloadAccounts])

  /** 展开某账号的作品明细。 */
  const loadWorks = useCallback(async (accountId: string): Promise<void> => {
    if (openWorks === accountId) {
      setOpenWorks(null)
      return
    }
    onError('')
    setOpenWorks(accountId)
    setWorks([])
    try {
      setWorks(await apiGet<AccountWork[]>(`/api/media/account/works?accountId=${encodeURIComponent(accountId)}`))
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
      setOpenWorks(null)
    }
  }, [onError, openWorks])

  /**
   * 打开/收起某账号的「发布规划」面板（展开时把当前值带进草稿；再点一次收起）。
   * 面板内用子页签分开「目标与时段」和「对话排期」，卡片上只保留一个入口。
   */
  const togglePlan = useCallback((a: Account): void => {
    if (planning === a.id) {
      setPlanning(null)
      return
    }
    onError('')
    setPlanning(a.id)
    setPlanTab('form')
    setDraftPeriod(a.cadence?.period ?? 'week')
    setDraftTarget(a.cadence ? String(a.cadence.target) : '')
    setDraftSlots((a.cadence?.slots ?? []).join('、'))
    setDraftPillars((a.pillars ?? []).join('、'))
  }, [onError, planning])

  /**
   * 保存发布目标与内容方向。
   * 目标留空 → cadence: null（取消周期目标）；时段/方向留空 → `[]`（清空）。
   */
  const savePlan = useCallback(async (a: Account): Promise<void> => {
    onError('')
    const raw = draftTarget.trim()
    const target = raw === '' ? null : Number(raw)
    if (target !== null && (!Number.isInteger(target) || target < 0)) {
      onError('目标篇数需为不小于 0 的整数')
      return
    }
    setSavingPlan(true)
    try {
      await apiPost('/api/media/account/save', {
        id: a.id,
        platform: a.platform,
        displayName: a.displayName,
        dailyLimit: a.dailyLimit,
        cadence: target === null ? null : { period: draftPeriod, target, slots: splitList(draftSlots) },
        pillars: splitList(draftPillars),
      })
      setPlanning(null)
      await reloadAccounts()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingPlan(false)
    }
  }, [draftPeriod, draftTarget, draftSlots, draftPillars, onError, reloadAccounts])

  /**
   * 把本期还差的发布档期物化成真实的「待排」计划记录（幂等：重复点只补差额）。
   * 只占时段、不替用户挑文章；生成后到「内容管理 → 发布节奏」给每条选文章。
   */
  const genSlots = useCallback(async (a: Account): Promise<void> => {
    onError('')
    setSlotBusy(a.id)
    setSlotNote(null)
    try {
      const res = await apiPost<{ created: number; shortfall: number }>('/api/media/plan/slots', { accountId: a.id })
      const parts: string[] = []
      parts.push(res.created === 0 ? '本期已排满，没有需要补的档期' : `已生成 ${res.created} 条待排档期`)
      if (res.shortfall > 0) parts.push(`剩余时段只够 ${res.created} 个，还差 ${res.shortfall} 个（可加偏好时段或调低目标）`)
      if (res.created > 0) parts.push('到「内容管理 → 发布节奏」点每条的「选文章」填成正式计划')
      setSlotNote({ id: a.id, text: parts.join('；') })
      await reloadAccounts()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setSlotBusy(null)
    }
  }, [onError, reloadAccounts])

  /** 采集全部已登录账号（逐个来，单个失败不影响其它）。 */
  const collectAll = useCallback(async (): Promise<void> => {
    setCollectNote(null)
    let ok = 0
    const failed: string[] = []
    for (const a of accounts) {
      setCollecting(a.id)
      try {
        await apiPost('/api/media/account/collect', { id: a.id })
        ok++
      } catch {
        failed.push(a.displayName)
      }
    }
    setCollecting(null)
    closeAllBrowsers()
    await reloadAccounts()
    setCollectNote(
      `采集完成：${ok}/${accounts.length} 个账号成功`
      + (failed.length > 0 ? `（失败：${failed.join('、')}）` : ''),
    )
  }, [accounts, reloadAccounts])

  const fields = chat.pending
  const hasFields = Object.keys(fields).length > 0

  const startNew = (): void => {
    setAdding(true)
    chat.reset()
  }

  const closeNew = (): void => {
    setAdding(false)
    chat.reset()
  }

  const confirm = async (): Promise<void> => {
    const platform = String(fields.platform ?? '')
    if (!PLATFORM_IDS.includes(platform as 'wechat')) return
    // 名字用户没给就先用平台名占位——登录成功后点「采集数据」会自动回填平台展示名
    const displayName = String(fields.displayName ?? '').trim() || `${PLATFORM_LABEL[platform] ?? platform}账号`
    try {
      const saved = await apiPost<Account>('/api/media/account/save', {
        displayName,
        platform,
        dailyLimit: typeof fields.dailyLimit === 'number' && fields.dailyLimit > 0 ? fields.dailyLimit : 3,
      })
      chat.reset()
      setAdding(false)
      await reloadAccounts()
      // 接入的下半场：直接拉起浏览器扫码登录（账号列表卡上显示进度），
      // 登录成功才算接入完成；失败/取消可走卡片上的「重新登录」兜底。
      await startLogin(saved.id)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const act = async (id: string, action: 'login' | 'check'): Promise<void> => {
    onError('')
    try {
      await apiPost(`/api/media/account/${action}`, { id })
      await reloadAccounts()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      closeAllBrowsers()
    }
  }

  /**
   * 扫码登录：走 SSE 进度流，实时显示「拉起浏览器 → 等扫码 → 复核持久化」，
   * 并提供取消（不必干等满 3 分钟超时）。
   */
  const startLogin = useCallback(async (id: string): Promise<void> => {
    onError('')
    setLogin(id)
    setLoginStage({ stage: 'launching', message: '正在拉起托管浏览器…' })
    try {
      const res = await fetch('/api/media/account/login/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ code: 'HTTP', message: `HTTP ${res.status}` })) as { code: string; message: string }
        throw new Error(`[${err.code}] ${err.message}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const f of frames) {
          const m = f.match(/^data: (.+)$/m)
          if (!m) continue
          const frame = JSON.parse(m[1]) as LoginFrame
          if (frame.type === 'stage') setLoginStage(frame)
          else if (frame.type === 'done') {
            setLoginStage({ stage: 'done', message: `登录成功（${frame.reason}）· 用时 ${frame.elapsed}s` })
            await reloadAccounts()
          } else if (frame.type === 'error') {
            setLoginStage({ stage: 'error', message: `[${frame.code}] ${frame.message}` })
            await reloadAccounts()
          }
        }
      }
    } catch (e) {
      setLoginStage({ stage: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setLogin(null)
      // 登录态已落在浏览器 profile 目录，窗口用完即关（不等 10 分钟空闲回收）
      closeAllBrowsers()
    }
  }, [closeAllBrowsers, onError, reloadAccounts])

  /** 取消进行中的扫码登录（后端中止等待，账号不会被误标为已登录）。 */
  const cancelLogin = async (id: string): Promise<void> => {
    try {
      await apiPost('/api/media/account/login/cancel', { id })
      setLoginStage({ stage: 'error', message: '已取消登录' })
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (a: Account): Promise<void> => {
    if (!window.confirm(`确定删除账号「${a.displayName}」吗？其发布计划会保留。`)) return
    onError('')
    try {
      await apiPost('/api/media/account/delete', { id: a.id })
      await reloadAccounts()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 逐个静默校验全部账号登录态（会依次拉起各账号浏览器，单个失败不影响其它）。 */
  const checkAll = async (): Promise<void> => {
    onError('')
    setCheckingAll(true)
    let ok = 0
    let bad = 0
    try {
      for (const a of accounts) {
        try {
          await apiPost('/api/media/account/check', { id: a.id })
          ok++
        } catch {
          bad++
        }
      }
      await reloadAccounts()
      onError(bad > 0 ? `检测完成：${ok} 个登录正常，${bad} 个需要重新登录（见卡片徽章）` : '')
    } finally {
      setCheckingAll(false)
      closeAllBrowsers()
    }
  }

  return (
    <div className={`${s.page} ${s.col}`}>
      <div className={s.pageHead}>
        <div>
          <div className={s.pageTitle}>账号管理</div>
          <div className={s.pageDesc}>接入各平台创作账号，登录态由插件托管；派活时按平台挑选账号发布。</div>
        </div>
        <div className={s.acts}>
          <button className={s.btn} type="button" disabled={checkingAll || accounts.length === 0} onClick={() => { void checkAll() }}>
            {checkingAll ? '检测中…' : '检测全部登录态'}
          </button>
          <button
            className={s.btn}
            type="button"
            disabled={collecting !== null || accounts.length === 0}
            title="逐个打开各账号的平台后台数据页读取概况与作品（只读，不改任何平台数据）"
            onClick={() => { void collectAll() }}
          >
            {collecting ? '采集中…' : '采集全部数据'}
          </button>
          <button className={s.btnPrimary} type="button" onClick={startNew}>＋ 接入账号</button>
        </div>
      </div>
      {collectNote && <div className={s.tiny} style={{ marginTop: 4 }}>{collectNote}</div>}

      <div className={s.acctGrid}>
        {accounts.map(a => (
          <div key={a.id} className={s.acctCard}>
            {/* ① 身份：名称 / 平台 / 登录态 —— 一屏一眼看清是谁、能不能发 */}
            <div className={s.nmRow}>
              <span className={s.acctImg} style={{ background: PLATFORM_TONE[a.platform] ?? 'var(--ms-accent)' }}>
                {(PLATFORM_LABEL[a.platform] ?? a.platform).slice(0, 1)}
              </span>
              <div className={s.grow} style={{ minWidth: 0 }}>
                <div className={s.ellipsis} style={{ fontWeight: 600 }}>{a.displayName}</div>
                <div className={s.acctSub}>
                  {PLATFORM_LABEL[a.platform] ?? a.platform}
                  {a.lastLoginCheckAt && ` · 最近检测 ${new Date(a.lastLoginCheckAt).toLocaleDateString('zh-CN')}`}
                </div>
              </div>
              <span className={STATUS_BADGE[a.status] ?? `${s.badge} ${s.badgeNeutral}`}>
                {ACCOUNT_STATUS_LABEL[a.status] ?? a.status}
              </span>
            </div>

            {/* ② 关键数字：一行直排，不再四个数字卡并排 */}
            <div className={s.acctMetrics}>
              <Metric k="今日已发" v={<>{a.sentToday ?? 0}<span className={s.acctMetricUnit}>/{a.dailyLimit}</span></>} />
              <Metric k="累计发布" v={<>{a.publishTotal ?? 0}<span className={s.acctMetricUnit}> 篇</span></>} />
              {a.profile?.fansTotal !== undefined && <Metric k="粉丝" v={fmtNum(a.profile.fansTotal)} />}
              {a.profile?.readsTotal !== undefined && <Metric k="总阅读" v={fmtNum(a.profile.readsTotal)} />}
            </div>

            {/* ③ 本周期排期（目标进度 + 待排缺口 + 候选档期） */}
            <PeriodPlan
              a={a}
              busy={slotBusy === a.id}
              note={slotNote?.id === a.id ? slotNote.text : undefined}
              onGenerate={() => { void genSlots(a) }}
              onSetup={() => togglePlan(a)}
            />

            {a.pillars && a.pillars.length > 0 && (
              <div className={s.pfChips}>
                {a.pillars.map(p => <span key={p} className={s.pfChip}>{p}</span>)}
              </div>
            )}

            {/* ④ 需要人处理的状态，合成一行（不再两条独立提示各占一行） */}
            {(a.status !== 'active' || (a.status === 'active' && !a.canPublish)) && (
              <div className={s.acctNote}>
                {a.status !== 'active'
                  ? '未登录，当前无法发布'
                  : '该平台走「草稿优先」，自动发布未接入，发布需人工确认'}
              </div>
            )}

            {/* ⑤ 操作：只留主操作 + 更多（其余收进第二行，避免一排七个按钮） */}
            <div className={s.acctOps}>
              {a.status !== 'active' ? (
                <button
                  className={s.chipBtn}
                  type="button"
                  disabled={login === a.id}
                  onClick={() => { void startLogin(a.id) }}
                >
                  {login === a.id ? '登录中…' : '重新登录'}
                </button>
              ) : (
                <button
                  className={s.chipBtn}
                  type="button"
                  disabled={collecting !== null}
                  title="打开平台后台数据页读取概况与作品（只读）"
                  onClick={() => { void collect(a) }}
                >
                  {collecting === a.id ? '采集中…' : a.profile ? '重新采集' : '采集数据'}
                </button>
              )}
              <button
                className={`${s.chipBtn} ${planning === a.id ? s.chipBtnOn : ''}`}
                type="button"
                title="设定发布目标与偏好时段，或用一句话让大模型排整期档期"
                onClick={() => togglePlan(a)}
              >
                发布规划
              </button>
              <div className={s.grow} />
              <button
                className={s.moreBtn}
                type="button"
                onClick={() => setMoreOpen(moreOpen === a.id ? null : a.id)}
              >
                {moreOpen === a.id ? '收起' : '更多'}
              </button>
            </div>
            {moreOpen === a.id && (
              <div className={s.acctOpsSecondary}>
                <button className={s.chipBtn} type="button" disabled={login === a.id} onClick={() => { void act(a.id, 'check') }}>
                  检测登录态
                </button>
                {a.status === 'active' && (
                  <button className={s.chipBtn} type="button" disabled={login === a.id} onClick={() => { void startLogin(a.id) }}>
                    重新登录
                  </button>
                )}
                {a.profile && (
                  <>
                    <button
                      className={s.chipBtn}
                      type="button"
                      onClick={() => setDetailOpen(detailOpen === a.id ? null : a.id)}
                    >
                      {detailOpen === a.id ? '收起数据' : '数据详情'}
                    </button>
                    <button
                      className={s.chipBtn}
                      type="button"
                      disabled={collecting !== null}
                      onClick={() => { void loadWorks(a.id) }}
                    >
                      {openWorks === a.id ? '收起作品' : '作品明细'}
                    </button>
                  </>
                )}
                <div className={s.grow} />
                <button className={`${s.chipBtn} ${s.chipBtnDanger}`} type="button" onClick={() => { void remove(a) }}>删除账号</button>
              </div>
            )}

            {detailOpen === a.id && a.profile && <AccountProfilePanel a={a} />}
            {planning === a.id && (
              <div className={s.planEdit}>
                <div className={s.tabs}>
                  <button
                    className={`${s.tab} ${planTab === 'form' ? s.tabActive : ''}`}
                    type="button"
                    onClick={() => setPlanTab('form')}
                  >
                    目标与时段
                  </button>
                  <button
                    className={`${s.tab} ${planTab === 'chat' ? s.tabActive : ''}`}
                    type="button"
                    onClick={() => setPlanTab('chat')}
                  >
                    对话排期
                  </button>
                </div>
                {planTab === 'form' ? (
                  <>
                    <div className={s.planEditRow}>
                      <span className={s.planEditLbl}>周期</span>
                      <select
                        className={s.select}
                        style={{ fontSize: 12 }}
                        value={draftPeriod}
                        onChange={e => setDraftPeriod(e.target.value === 'month' ? 'month' : 'week')}
                      >
                        <option value="week">每周</option>
                        <option value="month">每月</option>
                      </select>
                      <span className={s.planEditLbl}>目标</span>
                      <input
                        className={s.input}
                        style={{ fontSize: 12, width: 72 }}
                        value={draftTarget}
                        inputMode="numeric"
                        placeholder="5"
                        onChange={e => setDraftTarget(e.target.value)}
                      />
                      <span className={s.tiny}>篇</span>
                    </div>
                    <div className={s.planEditRow}>
                      <span className={s.planEditLbl}>偏好时段</span>
                      <input
                        className={s.input}
                        style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                        value={draftSlots}
                        placeholder="09:00、20:30（逗号分隔，24 小时制）"
                        onChange={e => setDraftSlots(e.target.value)}
                      />
                    </div>
                    <div className={s.planEditRow}>
                      <span className={s.planEditLbl}>内容方向</span>
                      <input
                        className={s.input}
                        style={{ fontSize: 12, flex: 1, minWidth: 0 }}
                        value={draftPillars}
                        placeholder="AI 工具、效率方法（逗号分隔）"
                        onChange={e => setDraftPillars(e.target.value)}
                      />
                    </div>
                    <div className={s.planEditActs}>
                      <div className={s.tiny}>目标留空 = 取消周期目标；时段/方向留空 = 清空。</div>
                      <div className={s.grow} />
                      <button
                        className={s.chipBtn}
                        type="button"
                        disabled={savingPlan}
                        onClick={() => setPlanning(null)}
                      >
                        取消
                      </button>
                      <button
                        className={`${s.btn} ${s.btnPrimary}`}
                        type="button"
                        disabled={savingPlan}
                        onClick={() => { void savePlan(a) }}
                      >
                        {savingPlan ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </>
                ) : (
                  <PlanChat account={a} onApplied={reloadAccounts} />
                )}
              </div>
            )}
            {openWorks === a.id && (
              <div className={s.acctWorks}>
                {works.length === 0
                  ? <div className={s.tiny}>没有采集到作品记录。</div>
                  : works.map(w => (
                      <div key={w.id} className={s.acctWorkRow}>
                        <span className={s.tiny} style={{ flex: '0 0 88px' }}>
                          {w.publishedAtText ?? new Date(w.capturedAt).toLocaleDateString('zh-CN')}
                        </span>
                        <span className={s.ellipsis} style={{ flex: 1, minWidth: 0 }}>{w.title}</span>
                        <span className={s.tiny} style={{ flex: '0 0 auto' }}>
                          展现 {fmtNum(w.shows)} · 阅读 {fmtNum(w.reads)} · 赞 {fmtNum(w.likes)} · 评 {fmtNum(w.comments)}
                        </span>
                      </div>
                    ))}
              </div>
            )}
            {login === a.id && loginStage && (
              <div className={s.acctLogin}>
                <div className={s.acctLoginMsg}>
                  <span className={s.acctSpin} />
                  <span>{loginStage.message}</span>
                </div>
                <button className={s.chipBtn} type="button" onClick={() => { void cancelLogin(a.id) }}>取消</button>
              </div>
            )}
          </div>
        ))}
        <button className={`${s.acctCard} ${s.dashed}`} type="button" onClick={startNew}>
          ＋<span>接入新账号</span>
          <span className={s.acctSub}>公众号 / 头条 / 知乎 / 小红书</span>
        </button>
      </div>

      {(adding || hasFields) && (
        <NlChatView
          turns={chat.turns}
          busy={chat.busy}
          input={chat.input}
          setInput={chat.setInput}
          onSend={() => { void chat.send(chat.input, {}) }}
          placeholder="一句话接入账号，如：「接入公众号，名字叫 AI 前沿观察，一天最多发 2 篇」"
          emptyHint={'用一句话描述要接入的账号，例如：「接入微信公众号，名字叫 AI 前沿观察，一天最多发 2 篇」。\n名字不提供也行，接入后从平台自动采集；缺平台它会追问。'}
        >
          {hasFields && (
            <div className={s.nlCard}>
              <div className={s.nlCardTitle}>确认接入账号</div>
              <NlField
                k="名称"
                v={String(fields.displayName ?? '').trim() || <span className={s.nlCardHint}>（保存后从平台采集）</span>}
              />
              <NlField
                k="平台"
                v={PLATFORM_LABEL[String(fields.platform ?? '')]
                  ?? <span className={s.nlCardHint}>（待补：公众号 / 头条 / 知乎 / 小红书）</span>}
              />
              <NlField k="日限额" v={String(typeof fields.dailyLimit === 'number' ? fields.dailyLimit : 3)} />
              <div className={s.rowWrap}>
                <button
                  className={`${s.btn} ${s.btnPrimary}`}
                  type="button"
                  disabled={!fields.platform || chat.busy}
                  onClick={() => { void confirm() }}
                >
                  保存
                </button>
                <button className={s.btn} type="button" onClick={() => { chat.clearPending() }}>重新说</button>
                <button className={s.btn} type="button" onClick={closeNew}>收起</button>
              </div>
            </div>
          )}
        </NlChatView>
      )}

    </div>
  )
}
