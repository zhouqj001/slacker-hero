/**
 * 书源 HTTP 抓取层（壳版）—— 主应用 booksource/http.ts 的移植：
 * 模板渲染 + 请求头合并 + warmup 与原作一致；底层替换为壳命令
 * `slacker_http_fetch`（绕 CORS，重定向/gzip 在 Rust 侧处理），
 * 字符集解码（UTF-8 乱码回退 GBK）留在 webview 的 TextDecoder。
 * 纯浏览器开发态回退原生 fetch（可能受 CORS 限制，仅本地调试用）。
 */
import type { RequestSpec, HttpConfig } from './types.ts'
import { applyTemplate } from './rule.ts'
import { shellInvoke } from '../../ipc.ts'

/* ── 字符集（同原作） ── */

/** 用指定编码解码 ArrayBuffer。 */
export function decodeBuffer(buf: ArrayBuffer, charset: string): string {
  const cs = charset.toLowerCase()
  try {
    const dec = new TextDecoder(cs === 'gb2312' ? 'gbk' : cs)
    return dec.decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

/** 检测字符串是否含乱码（大量替换字符 U+FFFD）。 */
function looksMojibake(s: string): boolean {
  if (!s) return false
  const sample = s.slice(0, 2000)
  return ((sample.match(/\uFFFD/g) ?? []).length) > 5
}

/* ── 结果/请求形状（同原作） ── */

export interface FetchResult {
  body: string
  finalUrl: string
  status: number
  headers: Record<string, string>
}

export interface PreparedRequest {
  url: string
  method: 'GET' | 'POST'
  body?: string
  headers: Record<string, string>
  charset: 'auto' | 'utf-8' | 'gbk' | 'gb18030'
}

/** base64 → ArrayBuffer（IPC body 传输）。 */
function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** 按 charset 解码（auto：UTF-8 乱码回退 GBK，同原作）。 */
function decodeBody(buf: ArrayBuffer, charset: PreparedRequest['charset']): string {
  let text = decodeBuffer(buf, charset === 'auto' ? 'utf-8' : charset)
  if (charset === 'auto' && looksMojibake(text)) {
    const gbkText = decodeBuffer(buf, 'gbk')
    if (!looksMojibake(gbkText)) text = gbkText
  }
  return text
}

/** 壳内：走 slacker_http_fetch；浏览器：原生 fetch。 */
async function doFetch(req: PreparedRequest): Promise<FetchResult> {
  const headerPairs: [string, string][] = Object.entries(req.headers)
  const invoke = shellInvoke()

  if (invoke !== undefined) {
    const r = (await invoke('slacker_http_fetch', {
      url: req.url,
      method: req.method,
      headers: headerPairs,
      body: req.body ?? null,
    })) as { status: number; final_url: string; body_b64: string }
    return {
      body: decodeBody(b64ToBuffer(r.body_b64), req.charset),
      finalUrl: r.final_url || req.url,
      status: r.status,
      headers: {},
    }
  }

  const resp = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'POST' ? req.body : undefined,
  })
  const buf = await resp.arrayBuffer()
  return {
    body: decodeBody(buf, req.charset),
    finalUrl: resp.url || req.url,
    status: resp.status,
    headers: {},
  }
}

/* ── 请求准备（同原作） ── */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 把 RequestSpec + 变量渲染成实际请求。 */
export function prepareRequest(
  spec: RequestSpec,
  vars: Record<string, string>,
  http?: HttpConfig,
): PreparedRequest {
  const headers: Record<string, string> = {
    'User-Agent': http?.userAgent ?? DEFAULT_UA,
    ...(http?.headers ?? {}),
    ...(spec.headers ?? {}),
  }
  if (spec.method === 'POST' && spec.body !== undefined && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  return {
    url: applyTemplate(spec.url, vars),
    method: spec.method ?? 'GET',
    body: spec.body !== undefined ? applyTemplate(spec.body, vars) : undefined,
    headers,
    charset: spec.charset ?? http?.charset ?? 'auto',
  }
}

/* ── 顶层抓取（带 warmup，同原作） ── */

export interface FetchOptions {
  base?: string
  http?: HttpConfig
  vars?: Record<string, string>
}

/** 抓取单个请求规格，返回解码后的文本。 */
export async function fetchRequestSpec(
  spec: RequestSpec,
  opts: FetchOptions,
): Promise<FetchResult> {
  const vars = { base: opts.base ?? '', ...(opts.vars ?? {}) }
  if (opts.http?.warmup !== undefined && opts.http.warmup.length > 0) {
    for (const wu of opts.http.warmup) {
      try { await doFetch(prepareRequest({ url: wu, method: 'GET' }, vars, opts.http)) }
      catch { /* warmup 失败忽略 */ }
    }
  }
  return doFetch(prepareRequest(spec, vars, opts.http))
}

/** 判断是否被反爬挑战拦截（粗判，同原作）。 */
export function isChallengePage(body: string): boolean {
  if (!body) return false
  const lower = body.slice(0, 5000).toLowerCase()
  return (
    lower.includes('cloudflare') ||
    lower.includes('just a moment') ||
    lower.includes('cf-browser-verification') ||
    lower.includes('checking your browser') ||
    lower.includes('challenge-platform')
  )
}
