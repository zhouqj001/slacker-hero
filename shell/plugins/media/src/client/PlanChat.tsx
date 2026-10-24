/**
 * 发布计划「对话规划」（方案 B 主路径）：整期提案 + 多轮改同一份提案。
 *
 * 用户说人话（「这周想发 5 篇、尽量晚上 9 点、周四那条别动」），服务端结合真实数据出一份
 * 整期提案（周期/目标/偏好时段 + 新增/保留/移除三栏）；继续说「太多，改 3 篇」→ 提案重算；
 * 点「确认排入日程」才原子落库。**对话本身不写库**——只有 apply 才动数据。
 * 无 LLM / 提案不合规时服务端明确报错，这里如实展示并提示改用「改这条」表单微调（方案 A 兜底）。
 */
import { useRef, useState } from 'react'
import { apiPost, apiPostRaw, fmtSlot, s, type Account } from './common.ts'
import { NlChatView, type NlTurn } from './NlChat.tsx'

/** 提案里的一条已有档期（保留 / 移除共用）。 */
interface ProposalPlanRow {
  id: string
  scheduledAt: number
  title: string | null
}

/** 服务端解析好的整期提案（新增档期已由服务端按目标推算）。 */
export interface PlanChatProposal {
  period: 'week' | 'month'
  periodLabel: string
  target: number
  slots: string[]
  published: number
  keep: ProposalPlanRow[]
  remove: ProposalPlanRow[]
  add: number[]
  shortfall: number
}

/** /plan/chat 响应：提案或明确的失败说明，外加会话句柄（下一轮续用同一会话）。 */
interface PlanChatData {
  reply: string | null
  proposal: PlanChatProposal | null
  fail?: { code: string; message: string }
  sessionId?: string | null
  baseline?: number
}

export function PlanChat(props: {
  account: Account
  /** 应用提案后刷新账号/计划数据。 */
  onApplied: () => Promise<void> | void
  /** 无 LLM / 提案不可用时，提示入口（打开表单式微调）。 */
  onNeedFallback?: () => void
}): JSX.Element {
  const { account, onApplied, onNeedFallback } = props
  const [turns, setTurns] = useState<NlTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const [proposal, setProposal] = useState<PlanChatProposal | null>(null)
  const [applying, setApplying] = useState(false)
  /** 会话句柄：首轮建立后每轮传回服务端，多轮对话始终落在同一个 dsh 会话里。 */
  const session = useRef<{ sessionId: string | null; baseline: number }>({ sessionId: null, baseline: 0 })

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setInput('')
    const base: NlTurn[] = [...turns, { role: 'user', text: trimmed }]
    setTurns(base)
    setBusy(true)
    try {
      const res = await apiPostRaw<PlanChatData>('/api/media/plan/chat', {
        accountId: account.id,
        messages: base,
        sessionId: session.current.sessionId ?? undefined,
        baseline: session.current.baseline,
      })
      if (!res.ok) {
        // 路由级错误（accountId 非法 / 账号不存在 / dsh 会话服务未就绪）
        const code = res.code ?? ''
        const msg = res.message ?? '请求失败'
        const extra = code === 'NO_SESSION'
          ? '（可到「内容管理 → 发布节奏」点每条的「改这条」逐条微调，或用「规划」手动设定目标与时段。）'
          : ''
        setTurns([...base, { role: 'assistant', text: `没排出来：${msg}${extra}` }])
        setProposal(null)
        if (code === 'NO_SESSION') onNeedFallback?.()
        return
      }
      const data = res.data ?? { reply: null, proposal: null }
      // 记住会话句柄（含失败轮），下一轮继续在同一会话里说
      if (data.sessionId) session.current = { sessionId: data.sessionId, baseline: data.baseline ?? 0 }
      if (data.fail) {
        const extra = data.fail.code === 'LLM_UNAVAILABLE' || data.fail.code === 'PROPOSAL_INVALID'
          ? '（可到「内容管理 → 发布节奏」点每条的「改这条」逐条微调，或用「规划」手动设定目标与时段。）'
          : ''
        setTurns([...base, { role: 'assistant', text: `没排出来：${data.fail.message}${extra}` }])
        setProposal(null)
        if (data.fail.code === 'LLM_UNAVAILABLE') onNeedFallback?.()
        return
      }
      const reply = data.reply?.trim() ? data.reply.trim() : '这是调整后的整期提案，确认后写入日程。'
      setTurns([...base, { role: 'assistant', text: reply }])
      setProposal(data.proposal)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setTurns([...base, { role: 'assistant', text: `没排出来：${msg}` }])
      setProposal(null)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (proposal === null || applying) return
    setApplying(true)
    try {
      const res = await apiPost<{ removed: number; created: number; shortfall: number }>(
        '/api/media/plan/apply',
        {
          accountId: account.id,
          period: proposal.period,
          target: proposal.target,
          slots: proposal.slots,
          removePlanIds: proposal.remove.map(r => r.id),
        },
      )
      const short = res.shortfall > 0
        ? `；本期剩余时段只够 ${res.created} 个，还差 ${res.shortfall} 个（可加偏好时段或调低目标）`
        : ''
      setTurns(t => [...t, {
        role: 'assistant',
        text: `已排入日程：移除 ${res.removed} 条、新增 ${res.created} 条待排档期。到「发布节奏」点每条的「选文章」填成正式计划${short}`,
      }])
      setProposal(null)
      await onApplied()
    } catch (e) {
      setTurns(t => [...t, { role: 'assistant', text: `落库失败：${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      setApplying(false)
    }
  }

  return (
    <NlChatView
      turns={turns}
      busy={busy}
      input={input}
      setInput={setInput}
      onSend={() => { void send(input) }}
      placeholder="例如：这周想发 5 篇，尽量晚上 9 点发，周四那条别动"
      emptyHint={'说一句你的排期想法，比如「这周 5 篇、尽量晚上 9 点」，我出一份整期提案给你确认。'}
    >
      {proposal !== null && (
        <div className={s.pcCard}>
          <div className={s.pcSummary}>
            <span>{proposal.periodLabel}目标 <b>{proposal.target}</b> 篇</span>
            <span>已发 {proposal.published}</span>
            <span>保留 {proposal.keep.length}</span>
            <span>移除 {proposal.remove.length}</span>
            <span>新增 <b>{proposal.add.length}</b></span>
          </div>
          {proposal.shortfall > 0 && (
            <div className={s.pcWarn}>本期剩余时段排不下目标，还差 {proposal.shortfall} 个（可加偏好时段或调低目标）</div>
          )}
          <div className={s.pcCols}>
            <div className={`${s.pcCol} ${s.pcColAdd}`}>
              <div className={s.pcColHead}>新增档期 <b>{proposal.add.length}</b></div>
              {proposal.add.length === 0
                ? <div className={s.pcEmpty}>无</div>
                : proposal.add.map(ts => <div key={ts} className={s.pcItem}>{fmtSlot(ts)}</div>)}
            </div>
            <div className={s.pcCol}>
              <div className={s.pcColHead}>保留 <b>{proposal.keep.length}</b></div>
              {proposal.keep.length === 0
                ? <div className={s.pcEmpty}>无</div>
                : proposal.keep.map(r => (
                  <div key={r.id} className={s.pcItem}>
                    <span className={s.pcWhen}>{fmtSlot(r.scheduledAt)}</span>
                    <span className={s.pcItemT} title={r.title ?? '待排 · 未选文章'}>{r.title ?? '待排 · 未选文章'}</span>
                  </div>
                ))}
            </div>
            <div className={`${s.pcCol} ${s.pcColRemove}`}>
              <div className={s.pcColHead}>移除 <b>{proposal.remove.length}</b></div>
              {proposal.remove.length === 0
                ? <div className={s.pcEmpty}>无</div>
                : proposal.remove.map(r => <div key={r.id} className={s.pcItem}>{fmtSlot(r.scheduledAt)}</div>)}
            </div>
          </div>
          <div className={s.pcActs}>
            <span className={s.pcHint}>偏离的地方继续说一句改，满意了再确认。</span>
            <button className={s.btnPrimary} type="button" disabled={applying} onClick={() => { void apply() }}>
              {applying ? '写入中…' : '确认排入日程'}
            </button>
          </div>
        </div>
      )}
    </NlChatView>
  )
}
