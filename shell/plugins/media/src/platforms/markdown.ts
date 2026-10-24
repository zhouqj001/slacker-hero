/**
 * 极简 Markdown → HTML（供公众号/小红书等编辑器粘贴，M4 不求全：
 * 标题/段落/无序有序列表/粗体/行内代码/链接/图片）。
 * 正文艺名为「粘贴引导」场景，保真度足够阅读即可。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 图片：相对路径（/api/media/asset?id=…）原样保留，由前端复制时补全 origin。 */
function imgTag(alt: string, src: string): string {
  return `<img src="${src}" alt="${alt}" style="max-width:100%" />`
}

/** 独占一行的图片：不再套 <p>（部分编辑器粘贴时会把段落样式带进图片）。 */
const IMAGE_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

function inline(s: string): string {
  return escapeHtml(s)
    // 图片必须先于链接替换，否则 `![alt](src)` 会被当成链接、留下裸 `!`
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => imgTag(alt, src))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
}

export function mdToHtml(md: string): string {
  const blocks: string[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      blocks.push(`<h${level}>${inline(h[2].trim())}</h${level}>`)
      i++; continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`)
        i++
      }
      blocks.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`)
        i++
      }
      blocks.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    const imgOnly = IMAGE_ONLY_RE.exec(line.trim())
    if (imgOnly) {
      blocks.push(imgTag(imgOnly[1], imgOnly[2]))
      i++; continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^(#{1,3})\s+/.test(lines[i]) &&
           !/^\s*[-*]\s+/.test(lines[i]) &&
           !/^\s*\d+\.\s+/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    blocks.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return blocks.join('\n')
}
