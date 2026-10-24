/**
 * 对话式设置共享模块：useNlChat 状态 hook + NlChatView 视图 + NlField 字段行。
 * 表单的替代形态——用户一句话描述，大模型解析出字段生成确认卡，信息不足时反问补全。
 */
import { useRef, useState, type ReactNode } from 'react'
import { apiPostRaw, s } from './common.ts'

export interface NlTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface NlParseData {
  fields: Record<string, unknown> | null
  question: string | null
  reason?: 'OK' | 'NO_LLM' | 'LLM_ERROR' | 'UNPARSABLE'
  /** dsh 会话句柄：首轮建立后原样传回，多轮对话落在同一会话里（否则每轮新建）。 */
  sessionId?: string | null
  baseline?: number
}

export type NlChatKind = 'account' | 'persona' | 'review'

export interface NlChat<F> {
  turns: NlTurn[]
  busy: boolean
  input: string
  setInput: (v: string) => void
  /** 累积的待确认字段（每轮解析结果浅合并，对象值深一层合并） */
  pending: Partial<F>
  setPending: (p: Partial<F>) => void
  clearPending: () => void
  send: (text: string, extra?: Record<string, unknown>) => Promise<void>
  reset: () => void
  say: (text: string) => void
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

function mergeFields(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(next)) {
    const old = out[k]
    out[k] = isPlainObj(v) && isPlainObj(old) ? { ...old, ...v } : v
  }
  return out
}

export function useNlChat<F>(kind: NlChatKind): NlChat<F> {
  const [turns, setTurns] = useState<NlTurn[]>([])
  const [pending, setPending] = useState<Partial<F>>({})
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  /** 会话句柄：首轮建立后每轮传回服务端，多轮对话始终落在同一个 dsh 会话里。 */
  const session = useRef<{ sessionId: string | null; baseline: number }>({ sessionId: null, baseline: 0 })

  const send = async (text: string, extra: Record<string, unknown> = {}): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setInput('')
    const base: NlTurn[] = [...turns, { role: 'user', text: trimmed }]
    setTurns(base)
    setBusy(true)
    try {
      // apiPostRaw：失败响应也要能拿到会话句柄，下一轮继续在同一会话里说
      const res = await apiPostRaw<NlParseData>('/api/media/nl/parse', {
        kind, text: trimmed, history: turns.slice(-8),
        sessionId: session.current.sessionId ?? undefined,
        baseline: session.current.baseline,
        ...extra,
      })
      if (!res.ok) throw new Error(res.message ?? '请求失败')
      const data: NlParseData = res.data ?? { fields: null, question: null, reason: 'LLM_ERROR' }
      if (data.sessionId) session.current = { sessionId: data.sessionId, baseline: data.baseline ?? 0 }
      const fields = data.fields
      if (fields) setPending(prev => mergeFields(prev as Record<string, unknown>, fields) as Partial<F>)
      if (data.question) {
        setTurns([...base, { role: 'assistant', text: data.question }])
      } else if (fields) {
        setTurns([...base, { role: 'assistant', text: '解析好了，确认一下就能保存。' }])
      } else {
        const why =
          data.reason === 'NO_LLM' ? '当前没有可用的大模型，先去设置里配置 API Key 吧。'
          : data.reason === 'LLM_ERROR' ? '大模型这会儿不太对劲，再试一次？'
          : '没太看懂，换个说法描述试试？'
        setTurns([...base, { role: 'assistant', text: why }])
      }
    } catch (e) {
      setTurns([...base, { role: 'assistant', text: `出错了：${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      setBusy(false)
    }
  }

  const reset = (): void => {
    setTurns([])
    setPending({})
    setBusy(false)
    setInput('')
    session.current = { sessionId: null, baseline: 0 }
  }
  const say = (text: string): void => { setTurns(t => [...t, { role: 'assistant', text }]) }

  return { turns, busy, input, setInput, pending, setPending, clearPending: () => setPending({}), send, reset, say }
}

/** 确认卡里的字段行：灰键 + 实值。 */
export function NlField(props: { k: string; v: ReactNode }): JSX.Element {
  return (
    <div className={s.nlField}>
      <span className={s.nlFieldKey}>{props.k}</span>
      <span className={s.nlFieldValue}>{props.v}</span>
    </div>
  )
}

export function NlChatView(props: {
  turns: NlTurn[]
  busy: boolean
  input: string
  setInput: (v: string) => void
  onSend: () => void
  placeholder: string
  emptyHint: string
  /** 确认卡，渲染在气泡流末尾 */
  children?: ReactNode
}): JSX.Element {
  const hasContent = props.turns.length > 0 || props.busy
  return (
    <div className={s.nlWrap}>
      {hasContent || props.children ? (
        <div className={s.nlStream}>
          {props.turns.map((t, i) => (
            <div key={i} className={`${s.nlTurn} ${t.role === 'user' ? s.nlUser : s.nlBot}`}>{t.text}</div>
          ))}
          {props.busy && <div className={`${s.nlTurn} ${s.nlBot}`}>解析中…</div>}
          {props.children}
        </div>
      ) : (
        <div className={s.nlEmpty}>{props.emptyHint}</div>
      )}
      <div className={s.composer}>
        <input
          className={s.composerInput}
          value={props.input}
          placeholder={props.placeholder}
          onChange={e => props.setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) props.onSend() }}
        />
        <button className={s.composerSend} type="button" disabled={props.busy || !props.input.trim()} onClick={props.onSend}>
          发送
        </button>
      </div>
    </div>
  )
}
