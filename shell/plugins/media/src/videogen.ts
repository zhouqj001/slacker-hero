/**
 * 视频生成适配位（G7）—— 与生图同构的 adapter 形状。
 *
 * 当前只注册 `none`（未接入）：调用方拿不到适配器时一律走「明确不支持」分支，
 * 不会静默产出假视频。接入真实供应商时：实现 `VideoGenAdapter`、注册进
 * `VIDEO_ADAPTERS`、并在 `resolveVideoAdapter` 里解析即可，路由与调用方无需改动。
 * @module @slacker/media/videogen
 */
import type { MediaDomain } from './domain.ts'

/** 视频生成请求。 */
export interface VideoGenRequest {
  /** 标题（用于脚本/分镜提示）。 */
  title: string
  /** 口播/字幕脚本文本（Markdown）。 */
  scriptMd: string
  /** 画幅。 */
  aspect?: '16:9' | '9:16' | '1:1'
  /** 目标时长（秒）。 */
  durationSeconds?: number
}

/** 视频生成结果。 */
export interface VideoGenResult {
  data: Uint8Array
  ext: 'mp4' | 'webm'
}

export interface VideoGenAdapter {
  readonly id: string
  readonly label: string
  /** 是否已配置可用。 */
  available(domain: MediaDomain): boolean
  generate(req: VideoGenRequest, domain: MediaDomain): Promise<VideoGenResult>
}

/** 占位适配器：永远不可用。 */
export const noneVideoAdapter: VideoGenAdapter = {
  id: 'none',
  label: '未接入视频生成',
  available: () => false,
  async generate() {
    throw new Error('未接入视频生成供应商')
  },
}

/** 已注册供应商（id → adapter）。 */
export const VIDEO_ADAPTERS: Record<string, VideoGenAdapter> = {
  none: noneVideoAdapter,
}

/**
 * 解析生效的视频适配器；没有可用供应商时返回 null
 * （调用方应返回 VIDEO_NOT_CONFIGURED，而不是兜底造假结果）。
 */
export function resolveVideoAdapter(domain: MediaDomain): VideoGenAdapter | null {
  const g = domain.global.get() as Record<string, unknown>
  const id = typeof g['videoGen:provider'] === 'string' ? g['videoGen:provider'] : 'none'
  const found = VIDEO_ADAPTERS[id]
  if (found && found.available(domain)) return found
  return null
}

/** 供设置页展示的供应商清单。 */
export function videoAdapterStatus(domain: MediaDomain): Array<{ id: string; label: string; available: boolean }> {
  return Object.values(VIDEO_ADAPTERS).map(a => ({
    id: a.id,
    label: a.label,
    available: a.available(domain),
  }))
}