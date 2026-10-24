/**
 * M6 复盘线共享工具：从平台页面文本里解析「1.2万 / 10万+ / 3,456」式计数。
 * 返回 undefined 表示没解析到（调用方当字段缺失处理）。
 */
export function parseCount(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const s = raw.replace(/[,，\s]/g, '').trim()
  if (!s) return undefined
  // 10万+ / 100000+
  const wanPlus = s.match(/^(\d+(?:\.\d+)?)万\+?$/)
  if (wanPlus) return Math.round(parseFloat(wanPlus[1]) * 10000)
  const yi = s.match(/^(\d+(?:\.\d+)?)亿\+?$/)
  if (yi) return Math.round(parseFloat(yi[1]) * 100000000)
  const num = s.match(/^(\d+)\+?$/)
  if (num) return parseInt(num[1], 10)
  return undefined
}

/**
 * 按候选 selector 表抓首个可见节点的文本并解析为计数。
 * 全部落空返回 undefined（不抛错——字段缺失比整篇失败好）。
 */
export async function scrapeCount(
  page: import('playwright-core').Page,
  selectors: string[],
  perSelectorTimeout = 2500,
): Promise<number | undefined> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout: perSelectorTimeout })
      const text = await loc.innerText()
      const n = parseCount(text)
      if (n !== undefined) return n
    } catch { /* try next */ }
  }
  return undefined
}
