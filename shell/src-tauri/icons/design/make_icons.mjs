/**
 * 「浮生半日」托盘/窗口图标生成器（零依赖 Node）。
 * 4 款极简线条候选：奶油圆底 + 炭色线条，SDF 光栅化（自带抗锯齿），
 * 输出 preview/*.png 预览与 icons-<n>.ico 多尺寸候选。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'preview')
mkdirSync(OUT, { recursive: true })

const S = 1024
const AA = 1.6
const BG = [242, 237, 227]   // cream 奶油底
const INK = [58, 65, 82]     // ink 炭蓝线
const W = 54                 // 默认线宽

/* ---------- SDF 基元：均返回 (distance, halfWidth) ---------- */

const hyp = Math.hypot

/** 线段（圆帽）。 */
function seg(ax, ay, bx, by, w = W / 2) {
  return (x, y) => {
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    return [hyp(x - (ax + t * dx), y - (ay + t * dy)), w]
  }
}

/** 折线串（圆帽），平滑度靠细分。 */
function poly(pts, w = W / 2) {
  const parts = []
  for (let i = 0; i < pts.length - 1; i++) parts.push(seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w))
  return parts
}

/** 圆弧描边：角度为屏幕系（y 向下，0°=+x，90°=向下），a0<a1 度数。 */
function arc(cx, cy, r, a0, a1, w = W / 2) {
  const rad = d => d * Math.PI / 180
  const ex0 = cx + r * Math.cos(rad(a0)), ey0 = cy + r * Math.sin(rad(a0))
  const ex1 = cx + r * Math.cos(rad(a1)), ey1 = cy + r * Math.sin(rad(a1))
  return (x, y) => {
    const ang = Math.atan2(y - cy, x - cx) * 180 / Math.PI
    let a = ang
    while (a < 0) a += 360
    const inRange = (a >= a0 && a <= a1)
      || (a0 > a1 && (a >= a0 || a <= a1))
    const d = inRange ? Math.abs(hyp(x - cx, y - cy) - r)
      : Math.min(hyp(x - ex0, y - ey0), hyp(x - ex1, y - ey1))
    return [d, w]
  }
}

/** 圆环描边。 */
function ring(cx, cy, r, w = W / 2) {
  return (x, y) => [Math.abs(hyp(x - cx, y - cy) - r), w]
}

/** 实心圆。 */
function dot(cx, cy, r) {
  return (x, y) => [hyp(x - cx, y - cy), r]
}

/** Catmull-Rom 平滑：点列 → 细分折线（用于热气等曲线）。 */
function smooth(pts, per = 14) {
  const p = [pts[0], ...pts, pts[pts.length - 1]]
  const out = []
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1], p[i], p[i + 1], p[i + 2]]
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  out.push(pts[pts.length - 1])
  return out
}

/** 二次贝塞尔 → 细分折线。 */
function qbez(p0, c, p1, per = 26) {
  const out = []
  for (let j = 0; j <= per; j++) {
    const t = j / per, u = 1 - t
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]])
  }
  return out
}

/* ---------- 四款设计 ---------- */

/** 公共：杯身（开口 U + 底弧）+ 柄 + 碟线。mouthLine=false 时不画杯口横线。 */
function cup(ox, oy, width = 360, mouth = 430, depth = 100, r = 180, handle = true, dish = true, mouthLine = true) {
  const x0 = ox - width / 2, x1 = ox + width / 2, yb = mouth + depth
  const parts = [
    ...poly([[x0, mouth], [x0, yb]]),
    arc(ox, yb, r, 0, 180),
    ...poly([[x1, yb], [x1, mouth]]),
  ]
  if (mouthLine) parts.push(...poly([[x0, mouth], [x1, mouth]]))
  if (handle) parts.push(arc(x1 + 38, yb - 10, 92, 260, 100))
  if (dish) parts.push(seg(ox - width * 0.36, mouth + depth + r + 66, ox + width * 0.36, mouth + depth + r + 66))
  return parts
}

/** ① 杯·双气：经典茶杯 + 两缕内弯热气（朝右凸 C 弧，极简）。 */
function designCupSteam() {
  // 弧圆心在左，弧段在圆心右侧凸出；两端点即热气起止
  const steam = (cx, cy, r, a0, a1) => arc(cx, cy, r, a0, a1, W / 2)
  return [
    ...cup(512, 0, 390, 450, 108, 195),
    steam(330, 300, 150, -50, 50),  // 左缕：弦 x=426，y 185..415
    steam(440, 265, 150, -44, 44),  // 右缕：弦 x=548，y 161..369（略短）
  ]
}

/** ② 半日杯：小半日坐杯口线（地平线）上，日光从茶杯升起（浮生半日闲）。 */
function designHalfSunCup() {
  const rays = [-138, -108, -90, -72, -42].map(a => {
    const rad = a * Math.PI / 180
    return seg(512 + 170 * Math.cos(rad), 450 + 170 * Math.sin(rad), 512 + 232 * Math.cos(rad), 450 + 232 * Math.sin(rad), W / 2)
  })
  return [
    ...cup(512, 0, 380, 450, 100, 170, true, true, true),  // 杯口横线 = 地平线
    arc(512, 450, 120, 180, 360),  // 半日：两端落在杯口线中段
    ...rays,
  ]
}

/** ③ 摸鱼钟：5:45 的表盘，摸鱼看表。 */
function designClock() {
  const hand = (deg, len) => {
    const rad = deg * Math.PI / 180
    return seg(512, 512, 512 + len * Math.sin(rad), 512 - len * Math.cos(rad), 30)
  }
  return [
    ring(512, 512, 330),
    hand(172.5, 176),  // 时针 ≈ 5:45
    hand(270, 246),    // 分针 45 分
    dot(512, 512, 30),
    seg(512, 512 - 330, 512, 512 - 330 + 56, 26), // 12 点刻度
  ]
}

/** ④ 闲鱼：一条打盹的小鱼 + 气泡。 */
function designFish() {
  const top = qbez([292, 560], [452, 372], [704, 560])
  const bot = qbez([292, 560], [452, 748], [704, 560])
  return [
    ...poly(top), ...poly(bot),
    ...poly([[704, 560], [786, 500]]),
    ...poly([[704, 560], [786, 620]]),
    dot(380, 548, 20),
    ring(600, 330, 52, 20),
    ring(706, 240, 30, 20),
  ]
}

/* ---------- 光栅化 ---------- */

function rasterize(primitives) {
  const px = new Float64Array(S * S)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let best = 1e9
      for (const f of primitives) {
        const [d, w] = f(x + 0.5, y + 0.5)
        const c = d - w
        if (c < best) best = c
      }
      px[y * S + x] = best
    }
  }
  return px
}

function compose(dist) {
  const rgba = new Uint8Array(S * S * 4)
  for (let i = 0; i < S * S; i++) {
    const dLine = dist[i]
    const aInk = Math.max(0, Math.min(1, 0.5 - dLine / AA))
    const dBg = hyp((i % S) + 0.5 - 512, Math.floor(i / S) + 0.5 - 512) - 496
    const aBg = Math.max(0, Math.min(1, 0.5 - dBg / AA))
    const aOut = aInk + aBg * (1 - aInk)
    const o = i * 4
    if (aOut <= 0) continue
    for (let k = 0; k < 3; k++) {
      rgba[o + k] = Math.round((INK[k] * aInk + BG[k] * aBg * (1 - aInk)) / aOut)
    }
    rgba[o + 3] = Math.round(aOut * 255)
  }
  return rgba
}

/* ---------- 下采样（alpha 加权面积平均） ---------- */

function downscale(src, size) {
  const out = new Uint8Array(size * size * 4)
  const scale = S / size
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const x0 = dx * scale, y0 = dy * scale
      const x1 = Math.min(S, (dx + 1) * scale), y1 = Math.min(S, (dy + 1) * scale)
      let ar = 0, ag = 0, ab = 0, aa = 0, wsum = 0
      for (let sy = Math.floor(y0); sy < y1; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        if (wy <= 0) continue
        for (let sx = Math.floor(x0); sx < x1; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
          if (wx <= 0) continue
          const w = wx * wy
          const o = (sy * S + sx) * 4
          const a = src[o + 3] / 255
          ar += src[o] * a * w; ag += src[o + 1] * a * w; ab += src[o + 2] * a * w
          aa += a * w; wsum += w
        }
      }
      const o = (dy * size + dx) * 4
      if (aa > 0) {
        out[o] = Math.round(ar / aa); out[o + 1] = Math.round(ag / aa); out[o + 2] = Math.round(ab / aa)
      }
      out[o + 3] = Math.round(aa / wsum * 255)
    }
  }
  return out
}

/* ---------- PNG / ICO 编码 ---------- */

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return bytes => {
    let c = 0xffffffff
    for (const b of bytes) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
})()

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

function encodeIco(pngs) {
  const count = pngs.length
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(count, 4)
  const entries = []
  let offset = 6 + count * 16
  const dirs = []
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size
    e[2] = 0; e[3] = 0
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12)
    offset += png.length
    dirs.push(e)
  }
  return Buffer.concat([head, ...dirs, ...pngs.map(p => p.png)])
}

/* ---------- 主流程 ---------- */

const designs = [
  ['1-cup-steam', designCupSteam],
  ['2-half-sun-cup', designHalfSunCup],
  ['3-clock', designClock],
  ['4-fish', designFish],
]

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

for (const [name, make] of designs) {
  console.time(name)
  const rgba = compose(rasterize(make()))
  writeFileSync(join(OUT, `${name}.png`), encodePng(rgba, S))
  const pngs = ICO_SIZES.map(size => ({ size, png: encodePng(downscale(rgba, size), size) }))
  writeFileSync(join(OUT, `icons-${name}.ico`), encodeIco(pngs))
  console.timeEnd(name)
}

// 2×2 预览拼图（浅灰底衬托）
{
  const cell = 560, pad = 40, canvas = cell * 2 + pad * 3
  const pv = new Uint8Array(canvas * canvas * 4)
  for (let i = 0; i < canvas * canvas; i++) {
    pv[i * 4] = 232; pv[i * 4 + 1] = 232; pv[i * 4 + 2] = 236; pv[i * 4 + 3] = 255
  }
  designs.forEach(([name], idx) => {
    const rgba = compose(rasterize(designs[idx][1]()))
    const small = downscale(rgba, cell - pad * 2)
    const gx = pad + (idx % 2) * (cell + pad), gy = pad + Math.floor(idx / 2) * (cell + pad)
    const inner = cell - pad * 2
    for (let y = 0; y < inner; y++) {
      for (let x = 0; x < inner; x++) {
        const so = (y * inner + x) * 4, a = small[so + 3] / 255
        const doo = ((gy + y) * canvas + gx + x) * 4
        for (let k = 0; k < 3; k++) pv[doo + k] = Math.round(pv[doo + k] * (1 - a) + small[so + k] * a)
      }
    }
  })
  writeFileSync(join(OUT, 'all-preview.png'), encodePng(pv, canvas))
}

console.log('done →', OUT)
