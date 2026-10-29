/**
 * 作品工作台：章节写作 / 大纲 / 设定 / 记忆 四页签。
 * 章节写作 = 左章纲列表 + 右编辑器（流式生成、保存/快照恢复、定稿回写、删章、质检盒）；
 * 大纲 = 卷/章纲总览 + 续排与开新卷（SSE 提案人工确认）+ 伏笔账；
 * 设定 = 只读（由向导与定稿回写维护）；记忆 = 全局摘要编辑 + 待确认条目逐条入册。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BeatsProposal,
  BookDetail,
  Chapter,
  ChapterListItem,
  ChapterReview,
  PendingRec,
  QualityReport,
  SseFrame,
  WriterAccount,
  WriterLog,
} from '../common.ts'
import {
  BEAT_STATUS_LABEL,
  LOG_STAGE_LABEL,
  PENDING_KIND_LABEL,
  PUBLISH_STATE_LABEL,
  REVIEW_LEVEL_LABEL,
  SETTING_KIND_LABEL,
  apiGet,
  apiPost,
  fmtTime,
  fmtWords,
  frameNum,
  frameObj,
  frameStr,
  postSse,
  s,
} from '../common.ts'
import { ConfirmModal, Modal } from '../ui.tsx'

export interface BookPageProps {
  bookId: string
  accounts: WriterAccount[]
  showToast: (msg: string, err?: boolean) => void
  onBack: () => void
}

type Tab = 'write' | 'outline' | 'settings' | 'memory' | 'logs'

const TAB_META: { id: Tab; label: string }[] = [
  { id: 'write', label: '章节写作' },
  { id: 'outline', label: '大纲' },
  { id: 'settings', label: '设定' },
  { id: 'memory', label: '记忆' },
  { id: 'logs', label: '日志' },
]

/** 章纲续排/开新卷进行态。 */
interface BeatsRun {
  kind: 'more' | 'volume'
  text: string
  err: string | null
}

/** 一键成书批量任务的前端进度态。 */
interface BookRunState {
  target: number
  current: number | null
  generated: number
  skipped: number
  words: number
  failures: number
  message: string
  phase: 'run' | 'done'
  finished: boolean
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function BookPage({ bookId, accounts, showToast, onBack }: BookPageProps): JSX.Element {
  const [detail, setDetail] = useState<BookDetail | null>(null)
  const [chapters, setChapters] = useState<ChapterListItem[]>([])
  const [tab, setTab] = useState<Tab>('write')
  const [loadErr, setLoadErr] = useState('')

  // ── 章节写作 ──
  const [selNo, setSelNo] = useState<number | null>(null)
  const [ch, setCh] = useState<Chapter | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [quality, setQuality] = useState<QualityReport | null>(null)
  const [review, setReview] = useState<ChapterReview | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [gen, setGen] = useState<{ no: number; err: string | null } | null>(null)
  const [finBusy, setFinBusy] = useState(false)
  const [delConfirm, setDelConfirm] = useState(false)
  const [saveBusy, setSaveBusy] = useState(false)
  const chSess = useRef<{ sessionId?: string; baseline?: number }>({})
  const genAbort = useRef<AbortController | null>(null)

  // ── 大纲 ──
  const [beatsRun, setBeatsRun] = useState<BeatsRun | null>(null)
  const [beatsProp, setBeatsProp] = useState<{ proposal: BeatsProposal; kind: 'more' | 'volume' } | null>(null)
  const [beatsBusy, setBeatsBusy] = useState(false)
  const olSess = useRef<{ sessionId?: string; baseline?: number }>({})
  const beatsAbort = useRef<AbortController | null>(null)

  // ── 记忆 ──
  const [memDraft, setMemDraft] = useState('')
  const [memBusy, setMemBusy] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState<string | null>(null)
  const memSess = useRef<{ sessionId?: string; baseline?: number }>({})

  // ── 一键成书 ──
  const [bookTarget, setBookTarget] = useState(100)
  const [bookConfirm, setBookConfirm] = useState(false)
  const [bookRun, setBookRun] = useState<BookRunState | null>(null)
  const bookAbort = useRef<AbortController | null>(null)

  // ── 日志 ──
  const [logs, setLogs] = useState<WriterLog[]>([])
  const logsLoaded = useRef(false)

  const book = detail?.book ?? null
  const account = accounts.find(a => a.id === book?.accountId) ?? null

  const reloadDetail = useCallback(() => {
    void apiGet<BookDetail>(`/api/writer/book?id=${encodeURIComponent(bookId)}`)
      .then(r => {
        setDetail(r)
        setLoadErr('')
      })
      .catch(err => setLoadErr(errMsg(err)))
  }, [bookId])

  const reloadChapters = useCallback(() => {
    void apiGet<ChapterListItem[]>(`/api/writer/chapters?bookId=${encodeURIComponent(bookId)}`)
      .then(setChapters)
      .catch(() => {})
  }, [bookId])

  useEffect(() => {
    reloadDetail()
    reloadChapters()
    return () => {
      genAbort.current?.abort()
      beatsAbort.current?.abort()
      bookAbort.current?.abort()
    }
  }, [reloadChapters, reloadDetail])

  useEffect(() => {
    setMemDraft(book?.memorySummary ?? '')
  }, [book?.memorySummary])

  useEffect(() => {
    if (tab !== 'logs' || logsLoaded.current) return
    logsLoaded.current = true
    void apiGet<{ logs: WriterLog[] }>(`/api/writer/logs?bookId=${encodeURIComponent(bookId)}`)
      .then(d => setLogs(Array.isArray(d.logs) ? d.logs : []))
      .catch(() => { logsLoaded.current = false })
  }, [bookId, tab])

  const beatOf = useCallback((no: number) => book?.outline.beats.find(b => b.no === no) ?? null, [book])
  const chapterMetaOf = useCallback((no: number) => chapters.find(c => c.no === no) ?? null, [chapters])

  /* ── 章节写作 ─────────────────────────────────────────── */

  const openChapter = useCallback((no: number) => {
    if (gen) {
      showToast('正在生成本章，请先停止或等待完成', true)
      return
    }
    setSelNo(no)
    const beat = beatOf(no)
    setTitle(beat?.title ?? `第${no}章`)
    setContent('')
    setQuality(null)
    setReview(null)
    setDirty(false)
    void apiGet<Chapter | null>(`/api/writer/chapter?bookId=${encodeURIComponent(bookId)}&no=${no}`)
      .then(c => {
        setCh(c)
        if (c) {
          setTitle(c.title)
          setContent(c.content)
          const q = c.quality as QualityReport | undefined
          setQuality(q && typeof q.passed === 'boolean' ? q : null)
          setReview(q?.review ?? null)
        }
      })
      .catch(err => showToast(errMsg(err), true))
  }, [beatOf, bookId, gen, showToast])

  const applyChapterResult = useCallback((next: Chapter, q: QualityReport | null) => {
    setCh(next)
    setTitle(next.title)
    setContent(next.content)
    setQuality(q)
    setReview(q?.review ?? null)
    setDirty(false)
  }, [])

  const genChapter = useCallback((no: number) => {
    if (bookRun?.phase === 'run') {
      showToast('一键成书进行中，请先停止批量任务', true)
      return
    }
    if (!beatOf(no)) {
      showToast(`大纲里没有第 ${no} 章的章纲，请先到「大纲」页续排`, true)
      return
    }
    genAbort.current?.abort()
    const ctrl = new AbortController()
    genAbort.current = ctrl
    setSelNo(no)
    setGen({ no, err: null })
    setTitle(beatOf(no)?.title ?? `第${no}章`)
    setContent('')
    setQuality(null)
    setReview(null)
    setDirty(false)
    const sess = chSess.current
    void postSse('/api/writer/generate/chapter', {
      bookId, no, sessionId: sess.sessionId, baseline: sess.baseline,
    }, (frame: SseFrame) => {
      if (frame['type'] === 'session') {
        chSess.current = { sessionId: frameStr(frame, 'sessionId'), baseline: frameNum(frame, 'baseline') }
        return false
      }
      if (frame['type'] === 'text') {
        const t = frameStr(frame, 'text')
        setContent(t)
        return false
      }
      if (frame['type'] === 'done') {
        const chapter = frameObj<Chapter>(frame, 'chapter')
        const q = frameObj<QualityReport>(frame, 'quality') ?? null
        if (chapter) applyChapterResult(chapter, q)
        setGen(null)
        showToast(`第 ${no} 章生成完成${q?.passed ? '，已通过质量闸' : '，请注意下方质检提示'}；确认无误后可「定稿回写」`)
        reloadChapters()
        reloadDetail()
        return true
      }
      if (frame['type'] === 'error') {
        const partial = frame['partial'] === true
        const msg = frameStr(frame, 'message') || '生成失败'
        const action = frameStr(frame, 'action')
        setGen({ no, err: action ? `${msg}（${action}）` : msg })
        if (partial) {
          showToast('本次生成中断，已有部分稿保留在编辑器，可编辑后保存或重新生成', true)
          reloadChapters()
        }
        return true
      }
      return false
    }, ctrl.signal).catch(err => {
      if (!ctrl.signal.aborted) setGen({ no, err: errMsg(err) })
    })
  }, [applyChapterResult, beatOf, bookId, bookRun, reloadChapters, reloadDetail, showToast])

  const stopGen = useCallback(() => {
    genAbort.current?.abort()
    setGen(g => (g ? { ...g, err: '已手动停止；编辑器中为中断前的内容，可编辑后保存' } : g))
  }, [])

  const saveChapter = useCallback(async () => {
    if (selNo == null) return
    setSaveBusy(true)
    try {
      const next = await apiPost<Chapter>('/api/writer/chapter/save', { bookId, no: selNo, title, content })
      setCh(next)
      setDirty(false)
      showToast(`第 ${selNo} 章已保存（${fmtWords(next.words)}）`)
      reloadChapters()
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setSaveBusy(false)
    }
  }, [bookId, content, reloadChapters, selNo, showToast, title])

  const restorePrev = useCallback(() => {
    const snap = ch?.snapshots?.[ch.snapshots.length - 1]
    if (!snap) {
      showToast('没有可恢复的历史版本', true)
      return
    }
    setContent(snap.content)
    setDirty(true)
    showToast('已把上一版填入编辑器；点「保存」才会生效')
  }, [ch, showToast])

  const finalizeChapter = useCallback(async () => {
    if (selNo == null || content.trim() === '') return
    setFinBusy(true)
    try {
      const mem = memSess.current
      const r = await apiPost<{
        pending: PendingRec[]
        fail?: { zh: string; action?: string }
        sessionId: string | null
        baseline: number
      }>('/api/writer/chapter/finalize', {
        bookId, no: selNo, sessionId: mem.sessionId, baseline: mem.baseline,
      })
      memSess.current = { sessionId: r.sessionId ?? undefined, baseline: r.baseline }
      if (r.fail) {
        showToast(`回写失败：${r.fail.zh}${r.fail.action ? `（${r.fail.action}）` : ''}；可稍后重试`, true)
      } else {
        showToast(`第 ${selNo} 章定稿完成，产生 ${r.pending.length} 条待确认记忆，请到「记忆」页逐条确认`)
        reloadDetail()
        reloadChapters()
      }
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setFinBusy(false)
    }
  }, [bookId, content, reloadChapters, reloadDetail, selNo, showToast])

  const deleteChapter = useCallback(async () => {
    if (selNo == null) return
    try {
      await apiPost('/api/writer/chapter/delete', { bookId, no: selNo })
      setDelConfirm(false)
      setCh(null)
      setSelNo(null)
      setContent('')
      setQuality(null)
      setReview(null)
      showToast(`第 ${selNo} 章已删除`)
      reloadChapters()
      reloadDetail()
    } catch (err) {
      showToast(errMsg(err), true)
    }
  }, [bookId, reloadChapters, reloadDetail, selNo, showToast])

  /** 一键成书：批量写到目标章数。后端自动续纲/质检重试/定稿/记忆入册，SSE 只报进度帧。 */
  const startBookRun = useCallback((target: number) => {
    if (gen) {
      showToast('正在生成单章，请先完成或停止', true)
      return
    }
    bookAbort.current?.abort()
    const ctrl = new AbortController()
    bookAbort.current = ctrl
    setBookRun({ target, current: null, generated: 0, skipped: 0, words: 0, failures: 0, message: '正在准备…', phase: 'run', finished: false })
    void postSse('/api/writer/generate/book', { bookId, target }, (frame: SseFrame) => {
      const type = frame['type']
      if (type === 'plan') {
        const t = frameNum(frame, 'target') ?? 100
        setBookRun(r => r ? { ...r, target: t, message: `目标 ${t} 章，已完成 ${frameNum(frame, 'already') ?? 0} 章，接着写…` } : r)
        return false
      }
      if (type === 'beats/start') {
        setBookRun(r => r ? { ...r, message: `章纲不够，正在续排约 ${frameNum(frame, 'count')} 章新章纲…` } : r)
        return false
      }
      if (type === 'beats/done') {
        setBookRun(r => r ? { ...r, message: `章纲已续排 ${frameNum(frame, 'added')} 章` } : r)
        reloadDetail()
        return false
      }
      if (type === 'chapter/skip') {
        const no = frameNum(frame, 'no') ?? 0
        setBookRun(r => r ? { ...r, current: no, skipped: r.skipped + 1, message: `第 ${no} 章已是定稿，跳过` } : r)
        return false
      }
      if (type === 'chapter/start') {
        const no = frameNum(frame, 'no') ?? 0
        setBookRun(r => r ? { ...r, current: no, message: `正在写第 ${no} 章「${frameStr(frame, 'title')}」…` } : r)
        return false
      }
      if (type === 'chapter/retry') {
        const no = frameNum(frame, 'no')
        const reason = frameStr(frame, 'reason')
        const why = reason === 'WORDS_SHORT' ? '字数偏短' : reason === 'HOOK_WEAK' ? '章末钩子偏弱' : reason
        setBookRun(r => r ? { ...r, message: `第 ${no} 章质检未过（${why}），自动重写…` } : r)
        return false
      }
      if (type === 'chapter/done') {
        const no = frameNum(frame, 'no') ?? 0
        const w = frameNum(frame, 'words') ?? 0
        const retried = frameNum(frame, 'retried') ?? 0
        setBookRun(r => r ? {
          ...r,
          generated: r.generated + 1, words: r.words + w,
          message: `第 ${no} 章初稿完成（${fmtWords(w)}${retried > 0 ? `，重写 ${retried} 次` : ''}）`,
        } : r)
        return false
      }
      if (type === 'finalize/start') {
        setBookRun(r => r ? { ...r, message: `第 ${frameNum(frame, 'no')} 章定稿回写并自动入册…` } : r)
        return false
      }
      if (type === 'finalize/fail') {
        setBookRun(r => r ? {
          ...r, failures: r.failures + 1,
          message: `第 ${frameNum(frame, 'no')} 章定稿失败：${frameStr(frame, 'message')}，继续下一章`,
        } : r)
        return false
      }
      if (type === 'finalize/done') {
        setBookRun(r => r ? {
          ...r,
          message: `第 ${frameNum(frame, 'no')} 章已定稿，记忆自动入册 ${frameNum(frame, 'applied')}/${frameNum(frame, 'total')} 条`,
        } : r)
        reloadDetail()
        reloadChapters()
        return false
      }
      if (type === 'error') {
        setBookRun(r => r ? { ...r, message: frameStr(frame, 'message') || '批量生成出错' } : r)
        return false
      }
      if (type === 'done') {
        const aborted = frame['aborted'] === true
        const finished = frame['finished'] === true
        const generated = frameNum(frame, 'generated') ?? 0
        const skipped = frameNum(frame, 'skipped') ?? 0
        const failures = frameNum(frame, 'failures') ?? 0
        setBookRun(r => r ? {
          ...r,
          generated, skipped, failures, words: frameNum(frame, 'words') ?? 0,
          current: null, phase: 'done', finished,
          message: finished
            ? `全书完成！目标 ${frameNum(frame, 'target')} 章已全部定稿${failures > 0 ? `（${failures} 章定稿失败，可单独重试）` : ''}`
            : aborted
              ? `已停止：本轮生成 ${generated} 章、跳过 ${skipped} 章，进度已保存，可随时继续`
              : `本轮结束：生成 ${generated} 章、跳过 ${skipped} 章${failures > 0 ? `，${failures} 章失败` : ''}`,
        } : r)
        reloadDetail()
        reloadChapters()
        return true
      }
      return false
    }, ctrl.signal).catch(err => {
      if (!ctrl.signal.aborted) {
        setBookRun(r => r ? { ...r, phase: 'done', message: `连接中断：${errMsg(err)}` } : r)
      }
    })
  }, [bookId, gen, reloadChapters, reloadDetail, showToast])

  const stopBookRun = useCallback(() => {
    bookAbort.current?.abort()
    setBookRun(r => r ? { ...r, message: '正在停止…（等当前章节收尾）' } : r)
  }, [])

  /** LLM 审稿：合并 AI 味 / 不确定密度 / 连续性，一次同步调用。 */
  const reviewChapter = useCallback(async () => {
    if (selNo == null || content.trim() === '') return
    setReviewBusy(true)
    try {
      const sess = chSess.current
      const r = await apiPost<{
        review?: ChapterReview
        quality?: Record<string, unknown>
        fail?: { zh: string; action?: string }
        sessionId: string | null
        baseline: number
      }>('/api/writer/review', {
        bookId, no: selNo, sessionId: sess.sessionId, baseline: sess.baseline,
      })
      chSess.current = { sessionId: r.sessionId ?? undefined, baseline: r.baseline }
      if (r.fail) {
        showToast(`审稿失败：${r.fail.zh}${r.fail.action ? `（${r.fail.action}）` : ''}；可稍后重试`, true)
        return
      }
      if (!r.review) return
      setReview(r.review)
      // 服务端把审稿结果与（旧稿时铺底的）粗筛报告合并回写了 quality，同步本地
      if (r.quality && typeof (r.quality as { passed?: unknown }).passed === 'boolean') {
        setQuality(r.quality as unknown as QualityReport)
      }
      showToast(r.review.blockCount > 0
        ? `审稿完成：${r.review.blockCount} 条必改、${r.review.warnCount} 条建议`
        : '审稿完成：无必改项')
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setReviewBusy(false)
    }
  }, [bookId, content, selNo, showToast])

  /* ── 大纲 ─────────────────────────────────────────────── */

  const runBeats = useCallback((kind: 'more' | 'volume') => {
    beatsAbort.current?.abort()
    const ctrl = new AbortController()
    beatsAbort.current = ctrl
    setBeatsRun({ kind, text: '', err: null })
    const sess = olSess.current
    void postSse('/api/writer/generate/outline', {
      kind, bookId, sessionId: sess.sessionId, baseline: sess.baseline,
    }, (frame: SseFrame) => {
      if (frame['type'] === 'session') {
        olSess.current = { sessionId: frameStr(frame, 'sessionId'), baseline: frameNum(frame, 'baseline') }
        return false
      }
      if (frame['type'] === 'text') {
        const t = frameStr(frame, 'text')
        setBeatsRun(r => (r ? { ...r, text: t } : r))
        return false
      }
      if (frame['type'] === 'done') {
        const proposal = frameObj<BeatsProposal>(frame, 'proposal')
        if (proposal) {
          setBeatsProp({ proposal, kind })
          setBeatsRun(null)
        } else {
          setBeatsRun(r => (r ? { ...r, err: '提案解析失败，请重试' } : r))
        }
        return true
      }
      if (frame['type'] === 'error') {
        const msg = frameStr(frame, 'message') || '生成失败'
        const action = frameStr(frame, 'action')
        setBeatsRun(r => (r ? { ...r, err: action ? `${msg}（${action}）` : msg } : r))
        return true
      }
      return false
    }, ctrl.signal).catch(err => {
      if (!ctrl.signal.aborted) setBeatsRun({ kind, text: '', err: errMsg(err) })
    })
  }, [bookId])

  const confirmBeats = useCallback(async () => {
    if (!beatsProp || !book) return
    setBeatsBusy(true)
    try {
      await apiPost('/api/writer/book/update', beatsProp.kind === 'volume'
        ? { id: book.id, appendBeats: beatsProp.proposal.beats, newVolume: beatsProp.proposal.volume }
        : { id: book.id, appendBeats: beatsProp.proposal.beats })
      setBeatsProp(null)
      showToast(`已追加 ${beatsProp.proposal.beats.length} 章章纲${beatsProp.kind === 'volume' ? '，新卷已建立' : ''}`)
      reloadDetail()
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setBeatsBusy(false)
    }
  }, [book, beatsProp, reloadDetail, showToast])

  /* ── 记忆 ─────────────────────────────────────────────── */

  const saveMemory = useCallback(async () => {
    if (!book) return
    setMemBusy(true)
    try {
      await apiPost('/api/writer/book/update', { id: book.id, patch: { memorySummary: memDraft } })
      showToast('全局剧情摘要已保存')
      reloadDetail()
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setMemBusy(false)
    }
  }, [book, memDraft, reloadDetail, showToast])

  const confirmPending = useCallback(async (p: PendingRec, approve: boolean) => {
    setConfirmBusy(p.id)
    try {
      await apiPost('/api/writer/memory/confirm', { pendingId: p.id, approve })
      showToast(approve ? '该条记忆已入册' : '已忽略该条')
      reloadDetail()
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setConfirmBusy(null)
    }
  }, [reloadDetail, showToast])

  /* ── 渲染 ─────────────────────────────────────────────── */

  if (loadErr !== '') {
    return (
      <div className={s.page}>
        <div className={s.col}>
          <div className={s.errorText}>{loadErr}</div>
          <button className={s.btn} onClick={onBack} style={{ alignSelf: 'flex-start' }}>返回书架</button>
        </div>
      </div>
    )
  }

  if (!book) {
    return <div className={s.page}><div className={s.muted}>加载中…</div></div>
  }

  // `book` 非 null 即 detail 整体已载入（两者同源同设），TS 推不出这层关系，
  // 断言别名供下方 JSX 使用，避免闭包内丢失收窄。
  const d = detail as BookDetail

  const pendingBeatNo = book.outline.beats.find(b => b.status === 'pending')?.no ?? null
  const bookBusy = bookRun != null && bookRun.phase === 'run'

  /** 待确认条目正文的纯文本渲染。 */
  const pendingBody = (p: PendingRec): string => {
    switch (p.kind) {
      case 'summary':
        return String(p.payload['text'] ?? '')
      case 'state':
        return `${String(p.payload['name'] ?? '')}：${String(p.payload['state'] ?? '')}`
      case 'setting': {
        const kind = SETTING_KIND_LABEL[String(p.payload['kind'] ?? '')] ?? '世界观'
        const tags = Array.isArray(p.payload['tags']) ? (p.payload['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : []
        return `【${kind}】${String(p.payload['name'] ?? '')}：${String(p.payload['summary'] ?? '')}${tags.length > 0 ? `（${tags.join('、')}）` : ''}`
      }
      case 'foreshadow': {
        const pay = typeof p.payload['suggestPayoffAt'] === 'number' ? `（建议第 ${p.payload['suggestPayoffAt']} 章前后回收）` : ''
        return `${String(p.payload['desc'] ?? '')}${pay}`
      }
      case 'knowledge':
        return `${String(p.payload['name'] ?? '')}：知晓「${String(p.payload['fact'] ?? '')}」`
      case 'timeline': {
        const anchors = Array.isArray(p.payload['anchors']) ? p.payload['anchors'] as { scene?: string; start: string; gap: string; duration: string; end: string }[] : []
        if (anchors.length === 0) return '（无有效场景时间锚）'
        const first = anchors[0]!
        const head = first.scene ? `「${first.scene}」止于${first.end}` : `止于${first.end}`
        return `${anchors.length} 个场景时间锚：${head}${anchors.length > 1 ? ' 等' : ''}（确认后覆盖本章时间线）`
      }
    }
  }

  const statusTagCls = (st: string): string =>
    st === 'drafted' ? s.tagInfo : st === 'finalized' ? s.tagOk : ''

  return (
    <>
      <div className={s.topbar}>
        <button className={s.btnGhost} onClick={onBack}>← 书架</button>
        <div className={s.topbarTitle}>{book.name}</div>
        <span className={s.tag}>{book.genre}</span>
        {account && <span className={s.tiny}>{account.name}</span>}
        <span className={s.spacer} />
        {book.fanqieBookId && <span className={`${s.tag} ${s.tagCool}`}>已绑定平台</span>}
      </div>
      <div className={s.page}>
        <div className={s.tabs}>
          {TAB_META.map(t => (
            <button
              key={t.id}
              className={`${s.tab} ${tab === t.id ? s.tabActive : ''}`}
              onClick={() => setTab(t.id)}
            >{t.label}{t.id === 'memory' && d.pending.length > 0 ? `（${d.pending.length}）` : ''}</button>
          ))}
        </div>

        {/* ── 章节写作 ── */}
        {tab === 'write' && (
          <div className={s.work}>
            <div className={s.chPane}>
              <div className={s.row}>
                <button
                  className={s.btnPrimary}
                  disabled={gen != null || bookBusy || pendingBeatNo == null}
                  onClick={() => pendingBeatNo != null && genChapter(pendingBeatNo)}
                >写下一章</button>
              </div>
              <div className={s.row}>
                <input
                  className={`${s.input} ${s.numInput}`}
                  type="number"
                  min={1}
                  max={300}
                  value={bookTarget}
                  disabled={bookBusy}
                  onChange={e => {
                    const n = Math.floor(Number(e.target.value))
                    setBookTarget(Number.isFinite(n) ? Math.min(Math.max(n, 1), 300) : 100)
                  }}
                />
                <span className={s.tiny}>章</span>
                <span className={s.spacer} />
                <button
                  className={s.btnPrimary}
                  disabled={gen != null || bookBusy}
                  onClick={() => setBookConfirm(true)}
                >一键成书</button>
              </div>
              {bookRun && (bookRun.phase === 'run' ? (
                <div className={s.runBox}>
                  <div className={s.row}>
                    <span className={s.genDot} />
                    <span className={`${s.grow} ${s.ellipsis}`}>{bookRun.message}</span>
                  </div>
                  <div className={s.tiny}>
                    进度 第 {bookRun.current ?? '—'}/{bookRun.target} 章 · 生成 {bookRun.generated} · 跳过 {bookRun.skipped} · 累计 {fmtWords(bookRun.words)} · 失败 {bookRun.failures}
                  </div>
                  <div className={s.row}>
                    <span className={s.spacer} />
                    <button className={s.btnSm} onClick={stopBookRun}>停止</button>
                  </div>
                </div>
              ) : (
                <div className={s.runBox}>
                  <div className={bookRun.failures > 0 ? s.errorText : undefined}>{bookRun.message}</div>
                  <div className={s.tiny}>
                    生成 {bookRun.generated} 章 · 跳过 {bookRun.skipped} 章 · 新增 {fmtWords(bookRun.words)} · 失败 {bookRun.failures} 章
                  </div>
                  <div className={s.row}>
                    <span className={s.spacer} />
                    <button className={s.btnSm} onClick={() => setBookRun(null)}>知道了</button>
                  </div>
                </div>
              ))}
              <div className={`${s.chList} ${s.listGrow}`}>
                {book.outline.beats.length === 0 && (
                  <div className={s.hint}>大纲还没有章纲，先到「大纲」页续排。</div>
                )}
                {book.outline.beats.map(b => {
                  const meta = chapterMetaOf(b.no)
                  return (
                    <button
                      key={b.no}
                      className={`${s.chRow} ${selNo === b.no ? s.chRowActive : ''}`}
                      onClick={() => openChapter(b.no)}
                    >
                      <span className={s.chNo}>{b.no}</span>
                      <span className={`${s.grow} ${s.ellipsis}`}>
                        {b.title}
                        {b.isClimax && <span className={`${s.tag} ${s.tagClimax}`}>高潮</span>}
                        {b.isCool && !b.isClimax && <span className={`${s.tag} ${s.tagCool}`}>爽点</span>}
                      </span>
                      <span className={`${s.tag} ${statusTagCls(b.status)}`}>{BEAT_STATUS_LABEL[b.status]}</span>
                      {meta && meta.publishState !== 'local' && (
                        <span className={s.tag}>{PUBLISH_STATE_LABEL[meta.publishState] ?? ''}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className={`${s.editor} ${s.col}`}>
              {gen && !gen.err && (
                <div className={s.genBar}>
                  <span className={s.genDot} />
                  <span className={s.genBarText}>第 {gen.no} 章生成中…（{fmtWords(content.length)}）</span>
                  <button className={s.genBarStop} onClick={stopGen}>停止</button>
                </div>
              )}
              {gen?.err && (
                <div className={s.errBox}>
                  <div className={s.errorText}>{gen.err}</div>
                  <div className={s.tiny}>可关闭此条后重新生成；中断的部分稿仍留在编辑器中。</div>
                  <div className={s.row}>
                    <span className={s.spacer} />
                    <button className={s.btnSm} onClick={() => setGen(null)}>知道了</button>
                    <button className={s.btnPrimary} onClick={() => genChapter(gen.no)}>重新生成</button>
                  </div>
                </div>
              )}
              {selNo == null ? (
                <div className={s.hint}>从左侧选择一章；「待写」的章可直接生成初稿。</div>
              ) : (
                <>
                  <div className={s.row}>
                    <span className={`${s.muted} ${s.chNo}`}>第 {selNo} 章</span>
                    <input
                      className={`${s.input} ${s.titleInput}`}
                      value={title}
                      onChange={e => { setTitle(e.target.value); setDirty(true) }}
                    />
                    <span className={s.wordsBadge}>{fmtWords(content.length)}</span>
                  </div>
                  <textarea
                    className={`${s.textarea} ${s.contentArea}`}
                    value={content}
                    placeholder={beatOf(selNo) ? `本章节拍：${beatOf(selNo)?.beat}\n章末钩子：${beatOf(selNo)?.hook}\n\n点击「写下一章」或右侧按钮生成本章初稿，也可以直接手写。` : '本章还没有章纲，可先手写，或到「大纲」页续排。'}
                    onChange={e => { setContent(e.target.value); setDirty(true) }}
                  />
                  <div className={s.btnBar}>
                    <button
                      className={s.btnPrimary}
                      disabled={gen != null || bookBusy || !beatOf(selNo)}
                      onClick={() => genChapter(selNo)}
                    >{ch && ch.words > 0 ? '重新生成' : '生成本章'}</button>
                    <button className={s.btn} disabled={!dirty || saveBusy} onClick={() => void saveChapter()}>
                      {saveBusy ? '保存中…' : '保存'}
                    </button>
                    <button className={s.btn} disabled={!ch || (ch.snapshots?.length ?? 0) === 0} onClick={restorePrev}>恢复上一版</button>
                    <button
                      className={s.btn}
                      disabled={content.trim() === '' || finBusy || gen != null || bookBusy}
                      onClick={() => void finalizeChapter()}
                    >{finBusy ? '回写中…' : '定稿回写'}</button>
                    <button
                      className={s.btn}
                      disabled={content.trim() === '' || reviewBusy || gen != null || finBusy || bookBusy}
                      onClick={() => void reviewChapter()}
                    >{reviewBusy ? '审稿中…' : 'LLM 审稿'}</button>
                    {ch && ch.publishState === 'local' && (
                      <button className={s.btnDanger} disabled={gen != null || bookBusy} onClick={() => setDelConfirm(true)}>删除本章</button>
                    )}
                    {ch && ch.summaryStale && <span className={`${s.tag} ${s.tagWarn}`}>摘要待更新，建议重新定稿回写</span>}
                  </div>
                  {(quality || review) && (
                    <div className={s.infoPane}>
                      {quality && (
                        <div className={`${s.qualityBox} ${quality.passed ? s.qualityPassed : s.qualityBlocked}`}>
                          <div className={s.row}>
                            <strong>{quality.passed ? '已通过质量闸' : '未通过质量闸'}</strong>
                            <span className={s.muted}>{fmtWords(quality.words)} · {quality.paragraphCount} 段</span>
                            {quality.passed && <span className={s.tiny}>可发布（到「发布」页操作）</span>}
                          </div>
                          {quality.issues.map((iss, i) => (
                            <div
                              key={i}
                              className={`${s.qIssue} ${iss.level === 'block' ? s.issueBlock : iss.level === 'warn' ? s.issueWarn : s.issueInfo}`}
                            >
                              [{iss.level === 'block' ? '阻断' : iss.level === 'warn' ? '提醒' : '提示'}] {iss.message}
                            </div>
                          ))}
                        </div>
                      )}
                      {review && (
                        <div className={s.reviewBox}>
                          <div className={s.row}>
                            <strong>LLM 审稿</strong>
                            <span className={`${s.tag} ${review.blockCount > 0 ? s.tagWarn : s.tagOk}`}>
                              {review.blockCount > 0 ? `${review.blockCount} 必改` : '无必改'}
                            </span>
                            {review.warnCount > 0 && <span className={`${s.tag} ${s.tagWarn}`}>{review.warnCount} 建议</span>}
                            <span className={s.spacer} />
                            <span className={s.tiny}>{fmtTime(review.reviewedAt)}</span>
                          </div>
                          {review.issues.length === 0 && <div className={s.tiny}>未发现问题。</div>}
                          {review.issues.map((iss, i) => (
                            <div
                              key={i}
                              className={`${s.reviewIssue} ${iss.level === 'block' ? s.issueBlock : iss.level === 'warn' ? s.issueWarn : s.issueInfo}`}
                            >
                              <div>[{REVIEW_LEVEL_LABEL[iss.level] ?? iss.level}] {iss.code}：{iss.message}</div>
                              {iss.evidence && <div className={s.reviewEvidence}>原文：「{iss.evidence}」</div>}
                              {iss.suggestion && <div className={s.tiny}>建议：{iss.suggestion}</div>}
                            </div>
                          ))}
                          {review.windows.length > 0 && (
                            <table className={s.qtable}>
                              <thead>
                                <tr>
                                  <th style={{ width: 110 }}>分窗（500字）</th>
                                  <th style={{ width: 90 }}>新信息</th>
                                  <th>备注</th>
                                </tr>
                              </thead>
                              <tbody>
                                {review.windows.map((w, i) => (
                                  <tr key={i}>
                                    <td>{w.window}</td>
                                    <td>
                                      <span className={`${s.tag} ${w.hasNew ? s.tagOk : s.tagWarn}`}>{w.hasNew ? '有' : '无'}</span>
                                    </td>
                                    <td className={s.ellipsis} style={{ maxWidth: 320 }}>{w.note ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {review.hookStrength === 'bad' && (
                            <div className={`${s.qIssue} ${s.issueWarn}`}>章末钩子偏弱：结尾没有留下让人想翻页的问题。</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ── 大纲 ── */}
        {tab === 'outline' && (
          <div className={s.col}>
            <div className={s.row}>
              <button className={s.btnPrimary} disabled={beatsRun != null || beatsProp != null} onClick={() => runBeats('more')}>续排章纲</button>
              <button className={s.btn} disabled={beatsRun != null || beatsProp != null} onClick={() => runBeats('volume')}>开新卷</button>
              <span className={s.tiny}>产出均为提案，需人工确认后才写入大纲。</span>
            </div>

            {book.outline.logline && (
              <div className={s.card}>
                <div className={s.muted}>一句话主纲</div>
                <div>{book.outline.logline}</div>
              </div>
            )}
            {book.outline.coreConflict && (
              <div className={s.card}>
                <div className={s.muted}>核心冲突</div>
                <div>{book.outline.coreConflict}</div>
              </div>
            )}
            {book.outline.volumes.map(v => (
              <div key={v.index} className={s.card}>
                <div className={s.row}>
                  <span className={`${s.tag} ${s.tagInfo}`}>第{v.index}卷</span>
                  <strong>{v.title}</strong>
                </div>
                {v.summary && <div className={s.muted}>{v.summary}</div>}
              </div>
            ))}

            {book.outline.beats.length > 0 && (
              <table className={s.qtable}>
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>章</th>
                    <th style={{ width: 150 }}>标题</th>
                    <th>节拍</th>
                    <th style={{ width: 130 }}>承诺</th>
                    <th style={{ width: 130 }}>不确定</th>
                    <th style={{ width: 70 }}>回收</th>
                    <th style={{ width: 150 }}>章末钩子</th>
                    <th style={{ width: 80 }}>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {book.outline.beats.map(b => (
                    <tr key={b.no}>
                      <td>{b.no}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 150 }}>
                        {b.title}
                        {b.isClimax && <span className={`${s.tag} ${s.tagClimax}`}>高潮</span>}
                        {b.isCool && !b.isClimax && <span className={`${s.tag} ${s.tagCool}`}>爽点</span>}
                      </td>
                      <td className={s.ellipsis} style={{ maxWidth: 320 }}>{b.beat}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 130 }}>{b.promise ?? '—'}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 130 }}>{b.uncertainty ?? '—'}</td>
                      <td>{b.payoffOf != null ? `#${b.payoffOf}` : '—'}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 150 }}>{b.hook}</td>
                      <td><span className={`${s.tag} ${statusTagCls(b.status)}`}>{BEAT_STATUS_LABEL[b.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className={s.card}>
              <div className={s.row}>
                <strong>伏笔账</strong>
                <span className={s.tiny}>定稿回写确认的伏笔在此登记；生成后续章节时会自动提示需回收的伏笔。</span>
              </div>
              {d.foreshadows.length === 0 ? (
                <div className={s.tiny}>暂无伏笔记录。</div>
              ) : (
                <table className={s.qtable}>
                  <thead>
                    <tr>
                      <th>描述</th>
                      <th style={{ width: 90 }}>埋设章</th>
                      <th style={{ width: 110 }}>建议回收</th>
                      <th style={{ width: 150 }}>出处摘录</th>
                      <th style={{ width: 80 }}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.foreshadows.map(f => (
                      <tr key={f.id}>
                        <td className={s.ellipsis} style={{ maxWidth: 300 }}>
                          {f.desc}
                          {f.stale && <span className={`${s.tag} ${s.tagWarn}`}>待复核</span>}
                        </td>
                        <td>第 {f.plantedAt} 章</td>
                        <td>{f.suggestPayoffAt != null ? `第 ${f.suggestPayoffAt} 章前后` : '—'}</td>
                        <td className={s.ellipsis} style={{ maxWidth: 150 }}>
                          {f.quote ? `「${f.quote}」` : '—'}
                          {f.sourceChapterNo != null && <span className={s.tiny}>（#{f.sourceChapterNo}）</span>}
                        </td>
                        <td>
                          <span className={`${s.tag} ${f.paidAt != null ? s.tagOk : s.tagWarn}`}>
                            {f.paidAt != null ? `已回收（第 ${f.paidAt} 章）` : '未回收'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── 设定 ── */}
        {tab === 'settings' && (
          <div className={s.col}>
            <div className={s.hint}>设定由新书向导创建、随逐章「定稿回写」人工确认后维护，此页只读；出处章节被重写后条目会标记「待复核」。</div>
            {d.settings.length === 0 && <div className={s.tiny}>暂无设定记录。</div>}
            {d.settings.map(st => (
              <div key={st.id} className={`${s.card} ${st.stale ? s.staleCard : ''}`}>
                <div className={s.row}>
                  <span className={s.tag}>{SETTING_KIND_LABEL[st.kind] ?? st.kind}</span>
                  <strong>{st.name}</strong>
                  {st.stale && <span className={`${s.tag} ${s.tagWarn}`}>待复核</span>}
                  {st.tags.map(t => <span key={t} className={`${s.tag} ${s.tagInfo}`}>{t}</span>)}
                  {st.sourceChapterNo != null && <span className={s.tiny}>出处：第 {st.sourceChapterNo} 章</span>}
                </div>
                {st.kind === 'relation' && st.relation ? (
                  <>
                    <div className={s.row}>
                      <span className={s.tag}>{st.relation.from}</span>
                      <span className={s.muted}>—{st.relation.publicLabel}→</span>
                      <span className={s.tag}>{st.relation.to}</span>
                      <span className={s.tiny}>（对外人设关系）</span>
                    </div>
                    {st.relation.realBond && (
                      <div className={s.row}>
                        <span className={`${s.tag} ${s.tagWarn}`}>真实关系</span>
                        <span className={s.muted}>{st.relation.realBond}（仅作者视角，正文不直说）</span>
                      </div>
                    )}
                    {(st.relation.fromKnows.length > 0 || st.relation.toKnows.length > 0) && (
                      <div className={s.tiny}>
                        {st.relation.fromKnows.length > 0 && <div>{st.relation.from} 知晓：{st.relation.fromKnows.join('；')}</div>}
                        {st.relation.toKnows.length > 0 && <div>{st.relation.to} 知晓：{st.relation.toKnows.join('；')}</div>}
                      </div>
                    )}
                  </>
                ) : (
                  st.summary && <div className={s.muted}>{st.summary}</div>
                )}
                {st.kind === 'character' && st.knownBy && st.knownBy.length > 0 && (
                  <div className={s.tiny}>知晓的事实：{st.knownBy.join('；')}</div>
                )}
                {st.state && <div className={s.row}><span className={`${s.tag} ${s.tagCool}`}>当前状态</span><span className={s.muted}>{st.state}</span></div>}
                {st.quote && <div className={s.tiny}>出处摘录：「{st.quote}」</div>}
              </div>
            ))}
          </div>
        )}

        {/* ── 记忆 ── */}
        {tab === 'memory' && (
          <div className={s.col}>
            <div className={s.card}>
              <div className={s.row}>
                <strong>全局剧情摘要</strong>
                <span className={s.tiny}>逐章生成时的「前情」来源之一；定稿回写会产生新摘要提案，也可手改。</span>
                <span className={s.spacer} />
                <button className={s.btnPrimary} disabled={memBusy || memDraft === book.memorySummary} onClick={() => void saveMemory()}>
                  {memBusy ? '保存中…' : '保存摘要'}
                </button>
              </div>
              <textarea
                className={s.textarea}
                rows={5}
                value={memDraft}
                placeholder="当前剧情走到哪了：主线进度、关键人物处境、悬而未决的冲突……"
                onChange={e => setMemDraft(e.target.value)}
              />
            </div>

            <div className={s.row}>
              <strong>待确认记忆（{d.pending.length}）</strong>
              <span className={s.tiny}>「定稿回写」提取的设定/伏笔/状态/摘要都在这里，逐条人工确认后才入册。</span>
            </div>
            {d.pending.length === 0 && <div className={s.tiny}>暂无待确认条目。</div>}
            {d.pending.map(p => (
              <div key={p.id} className={s.pendingCard}>
                <div className={s.pendingHead}>
                  <span className={`${s.tag} ${s.tagInfo}`}>{PENDING_KIND_LABEL[p.kind] ?? p.kind}</span>
                  <span className={s.tiny}>第 {p.chapterNo} 章</span>
                  <span className={s.spacer} />
                  <button className={s.btnSm} disabled={confirmBusy != null} onClick={() => void confirmPending(p, false)}>忽略</button>
                  <button className={s.btnSm} disabled={confirmBusy != null} onClick={() => void confirmPending(p, true)}>
                    {confirmBusy === p.id ? '处理中…' : '确认入册'}
                  </button>
                </div>
                <div className={s.pendingBody}>{pendingBody(p)}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── 日志 ── */}
        {tab === 'logs' && (
          <div className={s.col}>
            <div className={s.row}>
              <strong>创作日志</strong>
              <span className={s.tiny}>生成 / 续排 / 定稿 / 审稿 / 改稿的耗时与结果记录（最近 200 条）。</span>
              <span className={s.spacer} />
              <button
                className={s.btnSm}
                onClick={() => {
                  logsLoaded.current = false
                  setTab('logs')
                  void apiGet<{ logs: WriterLog[] }>(`/api/writer/logs?bookId=${encodeURIComponent(bookId)}`)
                    .then(d => setLogs(Array.isArray(d.logs) ? d.logs : []))
                    .catch(() => {})
                }}
              >刷新</button>
            </div>
            {logs.length === 0 ? (
              <div className={s.tiny}>暂无日志。</div>
            ) : (
              <table className={s.qtable}>
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>时间</th>
                    <th style={{ width: 90 }}>阶段</th>
                    <th style={{ width: 60 }}>章</th>
                    <th style={{ width: 70 }}>结果</th>
                    <th style={{ width: 80 }}>耗时</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(l => (
                    <tr key={l.id}>
                      <td>{fmtTime(l.ts)}</td>
                      <td>{LOG_STAGE_LABEL[l.stage] ?? l.stage}</td>
                      <td>{l.no != null ? `第 ${l.no} 章` : '—'}</td>
                      <td>
                        <span className={`${s.tag} ${l.ok ? s.tagOk : s.tagWarn}`}>{l.ok ? '成功' : '失败'}</span>
                      </td>
                      <td>{(l.ms / 1000).toFixed(1)}s</td>
                      <td className={s.ellipsis} style={{ maxWidth: 360 }}>
                        {l.err ? <span className={s.errorText}>{l.err}</span> : l.issueCount != null ? `${l.issueCount} 条问题` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* 删章确认 */}
      {delConfirm && (
        <ConfirmModal
          title="删除本章"
          message={`确定删除第 ${selNo} 章？旧稿将不可恢复（快照一并删除）；对应章纲回退为「待写」。`}
          confirmText="删除"
          danger
          onConfirm={() => void deleteChapter()}
          onCancel={() => setDelConfirm(false)}
        />
      )}

      {/* 一键成书：开始前确认 */}
      {bookConfirm && (
        <ConfirmModal
          title="一键成书"
          message={`将连续写到第 ${bookTarget} 章：缺纲自动续排，逐章生成并质检重试，定稿回写后记忆自动确认入册。中途可随时停止，已完成的章会保留，下次可接着写。确定开始？`}
          confirmText="开始成书"
          onConfirm={() => { setBookConfirm(false); startBookRun(bookTarget) }}
          onCancel={() => setBookConfirm(false)}
        />
      )}

      {/* 续排/开新卷：生成中 */}
      {beatsRun && (
        <Modal
          title={beatsRun.kind === 'more' ? '续排章纲中…' : '开新卷规划中…'}
          width={560}
          onClose={beatsRun.err ? () => { beatsAbort.current?.abort(); setBeatsRun(null) } : undefined}
        >
          {beatsRun.err ? (
            <div className={s.col}>
              <div className={s.errorText}>{beatsRun.err}</div>
              <div className={s.row}>
                <span className={s.spacer} />
                <button className={s.btn} onClick={() => setBeatsRun(null)}>关闭</button>
                <button className={s.btnPrimary} onClick={() => runBeats(beatsRun.kind)}>重试</button>
              </div>
            </div>
          ) : (
            <div className={s.col}>
              <div className={s.genBar}>
                <span className={s.genDot} />
                <span className={s.genBarText}>正在结合主线、记忆与未回收伏笔规划后续章节…</span>
              </div>
              <pre className={s.tiny} style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflowY: 'auto', margin: 0 }}>
                {beatsRun.text.slice(-800) || '（等待模型输出…）'}
              </pre>
            </div>
          )}
        </Modal>
      )}

      {/* 续排/开新卷：提案确认 */}
      {beatsProp && (
        <Modal
          title={beatsProp.kind === 'more' ? '确认续排提案' : '确认新卷提案'}
          width={640}
          footer={
            <>
              <button className={s.btn} onClick={() => setBeatsProp(null)}>放弃</button>
              <button className={s.btnPrimary} disabled={beatsBusy} onClick={() => void confirmBeats()}>
                {beatsBusy ? '写入中…' : `追加 ${beatsProp.proposal.beats.length} 章`}
              </button>
            </>
          }
        >
          <div className={s.col}>
            {beatsProp.kind === 'volume' && beatsProp.proposal.volume && (
              <div className={s.card}>
                <div className={s.row}>
                  <span className={`${s.tag} ${s.tagInfo}`}>新卷</span>
                  <strong>{beatsProp.proposal.volume.title}</strong>
                </div>
                {beatsProp.proposal.volume.summary && <div className={s.muted}>{beatsProp.proposal.volume.summary}</div>}
              </div>
            )}
            <div className={s.listGrow} style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table className={s.qtable}>
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>章</th>
                    <th style={{ width: 130 }}>标题</th>
                    <th>节拍</th>
                    <th style={{ width: 120 }}>承诺</th>
                    <th style={{ width: 120 }}>不确定</th>
                    <th style={{ width: 60 }}>回收</th>
                  </tr>
                </thead>
                <tbody>
                  {beatsProp.proposal.beats.map(b => (
                    <tr key={b.no}>
                      <td>{b.no}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 130 }}>{b.title}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 260 }}>{b.beat}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 120 }}>{b.promise ?? '—'}</td>
                      <td className={s.ellipsis} style={{ maxWidth: 120 }}>{b.uncertainty ?? '—'}</td>
                      <td>{b.payoffOf != null ? `#${b.payoffOf}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={s.tiny}>重复章号会自动跳过；追加后状态一律为「待写」。承诺=本章向读者许下的期待，不确定=本章埋下的新问题，回收=兑现了第几章的承诺。</div>
          </div>
        </Modal>
      )}
    </>
  )
}
