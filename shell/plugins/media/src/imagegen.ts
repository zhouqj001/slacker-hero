/**
 * 生图适配器 —— 把「谁生成封面」从 assets.ts 解耦。
 *
 * 配置结构借鉴 dsh 生态里成熟生图插件：**多渠道并存**（每渠道 = 端点 + 凭据 + 模型列表），
 * 外加总开关与「允许 agent 自动配图」独立开关——用户手动点生成和 agent 自行决定要图
 * 是两件事，后者会花钱，必须显式授权。默认两个开关都关。
 *
 * 所有生效配置存在 domain global（壳每次启动会覆盖 profile 配置文件，
 * 写在配置文件里的 key/端点/模型都不持久）。
 * @module @slacker/media/imagegen
 */
import type { MediaDomain } from './domain.ts'

/**
 * 出图接口协议方言：
 * - `openai`：官方 / 硅基流动等，OpenAI Images 形态，分辨率字段 `image_size`。
 * - `dashscope`：阿里云百炼千问图像（DashScope 原生 multimodal-generation 形态）：
 *   请求体 `input.messages` + `parameters`，分辨率字段 `parameters.size`（星号分隔）。
 */
export type ImageProtocol = 'openai' | 'dashscope'

/** 一个生图渠道 = 一组端点 + 凭据 + 该服务下的模型列表。 */
export interface ImageChannel {
  /** 稳定 id，供 defaultChannelId 引用。 */
  id: string
  /** 人看的渠道名，如「硅基流动」。 */
  name: string
  /** API 端点，OpenAI 兼容格式。 */
  baseUrl: string
  /** 凭据，不回显。 */
  apiKey: string
  /** 该渠道下的模型：alias 是给人看的短名，id 是上游真实 id。 */
  models: { alias: string; id: string }[]
  /** 协议方言，决定请求体字段名。缺省 openai。 */
  protocol: ImageProtocol
}

/** 生效的生图配置（多渠道版）。 */
export interface ImageGenRuntime {
  /** 总开关：关掉后一律走 SVG 模板，不发任何外部请求。 */
  enabled: boolean
  /**
   * 「允许 agent 自动配图」独立于总开关——agent 出图花钱，必须显式授权。默认关闭。
   */
  allowAgent: boolean
  channels: ImageChannel[]
  /** 默认渠道 id；无效时由 resolveChannel 挑第一个可用渠道。 */
  defaultChannelId: string
}

/** 生图请求。 */
export interface ImageGenRequest {
  /** 文章标题（template 适配器直接排版它）。 */
  title: string
  /** 提示词（AI 渠道用）。 */
  prompt: string
  /** 输出尺寸（AI 渠道用）。 */
  size?: string
}

/** 生图结果：二进制或 SVG 文本 + 扩展名。 */
export interface ImageGenResult {
  data: Uint8Array | string
  ext: 'png' | 'jpg' | 'webp' | 'svg'
}

export interface ImageGenAdapter {
  readonly id: string
  readonly label: string
  /** 不接渠道（模板）或接渠道（AI）都可能；由 resolveImagePlan 决定。 */
  generate(req: ImageGenRequest, channel: ImageChannel | null): Promise<ImageGenResult>
}

/** 标题 hash 选色（确定性，同一文章每次生成同款封面）。 */
function paletteOf(title: string): [string, string] {
  const palettes: Array<[string, string]> = [
    ['#4f46e5', '#06b6d4'],
    ['#7c3aed', '#ec4899'],
    ['#ea580c', '#facc15'],
    ['#059669', '#3b82f6'],
    ['#2563eb', '#a78bfa'],
  ]
  let h = 0
  for (const ch of title) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return palettes[h % palettes.length]
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 无生图 API 时的兜底封面：品牌渐变 + 标题排版（1200x675，webview 直接渲染）。 */
export function svgCover(title: string): string {
  const [c1, c2] = paletteOf(title)
  const chars = [...title]
  const lines: string[] = []
  for (let i = 0; i < chars.length && lines.length < 3; i += 14) {
    lines.push(chars.slice(i, i + 14).join(''))
  }
  if (lines.length === 3 && chars.length > 42) lines[2] = [...lines[2]].slice(0, 13).join('') + '…'
  const tspans = lines
    .map((l, i) => `<tspan x="90" dy="${i === 0 ? 0 : 78}">${xmlEscape(l)}</tspan>`)
    .join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>`,
    `</linearGradient></defs>`,
    `<rect width="1200" height="675" fill="url(#g)"/>`,
    `<circle cx="1050" cy="90" r="220" fill="rgba(255,255,255,0.10)"/>`,
    `<circle cx="120" cy="620" r="160" fill="rgba(255,255,255,0.08)"/>`,
    `<text x="90" y="310" font-family="'PingFang SC','Microsoft YaHei',sans-serif" font-size="56" font-weight="700" fill="#ffffff">${tspans}</text>`,
    `<text x="90" y="606" font-family="sans-serif" font-size="22" letter-spacing="4" fill="rgba(255,255,255,0.7)">MEDIA STUDIO</text>`,
    `</svg>`,
  ].join('\n')
}

/** 模板适配器：本地 SVG，无需任何凭据，永远可用。 */
export const templateAdapter: ImageGenAdapter = {
  id: 'template',
  label: 'SVG 模板封面',
  async generate(req) {
    return { data: svgCover(req.title), ext: 'svg' }
  },
}

/**
 * OpenAI 兼容的 images API（硅基流动 / 百炼 / OpenAI 官方 … 都属这一类）：
 * 生成 → 下载为字节（远程 URL 是临时的，必须落盘）。
 */
export const openaiCompatibleAdapter: ImageGenAdapter = {
  id: 'openai',
  label: 'OpenAI 兼容生图接口',
  async generate(req, channel) {
    if (!channel) throw new Error('没有可用渠道')
    const model = channel.models.find(m => m.id !== '')?.id
    if (!model) throw new Error(`渠道「${channel.name}」没有可用的模型 id`)
    const res = await fetch(`${channel.baseUrl.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify({ model, prompt: req.prompt, image_size: req.size ?? '1024x1024', n: 1 }),
    })
    if (!res.ok) throw new Error(`生图接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
    const data = await res.json() as { data?: Array<{ url?: string; b64_json?: string }>; images?: Array<{ url?: string; b64_json?: string }> }
    const item = data.data?.[0] ?? data.images?.[0]
    if (item?.b64_json) return { data: new Uint8Array(Buffer.from(item.b64_json, 'base64')), ext: 'png' }
    if (!item?.url) throw new Error('生图接口响应中没有图片')
    const imgRes = await fetch(item.url)
    if (!imgRes.ok) throw new Error(`图片下载 HTTP ${imgRes.status}`)
    return { data: new Uint8Array(await imgRes.arrayBuffer()), ext: 'png' }
  },
}

/**
 * 把渠道配的 baseUrl 折算成 **DashScope 原生 API 根**（形如 `.../api/v1`）。
 *
 * 千问图像的 OpenAI 兼容入口只在业务空间专属域名上提供（`{WorkspaceId}.<region>.maas.aliyuncs.com`），
 * 公共域名 `dashscope.aliyuncs.com` 上的 `/compatible-mode/v1/images/generations` 已下线（实测 404 空响应）；
 * 而原生入口 `.../services/aigc/multimodal-generation/generation` 在公共域名上仍在服务（实测 401 =
 * 路由存在，只是缺 Key），且**不需要** 业务空间 ID。故走原生协议，存量渠道配的
 * `/compatible-mode/v1` 在这里自动折算，用户无需重配。
 */
export function dashscopeNativeBase(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/compatible-mode\/v1$/, '/api/v1')
}

/**
 * 阿里云百炼（DashScope）原生协议的千问图像接口。
 *
 * 与 {@link openaiCompatibleAdapter} 不同，不是 OpenAI Images 形态：请求体是
 * `{ model, input: { messages: [{ role, content: [{ text }] }] }, parameters }`，
 * 分辨率字段 `parameters.size` 用星号（`1024*1024`，OpenAI 兼容态才用字母 `x`）；
 * 响应取 `output.choices[0].message.content[].image`，同样是 24 小时有效的临时 URL，必须落盘。
 */
export const dashscopeAdapter: ImageGenAdapter = {
  id: 'dashscope',
  label: '阿里云百炼 DashScope（千问图像）',
  async generate(req, channel) {
    if (!channel) throw new Error('没有可用渠道')
    const model = channel.models.find(m => m.id !== '')?.id
    if (!model) throw new Error(`渠道「${channel.name}」没有可用的模型 id`)
    const base = dashscopeNativeBase(channel.baseUrl)
    if (base === '') throw new Error(`渠道「${channel.name}」没有配置端点`)
    const parameters: Record<string, unknown> = { n: 1, prompt_extend: true }
    if (req.size) parameters.size = req.size.replace('x', '*')
    const res = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ text: req.prompt }] }] },
        parameters,
      }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`生图接口 HTTP ${res.status}：${text.slice(0, 300)}`)
    let data: {
      code?: string
      message?: string
      output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> }
    }
    try {
      data = JSON.parse(text) as typeof data
    } catch {
      throw new Error(`生图接口响应不是 JSON：${text.slice(0, 200)}`)
    }
    if (data.code) throw new Error(`生图接口错误 ${data.code}：${data.message ?? ''}`)
    const url = data.output?.choices?.[0]?.message?.content?.find(c => c.image)?.image
    if (!url) throw new Error(`生图接口响应中没有图片：${text.slice(0, 300)}`)
    const imgRes = await fetch(url)
    if (!imgRes.ok) throw new Error(`图片下载 HTTP ${imgRes.status}`)
    return { data: new Uint8Array(await imgRes.arrayBuffer()), ext: 'png' }
  },
}

/** 按协议方言挑适配器。 */
export function adapterForProtocol(protocol: ImageProtocol): ImageGenAdapter {
  return protocol === 'dashscope' ? dashscopeAdapter : openaiCompatibleAdapter
}

/** 预设渠道：设置页「一键添加」用，省掉手抄端点和模型 id。 */
export interface ImagePreset {
  id: string
  /** 按钮文案。 */
  label: string
  /** 预填的渠道名。 */
  name: string
  protocol: ImageProtocol
  baseUrl: string
  models: { alias: string; id: string }[]
}

/** 内置渠道预设（端点 + 该服务下的图像模型）。 */
export const IMAGE_PRESETS: ImagePreset[] = [
  {
    id: 'dashscope',
    label: '阿里云百炼 · 千问图像',
    name: '阿里云百炼',
    protocol: 'dashscope',
    // 公共域名（无需业务空间 ID）。若已迁到业务空间专属域名，把 baseUrl 换成
    // `https://<业务空间ID>.<地域>.maas.aliyuncs.com/api/v1` 即可（compatible-mode 会自动折算）。
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    models: [
      { alias: '千问图像 3.0', id: 'qwen-image-3.0' },
      { alias: '千问图像 3.0 Pro', id: 'qwen-image-3.0-pro' },
      { alias: '千问图像 2.1 Turbo', id: 'qwen-image-2.1-turbo' },
      { alias: '千问图像 2.1 Pro', id: 'qwen-image-2.1-pro' },
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    name: '硅基流动',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [{ alias: 'Kolors', id: 'Kwai-Kolors/Kolors' }],
  },
]

/** 渠道是否真能出图（端点 + Key + 至少一个模型）。 */
export function channelReady(c: ImageChannel): boolean {
  return c.baseUrl !== '' && c.apiKey !== '' && c.models.some(m => m.id !== '')
}

/** 挑出要用的渠道：有凭据、有模型、且（若指定）命中默认渠道。 */
export function resolveChannel(rt: ImageGenRuntime): ImageChannel | null {
  const usable = rt.channels.filter(channelReady)
  if (usable.length === 0) return null
  return usable.find(c => c.id === rt.defaultChannelId) ?? usable[0]
}

/** 从 domain global 读多渠道配置；老数据（旧四项）自动折成一个渠道。 */
export function imageGenRuntime(domain: MediaDomain): ImageGenRuntime {
  const g = domain.global.get() as Record<string, unknown>
  const bool = (key: string): boolean => g[key] === true
  const raw = g['imageGen:channels']
  let channels: ImageChannel[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[]).map((c, i) => ({
        id: typeof c.id === 'string' && c.id !== '' ? c.id : `ch${i + 1}`,
        name: typeof c.name === 'string' && c.name !== '' ? c.name : `渠道 ${i + 1}`,
        baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
        apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
        models: Array.isArray(c.models)
          ? (c.models as Record<string, unknown>[])
              .map(m => ({ alias: typeof m?.alias === 'string' ? m.alias : '', id: typeof m?.id === 'string' ? m.id : '' }))
              .filter(m => m.alias !== '' || m.id !== '')
          : [],
        // 存量渠道没写 protocol，按 openai 方言处理（老行为不变）
        protocol: c.protocol === 'dashscope' ? 'dashscope' : 'openai',
      }))
    : []
  // 老数据（单组 provider/baseUrl/apiKey/model）折成一个渠道，别让用户重配。
  // 只有「还没迁到 channels」的存量数据才享受「配过 Key 就默认开着」，新界面一律默认关。
  let migrated = false
  if (channels.length === 0) {
    const legacyBase = typeof g['imageGen:baseUrl'] === 'string' ? g['imageGen:baseUrl'] as string : ''
    const legacyModel = typeof g['imageGen:model'] === 'string' ? g['imageGen:model'] as string : ''
    if (raw === undefined && (legacyBase !== '' || legacyModel !== '')) {
      channels = [{
        id: 'default',
        name: '旧配置',
        baseUrl: legacyBase,
        apiKey: typeof g['imageGen:apiKey'] === 'string' ? g['imageGen:apiKey'] as string : '',
        models: legacyModel === '' ? [] : [{ alias: legacyModel, id: legacyModel }],
        protocol: 'openai' as const,
      }]
      migrated = true
    }
  }
  const dflt = typeof g['imageGen:defaultChannelId'] === 'string' ? g['imageGen:defaultChannelId'] : ''
  return {
    enabled: typeof g['imageGen:enabled'] === 'boolean' ? g['imageGen:enabled'] === true : (migrated && channels.some(channelReady)),
    allowAgent: bool('imageGen:allowAgent'),
    channels,
    defaultChannelId: channels.some(c => c.id === dflt) ? dflt : (channels[0]?.id ?? ''),
  }
}

/** 出图计划：走哪个适配器、走哪个渠道、被什么挡住。永不缺适配器——最差是模板。 */
export interface ImagePlan {
  adapter: ImageGenAdapter
  channel: ImageChannel | null
  /** 非 null 时表示真实出图被挡（只影响 AI 渠道，模板照常可用）。 */
  blocked: string | null
}

/**
 * 解析出图计划。
 * @param forAgent true = agent 自动配图路径，额外要求「允许 agent 自动配图」已开。
 */
export function resolveImagePlan(domain: MediaDomain, opts: { forAgent?: boolean } = {}): ImagePlan {
  const rt = imageGenRuntime(domain)
  if (!rt.enabled) return { adapter: templateAdapter, channel: null, blocked: '生图总开关已关闭，出图走 SVG 模板' }
  if (opts.forAgent && !rt.allowAgent) {
    return { adapter: templateAdapter, channel: null, blocked: '未授权 agent 自动配图（设置页需勾选「允许 agent 自动配图」），出图走 SVG 模板' }
  }
  const ch = resolveChannel(rt)
  if (!ch) return { adapter: templateAdapter, channel: null, blocked: '没有可用渠道（需要端点 + Key + 至少一个模型），出图走 SVG 模板' }
  return { adapter: adapterForProtocol(ch.protocol), channel: ch, blocked: null }
}

/** 供设置页展示：开关、渠道统计、生效渠道、不可用原因（不泄露 key 本体）。 */
export function imageAdapterStatus(domain: MediaDomain): {
  enabled: boolean
  allowAgent: boolean
  defaultChannelId: string
  /** 已配置渠道数 / 其中真能出图的数。 */
  channelCount: number
  readyCount: number
  /** 生效渠道名；走模板兜底时为 null。 */
  activeChannel: string | null
  activeModel: string | null
  blockedReason: string | null
} {
  const rt = imageGenRuntime(domain)
  const plan = resolveImagePlan(domain)
  const ch = plan.channel
  return {
    enabled: rt.enabled,
    allowAgent: rt.allowAgent,
    defaultChannelId: rt.defaultChannelId,
    channelCount: rt.channels.length,
    readyCount: rt.channels.filter(channelReady).length,
    activeChannel: ch ? ch.name : null,
    activeModel: ch ? (ch.models.find(m => m.id !== '')?.alias || ch.models.find(m => m.id !== '')?.id || null) : null,
    blockedReason: plan.blocked,
  }
}