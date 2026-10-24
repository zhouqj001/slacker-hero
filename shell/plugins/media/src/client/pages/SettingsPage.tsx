/**
 * 设置页：数字员工（人设卡 + 对话式新建/编辑）+ 工作文件夹。
 * 由 PersonaTab 全功能迁移而来；「生成管线配置」不在本期范围。
 */
import { useCallback, useEffect, useState } from 'react'
import { PLATFORM_LABEL, apiGet, apiPost, pickWorkspaceDir, s, type Account, type Persona } from '../common.ts'
import { NlChatView, NlField, useNlChat } from '../NlChat.tsx'

interface PersonaFields {
  name: string
  positioning: string
  tone: string
  audience: string
  taboos: string[]
  tags: string[]
}

const asStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

const STAFF_TONES = ['#4d6bfe', '#e89005', '#17b26a', '#8a5cf6']

interface Props {
  wsRoot: string
  onSetWsRoot: (root: string) => void
  onError: (msg: string) => void
}

/** 后端 personaAlignment 的载荷：人设与账号历史作品的重合度。 */
interface Alignment {
  comparable: boolean
  overlap: number | null
  usedTerms: string[]
  unusedTerms: string[]
  threshold: number
  verdict: 'aligned' | 'weak' | 'unknown'
  note: string
}

/** GET/POST /api/media/scheduler 载荷。 */
interface SchedulerState {
  autoRun: boolean
  tickSeconds: number
  minGapMinutes: number
  dailyLimitPerAccount: number
  lastRunAt: number | null
  lastResult: string | null
}

/** POST /api/media/scheduler/tick 载荷。 */
interface TickResult {
  scanned: number
  executed: number
  skipped: number
  results: string[]
  dryRun: boolean
}

/** 出图协议方言：openai（image_size 字段）/ dashscope（阿里云百炼，size 字段）。 */
type ImageProtocol = 'openai' | 'dashscope'

/** 预设渠道（服务端内置，点一下预填端点和模型）。 */
interface ImagePreset {
  id: string
  label: string
  name: string
  protocol: ImageProtocol
  baseUrl: string
  models: { alias: string; id: string }[]
}

/** GET /api/media/imagegen 载荷。 */
interface ImageGenStatus {
  enabled: boolean
  allowAgent: boolean
  defaultChannelId: string
  channelCount: number
  readyCount: number
  activeChannel: string | null
  activeModel: string | null
  blockedReason: string | null
  channels: { id: string; name: string; baseUrl: string; hasApiKey: boolean; models: { alias: string; id: string }[]; protocol: ImageProtocol }[]
  /** 内置渠道预设；老版本服务端可能缺省。 */
  presets?: ImagePreset[]
}

/** 渠道编辑态：id 为空串 = 尚未落库的新渠道。uid 是本地唯一键，多个未存渠道不串。 */
interface ChannelDraft {
  uid: string
  /** 服务端渠道 id；'' = 尚未落库。 */
  id: string
  name: string
  baseUrl: string
  /** 明文 key 输入；空 = 不改动已存的 key。 */
  keyInput: string
  hasApiKey: boolean
  models: { alias: string; id: string }[]
  protocol: ImageProtocol
}

export function SettingsPage(props: Props): JSX.Element {
  const { wsRoot, onSetWsRoot, onError } = props
  const [list, setList] = useState<Persona[]>([])
  const [editing, setEditing] = useState<Persona | null>(null)
  const chat = useNlChat<PersonaFields>('persona')

  // 工作文件夹
  const [wsInput, setWsInput] = useState('')
  const [wsBusy, setWsBusy] = useState(false)
  const [wsSyncBusy, setWsSyncBusy] = useState(false)
  const [wsNote, setWsNote] = useState<string | null>(null)

  // 定时发布调度
  const [sched, setSched] = useState<SchedulerState | null>(null)
  const [schedBusy, setSchedBusy] = useState(false)
  const [schedNote, setSchedNote] = useState<string | null>(null)
  const [schedPreview, setSchedPreview] = useState<TickResult | null>(null)

  // 热榜抓取源
  const [fetchers, setFetchers] = useState<{ name: string; url: string }[]>([])
  const [fetchersLoaded, setFetchersLoaded] = useState(false)
  const [fetchersBusy, setFetchersBusy] = useState(false)
  const [fetchersNote, setFetchersNote] = useState<string | null>(null)

  // 人设 <-> 账号 1:1 绑定
  const [accounts, setAccounts] = useState<Account[]>([])
  const [bindBusy, setBindBusy] = useState(false)
  // 绑定后的人设 ↔ 账号 对齐度提示（错配当场可见，不靠用户自己想起来）；只挂到刚绑定的那张卡
  const [alignNote, setAlignNote] = useState<{ pid: string; note: Alignment } | null>(null)

  // 封面生图 / 视频生成供应商
  const [imgGen, setImgGen] = useState<ImageGenStatus | null>(null)
  const [chDrafts, setChDrafts] = useState<ChannelDraft[]>([])
  const [imgBusy, setImgBusy] = useState(false)
  const [imgNote, setImgNote] = useState<string | null>(null)
  const [videoSupported, setVideoSupported] = useState<boolean | null>(null)

  useEffect(() => { setWsInput(wsRoot) }, [wsRoot])

  const loadProviders = useCallback(async () => {
    try {
      const [img, vid] = await Promise.all([
        apiGet<ImageGenStatus>('/api/media/imagegen'),
        apiGet<{ supported: boolean }>('/api/media/videogen'),
      ])
      setImgGen(img)
      setChDrafts(img.channels.map(c => ({ ...c, protocol: c.protocol ?? 'openai', uid: c.id, keyInput: '' })))
      setVideoSupported(vid.supported)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  useEffect(() => { void loadProviders() }, [loadProviders])

  /** 所有生图写操作都走这里：成功后以服务端返回为准重刷（key 输入框随之清空）。 */
  const callImageGen = async (
    path: string,
    body: unknown,
    okNote: string,
  ): Promise<void> => {
    setImgBusy(true)
    setImgNote(null)
    try {
      const res = await apiPost<ImageGenStatus>(path, body)
      setImgGen(res)
      setChDrafts(res.channels.map(c => ({ ...c, protocol: c.protocol ?? 'openai', uid: c.id, keyInput: '' })))
      setImgNote(okNote)
    } catch (e) {
      setImgNote(e instanceof Error ? e.message : String(e))
    } finally {
      setImgBusy(false)
    }
  }

  const patchDraft = (uid: string, patch: Partial<ChannelDraft>): void =>
    setChDrafts(prev => prev.map(d => (d.uid === uid ? { ...d, ...patch } : d)))

  /** 保存单个渠道：keyInput 为空则不提交 apiKey（保留原值）。 */
  const saveChannel = (d: ChannelDraft): void => {
    void callImageGen('/api/media/imagegen/channel', {
      id: d.id === '' ? undefined : d.id,
      name: d.name,
      baseUrl: d.baseUrl,
      apiKey: d.keyInput.trim() === '' ? undefined : d.keyInput.trim(),
      models: d.models,
      protocol: d.protocol,
    }, d.id === '' ? '渠道已新增' : '渠道已保存')
  }

  const clearChannelKey = (d: ChannelDraft): void => {
    void callImageGen('/api/media/imagegen/channel', { id: d.id, apiKey: '' }, '已清除该渠道的 API Key')
  }

  const removeChannel = (d: ChannelDraft): void => {
    if (d.id === '') {
      setChDrafts(prev => prev.filter(x => x.uid !== d.uid))
      return
    }
    void callImageGen('/api/media/imagegen/channel/delete', { id: d.id }, `已删除渠道「${d.name || d.id}」`)
  }

  const addChannel = (): void =>
    setChDrafts(prev => [...prev, {
      uid: `new-${Date.now().toString(36)}`,
      id: '', name: '', baseUrl: '', keyInput: '', hasApiKey: false,
      models: [{ alias: '', id: '' }], protocol: 'openai',
    }])

  /** 按内置预设加一条草稿（端点/模型已填好，只剩贴 Key）。 */
  const addPreset = (p: ImagePreset): void =>
    setChDrafts(prev => [...prev, {
      uid: `new-${Date.now().toString(36)}`,
      id: '', name: p.name, baseUrl: p.baseUrl, keyInput: '', hasApiKey: false,
      models: p.models.map(m => ({ ...m })), protocol: p.protocol,
    }])

  const loadFetchers = useCallback(async () => {
    try {
      const res = await apiGet<{ fetchers: { name: string; url: string }[] }>('/api/media/hotspot/fetchers')
      setFetchers(res.fetchers)
      setFetchersLoaded(true)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  useEffect(() => { void loadFetchers() }, [loadFetchers])

  const saveFetchers = async (): Promise<void> => {
    setFetchersBusy(true)
    setFetchersNote(null)
    try {
      const res = await apiPost<{ fetchers: { name: string; url: string }[] }>(
        '/api/media/hotspot/fetchers/save', { fetchers },
      )
      setFetchers(res.fetchers)
      setFetchersNote(`已保存 ${res.fetchers.length} 个热榜源`)
    } catch (e) {
      setFetchersNote(e instanceof Error ? e.message : String(e))
    } finally {
      setFetchersBusy(false)
    }
  }

  const loadSched = useCallback(async () => {
    try {
      setSched(await apiGet<SchedulerState>('/api/media/scheduler'))
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  useEffect(() => { void loadSched() }, [loadSched])

  const saveSched = async (next: { autoRun?: boolean; tickSeconds?: number }): Promise<void> => {
    setSchedBusy(true)
    setSchedNote(null)
    try {
      const res = await apiPost<{ autoRun?: boolean; tickSeconds?: number }>('/api/media/scheduler/save', next)
      setSched(s => (s ? { ...s, ...res } : s))
      setSchedNote(
        next.autoRun === undefined
          ? '已保存轮询间隔'
          : next.autoRun ? '定时发布已开启' : '定时发布已关闭',
      )
    } catch (e) {
      setSchedNote(e instanceof Error ? e.message : String(e))
    } finally {
      setSchedBusy(false)
    }
  }

  /**
   * 立即巡检：先 dryRun 预览「将要发布什么」，再由用户确认执行。
   * 预览阶段不执行任何发布、也不拉起浏览器——避免一次点错炸出很多窗口。
   */
  const tick = async (dryRun: boolean): Promise<void> => {
    setSchedBusy(true)
    setSchedNote(null)
    try {
      const res = await apiPost<TickResult>('/api/media/scheduler/tick', { dryRun })
      const detail = res.results.length > 0
        ? res.results.map(r => `· ${r}`).join('\n')
        : '· 无到点计划'
      if (dryRun) {
        setSchedPreview(res)
        setSchedNote(
          res.executed === 0 && res.results.every(r => r.includes('跳过'))
            ? `预览：${res.scanned} 条到点，全部被跳过（多因账号未登录）`
            : `预览：${res.scanned} 条到点，其中 ${res.results.length - res.skipped} 条将被发布`,
        )
      } else {
        setSchedPreview(null)
        setSchedNote(`巡检完成：到点 ${res.scanned}，发布 ${res.executed}，跳过 ${res.skipped}\n${detail}`)
        await loadSched()
      }
    } catch (e) {
      setSchedNote(e instanceof Error ? e.message : String(e))
    } finally {
      setSchedBusy(false)
    }
  }

  const load = useCallback(async () => {
    try {
      const [ps, acs] = await Promise.all([
        apiGet<Persona[]>('/api/media/persona'),
        apiGet<Account[]>('/api/media/accounts'),
      ])
      setList(ps)
      setAccounts(acs)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  useEffect(() => { void load() }, [load])

  /** 绑定/解绑人设与账号（后端保证 1:1 对称）。绑完显示人设与账号实况的对齐度。 */
  const bindPersona = async (personaId: string, accountId: string): Promise<void> => {
    setBindBusy(true)
    setAlignNote(null)
    try {
      const res = await apiPost<{ alignment: Alignment | null }>('/api/media/persona/bind', { id: personaId, accountId })
      setAlignNote(res.alignment ? { pid: personaId, note: res.alignment } : null)
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBindBusy(false)
    }
  }

  const startEdit = (p: Persona): void => {
    setEditing(p)
    chat.reset()
    chat.say(`正在改「${p.name}」。直接说改哪里，比如「语气改犀利一点」「受众改成大学生」。`)
  }

  const startNew = (): void => {
    setEditing(null)
    chat.reset()
  }

  const send = (): void => {
    const current = editing
      ? {
          name: editing.name,
          positioning: editing.positioning,
          tone: editing.tone,
          audience: editing.audience,
          taboos: editing.taboos,
          tags: editing.tags,
        }
      : undefined
    void chat.send(chat.input, current ? { current } : {})
  }

  const fields = chat.pending
  // 确认卡展示「保存时会写入的完整值」：pending 优先，编辑模式回退当前值
  const merged = (k: keyof PersonaFields): string => {
    const v = fields[k]
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join('、')
    if (typeof v === 'string' && v.trim() !== '') return v
    const ev = editing?.[k]
    if (Array.isArray(ev)) return ev.join('、')
    return String(ev ?? '')
  }
  const name = merged('name')
  const hasFields = Object.keys(fields).length > 0

  const save = async (): Promise<void> => {
    if (!name.trim()) return
    try {
      await apiPost<Persona>('/api/media/persona/save', {
        id: editing?.id,
        name: name.trim(),
        positioning: merged('positioning'),
        tone: merged('tone'),
        audience: merged('audience'),
        taboos: asStringArray(fields.taboos) ?? editing?.taboos ?? [],
        tags: asStringArray(fields.tags) ?? editing?.tags ?? [],
      })
      chat.reset()
      setEditing(null)
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  /** 设为在岗：order 排到当前首位之前，成为派活默认员工。 */
  const makeFirst = async (p: Persona): Promise<void> => {
    try {
      await apiPost('/api/media/persona/save', { id: p.id, name: p.name, order: (list[0]?.order ?? 0) - 1 })
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (p: Persona): Promise<void> => {
    if (!window.confirm(`确定删除人设「${p.name}」吗？删除后派活不再选它。`)) return
    try {
      await apiPost('/api/media/persona/delete', { id: p.id })
      if (editing?.id === p.id) { setEditing(null); chat.reset() }
      await load()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const saveWs = async (): Promise<void> => {
    setWsBusy(true)
    setWsNote(null)
    try {
      const res = await apiPost<{ root: string }>('/api/media/workspace/set', { root: wsInput })
      onSetWsRoot(res.root)
      setWsNote(res.root ? `已设置：${res.root}` : '已清除工作文件夹')
    } catch (e) {
      setWsNote(e instanceof Error ? e.message : String(e))
    } finally {
      setWsBusy(false)
    }
  }

  const pickWs = async (): Promise<void> => {
    setWsNote(null)
    try {
      const dir = await pickWorkspaceDir()
      if (dir) setWsInput(dir)
    } catch (e) {
      setWsNote(e instanceof Error ? e.message : String(e))
    }
  }

  const syncWs = async (): Promise<void> => {
    setWsSyncBusy(true)
    setWsNote(null)
    try {
      const res = await apiPost<{ written: number; failed: number }>('/api/media/workspace/sync', {})
      setWsNote(`同步完成：落盘 ${res.written} 篇${res.failed ? `，失败 ${res.failed}` : ''}`)
    } catch (e) {
      setWsNote(e instanceof Error ? e.message : String(e))
    } finally {
      setWsSyncBusy(false)
    }
  }

  return (
    <div>
      <div className={s.pageHead}>
        <div>
          <div className={s.pageTitle}>设置</div>
          <div className={s.pageDesc}>数字员工 · 工作文件夹 · 生图渠道 · 热榜源 · 定时发布</div>
        </div>
      </div>

      <div className={s.setSections}>
      {/* ------------------------------------------------ 员工设置 */}
      <div className={s.setSec}>
        <div className={s.secTitle}>员工设置 <small>Staff · 数字员工团队 · 在岗员工自动接管写 / 发 / 复盘</small></div>
        <div className={s.staffGrid}>
          {list.map((p, i) => (
            <div
              key={p.id}
              className={`${s.staffCard} ${i === 0 ? s.staffSel : ''}`}
              onClick={() => { startEdit(p) }}
              title="点击进入编辑对话"
            >
              <div className={s.staffHead}>
                <span className={s.acctImg} style={{ background: STAFF_TONES[i % STAFF_TONES.length] }}>
                  {p.name.slice(0, 1)}
                </span>
                <div>
                  <div className={s.acctName}>{p.name}{p.accountId ? '' : ' · 通用'}</div>
                  <div className={s.staffBind}>{p.positioning}</div>
                </div>
              </div>
              {p.tags.length > 0 && (
                <div className={s.staffTags}>
                  {p.tags.map((t, ti) => (
                    <span key={ti} className={`${s.badge} ${s.badgeNeutral}`}>{t}</span>
                  ))}
                </div>
              )}
              <div className={s.staffBind}>{p.audience ? `受众：${p.audience}` : '受众未设置'}</div>
              <div onClick={e => { e.stopPropagation() }}>
                <select
                  className={s.select}
                  value={p.accountId ?? ''}
                  disabled={bindBusy}
                  onChange={e => { void bindPersona(p.id, e.target.value) }}
                >
                  <option value="">通用人设（不绑定账号）</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {PLATFORM_LABEL[a.platform] ?? a.platform} · {a.displayName}
                    </option>
                  ))}
                </select>
              </div>
              {alignNote?.pid === p.id && (
                <div className={alignNote.note.verdict === 'weak' ? s.noteWarn : s.noteInfo}>
                  {alignNote.note.verdict === 'weak' ? '人设与账号不对齐 · ' : alignNote.note.verdict === 'aligned' ? '人设与账号对齐 · ' : ''}
                  {alignNote.note.note}
                </div>
              )}
              <div className={s.rowActs} onClick={e => { e.stopPropagation() }}>
                {i !== 0 && (
                  <button className={s.chipBtn} type="button" onClick={() => { void makeFirst(p) }}>设为在岗</button>
                )}
                <button className={`${s.chipBtn} ${s.chipBtnDanger}`} type="button" onClick={() => { void remove(p) }}>删除</button>
              </div>
            </div>
          ))}
          <button className={`${s.staffCard} ${s.staffAdd}`} type="button" onClick={startNew}>
            ＋<br />添加数字员工
          </button>
        </div>

        <NlChatView
          turns={chat.turns}
          busy={chat.busy}
          input={chat.input}
          setInput={chat.setInput}
          onSend={send}
          placeholder={editing ? `说怎么改「${editing.name}」…` : '一句话描述你想做的人设…'}
          emptyHint={'用一句话描述你想做的账号，例如：「做一个面向职场新人的效率工具测评号，语气平实专业，不聊明星八卦」。\n大模型会提炼成人设卡，缺什么它会追问；点员工卡可以直接改。'}
        >
          {(hasFields || editing) && (
            <div className={s.nlCard}>
              <div className={s.nlCardTitle}>
                {editing
                  ? (hasFields ? `确认修改「${editing.name}」` : `「${editing.name}」的当前配置`)
                  : '确认新建人设'}
              </div>
              <NlField k="名称" v={name || <span className={s.nlCardHint}>（待补）</span>} />
              <NlField k="定位" v={merged('positioning') || <span className={s.nlCardHint}>（待补）</span>} />
              <NlField k="语气" v={merged('tone') || <span className={s.nlCardHint}>（未设置）</span>} />
              <NlField k="受众" v={merged('audience') || <span className={s.nlCardHint}>（未设置）</span>} />
              <NlField k="禁忌" v={merged('taboos') || <span className={s.nlCardHint}>（未设置）</span>} />
              <NlField k="标签" v={merged('tags') || <span className={s.nlCardHint}>（未设置）</span>} />
              <div className={s.rowWrap}>
                <button
                  className={`${s.btn} ${s.btnPrimary}`}
                  type="button"
                  disabled={!name.trim() || chat.busy}
                  onClick={() => { void save() }}
                >
                  保存
                </button>
                <button className={s.btn} type="button" onClick={() => { chat.clearPending() }}>重新说</button>
                {editing && <button className={s.btn} type="button" onClick={startNew}>取消编辑</button>}
              </div>
            </div>
          )}
        </NlChatView>
        <div className={s.tiny}>在岗 = 员工列表第一条，注入文章生成与 personaFit 选题评分 prompt；派活指令里点名其他员工可临时换人。</div>
      </div>

      {/* ------------------------------------------------ 工作文件夹 */}
      <div className={s.setSec}>
        <div className={s.secTitle}>工作文件夹 <small>Workspace · 内容按文章归档，账号数据按账号归档</small></div>
        <div className={s.secCard}>
          <div className={s.pathBar}>
            <span className={s.tiny}>当前</span>
            <span className={s.pathText}>{wsRoot || '未设置（文章 / 账号 / 规划不会落盘）'}</span>
            <button className={s.btn} type="button" onClick={() => { void pickWs() }}>选择文件夹</button>
          </div>
          <div className={s.formGrid}>
            <div className={`${s.formCol} ${s.formFull}`}>
              <div className={s.fieldLabel}>工作文件夹路径</div>
              <input
                className={s.input}
                value={wsInput}
                placeholder="例如 D:\media-workspace"
                onChange={e => { setWsInput(e.target.value) }}
              />
            </div>
          </div>
          <div className={s.rowWrap}>
            <button className={`${s.btn} ${s.btnPrimary}`} type="button" disabled={wsBusy} onClick={() => { void saveWs() }}>
              {wsBusy ? '保存中…' : '保存'}
            </button>
            <button className={s.btn} type="button" disabled={wsSyncBusy || wsRoot === ''} onClick={() => { void syncWs() }}>
              {wsSyncBusy ? '同步中…' : '同步已有文章'}
            </button>
            {wsNote && <span className={s.tiny}>{wsNote}</span>}
          </div>
          <table className={s.dirTable}>
            <tbody>
              <tr><td>&lt;员工名&gt;/</td><td>正文主档 · <code>日期-标题.md</code>，一稿只存一份（按在岗人设分目录）</td></tr>
              <tr><td className={s.dirLv2}>└ &lt;平台&gt;/</td><td>发布成功的平台版本（front-matter 记链接与发布时间）</td></tr>
              <tr><td>规划/</td><td>选题规划与排期 · <code>日期-标题.md</code></td></tr>
              <tr><td>assets/</td><td>配图素材 · 按文章 ID 分目录存放，经素材路由读取</td></tr>
            </tbody>
          </table>
          <div className={s.tiny}>「同步已有文章」只补缺，不覆盖已有改动。</div>
        </div>
      </div>

      {/* ------------------------------------------------ 封面生图 / 视频 */}
      <div className={s.setSec}>
        <div className={s.secTitle}>封面生图 <small>Image / Video · 编辑器「生成封面」「补齐正文配图」走这里</small></div>
        <div className={s.secCard}>
          <div className={s.optList}>
            <label className={s.optRow}>
              <input
                type="checkbox"
                checked={imgGen?.enabled ?? false}
                disabled={imgBusy || !imgGen}
                onChange={e => { void callImageGen('/api/media/imagegen/save', { enabled: e.target.checked }, e.target.checked ? '已开启 AI 生图' : '已关闭 AI 生图（走 SVG 模板）') }}
              />
              <span>
                启用 AI 生图
                <em className={s.optHint}>关掉后一律出 SVG 模板封面，不发外部请求</em>
              </span>
            </label>
            <label className={s.optRow}>
              <input
                type="checkbox"
                checked={imgGen?.allowAgent ?? false}
                disabled={imgBusy || !imgGen}
                onChange={e => { void callImageGen('/api/media/imagegen/save', { allowAgent: e.target.checked }, e.target.checked ? '已授权 agent 自动配图' : '已取消 agent 自动配图授权') }}
              />
              <span>
                允许 agent 自动配图
                <em className={s.optHint}>正文写完后自动配封面 / 补齐配图位，会产生调用费用</em>
              </span>
            </label>
          </div>

          {chDrafts.length === 0 && (
            <div className={s.nlEmpty}>还没有出图渠道。可以在下面加一条空白渠道自己填，或从预设一键预填端点与模型。</div>
          )}

          {chDrafts.map((d, i) => {
            const ready = d.baseUrl !== '' && (d.hasApiKey || d.keyInput.trim() !== '') && d.models.some(m => m.id.trim() !== '')
            const isDefault = d.id !== '' && d.id === imgGen?.defaultChannelId
            return (
              <div key={d.uid} className={s.subCard}>
                <div className={s.subHead}>
                  <span className={s.subTitle}>渠道 {i + 1}</span>
                  {isDefault && <span className={`${s.badge} ${s.badgeAccent}`}>默认</span>}
                  {d.id === '' && <span className={`${s.badge} ${s.badgeNeutral}`}>未保存</span>}
                  <span className={`${s.badge} ${ready ? s.badgeSuccess : s.badgeNeutral}`}>
                    {ready ? '可出图' : '配置不全'}
                  </span>
                </div>

                <div className={s.formGrid}>
                  <div className={s.formCol}>
                    <div className={s.fieldLabel}>渠道名</div>
                    <input
                      className={s.input}
                      value={d.name}
                      placeholder="如 阿里云百炼"
                      disabled={imgBusy}
                      onChange={e => { patchDraft(d.uid, { name: e.target.value }) }}
                    />
                  </div>
                  <div className={s.formCol}>
                    <div className={s.fieldLabel}>出图协议</div>
                    <select
                      className={s.select}
                      value={d.protocol}
                      disabled={imgBusy}
                      onChange={e => { patchDraft(d.uid, { protocol: e.target.value as ImageProtocol }) }}
                    >
                      <option value="openai">OpenAI 兼容（字段 image_size）</option>
                      <option value="dashscope">阿里云百炼（字段 size）</option>
                    </select>
                  </div>
                  <div className={`${s.formCol} ${s.formFull}`}>
                    <div className={s.fieldLabel}>API 端点</div>
                    <input
                      className={s.input}
                      value={d.baseUrl}
                      placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                      disabled={imgBusy}
                      onChange={e => { patchDraft(d.uid, { baseUrl: e.target.value }) }}
                    />
                  </div>
                  <div className={`${s.formCol} ${s.formFull}`}>
                    <div className={s.fieldLabel}>API Key</div>
                    <input
                      className={s.input}
                      type="password"
                      value={d.keyInput}
                      placeholder={d.hasApiKey ? '已配置（留空不改动）' : '粘贴 API Key'}
                      disabled={imgBusy}
                      onChange={e => { patchDraft(d.uid, { keyInput: e.target.value }) }}
                    />
                  </div>
                  <div className={`${s.formCol} ${s.formFull}`}>
                    <div className={s.fieldLabel}>模型（短名 = 界面显示名，id = 上游调用名；出图取第一个填了 id 的）</div>
                    {d.models.map((m, j) => (
                      <div className={s.inlineFields} key={j}>
                        <input
                          className={s.input}
                          value={m.alias}
                          placeholder="短名，如 封面模型"
                          disabled={imgBusy}
                          onChange={e => { patchDraft(d.uid, { models: d.models.map((x, k) => (k === j ? { ...x, alias: e.target.value } : x)) }) }}
                        />
                        <input
                          className={s.input}
                          value={m.id}
                          placeholder="模型 id，如 qwen-image-3.0"
                          disabled={imgBusy}
                          onChange={e => { patchDraft(d.uid, { models: d.models.map((x, k) => (k === j ? { ...x, id: e.target.value } : x)) }) }}
                        />
                        <button
                          className={`${s.chipBtn} ${s.chipBtnDanger}`}
                          type="button"
                          disabled={imgBusy || d.models.length === 1}
                          onClick={() => { patchDraft(d.uid, { models: d.models.filter((_, k) => k !== j) }) }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <div className={s.rowWrap}>
                      <button
                        className={s.chipBtn}
                        type="button"
                        disabled={imgBusy}
                        onClick={() => { patchDraft(d.uid, { models: [...d.models, { alias: '', id: '' }] }) }}
                      >
                        + 模型
                      </button>
                    </div>
                  </div>
                </div>

                <div className={s.rowWrap}>
                  <button className={`${s.btn} ${s.btnPrimary}`} type="button" disabled={imgBusy} onClick={() => { saveChannel(d) }}>
                    保存渠道
                  </button>
                  <button
                    className={s.btn}
                    type="button"
                    disabled={imgBusy || d.id === '' || isDefault}
                    onClick={() => { void callImageGen('/api/media/imagegen/save', { defaultChannelId: d.id }, `已设为默认渠道：${d.name || d.id}`) }}
                  >
                    {isDefault ? '已是默认' : '设为默认'}
                  </button>
                  <button className={s.btn} type="button" disabled={imgBusy || !d.hasApiKey} onClick={() => { clearChannelKey(d) }}>
                    清除 Key
                  </button>
                  <button className={`${s.btn} ${s.btnDanger}`} type="button" disabled={imgBusy} onClick={() => { removeChannel(d) }}>
                    删除渠道
                  </button>
                </div>
              </div>
            )
          })}

          <div className={s.rowWrap}>
            <span className={s.fieldLabel}>添加渠道</span>
            <button className={s.chipBtn} type="button" disabled={imgBusy} onClick={addChannel}>
              + 空白渠道
            </button>
            {(imgGen?.presets ?? []).map(p => (
              <button
                key={p.id}
                className={s.chipBtn}
                type="button"
                disabled={imgBusy}
                title={`预填端点 ${p.baseUrl}`}
                onClick={() => { addPreset(p) }}
              >
                + {p.label}
              </button>
            ))}
          </div>

          <div className={s.tiny}>
            已配 {imgGen?.channelCount ?? 0} 个渠道，其中 {imgGen?.readyCount ?? 0} 个可用。
            当前生效：{imgGen?.activeChannel
              ? `${imgGen.activeChannel}（模型：${imgGen.activeModel ?? '未填'}）`
              : 'SVG 模板封面'}
            {imgGen?.blockedReason ? ` — ${imgGen.blockedReason}` : ''}
            ；视频生成：{videoSupported === true ? '已接入' : '未接入（占位适配器，接入供应商后启用）'}。
            Key 存在媒体库里，不回显。
          </div>
          {imgNote && <div className={s.tiny}>{imgNote}</div>}
        </div>
      </div>

      {/* ------------------------------------------------ 热榜抓取源 */}
      <div className={s.setSec}>
        <div className={s.secTitle}>热榜抓取源 <small>Hotspot sources · 「选题与热点」页的「抓取热榜」用这里</small></div>
        <div className={s.secCard}>
          {fetchers.length === 0 && (
            <div className={s.nlEmpty}>还没有热榜源。添加来源后，「抓取热榜」逐个源取数，失败不影响其它源。</div>
          )}
          {fetchers.map((f, i) => (
            <div className={s.srcRow} key={i}>
              <input
                className={s.input}
                value={f.name}
                placeholder="来源名称，如 微博热搜"
                onChange={e => setFetchers(prev => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                className={s.input}
                value={f.url}
                placeholder="https://…（JSON 列表或含 &lt;a&gt; 的页面均可）"
                onChange={e => setFetchers(prev => prev.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
              />
              <button
                className={`${s.chipBtn} ${s.chipBtnDanger}`}
                type="button"
                disabled={fetchersBusy}
                onClick={() => setFetchers(prev => prev.filter((_, j) => j !== i))}
              >
                删除
              </button>
            </div>
          ))}
          <div className={s.rowWrap}>
            <button
              className={s.btn}
              type="button"
              disabled={fetchersBusy}
              onClick={() => setFetchers(prev => [...prev, { name: '', url: '' }])}
            >
              + 添加来源
            </button>
            <button className={`${s.btn} ${s.btnPrimary}`} type="button" disabled={fetchersBusy || !fetchersLoaded} onClick={() => { void saveFetchers() }}>
              {fetchersBusy ? '保存中…' : '保存热榜源'}
            </button>
            {fetchersNote && <span className={s.tiny}>{fetchersNote}</span>}
          </div>
          <div className={s.tiny}>清空并保存 = 回到配置文件里的来源（默认无源）。</div>
        </div>
      </div>

      {/* ------------------------------------------------ 定时发布 */}
      <div className={s.setSec}>
        <div className={s.secTitle}>定时发布 <small>Scheduler · 到点自动执行「已审核通过」的计划</small></div>
        <div className={s.secCard}>
          <div className={s.optList}>
            <label className={s.optRow}>
              <input
                type="checkbox"
                checked={!!sched?.autoRun}
                disabled={schedBusy || !sched}
                onChange={e => { void saveSched({ autoRun: e.target.checked }) }}
              />
              <span>
                开启定时自动发布
                <em className={s.optHint}>
                  逐条最小间隔 {sched?.minGapMinutes ?? 30} 分钟 / 每账号每日上限 {sched?.dailyLimitPerAccount ?? 3} 篇；
                  登录失效或达上限会自动停并保留待发计划
                </em>
              </span>
            </label>
          </div>
          <div className={s.rowWrap}>
            <span className={s.fieldLabel}>轮询间隔</span>
            <input
              className={`${s.input} ${s.inputNarrow}`}
              type="number"
              min={15}
              value={sched?.tickSeconds ?? 60}
              disabled={schedBusy || !sched}
              onChange={e => setSched(s => (s ? { ...s, tickSeconds: Number(e.target.value) } : s))}
            />
            <span className={s.tiny}>秒</span>
            <button
              className={s.btn}
              type="button"
              disabled={schedBusy || !sched}
              onClick={() => { void saveSched({ tickSeconds: sched?.tickSeconds ?? 60 }) }}
            >
              保存间隔
            </button>
          </div>
          <div className={s.rowWrap}>
            <button className={s.btn} type="button" disabled={schedBusy} onClick={() => { void tick(true) }}>
              预览将发布什么
            </button>
            <button
              className={`${s.btn} ${s.btnPrimary}`}
              type="button"
              disabled={schedBusy || !schedPreview || schedPreview.results.every(r => r.includes('跳过'))}
              onClick={() => { void tick(false) }}
            >
              立即执行巡检
            </button>
            {schedPreview && <span className={s.tiny}>预览不会发布、也不会打开浏览器</span>}
          </div>
          {sched?.lastRunAt && (
            <div className={s.tiny}>
              上次巡检：{new Date(sched.lastRunAt).toLocaleTimeString('zh-CN', { hour12: false })} · {sched.lastResult ?? '—'}
            </div>
          )}
          {schedNote && <div className={s.noteText}>{schedNote}</div>}
        </div>
      </div>
      </div>
    </div>
  )
}
