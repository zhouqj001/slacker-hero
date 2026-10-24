/**
 * 内容管理页：内容库（文章列表）/ 素材库（图片网格）/ 发布节奏（周历）三个子页。
 * 数据来自 GET /api/media/content 与 /api/media/assets 聚合路由；搜索/分页客户端派生。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCOUNT_STATUS_LABEL, PLATFORM_LABEL, apiGet, apiPost, planSlots, s,
  type Account, type Article, type Plan, type PublishRecord, type Review, type SlotPlan,
} from '../common.ts'
import { mdToHtml } from '../../platforms/markdown.ts'
import { PlanChat } from '../PlanChat.tsx'

/** 计划时段 → `<input type="datetime-local">` 的值（本地时区，分钟精度）。 */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** datetime-local 值 → 时间戳；不合法返回 undefined（不合规就不保存，不静默兜底）。 */
function fromLocalInput(v: string): number | undefined {
  const ts = new Date(v).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

/** /api/media/content 行（与 host api.ts 对齐）。 */
interface ContentRow {
  article: Article
  plans: Plan[]
  publishes: PublishRecord[]
  reviews: Review[]
}

/** /api/media/assets 条目（与 host assets.ts 对齐）。 */
interface AssetItem {
  articleId: string
  filename: string
  url: string
  bytes: number
  mtimeMs: number
  articleTitle: string
}

export type ContentTab = 'articles' | 'assets' | 'rhythm'

/** 预览时按扩展决定渲染方式：视频用 <video>，其余（含动图 gif / svg）用 <img>。 */
const VIDEO_EXTS = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv'])
function isVideoFile(filename: string): boolean {
  const i = filename.lastIndexOf('.')
  return i >= 0 && VIDEO_EXTS.has(filename.slice(i + 1).toLowerCase())
}

/** 字节数转人类可读（素材信息展示用）。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

interface PlanChip {
  key: string
  label: string
  cls: string
  title: string
}

/**
 * 一篇文章「发布到哪几个平台、各自落在哪个账号」：按 已成功发布记录 → 发布计划 → 仅备好平台版本
 * 三级来源归并，每个平台只出一枚 chip。
 * 账号已删除 / 登录态异常会直接在 chip 上标出来——否则会「看着有计划，实际发不出去」。
 */
function platformChips(row: ContentRow, accounts: Account[]): PlanChip[] {
  const byId = new Map(accounts.map(a => [a.id, a]))
  const out: PlanChip[] = []
  const seen = new Set<string>()
  const push = (platform: string, state: string, cls: string, title: string): void => {
    if (seen.has(platform)) return
    seen.add(platform)
    out.push({ key: platform, label: `${PLATFORM_LABEL[platform] ?? platform} · ${state}`, cls, title })
  }
  for (const pub of row.publishes) {
    if (pub.state !== 'success' || pub.publishedAt === null) continue
    const who = byId.get(pub.accountId)?.displayName ?? '账号已删除'
    push(pub.platform, '已发布', `${s.pfChip} ${s.pfChipOk}`,
      `已通过「${who}」发布${pub.url ? `：${pub.url}` : ''}`)
  }
  for (const p of row.plans) {
    const acct = byId.get(p.accountId)
    const who = acct === undefined ? '账号已删除' : acct.displayName
    const state = PLAN_STATE_LABEL[p.state] ?? p.state
    const cls = acct === undefined || p.state === 'failed' || p.state === 'degraded'
      ? `${s.pfChip} ${s.pfChipBad}`
      : acct.status !== 'active'
        ? `${s.pfChip} ${s.pfChipWarn}`
        : p.state === 'published' ? `${s.pfChip} ${s.pfChipOk}` : s.pfChip
    const hint = acct === undefined
      ? '账号已删除，需换账号或移除该计划'
      : acct.status !== 'active' ? `账号登录态：${ACCOUNT_STATUS_LABEL[acct.status] ?? acct.status}` : ''
    push(p.platform, `${who} · ${state}`, cls,
      `${PLATFORM_LABEL[p.platform] ?? p.platform} · ${who} · ${state}${hint ? `（${hint}）` : ''} · 计划 ${new Date(p.scheduledAt).toLocaleString()}`)
  }
  for (const pf of Object.keys(row.article.platformVersions)) {
    if ((row.article.platformVersions[pf] ?? '') === '') continue
    push(pf, '已备稿', s.pfChip, `${PLATFORM_LABEL[pf] ?? pf}：已生成平台改写版本，但还没建发布计划`)
  }
  return out
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', generating: '生成中', generated: '已生成', editing: '编辑中', approved: '已通过', failed: '生成失败',
}
const STATUS_BADGE: Record<string, string> = {
  draft: `${s.badge} ${s.badgeNeutral}`,
  generating: `${s.badge} ${s.badgeAccent}`,
  generated: `${s.badge} ${s.badgeSuccess}`,
  editing: `${s.badge} ${s.badgeWarn}`,
  approved: `${s.badge} ${s.badgeSuccess}`,
  failed: `${s.badge} ${s.badgeDanger}`,
}
const PLAN_STATE_LABEL: Record<string, string> = {
  planned: '已排期', 'pending-review': '待审核', approved: '已批准',
  publishing: '发布中', published: '已发布', failed: '失败', degraded: '需人工', skipped: '已跳过',
}
const WEEK_LB = ['一', '二', '三', '四', '五', '六', '日']

/** 待排档期的显示名（articleId=null 的计划：只占了时段，还没挑文章）。 */
const SLOT_TITLE = '待排 · 未选文章'

/** 计划状态 → 圆点色：月历与账号泳道共用一份口径，避免两处漂移。 */
function planDot(state: Plan['state']): string {
  if (state === 'published') return s.calStOk
  if (state === 'approved' || state === 'publishing') return s.calStAcc
  if (state === 'failed') return s.calStBad
  if (state === 'planned' || state === 'skipped') return s.calStIdle
  return s.calStWarn
}

/** 账号泳道里的时间戳：`10/19 19:19`。 */
function fmtPlanWhen(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const PAGE_SIZE = 8

/**
 * 账号偏好时段里「下一个未来时刻」的时间戳（今天该时段已过则顺延明天）。
 * 没有可用时段返回 undefined（建计划时就不传 scheduledAt，维持原行为）。
 */
function nextSlotAt(slots: string[] | undefined): number | undefined {
  if (!slots || slots.length === 0) return undefined
  const mins = slots
    .map(s => {
      const [h, m] = s.split(':').map(Number)
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined
    })
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b)
  if (mins.length === 0) return undefined
  const now = new Date()
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const pick = mins.find(n => n > nowMin) ?? mins[0] + 1440 // 都用过 → 明天第一个时段
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, pick).getTime()
}

export function ContentPage(props: {
  accounts: Account[]
  initialTab: ContentTab
  onEdit: (article: Article) => void
  onRegenerate: (article: Article) => Promise<void>
  onError: (msg: string) => void
}): JSX.Element {
  const { accounts, initialTab, onEdit, onRegenerate, onError } = props
  const [tab, setTab] = useState<ContentTab>(initialTab)
  const [rows, setRows] = useState<ContentRow[]>([])
  /** 待排档期（articleId=null 的计划）：不属于任何文章，只出现在发布节奏的月历/账号泳道。 */
  const [slots, setSlots] = useState<Plan[]>([])
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updatedAt' | 'createdAt' | 'title'>('updatedAt')
  const [pageIdx, setPageIdx] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 正在放大预览的素材（null = 未打开）；点击缩略图打开，点遮罩 / 按 Esc 关闭。 */
  const [preview, setPreview] = useState<AssetItem | null>(null)
  /** 正在阅读预览的文章行（null = 未打开）；点「预览」打开，点浮层外 / 按 Esc 关闭。 */
  const [readRow, setReadRow] = useState<ContentRow | null>(null)

  const load = useCallback(async () => {
    try {
      const [content, assetRes] = await Promise.all([
        apiGet<{ rows: ContentRow[]; slots: Plan[] }>('/api/media/content'),
        apiGet<{ items: AssetItem[] }>('/api/media/assets'),
      ])
      setRows(content.rows)
      setSlots(content.slots ?? [])
      setAssets(assetRes.items)
      setLoaded(true)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  useEffect(() => { void load() }, [load])

  // ---------------------------------------------------------- 素材预览（全窗 lightbox）
  // 用原生 <dialog>.showModal() 而非 position:fixed 覆盖层：模态 dialog 进入浏览器 top layer，
  // 天然盖住壳层标题栏、且不受任何祖先裁剪/transform 影响（此前 fixed 覆盖层被面板祖先劫持，
  // 导致只盖住面板、关闭键被裁剪、还挤出滚动条）。
  const dlgRef = useRef<HTMLDialogElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 缩放倍率与平移量：wheel / 按钮缩放，放大后拖拽平移。 */
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  // 打开/关闭 dialog（Esc 由 dialog 原生 cancel→close 处理，无需自己监听键盘）
  useEffect(() => {
    const d = dlgRef.current
    if (d === null) return
    if (preview !== null && !d.open) d.showModal()
    else if (preview === null && d.open) d.close()
  }, [preview])

  // dialog 关闭（Esc / close()）后同步清空预览对象
  useEffect(() => {
    const d = dlgRef.current
    if (d === null) return
    const onClose = () => setPreview(null)
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])

  // 每次换素材都回到「适应窗口」
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [preview])

  // wheel 缩放需要非 passive 监听才能 preventDefault（React 的 onWheel 是 passive 的）
  useEffect(() => {
    const st = stageRef.current
    if (st === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
      setZoom(z => {
        const nz = Math.min(5, Math.max(0.5, +(z * f).toFixed(3)))
        if (nz <= 1) setPan({ x: 0, y: 0 })
        return nz
      })
    }
    st.addEventListener('wheel', onWheel, { passive: false })
    return () => st.removeEventListener('wheel', onWheel)
  }, [])

  const zoomBy = useCallback((f: number) => {
    setZoom(z => {
      const nz = Math.min(5, Math.max(0.5, +(z * f).toFixed(3)))
      if (nz <= 1) setPan({ x: 0, y: 0 })
      return nz
    })
  }, [])
  const resetZoom = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  /** 双击在「适应窗口」与 2× 之间切换。 */
  const toggleZoom = useCallback(() => {
    setZoom(z => {
      if (z > 1.01) { setPan({ x: 0, y: 0 }); return 1 }
      return 2
    })
  }, [])

  const onStagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    setDragging(true)
  }, [zoom, pan])
  const onStagePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (d === null) return
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) })
  }, [])
  const onStagePointerUp = useCallback(() => {
    dragRef.current = null
    setDragging(false)
  }, [])

  /** 点 dialog 自身（图片之外的暗色区域 / ::backdrop）关闭。 */
  const onDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setPreview(null)
  }, [])

  // ---------------------------------------------------------- 文章阅读预览（全窗浮层，同款 top-layer 方案）
  const readDlgRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => {
    const d = readDlgRef.current
    if (d === null) return
    if (readRow !== null && !d.open) d.showModal()
    else if (readRow === null && d.open) d.close()
  }, [readRow])

  useEffect(() => {
    const d = readDlgRef.current
    if (d === null) return
    const onClose = () => setReadRow(null)
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])

  const onReadDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setReadRow(null)
  }, [])

  // ---------------------------------------------------------- 发布计划管理（换账号 / 取消 / 移除）
  // 只存文章 id，行数据从 rows 派生：保存后 load() 刷新 rows，弹窗内容自动跟着更新。
  const [planRowId, setPlanRowId] = useState<string | null>(null)
  const planDlgRef = useRef<HTMLDialogElement | null>(null)
  /** 每条计划的账号选择草稿（planId → accountId）；点「保存」才落库。 */
  const [planDraft, setPlanDraft] = useState<Record<string, string>>({})
  /** 新建计划选的账号。 */
  const [newPlanAcct, setNewPlanAcct] = useState('')
  const [planBusyId, setPlanBusyId] = useState<string | null>(null)
  /** 正在给哪条待排档期选文章（null = 未打开选择器）。 */
  const [fillPlan, setFillPlan] = useState<Plan | null>(null)
  /** 待排档期生成结果提示（按账号记，生成后留在泳道头上供回溯）。 */
  const [slotNote, setSlotNote] = useState<{ id: string; text: string } | null>(null)
  const fillDlgRef = useRef<HTMLDialogElement | null>(null)

  const planRow = useMemo(
    () => (planRowId === null ? null : rows.find(r => r.article.id === planRowId) ?? null),
    [rows, planRowId],
  )

  const openPlanDialog = useCallback((row: ContentRow) => {
    setPlanRowId(row.article.id)
    setPlanDraft(Object.fromEntries(row.plans.map(p => [p.id, p.accountId])))
    setNewPlanAcct(accounts.find(a => a.status === 'active')?.id ?? accounts[0]?.id ?? '')
    onError('')
  }, [accounts, onError])

  useEffect(() => {
    const d = planDlgRef.current
    if (d === null) return
    if (planRow !== null && !d.open) d.showModal()
    else if (planRow === null && d.open) d.close()
  }, [planRow])

  useEffect(() => {
    const d = planDlgRef.current
    if (d === null) return
    const onClose = () => setPlanRowId(null)
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])

  const onPlanDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setPlanRowId(null)
  }, [])

  // 待排档期「选文章」选择器（同款原生 dialog：top layer 盖住壳层，Esc 原生关闭）
  useEffect(() => {
    const d = fillDlgRef.current
    if (d === null) return
    if (fillPlan !== null && !d.open) d.showModal()
    else if (fillPlan === null && d.open) d.close()
  }, [fillPlan])

  useEffect(() => {
    const d = fillDlgRef.current
    if (d === null) return
    const onClose = () => setFillPlan(null)
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])

  const onFillDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setFillPlan(null)
  }, [])

  /** 换账号：platform 必须跟着账号走（plan.platform 决定用哪个平台适配器）。 */
  const retargetPlan = useCallback(async (plan: Plan, accountId: string) => {
    const acct = accounts.find(a => a.id === accountId)
    if (acct === undefined) return
    setPlanBusyId(plan.id)
    onError('')
    try {
      await apiPost('/api/media/plan/save', {
        id: plan.id, articleId: plan.articleId, platform: acct.platform, accountId: acct.id,
      })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [accounts, load, onError])

  /** 取消发布：计划置 skipped，不再发（计划本身留着，可再改回来）。 */
  const skipPlan = useCallback(async (plan: Plan) => {
    setPlanBusyId(plan.id)
    onError('')
    try {
      await apiPost('/api/media/plan/approve', { id: plan.id, action: 'skip' })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [load, onError])

  const removePlan = useCallback(async (plan: Plan) => {
    if (!window.confirm('移除这条发布计划？已产生的发布回执与复盘数据会保留。')) return
    setPlanBusyId(plan.id)
    onError('')
    try {
      await apiPost('/api/media/plan/delete', { id: plan.id })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [load, onError])

  /** 再建一条计划（多平台同时发；只想发一个平台就先取消/移除不要的那条）。 */
  const addPlan = useCallback(async (articleId: string, accountId: string) => {
    const acct = accounts.find(a => a.id === accountId)
    if (acct === undefined) return
    setPlanBusyId('new')
    onError('')
    try {
      // 该账号设了偏好时段 → 预填下一个未来时段；没设就按服务端默认（现在）
      const at = nextSlotAt(acct.cadence?.slots)
      await apiPost('/api/media/plan/save', {
        articleId,
        platform: acct.platform,
        accountId: acct.id,
        ...(at !== undefined ? { scheduledAt: at } : {}),
      })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [accounts, load, onError])

  /**
   * 按账号发布目标物化「待排档期」：本期还差几篇就补几条占位记录（幂等，重复点只补差额）。
   * 只占时段、不挑文章；容不下时如实回报差额，绝不硬凑。
   */
  const genSlots = useCallback(async (accountId: string) => {
    setPlanBusyId(`gen:${accountId}`)
    onError('')
    setSlotNote(null)
    try {
      const res = await apiPost<{ created: number; shortfall: number }>('/api/media/plan/slots', { accountId })
      const shortfall = res.shortfall > 0 ? `；本期剩余时段只够 ${res.created} 个，还差 ${res.shortfall} 个（可加偏好时段或调低目标）` : ''
      setSlotNote(res.created === 0
        ? { id: accountId, text: '本期已排满，没有需要补的档期' }
        : { id: accountId, text: `已生成 ${res.created} 条待排档期，点每条的「选文章」把它填成正式计划${shortfall}` })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [load, onError])

  /** 给待排档期选一篇文章：填上后它才是一条真正要发的计划（状态按审核总闸重算）。 */
  const assignArticle = useCallback(async (plan: Plan, articleId: string) => {
    setPlanBusyId(plan.id)
    onError('')
    try {
      await apiPost('/api/media/plan/save', { id: plan.id, articleId, platform: plan.platform })
      setFillPlan(null)
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [load, onError])

  // ---------------------------------------------------------- 单条计划微调（方案 A：不走大模型）
  // 改时间 / 换文章 / 换账号 / 移除都在这里手改，是无 LLM 或提案不合规时的兜底路径。
  const adjustDlgRef = useRef<HTMLDialogElement | null>(null)
  const [adjustPlan, setAdjustPlan] = useState<Plan | null>(null)
  const [adjustAt, setAdjustAt] = useState('')
  const [adjustArticleId, setAdjustArticleId] = useState('')
  const [adjustAcctId, setAdjustAcctId] = useState('')

  useEffect(() => {
    const d = adjustDlgRef.current
    if (d === null) return
    if (adjustPlan !== null && !d.open) d.showModal()
    else if (adjustPlan === null && d.open) d.close()
  }, [adjustPlan])

  useEffect(() => {
    const d = adjustDlgRef.current
    if (d === null) return
    const onClose = () => setAdjustPlan(null)
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])

  const onAdjustDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setAdjustPlan(null)
  }, [])

  /** 打开「改这条」：把当前值带进草稿。 */
  const openAdjust = useCallback((plan: Plan) => {
    setAdjustPlan(plan)
    setAdjustAt(toLocalInput(plan.scheduledAt))
    setAdjustArticleId(plan.articleId ?? '')
    setAdjustAcctId(plan.accountId)
  }, [])

  /** 保存微调：时间 / 文章（空=清成待排槽）/ 账号（平台随账号走）一次性提交。 */
  const saveAdjust = useCallback(async () => {
    if (adjustPlan === null) return
    const acct = accounts.find(a => a.id === adjustAcctId)
    if (acct === undefined) {
      onError('请选择一个有效账号')
      return
    }
    const at = fromLocalInput(adjustAt)
    if (at === undefined) {
      onError('时间格式不对，请重新选择')
      return
    }
    setPlanBusyId(adjustPlan.id)
    onError('')
    try {
      await apiPost('/api/media/plan/save', {
        id: adjustPlan.id,
        articleId: adjustArticleId === '' ? null : adjustArticleId,
        platform: acct.platform,
        accountId: acct.id,
        scheduledAt: at,
      })
      setAdjustPlan(null)
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPlanBusyId(null)
    }
  }, [adjustAcctId, adjustArticleId, adjustAt, adjustPlan, accounts, load, onError])

  // ---------------------------------------------------------- 对话规划（方案 B：一句话出整期提案）
  const chatDlgRef = useRef<HTMLDialogElement | null>(null)
  /** 正在为哪个账号做对话规划（null = 未打开）。 */
  const [chatAcctId, setChatAcctId] = useState<string | null>(null)

  useEffect(() => {
    const d = chatDlgRef.current
    if (d === null) return
    if (chatAcctId !== null && !d.open) d.showModal()
    else if (chatAcctId === null && d.open) d.close()
  }, [chatAcctId])

  useEffect(() => {
    const d = chatDlgRef.current
    if (d === null) return
    const onClose = () => setChatAcctId(null)
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [])

  const onChatDialogClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) setChatAcctId(null)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q === ''
      ? rows
      : rows.filter(r => r.article.title.toLowerCase().includes(q))
    return [...list].sort((a, b) => {
      if (sort === 'title') return a.article.title.localeCompare(b.article.title)
      return sort === 'createdAt'
        ? b.article.createdAt - a.article.createdAt
        : b.article.updatedAt - a.article.updatedAt
    })
  }, [rows, query, sort])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const curPage = Math.min(pageIdx, pageCount - 1)
  const pageRows = filtered.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE)

  const removeArticle = useCallback(async (a: Article) => {
    if (!window.confirm(`确定删除「${a.title}」？正文与配图将一并删除。`)) return
    setBusyId(a.id)
    onError('')
    try {
      await apiPost('/api/media/article/delete', { id: a.id })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }, [load, onError])

  const regen = useCallback(async (a: Article) => {
    setBusyId(a.id)
    try {
      await onRegenerate(a)
    } finally {
      setBusyId(null)
      await load()
    }
  }, [onRegenerate, load])

  /** 送审：approve=true 置「已通过」，false 退回「编辑中」。 */
  const toggleApprove = useCallback(async (a: Article) => {
    const approve = a.status !== 'approved'
    setBusyId(a.id)
    onError('')
    try {
      await apiPost('/api/media/article/approve', { id: a.id, approved: approve })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }, [load, onError])

  /** 月历：当前查看的月份(默认本月，可前后翻看历史/未来)。 */
  const [cal, setCal] = useState(() => {
    const n = new Date()
    return { y: n.getFullYear(), m: n.getMonth() }
  })
  const calShift = useCallback((delta: number) => {
    setCal(c => {
      const d = new Date(c.y, c.m + delta, 1)
      return { y: d.getFullYear(), m: d.getMonth() }
    })
  }, [])
  const calReset = useCallback(() => {
    const n = new Date()
    setCal({ y: n.getFullYear(), m: n.getMonth() })
  }, [])
  const calIsNow = cal.y === new Date().getFullYear() && cal.m === new Date().getMonth()

  /** 账号视角（''=全部）：只过滤「发布节奏」的展示，不改动任何计划数据。 */
  const [calAcct, setCalAcct] = useState('')
  /** 「发布节奏」两种看法：月历（按天）/ 按账号（泳道）。 */
  const [rhythmView, setRhythmView] = useState<'cal' | 'acct'>('cal')

  /** 账号视角过滤后的行：只供节奏视图派生（rows 本体不动，文章库/当日详情共用同一份过滤）。 */
  const calRows = useMemo(
    () => (calAcct === ''
      ? rows
      : rows.map(r => ({ ...r, plans: r.plans.filter(p => p.accountId === calAcct) }))),
    [rows, calAcct],
  )

  /** 待排档期按账号视角过滤（它们不属于任何文章，单独并入月历与泳道）。 */
  const calSlots = useMemo(
    () => (calAcct === '' ? slots : slots.filter(p => p.accountId === calAcct)),
    [slots, calAcct],
  )

  /** 当月 42/35 格(周一起首，补到整周；跨月格 inMonth=false)。计划按天挂格。 */
  const monthCells = useMemo(() => {
    const now = new Date()
    const lead = (new Date(cal.y, cal.m, 1).getDay() + 6) % 7
    const days = new Date(cal.y, cal.m + 1, 0).getDate()
    const total = Math.ceil((lead + days) / 7) * 7
    type CalPlan = Plan & { articleTitle: string }
    const cells: { date: Date | null; inMonth: boolean; today: boolean; plans: CalPlan[] }[] = []
    const monday0 = new Date(cal.y, cal.m, 1 - lead) // 月份起点所在周的周一
    for (let i = 0; i < total; i++) {
      const d = new Date(monday0.getFullYear(), monday0.getMonth(), monday0.getDate() + i)
      const inMonth = d.getMonth() === cal.m
      cells.push({
        date: d,
        inMonth,
        today: d.toDateString() === now.toDateString(),
        plans: [],
      })
    }
    const put = (p: Plan, articleTitle: string): void => {
      if (!p.scheduledAt) return
      const day = new Date(p.scheduledAt)
      const idx = Math.floor(
        (new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() - monday0.getTime()) / 86400_000,
      )
      if (idx >= 0 && idx < cells.length) cells[idx].plans.push({ ...p, articleTitle })
    }
    for (const r of calRows) for (const p of r.plans) put(p, r.article.title)
    for (const p of calSlots) put(p, SLOT_TITLE)
    for (const c of cells) c.plans.sort((a, b) => a.scheduledAt - b.scheduledAt)
    return cells
  }, [cal, calRows, calSlots])

  /** 选中查看的日;点格子「查看」,capsule 可关闭。 */
  const [selDate, setSelDate] = useState<Date | null>(null)
  const monthTotals = useMemo(() => {
    let done = 0, pending = 0, review = 0, problem = 0
    for (const c of monthCells) for (const p of c.plans) {
      if (p.state === 'published') done++
      else if (p.state === 'approved' || p.state === 'publishing') pending++
      else if (p.state === 'pending-review') review++
      else if (p.state === 'failed' || p.state === 'degraded') problem++
    }
    return { done, pending, review, problem }
  }, [monthCells])

  /** 当日详情:capsule 里聚合该日计划的发布状态(带 article 引用,行点击可编辑；待排档期 article 为空)。 */
  const selDetail = useMemo(() => {
    if (selDate === null) return null
    const key = selDate.toDateString()
    const all: { p: Plan; article?: Article }[] = []
    for (const r of calRows) for (const p of r.plans) {
      if (!p.scheduledAt) continue
      if (new Date(p.scheduledAt).toDateString() === key) all.push({ p, article: r.article })
    }
    for (const p of calSlots) {
      if (new Date(p.scheduledAt).toDateString() === key) all.push({ p })
    }
    all.sort((a, b) => a.p.scheduledAt - b.p.scheduledAt)
    return all
  }, [selDate, calRows, calSlots])

  /**
   * 账号泳道：本月每个账号一条，含其月内计划与计数。
   * 选定某个账号时即使它本月没有计划也保留这条泳道——空白要看得见，不能悄悄消失。
   * 另：有发布目标且本期还差篇数的账号，即使本月没计划也给一条泳道——否则设了目标看不到排期。
   */
  const accountLanes = useMemo(() => {
    const lanes = new Map<string, { p: Plan; article?: Article }[]>()
    const add = (accountId: string, item: { p: Plan; article?: Article }): void => {
      const arr = lanes.get(accountId)
      if (arr) arr.push(item)
      else lanes.set(accountId, [item])
    }
    const inMonth = (ts: number): boolean => {
      const d = new Date(ts)
      return d.getFullYear() === cal.y && d.getMonth() === cal.m
    }
    for (const r of calRows) {
      for (const p of r.plans) {
        if (!p.scheduledAt || !inMonth(p.scheduledAt)) continue
        add(p.accountId, { p, article: r.article })
      }
    }
    // 待排档期（已物化）同样按月挂泳道，看不见就等于没排
    for (const p of calSlots) {
      if (!p.scheduledAt || !inMonth(p.scheduledAt)) continue
      add(p.accountId, { p })
    }
    const slotOf = (accountId: string): SlotPlan => {
      const a = accounts.find(x => x.id === accountId)
      return planSlots(a?.cadence, a?.periodPublished ?? 0, a?.periodPlannedAt ?? [])
    }
    const withSlots = accounts.filter(a => slotOf(a.id).needed > 0).map(a => a.id)
    const ids = calAcct === ''
      ? [...new Set([...lanes.keys(), ...withSlots])]
      : [calAcct, ...[...new Set([...lanes.keys(), ...withSlots])].filter(k => k !== calAcct)]
    const order = new Map(accounts.map((a, i) => [a.id, i]))
    ids.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
    return ids.map((accountId) => {
      const plans = (lanes.get(accountId) ?? []).sort((a, b) => a.p.scheduledAt - b.p.scheduledAt)
      const stat = { done: 0, pending: 0, review: 0, problem: 0 }
      for (const { p } of plans) {
        if (p.state === 'published') stat.done++
        else if (p.state === 'approved' || p.state === 'publishing') stat.pending++
        else if (p.state === 'pending-review') stat.review++
        else if (p.state === 'failed' || p.state === 'degraded') stat.problem++
      }
      return { accountId, plans, stat, slotPlan: slotOf(accountId) }
    })
  }, [calRows, calSlots, cal, accounts, calAcct])

  const activeCount = accounts.filter(a => a.status === 'active').length

  return (
    <div className={`${s.page} ${s.col}`}>
      <div className={s.pageHead}>
        <div>
          <div className={s.pageTitle}>内容管理</div>
          <div className={s.pageDesc}>
            草稿、配图与发布节奏统一管理；{activeCount > 0 ? `${activeCount} 个账号在线` : '尚未接入在线账号'}。
          </div>
        </div>
        <div className={s.acts}>
          <button className={s.chipBtn} type="button" onClick={() => { void load() }}>刷新</button>
        </div>
      </div>

      <div className={s.tabChips}>
        {([
          ['articles', `文章库 ${rows.length}`],
          ['assets', `素材库 ${assets.length}`],
          ['rhythm', '发布节奏'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? `${s.chipTab} ${s.chipTabActive}` : s.chipTab}
            onClick={() => { setTab(key); setPageIdx(0) }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'articles' && (
        <div className={s.col}>
          <div className={s.cmTools}>
            <input
              className={`${s.input} ${s.cmSearch}`}
              value={query}
              placeholder="搜索文章标题…"
              onChange={e => { setQuery(e.target.value); setPageIdx(0) }}
            />
            <select
              className={s.select}
              value={sort}
              onChange={e => setSort(e.target.value as 'updatedAt' | 'createdAt' | 'title')}
            >
              <option value="updatedAt">按更新时间</option>
              <option value="createdAt">按创建时间</option>
              <option value="title">按标题</option>
            </select>
            <div className={s.cmPager}>
              <button className={s.chipBtn} type="button" disabled={curPage === 0} onClick={() => setPageIdx(curPage - 1)}>‹</button>
              <span className={s.cmCur}>{curPage + 1}</span> / {pageCount}
              <button className={s.chipBtn} type="button" disabled={curPage >= pageCount - 1} onClick={() => setPageIdx(curPage + 1)}>›</button>
            </div>
          </div>

          {!loaded && <div className={s.cmEmpty}>加载中…</div>}
          {loaded && filtered.length === 0 && (
            <div className={s.cmEmpty}>没有匹配的文章。去工作台派个活，或从热点一键开写。</div>
          )}

          <div className={s.col} style={{ gap: 6 }}>
            {pageRows.map(row => {
              const { article } = row
              const chips = platformChips(row, accounts)
              return (
                <div key={article.id} className={s.rowItem}>
                  <div className={s.grow} style={{ minWidth: 0 }}>
                    <div className={s.rowT}>{article.title}</div>
                    {/* 平台标签即入口：点它改账号 / 换平台 / 取消 / 移除这条发布计划 */}
                    <button
                      className={s.rowChips}
                      type="button"
                      title="点这里管理发布计划：换账号 / 换平台 / 取消 / 移除"
                      onClick={() => openPlanDialog(row)}
                    >
                      {chips.length > 0
                        ? chips.map(c => <span key={c.key} className={c.cls} title={c.title}>{c.label}</span>)
                        : <span className={`${s.pfChip} ${s.pfChipMuted}`}>未建发布计划 · 点此新建</span>}
                    </button>
                  </div>
                  <span className={STATUS_BADGE[article.status] ?? `${s.badge} ${s.badgeNeutral}`}>
                    {STATUS_LABEL[article.status] ?? article.status}
                  </span>
                  <span className={s.rowMeta}>{new Date(article.updatedAt).toLocaleDateString()}</span>
                  <div className={s.rowActs}>
                    <button className={s.chipBtn} type="button" onClick={() => setReadRow(row)}>预览</button>
                    <button className={s.chipBtn} type="button" onClick={() => onEdit(article)}>编辑</button>
                    <button
                      className={s.chipBtn}
                      type="button"
                      disabled={busyId === article.id}
                      onClick={() => { void toggleApprove(article) }}
                    >
                      {article.status === 'approved' ? '退回' : '通过审批'}
                    </button>
                    <button
                      className={s.chipBtn}
                      type="button"
                      disabled={busyId === article.id}
                      onClick={() => { void regen(article) }}
                    >
                      {busyId === article.id ? '生成中…' : '重新生成'}
                    </button>
                    <button
                      className={`${s.chipBtn} ${s.chipBtnDanger}`}
                      type="button"
                      disabled={busyId === article.id}
                      onClick={() => { void removeArticle(article) }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'assets' && (
        <div className={s.col}>
          {loaded && assets.length === 0 && (
            <div className={s.cmEmpty}>暂无素材。生成文章会自动配图，编辑器里也能上传本地图片。</div>
          )}
          <div className={s.assetGrid}>
            {assets.map(a => {
              const video = isVideoFile(a.filename)
              return (
                <figure
                  key={`${a.articleId}/${a.filename}`}
                  className={`${s.assetCard} ${s.assetCardClick}`}
                  style={{ margin: 0 }}
                  onClick={() => setPreview(a)}
                  title={video ? '点击播放' : '点击放大查看'}
                >
                  {video
                    ? (
                      <>
                        <video className={s.assetImg} src={a.url} muted preload="metadata" />
                        <span className={s.assetPlay}>▶</span>
                      </>
                    )
                    : <img className={s.assetImg} src={a.url} alt={a.filename} loading="lazy" />}
                  <figcaption className={s.assetCap}>{a.articleTitle || a.filename}</figcaption>
                </figure>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'rhythm' && (
        <div className={s.col}>
          <div className={s.calBar}>
            <div className={s.calNav}>
              <button className={s.calNavBtn} type="button" onClick={() => calShift(-1)} title="上一月">‹</button>
              <div className={s.calTitle}>
                <span className={s.calTitleY}>{cal.y}</span>
                <span className={s.calTitleM}>{cal.m + 1} 月</span>
              </div>
              <button className={s.calNavBtn} type="button" onClick={() => calShift(1)} title="下一月">›</button>
              {!calIsNow && (
                <button className={s.calBack} type="button" onClick={calReset}>回到本月</button>
              )}
            </div>
            <div className={s.calSum}>
              <span className={s.calSumItem}><span className={`${s.dot} ${s.calStOk}`} />已发 {monthTotals.done}</span>
              <span className={s.calSumItem}><span className={`${s.dot} ${s.calStAcc}`} />待发 {monthTotals.pending}</span>
              <span className={s.calSumItem}><span className={`${s.dot} ${s.calStWarn}`} />待审 {monthTotals.review}</span>
              {monthTotals.problem > 0 && <span className={s.calSumItem}><span className={`${s.dot} ${s.calStBad}`} />异常 {monthTotals.problem}</span>}
            </div>
          </div>
          <div className={s.calTools}>
            <select
              className={s.select}
              style={{ fontSize: 12 }}
              value={calAcct}
              onChange={e => setCalAcct(e.target.value)}
              title="切换账号视角：日历与泳道只看这个账号的计划"
            >
              <option value="">全部账号</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.displayName}（{PLATFORM_LABEL[a.platform] ?? a.platform}）</option>
              ))}
            </select>
            {calAcct !== '' && (() => {
              const a = accounts.find(x => x.id === calAcct)
              if (!a) return null
              if (!a.cadence) return <span className={s.tiny}>该账号未设周期目标</span>
              return (
                <span className={s.tiny}>
                  {a.periodLabel ?? '本周'}已发 {a.periodPublished ?? 0}/{a.cadence.target} 篇
                </span>
              )
            })()}
            <span className={s.tiny}>只是换个看法，计划数据没动</span>
            <div className={s.calViewToggle}>
              <button
                type="button"
                className={rhythmView === 'cal' ? `${s.chipTab} ${s.chipTabActive}` : s.chipTab}
                onClick={() => setRhythmView('cal')}
              >
                月历
              </button>
              <button
                type="button"
                className={rhythmView === 'acct' ? `${s.chipTab} ${s.chipTabActive}` : s.chipTab}
                onClick={() => setRhythmView('acct')}
              >
                按账号
              </button>
            </div>
          </div>

          {rhythmView === 'cal' && (
            <>
              <div className={s.calHead}>
                {WEEK_LB.map(d => <span key={d}>{d}</span>)}
              </div>
              <div className={s.calGrid}>
                {monthCells.map((c, i) => {
                  const sel = selDate !== null && c.date !== null && c.date.toDateString() === selDate.toDateString()
                  return (
                    <div
                      key={i}
                      className={[
                        s.calCell,
                        !c.inMonth ? s.calOut : '',
                        c.today ? s.calToday : '',
                        sel ? s.calSelected : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => { if (c.inMonth) setSelDate(c.date!) }}
                    >
                      <div className={s.calCellHead}>
                        <span className={s.calDayNum}>{c.inMonth ? c.date!.getDate() : ''}</span>
                        {c.today
                          ? <span className={s.todayPill}>今天</span>
                          : c.plans.length > 0 && <span className={s.calCnt}>{c.plans.length}</span>}
                      </div>
                      {c.plans.slice(0, 3).map(p => (
                        <div key={p.id} className={s.planItem} title={`${p.articleTitle} · ${PLAN_STATE_LABEL[p.state] ?? p.state}`}>
                          <span className={`${s.dot} ${planDot(p.state)}`} />
                          <span className={s.planT}>{p.articleTitle}</span>
                          <span className={s.planTime}>
                            {new Date(p.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                          </span>
                        </div>
                      ))}
                      {c.plans.length > 3 && (
                        <div className={s.calMore}>还有 {c.plans.length - 3} 条</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {rhythmView === 'acct' && (
            accountLanes.length === 0
              ? <div className={s.calEmpty}>本月没有发布计划。</div>
              : (
                <div className={s.laneWrap}>
                  {accountLanes.map(lane => {
                    const acct = accounts.find(a => a.id === lane.accountId)
                    return (
                      <section key={lane.accountId} className={s.lane}>
                        <div className={s.laneHead}>
                          <span className={s.laneName}>{acct?.displayName ?? '账号已删除'}</span>
                          {acct && <span className={s.lanePlat}>{PLATFORM_LABEL[acct.platform] ?? acct.platform}</span>}
                          {acct && acct.status !== 'active' && (
                            <span className={`${s.pfChip} ${s.pfChipWarn}`}>{ACCOUNT_STATUS_LABEL[acct.status] ?? acct.status}</span>
                          )}
                          <span className={s.laneStat}>
                            <span>本月 {lane.plans.length} 条</span>
                            <span>已发 {lane.stat.done}</span>
                            <span>待发 {lane.stat.pending}</span>
                            <span>待审 {lane.stat.review}</span>
                            {lane.stat.problem > 0 && <span className={s.laneStatBad}>异常 {lane.stat.problem}</span>}
                            {acct && <span>今日 {acct.sentToday ?? 0}/{acct.dailyLimit}</span>}
                            {acct?.cadence && (
                              <span>{acct.periodLabel ?? '本周'} {acct.periodPublished ?? 0}/{acct.cadence.target}</span>
                            )}
                            {lane.slotPlan.needed > 0 && (
                              <span className={s.laneStatAcc}>待排 {lane.slotPlan.needed}</span>
                            )}
                          </span>
                          {acct && lane.slotPlan.needed > 0 && (
                            <button
                              className={s.chipBtn}
                              type="button"
                              disabled={planBusyId === `gen:${lane.accountId}`}
                              title="按本期目标把还差的档期生成成真实计划（只占时段、还没挑文章）"
                              onClick={() => { void genSlots(lane.accountId) }}
                            >
                              {planBusyId === `gen:${lane.accountId}` ? '生成中…' : `生成待排 ${lane.slotPlan.needed} 条`}
                            </button>
                          )}
                          {acct && (
                            <button
                              className={s.chipBtn}
                              type="button"
                              title="用一句话说排期想法（如「这周 5 篇、尽量晚上 9 点」），出整期提案，确认后才写入日程"
                              onClick={() => setChatAcctId(lane.accountId)}
                            >
                              对话规划
                            </button>
                          )}
                        </div>
                        {slotNote?.id === lane.accountId && <div className={s.slotNote}>{slotNote.text}</div>}
                        {lane.plans.length === 0 && lane.slotPlan.slots.length === 0
                          ? <div className={s.laneEmpty}>本月没有计划。</div>
                          : (
                            <div className={s.laneList}>
                              {lane.plans.map(({ p, article }) => (article === undefined ? (
                                /* 待排档期：已占时段、还没挑文章 → 选文章 / 移除 */
                                <div key={p.id} className={s.slotRow}>
                                  <span className={`${s.dot} ${s.calStIdle}`} />
                                  <span className={s.laneWhen}>{fmtPlanWhen(p.scheduledAt)}</span>
                                  <div className={s.dayMain}>
                                    <div className={s.dayT}>{SLOT_TITLE}</div>
                                  </div>
                                  <span className={s.dayState}>待排</span>
                                  <span className={s.rowActs}>
                                    <button
                                      className={s.chipBtn}
                                      type="button"
                                      disabled={planBusyId === p.id}
                                      onClick={() => setFillPlan(p)}
                                    >
                                      选文章
                                    </button>
                                    <button
                                      className={s.chipBtn}
                                      type="button"
                                      disabled={planBusyId === p.id}
                                      title="改时间 / 换文章 / 换账号 / 移除（不走大模型）"
                                      onClick={() => openAdjust(p)}
                                    >
                                      改这条
                                    </button>
                                    <button
                                      className={s.chipBtn}
                                      type="button"
                                      disabled={planBusyId === p.id}
                                      onClick={() => { void removePlan(p) }}
                                    >
                                      移除
                                    </button>
                                  </span>
                                </div>
                              ) : (
                                <div key={p.id} className={s.laneRow}>
                                  <span className={`${s.dot} ${planDot(p.state)}`} />
                                  <span className={s.laneWhen}>{fmtPlanWhen(p.scheduledAt)}</span>
                                  <div className={s.dayMain} onClick={() => onEdit(article)} title="点开编辑这篇草稿">
                                    <div className={s.dayT}>{article.title}</div>
                                  </div>
                                  <span className={s.dayState}>{PLAN_STATE_LABEL[p.state] ?? p.state}</span>
                                  <span className={s.rowActs}>
                                    <button
                                      className={s.chipBtn}
                                      type="button"
                                      disabled={planBusyId === p.id}
                                      title="改时间 / 换账号（不走大模型）"
                                      onClick={() => openAdjust(p)}
                                    >
                                      改这条
                                    </button>
                                  </span>
                                </div>
                              )))}
                              {/* 还没物化的候选时段：只是提示，点上面的「生成待排 N 条」才落成计划 */}
                              {lane.slotPlan.slots.map(ts => (
                                <div key={`slot-${ts}`} className={s.slotRow}>
                                  <span className={`${s.dot} ${s.calStIdle}`} />
                                  <span className={s.laneWhen}>{fmtPlanWhen(ts)}</span>
                                  <div className={s.dayMain}>
                                    <div className={s.dayT}>{SLOT_TITLE}</div>
                                  </div>
                                  <span className={s.dayState}>候选</span>
                                </div>
                              ))}
                            </div>
                          )}
                      </section>
                    )
                  })}
                </div>
              )
          )}
          <div className={s.footNote}>
            ‹ › 翻看历史与未来 · 月历点某天「查看」列出当天全部计划 · 按账号看每个账号的本月排期 · 「通过并发布」后自动落格
          </div>
        </div>
      )}

      {/* ---- 当日详情 capsule ---- */}
      {selDetail !== null && selDate !== null && (
        <div className={s.dayWrap} onClick={() => setSelDate(null)}>
          <div className={s.dayCard} onClick={e => e.stopPropagation()}>
            <div className={s.dayCardHead}>
              <div className={s.dayCardTitle}>
                {selDate.getMonth() + 1} 月 {selDate.getDate()} 日
                <span className={s.dayCardWk}>周{WEEK_LB[(selDate.getDay() + 6) % 7]}</span>
                {selDate.toDateString() === new Date().toDateString() && <span className={s.todayPill}>今天</span>}
              </div>
              <button className={s.dayClose} type="button" onClick={() => setSelDate(null)}>×</button>
            </div>
            {selDetail.length === 0 ? (
              <div className={s.dayEmpty}>这一天没有发布计划。</div>
            ) : (
              <div className={s.dayList}>
                {selDetail.map(({ p, article }) => {
                  return (
                    <div
                      key={p.id}
                      className={s.dayRow}
                      onClick={() => { if (article !== undefined) onEdit(article) }}
                      title={article === undefined ? '待排档期：还没选文章' : '点开编辑这篇草稿'}
                    >
                      <span className={`${s.dot} ${planDot(p.state)}`} />
                      <span className={s.dayTime}>
                        {new Date(p.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                      </span>
                      <div className={s.dayMain}>
                        <div className={s.dayT}>{article?.title ?? SLOT_TITLE}</div>
                        <div className={s.dayMeta}>
                          {PLATFORM_LABEL[p.platform] ?? p.platform}
                          <span>{accounts.find(a => a.id === p.accountId)?.displayName ?? '账号已删除'}</span>
                          <span className={s.dayState}>{PLAN_STATE_LABEL[p.state] ?? p.state}</span>
                        </div>
                      </div>
                      <span className={s.rowActs}>
                        {article === undefined && (
                          <button className={s.chipBtn} type="button" onClick={(e) => { e.stopPropagation(); setFillPlan(p) }}>
                            选文章
                          </button>
                        )}
                        <button
                          className={s.chipBtn}
                          type="button"
                          title="改时间 / 换文章 / 换账号 / 移除（不走大模型）"
                          onClick={(e) => { e.stopPropagation(); openAdjust(p) }}
                        >
                          改这条
                        </button>
                      </span>
                    </div>
                  )
                })}
                <div className={s.dayHint}>点某条可打开编辑器；待排档期点「选文章」把它填成正式计划。</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 发布计划：换账号（平台随账号走）/ 取消发布 / 移除，也可再建一条发到别的平台 */}
      <dialog ref={planDlgRef} className={s.pvDialog} onClick={onPlanDialogClick}>
        {planRow !== null && (
          <section className={s.pdSheet}>
            <header className={s.pdHead}>
              <div className={s.pdTitle}>发布计划</div>
              <div className={s.pdSub}>{planRow.article.title}</div>
            </header>
            <div className={s.pdBody}>
              {planRow.plans.length === 0 && (
                <div className={s.pdEmpty}>这篇文章还没有发布计划，选个账号建一条。</div>
              )}
              {planRow.plans.map(p => {
                const picked = accounts.find(a => a.id === (planDraft[p.id] ?? p.accountId))
                const bound = accounts.find(a => a.id === p.accountId)
                const changed = picked !== undefined && picked.id !== p.accountId
                return (
                  <div key={p.id} className={s.pdRow}>
                    <div className={s.pdRowHead}>
                      <span className={s.pdState}>{PLAN_STATE_LABEL[p.state] ?? p.state}</span>
                      <span className={s.pdTime}>
                        {PLATFORM_LABEL[p.platform] ?? p.platform} · 计划 {new Date(p.scheduledAt).toLocaleString()}
                      </span>
                    </div>
                    <div className={s.pdRowMain}>
                      <select
                        className={s.select}
                        value={planDraft[p.id] ?? p.accountId}
                        disabled={planBusyId === p.id}
                        onChange={e => setPlanDraft(d => ({ ...d, [p.id]: e.target.value }))}
                      >
                        {bound === undefined && <option value={p.accountId}>账号已删除（{p.accountId}）</option>}
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>
                            {a.displayName} · {PLATFORM_LABEL[a.platform] ?? a.platform} · {ACCOUNT_STATUS_LABEL[a.status] ?? a.status}
                          </option>
                        ))}
                      </select>
                      <div className={s.pdActs}>
                        <button
                          className={s.chipBtn}
                          type="button"
                          disabled={!changed || planBusyId === p.id}
                          onClick={() => { void retargetPlan(p, planDraft[p.id] ?? p.accountId) }}
                        >
                          保存
                        </button>
                        <button
                          className={s.chipBtn}
                          type="button"
                          disabled={planBusyId === p.id || p.state === 'skipped'}
                          onClick={() => { void skipPlan(p) }}
                        >
                          取消发布
                        </button>
                        <button
                          className={`${s.chipBtn} ${s.chipBtnDanger}`}
                          type="button"
                          disabled={planBusyId === p.id}
                          onClick={() => { void removePlan(p) }}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                    {changed && (
                      <div className={s.pdNote}>
                        保存后改由「{picked?.displayName}」通过{PLATFORM_LABEL[picked?.platform ?? ''] ?? picked?.platform}发布。
                      </div>
                    )}
                    {!changed && bound !== undefined && bound.status !== 'active' && (
                      <div className={s.pdWarn}>
                        该账号登录态为「{ACCOUNT_STATUS_LABEL[bound.status] ?? bound.status}」，发布前需到「账号管理」重新登录。
                      </div>
                    )}
                  </div>
                )
              })}

              <div className={s.pdRow}>
                <div className={s.pdRowHead}>
                  <span className={s.pdState}>再建一条</span>
                  <span className={s.pdTime}>多平台同时发；只想发一个平台，先把不要的那条取消或移除</span>
                </div>
                <div className={s.pdRowMain}>
                  <select
                    className={s.select}
                    value={newPlanAcct}
                    disabled={planBusyId === 'new'}
                    onChange={e => setNewPlanAcct(e.target.value)}
                  >
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.displayName} · {PLATFORM_LABEL[a.platform] ?? a.platform} · {ACCOUNT_STATUS_LABEL[a.status] ?? a.status}
                      </option>
                    ))}
                  </select>
                  <div className={s.pdActs}>
                    <button
                      className={s.chipBtn}
                      type="button"
                      disabled={newPlanAcct === '' || planBusyId === 'new'}
                      onClick={() => { void addPlan(planRow.article.id, newPlanAcct) }}
                    >
                      创建
                    </button>
                  </div>
                </div>
              </div>

              {accounts.length === 0 && (
                <div className={s.pdNote}>还没有可用账号：先到「账号管理」添加并登录一个账号，再回来建计划。</div>
              )}
            </div>
            <button className={s.rdClose} type="button" title="关闭（Esc）" onClick={() => setPlanRowId(null)}>×</button>
          </section>
        )}
      </dialog>

      {/* 待排档期「选文章」：选完才是一条真正要发的计划（状态按审核总闸重算） */}
      <dialog ref={fillDlgRef} className={s.pvDialog} onClick={onFillDialogClick}>
        {fillPlan !== null && (
          <section className={s.pdSheet}>
            <header className={s.pdHead}>
              <div className={s.pdTitle}>给这条待排档期选一篇文章</div>
              <div className={s.pdSub}>
                {fmtPlanWhen(fillPlan.scheduledAt)} · {PLATFORM_LABEL[fillPlan.platform] ?? fillPlan.platform} ·
                {' '}{accounts.find(a => a.id === fillPlan.accountId)?.displayName ?? '账号已删除'}
              </div>
            </header>
            <div className={s.pdBody}>
              {rows.length === 0 && (
                <div className={s.pdEmpty}>还没有任何文章：先去「选题库」把选题写成文章，再回来填这条档期。</div>
              )}
              {rows.map(r => (
                <div key={r.article.id} className={s.pdRow}>
                  <div className={s.pdRowHead}>
                    <span className={s.pdState}>{STATUS_LABEL[r.article.status] ?? r.article.status}</span>
                    <span className={s.pdTime}>
                      更新 {new Date(r.article.updatedAt).toLocaleString()}
                      {r.plans.length > 0 ? ` · 已有 ${r.plans.length} 条计划` : ''}
                    </span>
                  </div>
                  <div className={s.pdRowMain}>
                    <span className={s.pdPickT} title={r.article.title}>{r.article.title}</span>
                    <div className={s.pdActs}>
                      <button
                        className={s.chipBtn}
                        type="button"
                        disabled={planBusyId === fillPlan.id}
                        onClick={() => { void assignArticle(fillPlan, r.article.id) }}
                      >
                        {planBusyId === fillPlan.id ? '填入中…' : '选这篇'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button className={s.rdClose} type="button" title="关闭（Esc）" onClick={() => setFillPlan(null)}>×</button>
          </section>
        )}
      </dialog>

      {/* 单条计划微调（方案 A）：改时间 / 换文章 / 换账号 / 移除，不走大模型 */}
      <dialog ref={adjustDlgRef} className={s.pvDialog} onClick={onAdjustDialogClick}>
        {adjustPlan !== null && (
          <section className={s.pdSheet}>
            <header className={s.pdHead}>
              <div className={s.pdTitle}>改这条计划</div>
              <div className={s.pdSub}>
                当前 {fmtPlanWhen(adjustPlan.scheduledAt)} · {PLATFORM_LABEL[adjustPlan.platform] ?? adjustPlan.platform} ·
                {' '}{accounts.find(a => a.id === adjustPlan.accountId)?.displayName ?? '账号已删除'}
              </div>
            </header>
            <div className={s.pdBody}>
              <div className={s.adGrid}>
                <label className={s.adField}>
                  <span className={s.adLbl}>发布时间</span>
                  <input
                    className={s.input}
                    type="datetime-local"
                    value={adjustAt}
                    disabled={planBusyId === adjustPlan.id}
                    onChange={e => setAdjustAt(e.target.value)}
                  />
                </label>
                <label className={s.adField}>
                  <span className={s.adLbl}>文章（留空 = 变回待排档期）</span>
                  <select
                    className={s.select}
                    value={adjustArticleId}
                    disabled={planBusyId === adjustPlan.id}
                    onChange={e => setAdjustArticleId(e.target.value)}
                  >
                    <option value="">（不指定文章 · 待排）</option>
                    {adjustArticleId !== '' && !rows.some(r => r.article.id === adjustArticleId) && (
                      <option value={adjustArticleId}>原文章已删除</option>
                    )}
                    {rows.map(r => (
                      <option key={r.article.id} value={r.article.id}>{r.article.title}</option>
                    ))}
                  </select>
                </label>
                <label className={s.adField}>
                  <span className={s.adLbl}>发布账号（平台随账号走）</span>
                  <select
                    className={s.select}
                    value={adjustAcctId}
                    disabled={planBusyId === adjustPlan.id}
                    onChange={e => setAdjustAcctId(e.target.value)}
                  >
                    {adjustAcctId !== '' && accounts.find(a => a.id === adjustAcctId) === undefined && (
                      <option value={adjustAcctId}>账号已删除（{adjustAcctId}）</option>
                    )}
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.displayName} · {PLATFORM_LABEL[a.platform] ?? a.platform} · {ACCOUNT_STATUS_LABEL[a.status] ?? a.status}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {adjustArticleId === '' && (
                <div className={s.pdNote}>不指定文章 = 变回「待排档期」：占了时段但还没选文章，可在发布节奏里再填。</div>
              )}
              <div className={s.pdRowMain}>
                <div className={s.pdActs}>
                  <button
                    className={`${s.chipBtn} ${s.chipBtnDanger}`}
                    type="button"
                    disabled={planBusyId === adjustPlan.id}
                    onClick={() => { const p = adjustPlan; setAdjustPlan(null); void removePlan(p) }}
                  >
                    移除这条
                  </button>
                  <button
                    className={s.btnPrimary}
                    type="button"
                    disabled={planBusyId === adjustPlan.id}
                    onClick={() => { void saveAdjust() }}
                  >
                    {planBusyId === adjustPlan.id ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
            </div>
            <button className={s.rdClose} type="button" title="关闭（Esc）" onClick={() => setAdjustPlan(null)}>×</button>
          </section>
        )}
      </dialog>

      {/* 对话规划（方案 B）：一句话出整期提案，确认后才落库 */}
      <dialog ref={chatDlgRef} className={s.pvDialog} onClick={onChatDialogClick}>
        {chatAcctId !== null && (
          <section className={s.pdSheet}>
            <header className={s.pdHead}>
              <div className={s.pdTitle}>对话规划</div>
              <div className={s.pdSub}>
                {accounts.find(a => a.id === chatAcctId)?.displayName ?? '账号已删除'} ·
                {' '}说一句排期想法，出整期提案，确认后才会写入日程
              </div>
            </header>
            <div className={s.pdBody}>
              {(() => {
                const acct = accounts.find(a => a.id === chatAcctId)
                return acct === undefined
                  ? <div className={s.pdEmpty}>账号已删除，无法规划。</div>
                  : <PlanChat account={acct} onApplied={load} />
              })()}
            </div>
            <button className={s.rdClose} type="button" title="关闭（Esc）" onClick={() => setChatAcctId(null)}>×</button>
          </section>
        )}
      </dialog>

      {/* 文章预览：阅读态浮层（原生 dialog 模态层），正文走与发布同一套 mdToHtml 渲染 */}
      <dialog ref={readDlgRef} className={s.pvDialog} onClick={onReadDialogClick}>
        {readRow !== null && (
          <article className={s.rdSheet}>
            <header className={s.rdHead}>
              <div className={s.rdTitle}>{readRow.article.title}</div>
              <div className={s.rdChips}>
                <span className={STATUS_BADGE[readRow.article.status] ?? `${s.badge} ${s.badgeNeutral}`}>
                  {STATUS_LABEL[readRow.article.status] ?? readRow.article.status}
                </span>
                {platformChips(readRow, accounts).map(c => (
                  <span key={c.key} className={c.cls} title={c.title}>{c.label}</span>
                ))}
                <span className={s.rdDate}>{new Date(readRow.article.updatedAt).toLocaleString()} 更新</span>
              </div>
            </header>
            <div
              className={s.rdBody}
              dangerouslySetInnerHTML={{
                __html: mdToHtml(readRow.article.bodyMd || readRow.article.title),
              }}
            />
            <button className={s.rdClose} type="button" title="关闭（Esc）" onClick={() => setReadRow(null)}>×</button>
          </article>
        )}
      </dialog>

      {/* 素材预览：全窗 lightbox（原生 dialog 模态层）；图片滚轮/按钮/双击缩放，放大后可拖拽平移 */}
      <dialog ref={dlgRef} className={s.pvDialog} onClick={onDialogClick}>
        <div
          ref={stageRef}
          className={`${s.pvStage} ${zoom > 1 ? s.pvStageZoomed : ''} ${dragging ? s.pvStageDragging : ''}`}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
          onDoubleClick={toggleZoom}
        >
          {preview && (isVideoFile(preview.filename)
            ? <video
                className={s.pvMedia}
                src={preview.url}
                controls
                autoPlay
                loop
                playsInline
                style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`, transition: dragging ? 'none' : 'transform 0.18s ease' }}
              />
            : <img
                className={s.pvMedia}
                src={preview.url}
                alt={preview.filename}
                draggable={false}
                style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`, transition: dragging ? 'none' : 'transform 0.18s ease' }}
              />)}
        </div>
        <div className={s.pvBar}>
          {preview && (
            <span className={s.pvBarText}>
              <span className={s.pvName}>{preview.articleTitle || preview.filename}</span>
              <span className={s.pvMeta}>{preview.filename} · {fmtBytes(preview.bytes)}</span>
            </span>
          )}
          <span className={s.pvDivider} />
          <button className={s.pvBtn} type="button" title="缩小" disabled={zoom <= 0.5} onClick={() => zoomBy(1 / 1.4)}>−</button>
          <button className={s.pvPct} type="button" title="恢复适应窗口（双击图片同效）" onClick={resetZoom}>{Math.round(zoom * 100)}%</button>
          <button className={s.pvBtn} type="button" title="放大" disabled={zoom >= 5} onClick={() => zoomBy(1.4)}>＋</button>
          <span className={s.pvDivider} />
          <button className={s.pvBtn} type="button" title="关闭（Esc）" onClick={() => setPreview(null)}>×</button>
        </div>
      </dialog>
    </div>
  )
}
