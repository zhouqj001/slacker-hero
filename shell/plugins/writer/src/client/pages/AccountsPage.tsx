/**
 * 账号页：番茄多账号管理。
 * 添加账号（随即进入扫码登录 SSE 弹窗）、登录态检测、重新登录、移除、
 * 按账号配额台账总览、关闭全部平台浏览器。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuotaRow, WriterAccount } from '../common.ts'
import {
  ACCOUNT_STATUS_LABEL,
  apiGet,
  apiPost,
  fmtTime,
  fmtWords,
  postSse,
  frameStr,
  s,
} from '../common.ts'
import { ConfirmModal, Modal, StatusDot } from '../ui.tsx'

export interface AccountsPageProps {
  accounts: WriterAccount[]
  reload: () => void
  showToast: (msg: string, err?: boolean) => void
}

/** 扫码登录进行态（SSE stage 消息累积展示）。 */
interface LoginRun {
  accountId: string
  name: string
  stages: string[]
  err: string | null
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function AccountsPage({ accounts, reload, showToast }: AccountsPageProps): JSX.Element {
  const [login, setLogin] = useState<LoginRun | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [checking, setChecking] = useState<string | null>(null)
  const [rmAcc, setRmAcc] = useState<WriterAccount | null>(null)
  const [rmBusy, setRmBusy] = useState(false)
  const [quotaRows, setQuotaRows] = useState<QuotaRow[]>([])
  const [closeBusy, setCloseBusy] = useState(false)
  const [profile, setProfile] = useState<string | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const loginAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    void apiGet<{ accounts: QuotaRow[] }>('/api/writer/quota')
      .then(r => { if (alive) setQuotaRows(r.accounts) })
      .catch(() => {})
    void apiGet<{ authorProfile: string }>('/api/writer/profile')
      .then(r => { if (alive) setProfile(r.authorProfile) })
      .catch(() => { if (alive) setProfile('') })
    return () => { alive = false }
  }, [accounts])

  const saveProfile = useCallback(async () => {
    setProfileBusy(true)
    try {
      await apiPost('/api/writer/profile', { authorProfile: profile ?? '' })
      showToast('作者档案已保存，逐章生成即刻生效')
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setProfileBusy(false)
    }
  }, [profile, showToast])

  useEffect(() => () => loginAbort.current?.abort(), [])

  const runLogin = useCallback((acc: WriterAccount) => {
    loginAbort.current?.abort()
    const ctrl = new AbortController()
    loginAbort.current = ctrl
    void postSse('/api/writer/fanqie/login', { accountId: acc.id }, frame => {
      if (frame['type'] === 'stage') {
        const msg = frameStr(frame, 'message')
        if (msg) setLogin(prev => (prev && prev.accountId === acc.id ? { ...prev, stages: [...prev.stages, msg] } : prev))
        return false
      }
      if (frame['type'] === 'done') {
        setLogin(null)
        showToast(`账号「${acc.name}」登录成功`)
        reload()
        return true
      }
      if (frame['type'] === 'error') {
        const msg = frameStr(frame, 'message') || '登录失败'
        setLogin(prev => (prev && prev.accountId === acc.id ? { ...prev, err: msg } : prev))
        return true
      }
      return false
    }, ctrl.signal).catch(err => {
      if (!ctrl.signal.aborted) {
        setLogin(prev => (prev && prev.accountId === acc.id ? { ...prev, err: errMsg(err) } : prev))
      }
    })
  }, [reload, showToast])

  const addAndLogin = useCallback(async () => {
    setAddBusy(true)
    try {
      const acc = await apiPost<WriterAccount>('/api/writer/accounts', {})
      setLogin({ accountId: acc.id, name: acc.name, stages: [], err: null })
      runLogin(acc)
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setAddBusy(false)
    }
  }, [runLogin, showToast])

  const checkLogin = useCallback(async (acc: WriterAccount) => {
    setChecking(acc.id)
    try {
      const r = await apiGet<{ loggedIn: boolean }>(`/api/writer/fanqie/login-status?accountId=${encodeURIComponent(acc.id)}`)
      showToast(r.loggedIn ? `「${acc.name}」登录有效` : `「${acc.name}」登录已过期，请重新扫码`)
      reload()
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setChecking(null)
    }
  }, [reload, showToast])

  const doRemove = useCallback(async () => {
    if (!rmAcc) return
    setRmBusy(true)
    try {
      await apiPost('/api/writer/accounts/remove', { accountId: rmAcc.id })
      setRmAcc(null)
      showToast(`账号「${rmAcc.name}」已移除`)
      reload()
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setRmBusy(false)
    }
  }, [reload, rmAcc, showToast])

  const closeAll = useCallback(async () => {
    setCloseBusy(true)
    try {
      await apiPost('/api/writer/browser/close-all', {})
      showToast('已关闭全部平台浏览器窗口')
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setCloseBusy(false)
    }
  }, [showToast])

  return (
    <div className={s.col}>
      <div className={s.row}>
        <span className={s.muted}>番茄小说创作平台账号；每账号独立浏览器登录态与发布额度。</span>
        <span className={s.spacer} />
        <button className={s.btnGhost} onClick={() => void closeAll()} disabled={closeBusy}>关闭全部浏览器</button>
        <button className={s.btnPrimary} onClick={() => void addAndLogin()} disabled={addBusy || login != null}>添加账号</button>
      </div>

      <div className={s.list}>
        {accounts.length === 0 && <div className={s.hint}>还没有账号。点「添加账号」扫码登录番茄创作平台。</div>}
        {accounts.map(acc => (
          <div key={acc.id} className={s.card}>
            <div className={s.row}>
              <StatusDot status={acc.status} />
              <strong>{acc.name}</strong>
              <span className={`${s.tag} ${acc.status === 'active' ? s.tagOk : acc.status === 'expired' ? s.tagWarn : ''}`}>
                {ACCOUNT_STATUS_LABEL[acc.status] ?? acc.status}
              </span>
              {acc.fanqieUserId && <span className={s.tiny}>ID {acc.fanqieUserId}</span>}
              <span className={s.spacer} />
              <span className={s.tiny}>上次检测 {fmtTime(acc.lastLoginCheckAt)}</span>
              <button className={s.btnSm} onClick={() => void checkLogin(acc)} disabled={checking === acc.id}>
                {checking === acc.id ? '检测中…' : '检测登录'}
              </button>
              <button className={s.btnSm} onClick={() => {
                setLogin({ accountId: acc.id, name: acc.name, stages: [], err: null })
                runLogin(acc)
              }} disabled={login != null}>重新登录</button>
              <button className={s.btnSm} onClick={() => setRmAcc(acc)}>移除</button>
            </div>
          </div>
        ))}
      </div>

      <div className={s.card}>
        <div className={s.row}>
          <strong>作者档案</strong>
          <span className={s.tiny}>你自己的写作偏好（口头禅、禁用词、句读习惯…），跨书生效，优先级仅次于文风卡。</span>
          <span className={s.spacer} />
          <button className={s.btnSm} onClick={() => void saveProfile()} disabled={profileBusy || profile == null}>
            {profileBusy ? '保存中…' : '保存档案'}
          </button>
        </div>
        <textarea
          className={s.textarea}
          rows={5}
          value={profile ?? ''}
          placeholder={'例：多用反问句收段；「忽然」「顿时」这种词能删就删；对话里别让人物把情绪说出来，让他们做别的事。'}
          onChange={e => setProfile(e.target.value)}
        />
      </div>

      <div className={s.card}>
        <div className={s.row}>
          <strong>发布额度总览</strong>
          <span className={s.tiny}>「立即发布」按字数记账；存草稿箱不占额度；标记返还后释放。</span>
        </div>
        <table className={s.qtable}>
          <thead>
            <tr>
              <th>账号</th>
              <th>今日已发</th>
              <th>本月已发</th>
              <th>今日更新作品</th>
              <th>日上限</th>
              <th>月上限</th>
            </tr>
          </thead>
          <tbody>
            {quotaRows.length === 0 && (
              <tr><td colSpan={6} className={s.muted}>暂无数据</td></tr>
            )}
            {quotaRows.map(r => (
              <tr key={r.accountId}>
                <td>{r.name}</td>
                <td>{fmtWords(r.usage.dailyWords)}</td>
                <td>{fmtWords(r.usage.monthlyWords)}</td>
                <td>{r.usage.updatedWorksToday.length}</td>
                <td>{fmtWords(r.limits.dailyWordLimit)}</td>
                <td>{fmtWords(r.limits.monthlyWordLimit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {login && (
        <Modal
          title={login.err ? `登录失败：${login.name}` : `扫码登录：${login.name}`}
          width={480}
          onClose={login.err ? () => { loginAbort.current?.abort(); setLogin(null) } : undefined}
        >
          {login.err ? (
            <div className={s.col}>
              <div className={s.errorText}>{login.err}</div>
              <div className={s.tiny}>浏览器窗口已关闭；可关闭本弹窗后点「重新登录」再试。</div>
            </div>
          ) : (
            <div className={s.col}>
              <div className={s.muted}>请用番茄小说 App 扫描浏览器窗口中的二维码完成登录；登录成功后本弹窗自动关闭。</div>
              {login.stages.map((msg, i) => (
                <div key={i} className={s.tiny}>{msg}</div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {rmAcc && (
        <ConfirmModal
          title="移除账号"
          message={`确定移除账号「${rmAcc.name}」？登录态与该账号的发布台账关联将一并失效（已发布内容不受影响）。`}
          confirmText="移除"
          danger
          busy={rmBusy}
          onConfirm={() => void doRemove()}
          onCancel={() => setRmAcc(null)}
        />
      )}
    </div>
  )
}
