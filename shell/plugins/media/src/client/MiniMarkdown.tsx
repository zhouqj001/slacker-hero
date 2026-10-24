/**
 * 迷你 Markdown 渲染器 —— 卡片内阅读用（无依赖、React 元素输出、无 innerHTML）。
 * 支持块级：# 标题、- 列表、> 引用、``` 代码块、段落；行内：**粗**、*斜*、`码`、[链](接)、![图](片)。
 * 文本一律走 React 文本节点（自动转义），图片/链接 src|href 仅接受 http(s) 与站内 /api 路径。
 * @module @slacker/media/client/MiniMarkdown
 */
import type { ReactNode } from 'react'
import { s } from './common.ts'

/** 安全 URL：http(s) 外链或站内 /api、/ 路径，其余当纯文本处理。 */
function safeUrl(url: string): string | null {
  if (/^https:\/\//i.test(url) || /^http:\/\//i.test(url)) return url
  if (/^\/(api\/|)/.test(url) && !url.includes('\\')) return url
  return null
}

/** 行内解析：正则顺序扫描，命中即产出对应元素。 */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const key = `${keyBase}-${i++}`
    const imgUrl = m[2] !== undefined ? safeUrl(m[2]) : null
    const linkUrl = m[4] !== undefined ? safeUrl(m[4]) : null
    if (imgUrl !== null) {
      nodes.push(<img key={key} className={s.mdImg} src={imgUrl} alt={m[1] || '图片'} loading="lazy" />)
    } else if (linkUrl !== null) {
      nodes.push(
        <a key={key} className={s.mdLink} href={linkUrl} target="_blank" rel="noreferrer">{m[3]}</a>,
      )
    } else if (m[5] !== undefined) {
      nodes.push(<strong key={key}>{m[5]}</strong>)
    } else if (m[6] !== undefined) {
      nodes.push(<em key={key}>{m[6]}</em>)
    } else if (m[7] !== undefined) {
      nodes.push(<code key={key} className={s.mdCode}>{m[7]}</code>)
    } else {
      // URL 不安全：原样输出命中片段
      nodes.push(m[0])
    }
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 块级解析：按行扫描聚合。 */
function blocks(md: string): ReactNode[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let para: string[] = []
  let list: string[] = []
  let quote: string[] = []
  let key = 0

  const flushPara = (): void => {
    if (para.length === 0) return
    const content = para.map((l, i) => (
      <span key={`p${key}-${i}`}>{i > 0 && <br />}{inline(l, `p${key}-${i}`)}</span>
    ))
    out.push(<p key={`p${key++}`} className={s.mdP}>{content}</p>)
    para = []
  }
  const flushList = (): void => {
    if (list.length === 0) return
    out.push(
      <ul key={`ul${key++}`} className={s.mdUl}>
        {list.map((li, i) => <li key={i}>{inline(li, `li${key}-${i}`)}</li>)}
      </ul>,
    )
    list = []
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    out.push(<blockquote key={`q${key++}`} className={s.mdQuote}>{inline(quote.join(' '), `q${key}`)}</blockquote>)
    quote = []
  }
  const flushAll = (): void => { flushPara(); flushList(); flushQuote() }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 代码块
    if (line.startsWith('```')) {
      flushAll()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++ }
      out.push(<pre key={`pre${key++}`} className={s.mdPre}><code>{code.join('\n')}</code></pre>)
      continue
    }
    // 标题（卡内空间有限，h1-h3 降为两档字号）
    const head = /^(#{1,6})\s+(.*)$/.exec(line)
    if (head) {
      flushAll()
      const level = head[1].length
      const cls = level <= 1 ? s.mdH1 : level === 2 ? s.mdH2 : s.mdH3
      out.push(<div key={`h${key++}`} className={cls}>{inline(head[2], `h${key}`)}</div>)
      continue
    }
    // 引用
    if (line.startsWith('>')) {
      flushPara(); flushList()
      quote.push(line.replace(/^>\s?/, ''))
      continue
    }
    flushQuote()
    // 列表
    const li = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      list.push(li[1])
      continue
    }
    flushList()
    // 空行分段
    if (line.trim() === '') {
      flushPara()
      continue
    }
    para.push(line)
  }
  flushAll()
  return out
}

/** 渲染入口：<MiniMarkdown md={bodyMd} />。 */
export function MiniMarkdown(props: { md: string }): JSX.Element {
  return <div className={s.mdRoot}>{blocks(props.md)}</div>
}
