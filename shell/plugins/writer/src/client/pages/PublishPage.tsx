/**
 * 发布页：绑定平台书 → 逐章发布（存草稿箱 / 立即发布）→ 对账 → 额度台账。
 * 合规红线：逐章人工触发（无批量按钮）、同章已成功发布不覆盖、存草稿箱不占额度。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Chapter, ChapterListItem, FanqieBook, PublishLog, WriterAccount, WriterBook } from '../common.ts'
import {
  ApiError,
  LOG_STATUS_LABEL,
  MODE_LABEL,
  PUBLISH_STATE_LABEL,
  apiGet,
  apiPost,
  fmtTime,
  fmtWords,
  s,
} from '../common.ts'
import { Modal } from '../ui.tsx'

export interface PublishPageProps {
  accounts: WriterAccount[]
  reloadAccounts: () => void
  showToast: (msg: string, err?: boolean) => void
}

/** 额度不足三选一弹窗。 */
interface QuotaAsk {
  chapterNo: number
  message: string
}

/** 可发起发布的章节状态（一期口径：排队中/已提交/已上线不可重复发）。 */
const PUBLISHABLE = new Set(['local', 'draft', 'rejected'])

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function PublishPage({ accounts, reloadAccounts, showToast }: PublishPageProps): JSX.Element {
  const [accountId, setAccountId] = useState('')
  const [quota, setQuota] = useState<{ dailyWords: number; monthlyWords: number; dailyWordLimit: number; monthlyWordLimit: number } | null>(null)
  const [books, setBooks] = useState<WriterBook[]>([])
  const [bookId, setBookId] = useState('')
  const [works, setWorks] = useState<FanqieBook[] | null>(null)
  const [worksBusy, setWorksBusy] = useState(false)
  const [bindSel, setBindSel] = useState('')
  const [chapters, setChapters] = useState<ChapterListItem[]>([])
  const [pubBusy, setPubBusy] = useState<number | null>(null)
  const [quotaAsk, setQuotaAsk] = useState<QuotaAsk | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [logs, setLogs] = useState<PublishLog[]>([])

  const book = books.find(b => b.id === bookId) ?? null

  // 账号列表变化时保持选择合法
  useEffect(() => {
    if (accounts.length === 0) { setAccountId(''); return }
    if (!accounts.some(a => a.id === accountId)) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const reloadQuota = useCallback((aid: string) => {
    if (!aid) { setQuota(null); return }
    void apiGet<{ usage: { dailyWords: number; monthlyWords: number }; limits: { dailyWordLimit: number; monthlyWordLimit: number } }>(
      `/api/writer/quota?accountId=${encodeURIComponent(aid)}`,
    ).then(r => setQuota({ ...r.usage, ...r.limits })).catch(() => {})
  }, [])

  const reloadBooks = useCallback((aid: string, keep: string) => {
    if (!aid) { setBooks([]); setBookId(''); return }
    void apiGet<WriterBook[]>(`/api/writer/books?accountId=${encodeURIComponent(aid)}`).then(list => {
      setBooks(list)
      setBookId(prev => (list.some(b => b.id === prev) ? prev : keep !== '' && list.some(b => b.id === keep) ? keep : (list[0]?.id ?? '')))
    }).catch(() => {})
  }, [])

  const reloadChapters = useCallback((bid: string) => {
    if (!bid) { setChapters([]); return }
    void apiGet<ChapterListItem[]>(`/api/writer/chapters?bookId=${encodeURIComponent(bid)}`)
      .then(setChapters)
      .catch(() => {})
  }, [])

  useEffect(() => {
    reloadQuota(accountId)
    reloadBooks(accountId, '')
    setWorks(null)
    setBindSel('')
  }, [accountId, reloadBooks, reloadQuota])

  useEffect(() => {
    reloadChapters(bookId)
  }, [bookId, reloadChapters])

  const loadWorks = useCallback(async () => {
    setWorksBusy(true)
    try {
      const list = await apiGet<FanqieBook[]>(`/api/writer/fanqie/works?accountId=${encodeURIComponent(accountId)}`)
      setWorks(list)
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setWorksBusy(false)
    }
  }, [accountId, showToast])

  const bind = useCallback(async (fanqieBookId: string) => {
    if (!book || fanqieBookId === '') return
    try {
      await apiPost('/api/writer/book/update', { id: book.id, patch: { fanqieBookId } })
      showToast(`《${book.name}》已绑定平台书`)
      reloadBooks(accountId, book.id)
    } catch (err) {
      showToast(errMsg(err), true)
    }
  }, [accountId, book, reloadBooks, showToast])

  const unbind = useCallback(async () => {
    if (!book) return
    try {
      await apiPost('/api/writer/book/update', { id: book.id, patch: { fanqieBookId: '' } })
      showToast(`《${book.name}》已解除绑定`)
      reloadBooks(accountId, book.id)
    } catch (err) {
      showToast(errMsg(err), true)
    }
  }, [accountId, book, reloadBooks, showToast])

  const publish = useCallback(async (no: number, mode: 'draft' | 'now', force?: boolean) => {
    if (!book) return
    setPubBusy(no)
    try {
      const r = await apiPost<{ chapter: Chapter; log: PublishLog }>('/api/writer/fanqie/publish', {
        accountId, bookId: book.id, chapterNo: no, mode, force,
      })
      setLogs(prev => [r.log, ...prev])
      showToast(mode === 'draft' ? `第 ${no} 章已存入平台草稿箱` : `第 ${no} 章已提交发布，等待平台上线`)
      reloadChapters(book.id)
      reloadQuota(accountId)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUOTA_EXCEEDED') {
        setQuotaAsk({ chapterNo: no, message: err.message })
      } else if (err instanceof ApiError && err.code === 'QUALITY_GATE') {
        const quality = err.extra['quality'] as { issues?: { level: string; message: string }[] } | undefined
        const blocks = (quality?.issues ?? []).filter(i => i.level === 'block').map(i => i.message).join('；')
        showToast(`第 ${no} 章未过质量闸：${blocks || err.message}（请到作品编辑器处理）`, true)
      } else if (err instanceof ApiError && err.code === 'DUPLICATE_SUBMIT') {
        showToast(`第 ${no} 章：${err.message}`, true)
      } else {
        showToast(`第 ${no} 章发布失败：${errMsg(err)}（失败已记录台账，可直接重试）`, true)
      }
    } finally {
      setPubBusy(null)
    }
  }, [accountId, book, reloadChapters, reloadQuota, showToast])

  const sync = useCallback(async () => {
    if (!book) return
    setSyncBusy(true)
    try {
      const r = await apiPost<{ updated: Chapter[]; remoteCount: number }>('/api/writer/fanqie/sync', { accountId, bookId: book.id })
      showToast(`对账完成：${r.updated.length} 章标记为已上线（平台共 ${r.remoteCount} 章）`)
      reloadChapters(book.id)
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setSyncBusy(false)
    }
  }, [accountId, book, reloadChapters, showToast])

  const refund = useCallback(async (log: PublishLog) => {
    try {
      await apiPost('/api/writer/quota/refund', { logId: log.id })
      setLogs(prev => prev.map(l => (l.id === log.id ? { ...l, status: 'refunded' } : l)))
      showToast(`第 ${log.chapterNo} 章已标记返还，额度已释放`)
      reloadQuota(accountId)
    } catch (err) {
      showToast(errMsg(err), true)
    }
  }, [accountId, reloadQuota, showToast])

  if (accounts.length === 0) {
    return <div className={s.hint}>还没有番茄账号。请先到「账号」页添加并扫码登录。</div>
  }

  const boundName = book?.fanqieBookId ? (works?.find(w => w.bookId === book.fanqieBookId)?.name ?? book.fanqieBookId) : null

  return (
    <div className={s.col}>
      <div className={s.hint}>
        合规提示：逐章人工确认发布，无批量操作；同章已成功发布的内容不会被覆盖；「存草稿箱」不占用发布额度；平台审核结果以对账为准。
      </div>

      <div className={s.row}>
        <span className={s.muted}>账号</span>
        <select className={s.select} value={accountId} onChange={e => setAccountId(e.target.value)} style={{ width: 180 }}>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {quota && (
          <span className={s.tiny}>
            今日 {fmtWords(quota.dailyWords)}/{fmtWords(quota.dailyWordLimit)} · 本月 {fmtWords(quota.monthlyWords)}/{fmtWords(quota.monthlyWordLimit)}
          </span>
        )}
        <span className={s.spacer} />
      </div>

      <div className={s.row}>
        <span className={s.muted}>作品</span>
        <select className={s.select} value={bookId} onChange={e => setBookId(e.target.value)} style={{ width: 260 }}>
          {books.length === 0 && <option value="">（该账号还没有作品）</option>}
          {books.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {book && <button className={s.btnSm} onClick={() => void sync()} disabled={syncBusy || !book.fanqieBookId}>
          {syncBusy ? '对账中…' : '对账'}
        </button>}
      </div>

      {book && (
        <div className={s.bindBox}>
          {book.fanqieBookId ? (
            <div className={s.row}>
              <span className={`${s.tag} ${s.tagOk}`}>已绑定</span>
              <span className={s.ellipsis} style={{ maxWidth: 320 }}>平台书：{boundName}</span>
              <span className={s.spacer} />
              <button className={s.btnSm} onClick={() => void unbind()}>解绑</button>
            </div>
          ) : (
            <div className={s.col}>
              <div className={s.row}>
                <span className={`${s.tag} ${s.tagWarn}`}>未绑定</span>
                <span className={s.tiny}>发布前需把作品绑定到平台书（一部作品对应一个平台书）。</span>
                <span className={s.spacer} />
                <button className={s.btnSm} onClick={() => void loadWorks()} disabled={worksBusy}>
                  {worksBusy ? '拉取中…' : '拉取平台书单'}
                </button>
              </div>
              {works && (
                <div className={s.row}>
                  <select className={s.select} value={bindSel} onChange={e => setBindSel(e.target.value)} style={{ width: 320 }}>
                    <option value="">选择平台书…</option>
                    {works.map(w => (
                      <option key={w.bookId} value={w.bookId}>{w.name}（{fmtWords(w.wordNumber)}）</option>
                    ))}
                  </select>
                  <button className={s.btnPrimary} disabled={bindSel === ''} onClick={() => void bind(bindSel)}>绑定</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {bookId !== '' && (
        <table className={s.qtable}>
          <thead>
            <tr>
              <th style={{ width: 56 }}>章</th>
              <th>标题</th>
              <th style={{ width: 90 }}>字数</th>
              <th style={{ width: 90 }}>状态</th>
              <th style={{ width: 200 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {chapters.length === 0 && (
              <tr><td colSpan={5} className={s.muted}>还没有章节，先到作品工作台生成</td></tr>
            )}
            {chapters.map(c => {
              const canPub = c.words > 0 && PUBLISHABLE.has(c.publishState)
              return (
                <tr key={c.id}>
                  <td>{c.no}</td>
                  <td className={s.ellipsis} style={{ maxWidth: 280 }}>{c.title}</td>
                  <td>{c.words > 0 ? fmtWords(c.words) : '—'}</td>
                  <td>
                    <span className={`${s.tag} ${c.publishState === 'live' ? s.tagOk : c.publishState === 'rejected' ? s.tagDanger : c.publishState === 'submitted' || c.publishState === 'queued' ? s.tagInfo : c.publishState === 'draft' ? s.tagWarn : ''}`}>
                      {PUBLISH_STATE_LABEL[c.publishState] ?? c.publishState}
                    </span>
                  </td>
                  <td>
                    {canPub ? (
                      <span className={s.rowWrap}>
                        <button className={s.btnSm} disabled={pubBusy != null} onClick={() => void publish(c.no, 'draft')}>存草稿</button>
                        <button className={s.btnSm} disabled={pubBusy != null} onClick={() => void publish(c.no, 'now')}>立即发布</button>
                      </span>
                    ) : c.publishState === 'submitted' ? (
                      <span className={s.tiny}>已提交，等待平台审核（可对账）</span>
                    ) : c.publishState === 'queued' ? (
                      <span className={s.tiny}>排队中</span>
                    ) : c.publishState === 'live' ? (
                      <span className={s.tiny}>已上线</span>
                    ) : (
                      <span className={s.tiny}>无正文，不可发布</span>
                    )}
                    {pubBusy === c.no && <span className={s.tiny}> 发布中…</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {logs.length > 0 && (
        <div className={s.card}>
          <div className={s.row}>
            <strong>本次会话发布记录</strong>
            <span className={s.tiny}>仅展示本次打开期间的操作；「立即发布」成功后可标记返还以释放额度。</span>
          </div>
          <div className={s.list}>
            {logs.map(l => (
              <div key={l.id} className={s.logItem}>
                <div className={s.row}>
                  <span>第 {l.chapterNo} 章 · {MODE_LABEL[l.mode] ?? l.mode} · {fmtWords(l.words)}</span>
                  <span className={`${s.tag} ${l.status === 'success' ? s.tagOk : l.status === 'failed' ? s.tagDanger : s.tagInfo}`}>
                    {LOG_STATUS_LABEL[l.status] ?? l.status}
                  </span>
                  <span className={s.tiny}>{fmtTime(l.ts)}</span>
                  {l.error && <span className={s.tiny} style={{ color: 'var(--w-danger)' }}>{l.error}</span>}
                  <span className={s.spacer} />
                  {l.mode === 'now' && l.status === 'success' && (
                    <button className={s.btnSm} onClick={() => void refund(l)}>标记返还</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {quotaAsk && (
        <Modal
          title="今日发布额度不足"
          width={480}
          footer={
            <>
              <button className={s.btn} onClick={() => setQuotaAsk(null)}>取消</button>
              <button className={s.btn} onClick={() => { const no = quotaAsk.chapterNo; setQuotaAsk(null); void publish(no, 'draft') }}>改存草稿箱</button>
              <button className={s.btnDanger} onClick={() => { const no = quotaAsk.chapterNo; setQuotaAsk(null); void publish(no, 'now', true) }}>仍要发布</button>
            </>
          }
        >
          <div className={s.modalMsg}>{quotaAsk.message}</div>
          <div className={s.tiny} style={{ marginTop: 8 }}>
            改存草稿箱不占用发布额度，稍后可在平台手动定时；强制发布将照常记账并可能超出当日额度。
          </div>
        </Modal>
      )}
    </div>
  )
}
