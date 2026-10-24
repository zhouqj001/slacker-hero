/**
 * 书架页：作品卡片网格 + 新书向导。
 * 向导走 outline SSE（kind:'wizard'）产出提案，人工确认后 POST /books 落库
 * （含主角设定与第一卷），随后直接打开作品工作台。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArchetypeSummary, SseFrame, WriterAccount, WriterBook, WizardProposal } from '../common.ts'
import {
  BOOK_STATUS_LABEL,
  DEFAULT_STYLE_CARD,
  FANQIE_GENRES,
  apiGet,
  apiPost,
  frameObj,
  frameStr,
  frameNum,
  postSse,
  s,
} from '../common.ts'
import { Field, Modal } from '../ui.tsx'

export interface ShelfPageProps {
  accounts: WriterAccount[]
  onOpen: (bookId: string) => void
  showToast: (msg: string, err?: boolean) => void
}

/** 向导弹窗状态机：表单 → 生成中 → 提案确认。 */
type WizardPhase =
  | { kind: 'form' }
  | { kind: 'running'; text: string; err: string | null }
  | { kind: 'proposal'; proposal: WizardProposal }

interface WizardForm {
  accountId: string
  genre: string
  idea: string
  style: string
  pace: string
}

/** 提案确认视图的可编辑字段。 */
interface ProposalDraft {
  name: string
  intro: string
  chapterWords: number
  targetWords: number
  styleCard: string
  /** 风格原型 id（向导推荐，可换；'' = 一期通用腔）。 */
  archetype: string
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ShelfPage({ accounts, onOpen, showToast }: ShelfPageProps): JSX.Element {
  const [books, setBooks] = useState<WriterBook[]>([])
  const [loading, setLoading] = useState(false)
  const [archetypes, setArchetypes] = useState<ArchetypeSummary[]>([])
  const [wizard, setWizard] = useState<WizardPhase | null>(null)
  const [form, setForm] = useState<WizardForm>({ accountId: '', genre: '', idea: '', style: '', pace: '' })
  const [draft, setDraft] = useState<ProposalDraft | null>(null)
  const [createBusy, setCreateBusy] = useState(false)
  const sessRef = useRef<{ sessionId?: string; baseline?: number }>({})
  const wizardAbort = useRef<AbortController | null>(null)

  const reloadBooks = useCallback(() => {
    setLoading(true)
    void apiGet<WriterBook[]>('/api/writer/books')
      .then(setBooks)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    reloadBooks()
    void apiGet<{ archetypes: ArchetypeSummary[] }>('/api/writer/archetypes')
      .then(r => setArchetypes(r.archetypes))
      .catch(() => {})
    return () => wizardAbort.current?.abort()
  }, [reloadBooks])

  // 无账号/账号列表变化时，保证表单账号选择落在合法值上
  useEffect(() => {
    setForm(f => (f.accountId === '' && accounts.length > 0 ? { ...f, accountId: accounts[0].id } : f))
  }, [accounts])

  const runWizard = useCallback((f: WizardForm) => {
    setWizard({ kind: 'running', text: '', err: null })
    const ctrl = new AbortController()
    wizardAbort.current = ctrl
    void postSse('/api/writer/generate/outline', {
      kind: 'wizard',
      genre: f.genre,
      idea: f.idea,
      style: f.style,
      pace: f.pace,
      sessionId: sessRef.current.sessionId,
      baseline: sessRef.current.baseline,
    }, (frame: SseFrame) => {
      if (frame['type'] === 'session') {
        sessRef.current = { sessionId: frameStr(frame, 'sessionId'), baseline: frameNum(frame, 'baseline') }
        return false
      }
      if (frame['type'] === 'text') {
        const t = frameStr(frame, 'text')
        setWizard(w => (w && w.kind === 'running' ? { ...w, text: t } : w))
        return false
      }
      if (frame['type'] === 'done') {
        const proposal = frameObj<WizardProposal>(frame, 'proposal')
        if (proposal) {
          setWizard({ kind: 'proposal', proposal })
          setDraft({
            name: proposal.names[0] ?? '',
            intro: proposal.intro,
            chapterWords: 2400,
            targetWords: 0,
            styleCard: DEFAULT_STYLE_CARD,
            archetype: proposal.archetype ?? '',
          })
        } else {
          setWizard({ kind: 'running', text: '', err: '提案解析失败，请重试' })
        }
        return true
      }
      if (frame['type'] === 'error') {
        const msg = frameStr(frame, 'message') || '生成失败'
        const action = frameStr(frame, 'action')
        setWizard(w => (w && w.kind === 'running' ? { ...w, err: action ? `${msg}（${action}）` : msg } : w))
        return true
      }
      return false
    }, ctrl.signal).catch(err => {
      if (!ctrl.signal.aborted) setWizard({ kind: 'running', text: '', err: errMsg(err) })
    })
  }, [])

  const createBook = useCallback(async () => {
    if (!draft || wizard?.kind !== 'proposal') return
    setCreateBusy(true)
    try {
      const book = await apiPost<WriterBook>('/api/writer/books', {
        accountId: form.accountId,
        name: draft.name,
        genre: form.genre,
        intro: draft.intro,
        chapterWords: draft.chapterWords,
        targetWords: draft.targetWords > 0 ? draft.targetWords : undefined,
        styleCard: draft.styleCard,
        archetype: draft.archetype || undefined,
        outline: {
          logline: wizard.proposal.outline.logline,
          coreConflict: wizard.proposal.outline.coreConflict,
          volumes: [{ index: 1, title: wizard.proposal.volume.title, summary: wizard.proposal.volume.summary }],
          beats: wizard.proposal.beats,
        },
        settings: [{
          kind: 'character',
          name: wizard.proposal.protagonist.name,
          summary: wizard.proposal.protagonist.summary,
          tags: wizard.proposal.protagonist.tags,
        }],
      })
      setWizard(null)
      setDraft(null)
      sessRef.current = {}
      showToast(`《${book.name}》已创建，共 ${wizard.proposal.beats.length} 章章纲`)
      onOpen(book.id)
    } catch (err) {
      showToast(errMsg(err), true)
    } finally {
      setCreateBusy(false)
    }
  }, [draft, form, onOpen, showToast, wizard])

  const formOk = form.accountId !== '' && form.genre.trim() !== '' && form.idea.trim() !== ''

  return (
    <div className={s.col}>
      <div className={s.row}>
        <span className={s.muted}>{books.length} 部作品</span>
        <span className={s.spacer} />
        <button className={s.btnGhost} onClick={reloadBooks} disabled={loading}>刷新</button>
        <button className={s.btnPrimary} onClick={() => {
          sessRef.current = {}
          setWizard({ kind: 'form' })
        }}>新书向导</button>
      </div>

      {books.length === 0 && !loading && (
        <div className={s.hint}>书架还是空的。点「新书向导」，用一句话点子生成书名、大纲与第一卷章纲。</div>
      )}

      <div className={s.shelfGrid}>
        {books.map(b => {
          const total = b.outline.beats.length
          const done = b.outline.beats.filter(x => x.status === 'finalized').length
          const pct = total > 0 ? Math.round((done / total) * 100) : 0
          return (
            <button key={b.id} className={s.bookCard} onClick={() => onOpen(b.id)}>
              <div className={`${s.row} ${s.ellipsis}`}>
                <span className={`${s.bookName} ${s.ellipsis}`}>{b.name}</span>
                <span className={s.tag}>{b.genre}</span>
              </div>
              <div className={s.row}>
                <span className={`${s.tag} ${b.status === 'writing' ? s.tagInfo : b.status === 'finished' ? s.tagOk : ''}`}>
                  {BOOK_STATUS_LABEL[b.status] ?? b.status}
                </span>
                {b.fanqieBookId && <span className={`${s.tag} ${s.tagCool}`}>已绑定平台</span>}
              </div>
              <div className={s.bookMeta}>
                第 {done}/{total} 章定稿 · 章均 {b.chapterWords} 字
                {b.archetype ? ` · ${archetypes.find(a => a.id === b.archetype)?.name ?? b.archetype}` : ''}
              </div>
              <div className={s.progBar}>
                <div className={s.progFill} style={{ width: `${pct}%` }} />
              </div>
              <div className={s.row}>
                <span
                  className={s.linkTiny}
                  onClick={e => {
                    e.stopPropagation()
                    window.open(`/api/writer/book/export?bookId=${encodeURIComponent(b.id)}&format=md`)
                  }}
                >导出全稿</span>
                <span
                  className={s.linkTiny}
                  onClick={e => {
                    e.stopPropagation()
                    window.open(`/api/writer/book/export?bookId=${encodeURIComponent(b.id)}&format=json`)
                  }}
                >备份 json</span>
              </div>
            </button>
          )
        })}
      </div>

      {wizard && (
        <Modal
          title={wizard.kind === 'form' ? '新书向导' : wizard.kind === 'running' ? '大纲生成中…' : '确认新书提案'}
          width={wizard.kind === 'proposal' ? 640 : 560}
          onClose={() => {
            wizardAbort.current?.abort()
            setWizard(null)
            setDraft(null)
          }}
          footer={wizard.kind === 'proposal' && draft ? (
            <>
              <button className={s.btn} onClick={() => { setWizard(null); setDraft(null) }}>放弃</button>
              <button className={s.btnPrimary} onClick={() => void createBook()} disabled={createBusy || draft.name.trim() === ''}>
                {createBusy ? '创建中…' : '创建作品'}
              </button>
            </>
          ) : undefined}
        >
          {wizard.kind === 'form' && (
            <div className={s.col}>
              <Field label="发布账号">
                <select
                  className={s.select}
                  value={form.accountId}
                  onChange={e => setForm({ ...form, accountId: e.target.value })}
                >
                  {accounts.length === 0 && <option value="">（先到「账号」页添加番茄账号）</option>}
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="题材" hint="点选常用题材或直接输入">
                <div className={s.rowWrap}>
                  {FANQIE_GENRES.map(g => (
                    <button
                      key={g}
                      className={`${s.chip} ${form.genre === g ? s.chipActive : ''}`}
                      onClick={() => setForm({ ...form, genre: g })}
                    >{g}</button>
                  ))}
                </div>
                <input
                  className={s.input}
                  value={form.genre}
                  placeholder="或输入自定义题材"
                  onChange={e => setForm({ ...form, genre: e.target.value })}
                />
              </Field>
              <Field label="一句话点子" hint="核心设定、主角、冲突，越具体越好">
                <textarea
                  className={s.textarea}
                  rows={4}
                  value={form.idea}
                  placeholder="例：外卖骑手意外获得能看见三分钟后的未来的能力，被卷入一场针对城市的连环阴谋"
                  onChange={e => setForm({ ...form, idea: e.target.value })}
                />
              </Field>
              <Field label="文风偏好（可选）" hint="留空则用默认网文正文腔">
                <textarea
                  className={s.textarea}
                  rows={2}
                  value={form.style}
                  placeholder="例：冷硬干脆，对话多、描写少，带点黑色幽默"
                  onChange={e => setForm({ ...form, style: e.target.value })}
                />
              </Field>
              <Field label="节奏要求（可选）">
                <input
                  className={s.input}
                  value={form.pace}
                  placeholder="例：快节奏，每章一个小钩子，每 10 章一个阶段高潮"
                  onChange={e => setForm({ ...form, pace: e.target.value })}
                />
              </Field>
              <div className={s.row}>
                <span className={s.tiny}>生成约需 1–2 分钟，产出提案后需人工确认才会创建作品。</span>
                <span className={s.spacer} />
                <button
                  className={s.btnPrimary}
                  disabled={!formOk}
                  onClick={() => runWizard(form)}
                >生成提案</button>
              </div>
            </div>
          )}

          {wizard.kind === 'running' && (
            <div className={s.col}>
              <div className={s.genBar}>
                <span className={s.genDot} />
                <span className={s.genBarText}>正在生成书名、简介、大纲与第一卷章纲…</span>
              </div>
              {wizard.err ? (
                <div className={s.col}>
                  <div className={s.errorText}>{wizard.err}</div>
                  <div className={s.row}>
                    <span className={s.spacer} />
                    <button className={s.btn} onClick={() => setWizard({ kind: 'form' })}>返回修改</button>
                    <button className={s.btnPrimary} onClick={() => runWizard(form)}>重试</button>
                  </div>
                </div>
              ) : (
                <pre className={s.tiny} style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', margin: 0 }}>
                  {wizard.text.slice(-800) || '（等待模型输出…）'}
                </pre>
              )}
            </div>
          )}

          {wizard.kind === 'proposal' && draft && (
            <div className={s.col}>
              <Field label="书名" hint="点选候选或直接改成想要的名字">
                <div className={s.rowWrap}>
                  {wizard.proposal.names.map(n => (
                    <button
                      key={n}
                      className={`${s.chip} ${draft.name === n ? s.chipActive : ''}`}
                      onClick={() => setDraft({ ...draft, name: n })}
                    >{n}</button>
                  ))}
                </div>
                <input
                  className={s.input}
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="简介">
                <textarea
                  className={s.textarea}
                  rows={3}
                  value={draft.intro}
                  onChange={e => setDraft({ ...draft, intro: e.target.value })}
                />
              </Field>
              <div className={s.row}>
                <Field label="章均字数">
                  <input
                    className={s.input}
                    type="number"
                    min={800}
                    max={6000}
                    value={draft.chapterWords}
                    onChange={e => setDraft({ ...draft, chapterWords: Number(e.target.value) || 0 })}
                  />
                </Field>
                <Field label="目标字数（可空）">
                  <input
                    className={s.input}
                    type="number"
                    min={0}
                    value={draft.targetWords || ''}
                    placeholder="如 1000000"
                    onChange={e => setDraft({ ...draft, targetWords: Number(e.target.value) || 0 })}
                  />
                </Field>
              </div>
              <Field label="一句话主纲">
                <div className={s.hint}>{wizard.proposal.outline.logline || '—'}</div>
              </Field>
              <Field label="核心冲突">
                <div className={s.hint}>{wizard.proposal.outline.coreConflict || '—'}</div>
              </Field>
              <Field label="第一卷">
                <div className={s.hint}>
                  《{wizard.proposal.volume.title}》{wizard.proposal.volume.summary}
                </div>
              </Field>
              {archetypes.length > 0 && (
                <Field label="风格原型" hint="决定整本书「怎么写」的口吻范式；AI 味闸按原型校准">
                  <div className={s.rowWrap}>
                    <button
                      className={`${s.chip} ${draft.archetype === '' ? s.chipActive : ''}`}
                      onClick={() => setDraft({ ...draft, archetype: '' })}
                    >通用腔（不套原型）</button>
                    {archetypes.map(a => (
                      <button
                        key={a.id}
                        className={`${s.chip} ${draft.archetype === a.id ? s.chipActive : ''}`}
                        title={`${a.lineage}｜适用：${a.genres.join('/')}`}
                        onClick={() => setDraft({ ...draft, archetype: a.id })}
                      >{a.name}{wizard.proposal.archetype === a.id ? ' ★推荐' : ''}</button>
                    ))}
                  </div>
                  <div className={s.tiny}>
                    {archetypes.find(a => a.id === draft.archetype)?.lineage ?? '一期默认网文正文腔，不做原型校准'}
                  </div>
                </Field>
              )}
              <Field label={`第一卷章纲（${wizard.proposal.beats.length} 章）`} hint="创建后仍可在「大纲」页续排与开新卷">
                <div className={s.list} style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {wizard.proposal.beats.map(b => (
                    <div key={b.no} className={`${s.col} ${s.beatPreview}`}>
                      <div className={s.tiny}>
                        <b>第{b.no}章《{b.title}》</b>{b.isClimax ? '【高潮】' : b.isCool ? '【爽点】' : ''}
                      </div>
                      <div className={s.tiny}>{b.beat}</div>
                      {b.promise && <div className={s.tiny}>承诺：{b.promise}</div>}
                      {b.uncertainty && <div className={s.tiny}>不确定：{b.uncertainty}</div>}
                      {b.payoffOf != null && <div className={s.tiny}>回收：第 {b.payoffOf} 章的承诺</div>}
                    </div>
                  ))}
                </div>
              </Field>
              <Field label="文风卡" hint="全书一致的写作规范，逐章生成时作为最高优先级指令">
                <textarea
                  className={s.textarea}
                  rows={4}
                  value={draft.styleCard}
                  onChange={e => setDraft({ ...draft, styleCard: e.target.value })}
                />
              </Field>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
