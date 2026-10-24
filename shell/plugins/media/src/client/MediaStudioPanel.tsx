/**
 * 媒体工作台主壳。
 * 左侧栏六项导航（工作台/账号管理/内容管理/选题与热点/数据看板/设置）
 * + 顶栏状态条 + 页面切换；工作台页承载派活 composer、生成置顶卡、汇报动态流与右栏速览。
 * 共享状态（账号/人设/动态流/生成流/编辑器/派活弹窗）由壳持有，页面组件按 props 注入。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Account, Article, DispatchPayload, FeedPayload, Hotspot, Persona } from './common.ts'
import { ACCOUNT_STATUS_LABEL, PLATFORM_IDS, PLATFORM_LABEL, apiGet, apiPost, s } from './common.ts'
import { FeedCard, type FeedCardActions } from './FeedCards.tsx'
import { DispatchModal, type DispatchConfirmPayload, type DispatchNote, type DispatchRequest } from './DispatchModal.tsx'
import { AccountsPage } from './pages/AccountsPage.tsx'
import { ContentPage, type ContentTab } from './pages/ContentPage.tsx'
import { MetricsPage } from './pages/MetricsPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'
import { TopicsPage } from './pages/TopicsPage.tsx'

/** 面板组件 props（main 槽签名）。 */
export type MediaStudioPanelProps = PropsRuntime<'main'>

/** SSE delta 帧。 */
interface DeltaFrame { type: 'delta'; text: string }
/** SSE session 帧：写作已派给 dsh 会话。 */
interface SessionFrame { type: 'session'; sessionId: string }
/** SSE done 帧。 */
interface DoneFrame { type: 'done'; articleId: string; sessionId?: string }
/** SSE error 帧。 */
interface ErrorFrame { type: 'error'; code: string; message: string; action: string }
/** SSE notice 帧：非致命提示（如配图回落模板图的具体原因）。 */
interface NoticeFrame { type: 'notice'; warnings: string[] }

type SseFrame = DeltaFrame | SessionFrame | DoneFrame | ErrorFrame | NoticeFrame

/** 配图 SSE 帧：逐张推进，让用户看见「正在画第几张」。 */
type IllustrateFrame =
  | { type: 'plan'; mode: 'fill' | 'redraw'; total: number; items: { index: number; prompt: string }[] }
  | { type: 'start'; index: number; prompt: string }
  | { type: 'end'; index: number; ok: boolean; message: string | null }
  | {
      type: 'finish'; id: string; total: number; filled: number; failed: number; redrawn: number
      errors: { index: number; message: string }[]; blocked: string | null
    }
  | { type: 'error'; code: string; message: string }

/** 逐张配图状态（编辑器里实时渲染成三态行）。 */
type FigStep = { index: number; status: 'pending' | 'running' | 'ok' | 'fail'; prompt: string; message?: string }

/** 正文生成置顶卡状态。 */
interface GenState {
  articleId: string
  title: string
  text: string
  err: string | null
  /** 本次点名的员工名（未点名时为 undefined，前端展示在岗员工）。 */
  personaName?: string
  /** 会话化写作：承载本次任务的 dsh 会话 id。 */
  sessionId?: string
  /** 非致命提示（配图失败/回落模板图等），按到达顺序累积。 */
  warns?: string[]
}

type Page = 'workbench' | 'accounts' | 'content' | 'topics' | 'metrics' | 'settings'

const PAGE_META: Record<Page, { zh: string; en: string }> = {
  workbench: { zh: '内容工作台', en: 'Media Studio' },
  accounts: { zh: '账号管理', en: 'Accounts' },
  content: { zh: '内容管理', en: 'Content' },
  topics: { zh: '选题与热点', en: 'Topics' },
  metrics: { zh: '数据看板', en: 'Metrics' },
  settings: { zh: '设置', en: 'Settings' },
}

const CONTENT_SUB: { id: ContentTab; label: string }[] = [
  { id: 'articles', label: '内容库' },
  { id: 'assets', label: '素材库' },
  { id: 'rhythm', label: '发布节奏' },
]

const WEEK_LB = ['一', '二', '三', '四', '五', '六', '日']

export function MediaStudioPanel(_props: MediaStudioPanelProps): JSX.Element {
  const [feed, setFeed] = useState<FeedPayload | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [personas, setPersonas] = useState<Persona[]>([])
  const [error, setError] = useState<string | null>(null)

  // 页面切换
  const [page, setPage] = useState<Page>('workbench')
  const [contentTab, setContentTab] = useState<ContentTab>('articles')
  const [contentOpen, setContentOpen] = useState(false)

  // toast（操作反馈，约 4s 自动消失）
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast(null) }, 4000)
  }, [])

  const showError = useCallback((msg: string) => { showToast(msg) }, [showToast])

  // 派活
  const [nlText, setNlText] = useState('')
  const [parsing, setParsing] = useState(false)
  /** 派活解析的 dsh 会话句柄：页面没关就一直复用同一个会话（不刷会话列表）。 */
  const dispatchSession = useRef<{ sessionId: string | null; baseline: number }>({ sessionId: null, baseline: 0 })
  const [dispatch, setDispatch] = useState<DispatchRequest | null>(null)

  // 快捷动作
  const [briefBusy, setBriefBusy] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)

  // 工作文件夹（文章/发布/规划的真实落盘目录）
  const [wsRoot, setWsRoot] = useState('')

  // 逐卡片动作 busy（key: write:<id> / approve:<id> / relogin:<id> / backfill:<planId> / gen:<id>）
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const setBusyKey = useCallback((key: string, v: boolean) => {
    setBusy(b => ({ ...b, [key]: v }))
  }, [])

  // 正文生成置顶卡
  const [gen, setGen] = useState<GenState | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 编辑器弹窗
  const [editor, setEditor] = useState<{
    article: Article; title: string; bodyMd: string; platformVersions: Record<string, string>
  } | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [imgBusy, setImgBusy] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [figBusy, setFigBusy] = useState(false)
  /**
   * 出图失败提示（封面 / 正文配图回落模板图的具体原因）。
   * 只弹 4 秒 toast 用户看不到发生了什么，这里保留在编辑器里可细看，直到下次出图或关编辑器。
   */
  const [imgNote, setImgNote] = useState<{ title: string; lines: string[] } | null>(null)
  /** 逐张配图进度（点「补齐正文配图」时实时刷新）；完成后保留最终状态，不清掉。 */
  const [figSteps, setFigSteps] = useState<FigStep[]>([])
  const [figMode, setFigMode] = useState<'fill' | 'redraw'>('fill')
  /** 编辑器当前编辑的版本：'base'（原文）或平台 id。 */
  const [pvTab, setPvTab] = useState<string>('base')
  /** 正在改写的平台 id（null=空闲）。 */
  const [rewriteBusy, setRewriteBusy] = useState<string | null>(null)
  const editorTaRef = useRef<HTMLTextAreaElement | null>(null)
  const editorFileRef = useRef<HTMLInputElement | null>(null)

  // ---------------------------------------------------------- 数据加载

  const loadFeed = useCallback(async () => {
    try {
      setFeed(await apiGet<FeedPayload>('/api/media/feed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadAccounts = useCallback(async () => {
    try {
      setAccounts(await apiGet<Account[]>('/api/media/accounts'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const loadPersonas = useCallback(async () => {
    try {
      setPersonas(await apiGet<Persona[]>('/api/media/persona'))
    } catch { /* 人设拉取失败不阻塞主面板 */ }
  }, [])

  const loadWorkspace = useCallback(async () => {
    try {
      setWsRoot((await apiGet<{ root: string }>('/api/media/workspace')).root)
    } catch { /* 工作文件夹拉取失败不阻塞主面板 */ }
  }, [])

  useEffect(() => {
    void loadFeed()
    void loadAccounts()
    void loadPersonas()
    void loadWorkspace()
  }, [loadFeed, loadAccounts, loadPersonas, loadWorkspace])

  // 25s 轮询（生成中跳过，避免干扰流式渲染）
  const genRef = useRef(gen)
  genRef.current = gen
  useEffect(() => {
    const timer = setInterval(() => {
      if (!genRef.current) {
        void loadFeed()
        void loadAccounts()
        void loadPersonas()
      }
    }, 25_000)
    return () => clearInterval(timer)
  }, [loadFeed, loadAccounts, loadPersonas])

  // ---------------------------------------------------------- 生成（SSE）

  const runGenerate = useCallback(async (articleId: string, title: string, personaId?: string, personaName?: string, accountId?: string) => {
    setGen({ articleId, title, text: '', err: null, personaName })
    setBusyKey(`gen:${articleId}`, true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/media/article/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: articleId, personaId, accountId }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        setGen(g => (g && g.articleId === articleId ? { ...g, err: `HTTP ${res.status}` } : g))
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const m = line.match(/^data: (.+)$/m)
          if (!m) continue
          try {
            const frame = JSON.parse(m[1]) as SseFrame
            if (frame.type === 'session') {
              setGen(g => (g && g.articleId === articleId ? { ...g, sessionId: frame.sessionId } : g))
            } else if (frame.type === 'delta') {
              setGen(g => (g && g.articleId === articleId ? { ...g, text: g.text + frame.text } : g))
            } else if (frame.type === 'error') {
              setGen(g => (g && g.articleId === articleId ? { ...g, err: `[${frame.code}] ${frame.message} · ${frame.action}` } : g))
            } else if (frame.type === 'notice') {
              setGen(g => (g && g.articleId === articleId ? { ...g, warns: [...(g.warns ?? []), ...frame.warnings] } : g))
            }
          } catch { /* ignore parse error */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setGen(g => (g && g.articleId === articleId ? { ...g, err: (e as Error).message } : g))
      }
    } finally {
      abortRef.current = null
      setBusyKey(`gen:${articleId}`, false)
      // 成功即收起并提示（动态流会出现草稿卡）；出错保留卡片供阅读
      setGen(g => {
        if (g && g.articleId === articleId && !g.err) showToast(`《${g.title}》已写好，到动态流里审稿吧`)
        return g && g.articleId === articleId && !g.err ? null : g
      })
      await loadFeed()
    }
  }, [loadFeed, setBusyKey, showToast])

  // ---------------------------------------------------------- 派活

  /** 为文章在指定平台建发布计划（账号取该平台第一个 active，缺省 default）。 */
  const createPlans = useCallback(async (articleId: string, platform: string, accountId: string) => {
    await apiPost('/api/media/plan/save', { articleId, platform, accountId })
  }, [])

  const confirmDispatch = useCallback(async (payload: DispatchConfirmPayload) => {
    setError(null)
    try {
      let articleId = payload.articleId
      if (!articleId && payload.hotspotId) {
        // 热点写作：走采纳回链（标记已采纳 + 关联文章），而不是另建一张空白稿
        setBusyKey(`write:${payload.hotspotId}`, true)
        const res = await apiPost<{ article: Article }>('/api/media/hotspot/adopt', { id: payload.hotspotId })
        articleId = res.article.id
      }
      if (!articleId) {
        const art = await apiPost<Article>('/api/media/article/save', {
          title: payload.topic,
          bodyMd: '',
          status: 'draft',
          topic: { manual: true },
        })
        articleId = art.id
      }
      await createPlans(articleId, payload.platform, payload.accountId)
      setDispatch(null)
      setNlText('')
      await runGenerate(articleId, payload.topic, payload.personaId, payload.personaName, payload.accountId)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      if (payload.hotspotId) setBusyKey(`write:${payload.hotspotId}`, false)
    }
  }, [createPlans, runGenerate, setBusyKey, showError])

  /**
   * NL 派活：解析成功且带平台 → 直接开干（无弹窗）。
   * 解析不完整时才降级到确认弹窗，并在弹窗顶部说明**为什么**降级：
   *   - AI 不可用（没配 key / 调用失败）→ 明确告知，且顶部红色说明；
   *   - 解析出选题但没平台 → 正常反问，补选平台即可；
   *   - 完全没听懂 → 提示手填。
   * 之前这里静默降级，用户只看到凭空冒出的表单，以为「本来就该填」。
   */
  const submitNl = useCallback(async () => {
    const text = nlText.trim()
    if (!text || parsing || gen) return
    setParsing(true)
    setError(null)
    try {
      // 会话句柄随请求带回：整个工作台的派活指令共用同一个 dsh 会话，不再每句新开
      const res = await apiPost<DispatchPayload>('/api/media/dispatch', {
        text,
        sessionId: dispatchSession.current.sessionId ?? undefined,
        baseline: dispatchSession.current.baseline,
      })
      if (res.sessionId) dispatchSession.current = { sessionId: res.sessionId, baseline: res.baseline ?? 0 }
      const firstPlatform = res.parsed?.platforms[0]
      const firstAccount = firstPlatform
        ? accounts.find(a => a.platform === firstPlatform)?.id
        : undefined
      if (res.parsed && firstPlatform && firstAccount) {
        // 解析出的平台有对应账号 → 直接开干，不弹窗
        await confirmDispatch({
          topic: res.parsed.topic,
          platform: firstPlatform,
          accountId: firstAccount,
          personaId: res.parsed.personaId ?? undefined,
          personaName: res.parsed.persona ?? undefined,
        })
      } else if (res.parsed) {
        setDispatch({
          topic: res.parsed.topic,
          personaId: res.parsed.personaId ?? undefined,
          platform: firstPlatform ?? '',
          note: {
            kind: 'need-platform',
            text: `已读出选题「${res.parsed.topic}」，但没说要发到哪个平台，补选后即可开干。`,
          },
        })
      } else {
        const note: DispatchNote = res.reason === 'NO_LLM'
          ? {
              kind: 'ai-unavailable',
              text: '未配置大模型 API Key，AI 无法读你的指令。请在 Web 界面的 Models 页面填入 Key，之后同样的指令会自动开干、不再弹这个表单。',
            }
          : res.reason === 'LLM_ERROR'
            ? {
                kind: 'ai-unavailable',
                text: '调用大模型失败（Key 无效或额度/网络问题），AI 没能读你的指令。可先手动填，或检查 Key 后重试。',
              }
            : {
                kind: 'unparsable',
                text: '没能从这句话里读出「写什么」。可以直接在下面改写选题、补选平台。',
              }
        setDispatch({ topic: text, note })
      }
    } catch {
      setDispatch({
        topic: text,
        note: { kind: 'ai-unavailable', text: '派活请求失败（网络或服务异常），请手动填写或重试。' },
      })
    } finally {
      setParsing(false)
    }
  }, [nlText, parsing, gen, confirmDispatch])

  // ---------------------------------------------------------- 快捷动作

  const refreshBrief = useCallback(async () => {
    setBriefBusy(true)
    setError(null)
    try {
      await apiPost('/api/media/hotspot/refresh', {})
      showToast('已抓取各平台热榜，简报已更新')
      await loadFeed()
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setBriefBusy(false)
    }
  }, [loadFeed, showToast])

  const syncData = useCallback(async () => {
    setSyncBusy(true)
    setError(null)
    try {
      const res = await apiPost<{ synced: number; failed: number; skipped: number }>('/api/media/review/sync', {})
      showToast(`数据同步完成：更新 ${res.synced} 篇 · 跳过 ${res.skipped} · 失败 ${res.failed}`)
      await loadFeed()
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncBusy(false)
    }
  }, [loadFeed, showToast])

  // ---------------------------------------------------------- 动态流动作

  /** 简报卡 / 选题页「写」：先弹账号选择（默认预选最契合账号），确认后再采纳 → 建计划 → 开写。 */
  const writeHotspot = useCallback((hotspot: Hotspot) => {
    setError(null)
    if (accounts.length === 0) {
      showError('还没有可用账号：先到「账号管理」添加并登录一个账号，再派活写作')
      return
    }
    setDispatch({
      topic: hotspot.title,
      hotspotId: hotspot.id,
      // personaFits 按 personaId 键；旧单值评分视作通用人设 '_default' 视角
      hotspotFits: hotspot.personaFits
        ?? (hotspot.personaFit ? { _default: hotspot.personaFit } : undefined),
    })
  }, [accounts, showError])

  const writeBusyId = useMemo(
    () => Object.keys(busy).find(k => k.startsWith('write:') && busy[k])?.slice(6) ?? null,
    [busy],
  )

  const actions: FeedCardActions = {
    onWrite: h => { void writeHotspot(h) },

    // 草稿卡「通过并发布」：先批准全部待审计划，再逐条发布（单条失败继续）
    onApprove: async (article, plans) => {
      setBusyKey(`approve:${article.id}`, true)
      setError(null)
      try {
        for (const p of plans) {
          if (p.state === 'pending-review') {
            await apiPost('/api/media/plan/approve', { id: p.id })
          }
        }
        for (const p of plans) {
          try {
            await apiPost('/api/media/plan/run', { planId: p.id })
          } catch { /* 单条失败不阻塞其余平台 */ }
        }
        showToast('已全部发布，回执稍后出现在动态流')
        await loadFeed()
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyKey(`approve:${article.id}`, false)
      }
    },

    onRegenerate: async (article) => {
      await runGenerate(article.id, article.title)
    },

    onEdit: (article) => {
      setEditor({
        article,
        title: article.title,
        bodyMd: article.bodyMd,
        platformVersions: { ...article.platformVersions },
      })
      setPvTab('base')
      setImgNote(null)
    },

    onBackfill: async (planId, url) => {
      setBusyKey(`backfill:${planId}`, true)
      setError(null)
      try {
        await apiPost('/api/media/publish/manual', { planId, url })
        showToast('链接已回填')
        await loadFeed()
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyKey(`backfill:${planId}`, false)
      }
    },

    onOpenUrl: async (url) => {
      setError(null)
      try {
        // 壳里 window.open 是空操作：外链得由宿主进程用系统浏览器打开
        await apiPost('/api/media/open-url', { url })
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      }
    },

    onRelogin: async (accountId) => {
      setBusyKey(`relogin:${accountId}`, true)
      setError(null)
      try {
        await apiPost('/api/media/account/login', { id: accountId })
        showToast('已拉起扫码窗口，等待扫码…')
        await loadAccounts()
        await loadFeed()
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyKey(`relogin:${accountId}`, false)
      }
    },
  }

  // ---------------------------------------------------------- 编辑器

  /** 更新「当前编辑版本」（原文或选中平台版）的文本。 */
  const updateCurrentText = useCallback((updater: (prev: string) => string) => {
    setEditor(ed => {
      if (!ed) return ed
      if (pvTab === 'base') return { ...ed, bodyMd: updater(ed.bodyMd) }
      const prev = ed.platformVersions[pvTab] ?? ''
      return { ...ed, platformVersions: { ...ed.platformVersions, [pvTab]: updater(prev) } }
    })
  }, [pvTab])

  /** 在正文光标处插入 markdown 片段（作用于当前编辑版本）。 */
  const insertAtCursor = useCallback((snippet: string) => {
    const ta = editorTaRef.current
    const pos = ta?.selectionStart ?? null
    updateCurrentText(prev => {
      const at = pos ?? prev.length
      return prev.slice(0, at) + snippet + prev.slice(at)
    })
    // textarea 受控更新后恢复焦点
    requestAnimationFrame(() => editorTaRef.current?.focus())
  }, [updateCurrentText])

  /** 本地图片：读为 base64 上传落盘（工作文件夹 assets），光标处插入引用。 */
  const onPickLocalImage = useCallback(async (file: File | undefined) => {
    if (!editor || !file) return
    if (file.size > 4 * 1024 * 1024) {
      showError('图片超过 4MB，请压缩后再插入')
      return
    }
    setImgBusy(true)
    setError(null)
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
      const { url } = await apiPost<{ url: string }>('/api/media/article/asset', {
        articleId: editor.article.id,
        filename: file.name,
        dataBase64,
      })
      insertAtCursor(`\n![${file.name}](${url})\n`)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setImgBusy(false)
      if (editorFileRef.current) editorFileRef.current.value = ''
    }
  }, [editor, insertAtCursor, showError])

  /** 网络图片：直接插入外链引用。 */
  const insertUrlImage = useCallback(() => {
    const url = window.prompt('输入图片 URL（https://…）：')
    if (url && url.trim()) insertAtCursor(`\n![图片](${url.trim()})\n`)
  }, [insertAtCursor])

  /** 生成/重生成封面（生图渠道或 SVG 兜底），正文未引用则前置。 */
  const generateCover = useCallback(async () => {
    if (!editor) return
    setCoverBusy(true)
    setError(null)
    setImgNote(null)
    try {
      const res = await apiPost<{
        url: string; bodyMd: string; usedTemplate: boolean; error: string | null; blocked: string | null
      }>('/api/media/asset/generate', {
        articleId: editor.article.id,
      })
      setEditor(ed => ed && { ...ed, bodyMd: res.bodyMd })
      setPvTab('base')
      if (res.usedTemplate) {
        setImgNote({
          title: '封面未真实生成，已回落 SVG 模板图',
          lines: [res.blocked ?? res.error ?? '未知原因'],
        })
        showToast('封面已生成（模板图）')
      } else {
        showToast('封面已生成')
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setCoverBusy(false)
    }
  }, [editor, showError, showToast])

  /** 在光标处插入一个配图占位（模型判断不配图时，可手动指定哪里要图）。 */
  const insertFigureSpot = useCallback(() => {
    const desc = window.prompt('这个位置要配什么图？\n写具体场景，会原样作为画图提示词\n例如：书桌上的笔记本电脑，屏幕显示代码，暖色台灯')
    if (!desc || desc.trim() === '') return
    const alt = window.prompt('图注（可留空）', '示意图') ?? ''
    insertAtCursor(`\n\n![${alt.trim() || '配图'}](gen:${desc.trim()})\n\n`)
    showToast('已插入配图位，点「补齐正文配图」生成')
  }, [insertAtCursor, showToast])

  /** 读配图 SSE 流：按帧实时更新逐张状态（进度全部来自服务端真实帧，不做假进度）。 */
  const readIllustrateStream = useCallback(async (res: Response) => {
    if (!res.body) throw new Error('响应没有流式 body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const m = chunk.match(/^data: (.+)$/m)
        if (!m) continue
        let frame: IllustrateFrame
        try { frame = JSON.parse(m[1]) as IllustrateFrame } catch { continue }
        if (frame.type === 'plan') {
          setFigMode(frame.mode)
          setFigSteps(frame.items.map(i => ({ index: i.index, status: 'pending', prompt: i.prompt })))
        } else if (frame.type === 'start') {
          setFigSteps(list => list.map(s => (s.index === frame.index ? { ...s, status: 'running' } : s)))
        } else if (frame.type === 'end') {
          setFigSteps(list => list.map(s => (s.index === frame.index
            ? { ...s, status: frame.ok ? 'ok' : 'fail', message: frame.message ?? undefined }
            : s)))
        } else if (frame.type === 'error') {
          setError(`[${frame.code}] ${frame.message}`)
        } else if (frame.type === 'finish') {
          if (frame.blocked) setImgNote({ title: '生图渠道被挡：整批回落 SVG 模板图', lines: [frame.blocked] })
          if (frame.failed > 0) showToast(`${frame.filled} 张已生成，${frame.failed} 张未生成（逐张原因见下方）`)
          else if (frame.redrawn > 0) showToast(`已用真实生图重画 ${frame.redrawn} 张`)
          else showToast(`配图已生成 ${frame.filled} 张`)
        }
      }
    }
  }, [showToast])

  /** 正文配图补齐 / 重画：SSE 逐张进度，回填正文。 */
  const fillFigures = useCallback(async () => {
    if (!editor) return
    const articleId = editor.article.id
    setFigBusy(true)
    setError(null)
    setImgNote(null)
    setFigSteps([])
    try {
      const start = (redraw: boolean) => fetch('/api/media/article/illustrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: articleId, redraw }),
      })

      let res = await start(false)
      // 非流式响应 = 正文里没有 gen: 占位：要么直接报错，要么回报「已有 N 张」等用户确认
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const j = await res.json() as { ok: boolean; message?: string; data?: { existing?: number } }
        if (!res.ok || !j.ok) throw new Error(j.message ?? `HTTP ${res.status}`)
        const n = j.data?.existing ?? 0
        const go = window.confirm(
          `正文里没有待生成的配图占位（占位在上一轮生成时已被替换掉）。\n\n`
          + `检测到已有 ${n} 张配图，多半是上一轮回落生成的模板图。\n`
          + `要用真实生图重画这 ${n} 张吗？`,
        )
        if (!go) {
          showToast(`正文已有 ${n} 张配图，未重画`)
          return
        }
        res = await start(true)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await readIllustrateStream(res)

      // 回读正文：占位已换成真实 URL / 重画后 URL 已换
      const arts = await apiGet<Article[]>('/api/media/articles')
      const fresh = arts.find(a => a.id === articleId)
      if (fresh) {
        setEditor(ed => ed && { ...ed, bodyMd: fresh.bodyMd })
        setPvTab('base')
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setFigBusy(false)
    }
  }, [editor, readIllustrateStream, showError, showToast])

  /** 生成/重写指定平台版本：先保存当前草稿（让模型看到最新原文），再改写。 */
  const rewritePlatform = useCallback(async (platform: string) => {
    if (!editor) return
    setRewriteBusy(platform)
    setError(null)
    try {
      await apiPost('/api/media/article/save', {
        id: editor.article.id,
        title: editor.title.trim() || editor.article.title,
        bodyMd: editor.bodyMd,
        platformVersions: editor.platformVersions,
      })
      const res = await apiPost<{ text: string }>('/api/media/article/rewrite', {
        id: editor.article.id, platform,
      })
      setEditor(ed => ed && { ...ed, platformVersions: { ...ed.platformVersions, [platform]: res.text } })
      setPvTab(platform)
      showToast(`已生成「${PLATFORM_LABEL[platform] ?? platform}」版本`)
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setRewriteBusy(null)
    }
  }, [editor, showError, showToast])

  const saveEditor = useCallback(async () => {
    if (!editor) return
    const title = editor.title.trim()
    if (!title) return
    setEditorBusy(true)
    setError(null)
    try {
      await apiPost('/api/media/article/save', {
        id: editor.article.id, title, bodyMd: editor.bodyMd,
        platformVersions: editor.platformVersions,
      })
      setEditor(null)
      showToast('草稿已保存')
      await loadFeed()
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditorBusy(false)
    }
  }, [editor, loadFeed, showToast])

  const removeEditorArticle = useCallback(async () => {
    if (!editor?.article.id) return
    if (!confirm('确定删除这篇草稿？')) return
    setEditorBusy(true)
    setError(null)
    try {
      await apiPost('/api/media/article/delete', { id: editor.article.id })
      setEditor(null)
      showToast('草稿已删除')
      await loadFeed()
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e))
    } finally {
      setEditorBusy(false)
    }
  }, [editor, loadFeed, showToast])

  // ---------------------------------------------------------- 工作台右栏派生

  const briefItem = useMemo(() => feed?.items.find(i => i.kind === 'brief'), [feed])
  const railHotspots = briefItem?.kind === 'brief' ? briefItem.hotspots.slice(0, 5) : []
  const railMaxHeat = Math.max(1, ...railHotspots.map(h => h.heat ?? 0))

  // 本周（周一至今）成功发布篇数，按天落柱
  const weekCounts = useMemo(() => {
    const now = new Date()
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime()
    const counts = Array.from({ length: 7 }, () => 0)
    for (const item of feed?.items ?? []) {
      if (item.kind !== 'receipt' || item.publish.state !== 'success' || !item.publish.publishedAt) continue
      const day = Math.floor((item.publish.publishedAt - monday) / 86_400_000)
      if (day >= 0 && day < 7) counts[day]++
    }
    return counts
  }, [feed])
  const weekMax = Math.max(1, ...weekCounts)
  const weekTotal = weekCounts.reduce((a, b) => a + b, 0)

  // ---------------------------------------------------------- 渲染

  // 「写作中」= 有正在流式进行的生成；失败已终止的（gen.err）不算，状态回到空闲
  const genActive = gen !== null && !gen.err
  const working = genActive || parsing
  const now = new Date()
  const topDate = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${'日一二三四五六'[now.getDay()]}`
  const meta = PAGE_META[page]

  /* 账号聚合状态：顶栏只占一枚胶囊（账号多也不撑爆），明细走悬停浮层 + 账号管理页。 */
  const accTotal = accounts.length
  const accActive = accounts.filter(a => a.status === 'active').length
  const accExpired = accounts.filter(a => a.status === 'expired').length
  const accDot = accTotal === 0
    ? s.chipDotIdle
    : accExpired > 0
      ? s.chipDotWarn
      : accActive === accTotal
        ? s.chipDotOk
        : s.chipDotIdle

  const navGroup = (id: Page, label: string, opts?: { count?: number; chev?: boolean }): JSX.Element => (
    <button
      className={page === id ? `${s.navGroup} ${s.navGroupActive}` : s.navGroup}
      type="button"
      onClick={() => {
        setPage(id)
        if (id === 'content') setContentOpen(true)
      }}
    >
      <span className={s.navCnt}>{label}</span>
      {opts?.count ? <span className={s.navCntHot}>{opts.count}</span> : null}
      {opts?.chev ? <span className={`${s.navChev} ${contentOpen ? s.navChevOpen : ''}`}>›</span> : null}
    </button>
  )

  return (
    <div className={s.root}>
      {/* ============ 左侧栏 ============ */}
      <aside className={s.sidebar}>
        <div className={s.sbBrand}>
          <span className={s.sealLogo}>媒</span>
          <div>
            <div className={s.sbBrandT}>媒体工作台</div>
            <div className={s.sbBrandS}>Media Studio</div>
          </div>
        </div>
        <nav className={s.nav}>
          {navGroup('workbench', '工作台')}
          {navGroup('accounts', '账号管理')}
          {navGroup('content', '内容管理', { chev: true })}
          <div className={`${s.subnav} ${contentOpen ? s.subnavOpen : ''}`}>
            {CONTENT_SUB.map(sub => (
              <button
                key={sub.id}
                className={page === 'content' && contentTab === sub.id ? `${s.subItem} ${s.subItemActive}` : s.subItem}
                type="button"
                onClick={() => { setPage('content'); setContentTab(sub.id) }}
              >
                {sub.label}
              </button>
            ))}
          </div>
          {navGroup('topics', '选题与热点', { count: feed?.pendingHotspots || undefined })}
          {navGroup('metrics', '数据看板')}
          {navGroup('settings', '设置')}
        </nav>
        <div className={s.navMe}>
          <span className={s.navMeDot} />
          <div>
            <div className={s.navMeName}>{personas[0]?.name ?? '数字员工'} · 在岗</div>
            <div className={s.navMeRole}>{working ? '写作中' : '在线 · 待派活'}</div>
          </div>
        </div>
      </aside>

      {/* ============ 主列 ============ */}
      <div className={s.mainCol}>
        <header className={s.topbar}>
          <div>
            <div className={s.topZh}>{meta.zh}</div>
            <div className={s.topEn}>{meta.en}</div>
          </div>
          <span className={s.topDate}>{topDate}</span>
          <div className={s.statusRow}>
            <span className={s.chip}>
              <span className={`${s.chipDot} ${genActive || parsing ? s.chipDotWarn : accounts.some(a => a.status === 'expired') ? s.chipDotWarn : s.chipDotOk}`} />
              {parsing ? '理解指令…' : genActive ? '写作中…' : '空闲'}
            </span>
            <div className={s.acctWrap}>
              <button
                className={`${s.chip} ${s.chipAcct}`}
                type="button"
                title="账号登录态总览，点击进入账号管理"
                onClick={() => { setPage('accounts') }}
              >
                <span className={`${s.chipDot} ${accDot}`} />
                {accTotal === 0 ? '未接入账号' : `账号 ${accTotal} · ${accActive} 正常`}
              </button>
              {accTotal > 0 && (
                <div className={s.acctPop}>
                  {accounts.map(a => (
                    <div key={a.id} className={s.acctPopRow}>
                      <span className={`${s.chipDot} ${a.status === 'active' ? s.chipDotOk : a.status === 'expired' ? s.chipDotWarn : s.chipDotIdle}`} />
                      <span className={s.acctPopName}>{PLATFORM_LABEL[a.platform] ?? a.platform}</span>
                      <span className={s.acctPopSub}>{a.displayName}</span>
                      <span className={s.acctPopSt}>{ACCOUNT_STATUS_LABEL[a.status] ?? a.status}</span>
                    </div>
                  ))}
                  <div className={s.acctPopHint}>点击进入账号管理</div>
                </div>
              )}
            </div>
            <button
              className={`${s.chip} ${s.chipFolder} ${wsRoot ? '' : s.chipWarn}`}
              type="button"
              title={wsRoot ? `工作文件夹：${wsRoot}` : '点击设置工作文件夹，文章/发布/规划将落盘到此处'}
              onClick={() => { setPage('settings') }}
            >
              {wsRoot ? (wsRoot.length > 26 ? `…${wsRoot.slice(-25)}` : wsRoot) : '设置工作文件夹'}
            </button>
            <button
              className={s.btnSettings}
              type="button"
              title="设置"
              onClick={() => { setPage('settings') }}
            >
              设置
            </button>
          </div>
        </header>

        {/* 生成置顶卡（全局）：任何页面都能看到写作进度与报错 */}
        {gen && (
          <div className={s.genBar}>
            <div className={s.card}>
              <div className={s.cardHead}>
                <span className={s.cardTitle}>{gen.err ? `写作中断：${gen.title}` : `正在写：${gen.title}`}</span>
                {!gen.err && <span className={`${s.chip} ${s.chipAccent}`}>生成中…</span>}
                <button
                  className={s.btnDanger}
                  type="button"
                  onClick={() => {
                    abortRef.current?.abort()
                    setGen(null)
                  }}
                >
                  {gen.err ? '知道了' : '停止'}
                </button>
              </div>
              {gen.err && <div className={s.errorText}>{gen.err}</div>}
              {!gen.err && gen.text && <div className={s.genBody}>{gen.text}<span className={s.caret} /></div>}
              {!gen.err && !gen.text && (
                <div className={s.genBody}>
                  {gen.sessionId
                    ? '已派给 dsh 会话执行写作，完成后正文自动回填内容库；可到会话列表「媒体工作台 · 标题」查看写作过程。'
                    : '正在排队…'}
                </div>
              )}
              {gen.warns !== undefined && gen.warns.length > 0 && (
                <div className={s.imgNote}>
                  <div className={s.imgNoteTitle}>配图未真实生成（已回落 SVG 模板图）</div>
                  {gen.warns.map((m, i) => <div key={i} className={s.imgNoteLine}>{m}</div>)}
                </div>
              )}
            </div>
          </div>
        )}

        <div className={s.pageScroll}>
          <div className={s.pagePad}>
            <div className={s.page} key={page}>
              {page === 'workbench' && (
                <div className={s.wbGrid}>
                  {/* ---- 动态流列 ---- */}
                  <section className={s.feedCol}>
                    {error && <div className={s.errorText}>{error}</div>}

                    <div className={s.composerWrap}>
                      <div className={s.composerLabel}>Dispatch · 一句话派活</div>
                      <div className={s.composer}>
                        <input
                          className={s.composerInput}
                          placeholder="例如：写一篇 AI 编程助手实测，发到知乎和公众号"
                          value={nlText}
                          onChange={e => { setNlText(e.target.value) }}
                          onKeyDown={e => { if (e.key === 'Enter') void submitNl() }}
                          disabled={working}
                        />
                        <button
                          className={s.composerSend}
                          type="button"
                          disabled={!nlText.trim() || working}
                          onClick={() => { void submitNl() }}
                        >
                          {parsing ? '理解中…' : '派活'}
                        </button>
                      </div>
                      <div className={s.rowWrap}>
                        <button className={s.stamp} type="button" onClick={() => { setDispatch({ topic: '' }) }}>
                          派题写作
                        </button>
                        <button className={s.stamp} type="button" disabled={briefBusy} onClick={() => { void refreshBrief() }}>
                          {briefBusy ? '刷热榜中…' : '抓一波热点'}
                        </button>
                        <button className={s.stamp} type="button" disabled={syncBusy} onClick={() => { void syncData() }}>
                          {syncBusy ? '同步中…' : '同步阅读数据'}
                        </button>
                      </div>
                    </div>

                    {/* 生成置顶卡已上移到全局（mainCol 顶部），任何页面都可见 */}

                    {/* 今日简报补卡：无简报且不在生成中 */}
                    {!briefItem && !gen && (
                      <div className={s.card}>
                        <div className={s.cardHead}>
                          <span className={s.cardTitle}>今天还没有热点简报</span>
                        </div>
                        <div className={s.cardBody}>让我去刷一轮各平台热榜，挑几条值得写的。</div>
                        <div className={s.rowWrap}>
                          <button
                            className={s.btnPrimary}
                            type="button"
                            disabled={briefBusy}
                            onClick={() => { void refreshBrief() }}
                          >
                            {briefBusy ? '正在刷热榜…' : '生成今日简报'}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 汇报动态流 */}
                    {feed && feed.items.length === 0 && !gen && (
                      <div className={s.tiny}>暂无动态。派个活，或先抓一波热点。</div>
                    )}
                    {feed?.items.map(item => (
                      <FeedCard key={item.id} item={item} busy={busy} actions={actions} />
                    ))}
                  </section>

                  {/* ---- 右栏速览 ---- */}
                  <aside className={s.railCol}>
                    <div className={s.railCard}>
                      <div className={s.railTitle}>今日热点 <small>HOT BOARD</small></div>
                      {railHotspots.length === 0 && <div className={s.tiny}>还没有简报，点「抓一波热点」。</div>}
                      {railHotspots.map((h, i) => (
                        <div key={h.id} className={s.heatRow}>
                          <span className={s.heatNo}>{String(i + 1).padStart(2, '0')}</span>
                          <div className={s.heatMain}>
                            <div className={s.heatTitle} title={h.title}>{h.title}</div>
                            <div className={s.heatBar}>
                              <div className={s.heatFill} style={{ width: `${Math.round(((h.heat ?? 0) / railMaxHeat) * 100)}%` }} />
                            </div>
                          </div>
                          <span className={s.heatVal}>{h.heat != null ? h.heat : '—'}</span>
                        </div>
                      ))}
                      <button className={s.quick} type="button" onClick={() => { setPage('topics') }}>
                        查看全部热点 →
                      </button>
                    </div>

                    <div className={s.railCard}>
                      <div className={s.railTitle}>账号健康 <small>ACCOUNTS</small></div>
                      {accounts.length === 0 && <div className={s.tiny}>还没有接入账号。</div>}
                      {accounts.map(a => (
                        <div key={a.id} className={s.acctRow}>
                          <span
                            className={s.acctSt}
                            style={{
                              color: a.status === 'active' ? 'var(--ms-success)' : a.status === 'expired' ? 'var(--ms-warn)' : 'var(--ms-text3)',
                              borderColor: a.status === 'active' ? 'var(--ms-success)' : a.status === 'expired' ? 'var(--ms-warn)' : undefined,
                            }}
                          >
                            {a.status === 'active' ? '正常' : a.status === 'expired' ? '过期' : '停用'}
                          </span>
                          <span className={s.acctNm}>{a.displayName}</span>
                          <span className={s.acctQt}>
                            {a.status !== 'active'
                              ? '—'
                              : (a.publishTotal ?? 0) === 0
                                ? '未发过'
                                : `今日 ${a.sentToday ?? 0}/自设上限 ${a.dailyLimit}`}
                          </span>
                        </div>
                      ))}
                      <button className={s.quick} type="button" onClick={() => { setPage('accounts') }}>
                        管理账号 →
                      </button>
                    </div>

                    <div className={s.railCard}>
                      <div className={s.railTitle}>本周发布 <small>THIS WEEK</small></div>
                      <div className={s.week}>
                        {weekCounts.map((n, i) => (
                          <div
                            key={i}
                            className={`${s.weekBar} ${n > 0 && n === weekMax ? s.weekBarMax : ''}`}
                            style={{ height: `${Math.max(6, Math.round((n / weekMax) * 100))}%` }}
                            title={`周${WEEK_LB[i]} · ${n} 篇`}
                          />
                        ))}
                      </div>
                      <div className={s.weekLb}>
                        {WEEK_LB.map(d => <span key={d}>{d}</span>)}
                      </div>
                      <div className={s.weekTotal}>本周已发 {weekTotal} 篇</div>
                    </div>
                  </aside>
                </div>
              )}

              {page === 'accounts' && (
                <AccountsPage
                  accounts={accounts}
                  reloadAccounts={loadAccounts}
                  onError={showError}
                />
              )}

              {page === 'content' && (
                <ContentPage
                  key={contentTab}
                  accounts={accounts}
                  initialTab={contentTab}
                  onEdit={a => { actions.onEdit(a) }}
                  onRegenerate={async a => { actions.onRegenerate(a) }}
                  onError={showError}
                />
              )}

              {page === 'topics' && (
                <TopicsPage
                  onWriteHotspot={writeHotspot}
                  writeBusyId={writeBusyId}
                  onError={showError}
                />
              )}

              {page === 'metrics' && <MetricsPage />}

              {page === 'settings' && (
                <SettingsPage
                  wsRoot={wsRoot}
                  onSetWsRoot={setWsRoot}
                  onError={showError}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 派活确认弹窗 */}
      {dispatch && (
        <DispatchModal
          request={dispatch}
          accounts={accounts}
          personas={personas}
          onClose={() => { setDispatch(null) }}
          onConfirm={p => { void confirmDispatch(p) }}
        />
      )}

      {/* 草稿编辑器弹窗 */}
      {editor && (
        <div className={s.overlay} onClick={() => { setEditor(null) }}>
          <div className={s.modal} onClick={e => { e.stopPropagation() }}>
            <div className={s.h2}>编辑草稿</div>
            <input
              className={s.input}
              value={editor.title}
              placeholder="标题"
              onChange={e => { setEditor(ed => ed && { ...ed, title: e.target.value }) }}
            />
            <div className={s.pvTabs}>
              <button
                type="button"
                className={pvTab === 'base' ? `${s.pvTab} ${s.pvTabActive}` : s.pvTab}
                onClick={() => setPvTab('base')}
              >
                原文
              </button>
              {PLATFORM_IDS.map(pf => (
                <button
                  key={pf}
                  type="button"
                  className={pvTab === pf ? `${s.pvTab} ${s.pvTabActive}` : s.pvTab}
                  onClick={() => setPvTab(pf)}
                >
                  {PLATFORM_LABEL[pf]}{editor.platformVersions[pf] ? '' : ' ·未生成'}
                </button>
              ))}
              <span className={s.spacer} />
              {pvTab !== 'base' && (
                <button
                  className={s.btn}
                  type="button"
                  disabled={rewriteBusy === pvTab}
                  onClick={() => { void rewritePlatform(pvTab) }}
                >
                  {rewriteBusy === pvTab
                    ? '改写中…'
                    : editor.platformVersions[pvTab] ? '重新改写' : '生成平台版本'}
                </button>
              )}
            </div>
            <textarea
              ref={editorTaRef}
              className={s.textarea}
              style={{ minHeight: 260 }}
              value={pvTab === 'base' ? editor.bodyMd : (editor.platformVersions[pvTab] ?? '')}
              placeholder={pvTab === 'base'
                ? '正文（Markdown，可用 ![说明](图片URL) 插图）'
                : `「${PLATFORM_LABEL[pvTab] ?? pvTab}」平台版本：点右上「生成平台版本」，或直接编辑`}
              onChange={e => updateCurrentText(() => e.target.value)}
            />
            <div className={s.rowWrap}>
              <button className={s.btn} type="button" disabled={imgBusy} onClick={() => { editorFileRef.current?.click() }}>
                {imgBusy ? '上传中…' : '插入本地图片'}
              </button>
              <button className={s.btn} type="button" onClick={insertUrlImage}>网络图片</button>
              <button className={s.btn} type="button" disabled={coverBusy} onClick={() => { void generateCover() }}>
                {coverBusy ? '生成中…' : '生成封面'}
              </button>
              <button className={s.btn} type="button" disabled={figBusy} onClick={() => { void fillFigures() }}>
                {figBusy ? '配图生成中…' : '补齐正文配图'}
              </button>
              <button className={s.btn} type="button" onClick={() => { insertFigureSpot() }} title="在光标处插入一个配图位">
                + 配图位
              </button>
              <input
                ref={editorFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                style={{ display: 'none' }}
                onChange={e => { void onPickLocalImage(e.target.files?.[0]) }}
              />
              <span className={s.spacer} />
              <button
                className={s.btnPrimary}
                type="button"
                disabled={editorBusy || editor.title.trim() === ''}
                onClick={() => { void saveEditor() }}
              >
                {editorBusy ? '保存中…' : '保存'}
              </button>
              <button className={s.btn} type="button" onClick={() => { setEditor(null) }}>关闭</button>
              <span className={s.spacer} />
              <button
                className={s.btnDanger}
                type="button"
                disabled={editorBusy}
                onClick={() => { void removeEditorArticle() }}
              >
                删除
              </button>
            </div>
            {figSteps.length > 0 && (() => {
              const done = figSteps.filter(x => x.status === 'ok' || x.status === 'fail').length
              const okN = figSteps.filter(x => x.status === 'ok').length
              const head = figBusy
                ? `配图生成中 ${done}/${figSteps.length}（${figMode === 'redraw' ? '重画' : '补齐'}）`
                : `配图完成 ${okN}/${figSteps.length}${figMode === 'redraw' ? '（重画）' : ''}`
              return (
                <div className={s.figSteps}>
                  <div className={s.figStepsHead}>{head}</div>
                  {figSteps.map(st => (
                    <div key={st.index} className={s.figStepRow}>
                      <span className={
                        st.status === 'ok' ? s.figStepOk
                          : st.status === 'fail' ? s.figStepFail
                            : s.figStepWait
                      }>
                        {st.status === 'ok' ? '✓' : st.status === 'fail' ? '✗' : st.status === 'running' ? '⏳' : '·'}
                      </span>
                      <span className={s.figStepText}>
                        第 {st.index} 张
                        {st.status === 'running' ? ' 生成中…' : ''}
                        {st.status === 'pending' ? ' 等待中' : ''}
                        {st.status === 'ok' ? ' 完成' : ''}
                        {st.status === 'fail'
                          ? ` 失败：${st.message ?? '未知原因'}${figMode === 'redraw' ? '（已保留原图）' : ''}`
                          : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )
            })()}
            {imgNote && (
              <div className={s.imgNote}>
                <div className={s.imgNoteTitle}>{imgNote.title}</div>
                {imgNote.lines.map((m, i) => <div key={i} className={s.imgNoteLine}>{m}</div>)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 轻提示 */}
      {toast && <div className={s.toast}>{toast}</div>}
    </div>
  )
}
