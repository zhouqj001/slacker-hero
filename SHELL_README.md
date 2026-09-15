# Slacker Shell — Tauri 桌面壳

**`npm run shell`** 启动的独立 Tauri 应用。原生支持：茶水间、小说阅读器、游戏、股票行情/悬浮窗，并提供通用的本地存储、全局快捷键、HTTP 代理等能力。

---

## 功能清单

| 模块 | 入口 | 说明 |
|------|------|------|
| **茶水间** | `tea.html` / `slacker_tea_window` | 独立无边框窗口，内置 Stock / Novel / Game 三个子视图，支持老板键 (Ctrl+Shift+H) |
| **小说阅读器** | `novel.html` / `slacker_novel_window` | TXT 本地书架，章节切分、进度持久化、悬浮阅读条 |
| **股票行情** | `tea.html#stock` / `slacker_stock_mini` | 自选列表、搜索加自选、K 线详情 (SVG 手绘)、桌面常驻悬浮窗 |
| **贪吃蛇游戏** | `tea.html#game` | Canvas 实现，分数本地存储 |
| **通用能力** | — | KV 持久化、全局快捷键、HTTP 代理 (GB18030 自动转码)、主题同步 |

---

## 快速开始

### 环境要求
- **Node.js** ≥ 18 (pnpm 管理依赖)
- **Rust** 稳定工具链 (MSVC 或 GNU，Windows 建议 MSVC)
- **Tauri 2** 前置依赖：WebView2、Visual Studio Build Tools

### 安装与运行

```bash
# 1. 安装 JS 依赖
pnpm install

# 2. 开发模式（热重载前端 + 后端 cargo watch）
npm run shell

# 3. 生产构建
cd shell && cargo build --release
# 产物：shell/src-tauri/target/release/slacker-shell.exe
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run shell` | 启动开发服务器 + `tauri dev`（前端 vite + 后端 cargo） |
| `cd shell && cargo build` | 仅编译 Rust 二进制（调试版） |
| `cd shell && cargo build --release` | 编译发布版 |
| `cd shell && cargo clean` | 清理构建缓存 |
| `node shell/scripts/standalone-assets.cjs` | 同步独立窗口 HTML/JS 到 `shell/ui/` |

---

## 目录结构

```
slacker-shell/
├── package.json              # 根脚本：setup / shell
├── shell/                    # Tauri 应用核心
│   ├── src-tauri/            # Rust 后端
│   │   ├── src/
│   │   │   ├── lib.rs        # 所有 slacker_* 命令、窗口管理、全局快捷键
│   │   │   └── main.rs       # 入口
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   └── resources/        # 独立窗口 HTML 模板
│   │       ├── tea.html
│   │       ├── novel.html
│   │       ├── stock-mini.html
│   │       └── vendor/       # React UMD 等静态资源
│   ├── plugins/              # 前端插件 (tsdown 产物)
│   │   ├── ui-slacker/       # 茶水间/股票/游戏 共享 UI
│   │   │   ├── src/client/   # IPC 封装、StockView、StockMiniWindow、locales
│   │   │   ├── tsdown.config.ts
│   │   │   └── package.json
│   │   └── novel/            # 小说阅读器插件
│   ├── scripts/
│   │   └── standalone-assets.cjs  # 复制 HTML/JS 到 shell/ui/
│   └── ui/                   # 运行时静态资源 (由 standalone-assets 生成)
│       ├── tea.html
│       ├── novel.html
│       ├── stock-mini.html
│       ├── vendor/
│       └── @slacker/
│           ├── ui-slacker/{tea.js,stock-mini.js,client.js}
│           └── novel/{client.js,novel-reader.js}
```

---

## 核心 Rust 命令 (lib.rs)

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `slacker_stock_quotes` | `codes: string[]` | `StockQuote[]` | 批量实时行情 (东财 push2) |
| `slacker_stock_trends` | `codes: string[]` | `StockTrend[]` | 分时走势 (trends2) |
| `slacker_stock_search` | `query: string` | `StockSearchItem[]` | 搜索建议 (searchadapter) |
| `slacker_stock_kline` | `code, period, adjust, count?` | `StockKlineItem[]` | K 线 (日/周/月/分钟，前/后/不复权) |
| `slacker_stock_mini` | `action: "toggle"\|"close"` | `string` | 悬浮窗 创建/关闭/聚焦 |
| `slacker_kv_get/set` | `key, value?` | `string/null` / `void` | 本地持久化 (应用级) |
| `slacker_http_fetch` | `url, method, headers, body?` | `HttpReply` | 通用 HTTP 代理 (base64 回传) |
| `slacker_theme_get` | — | `ThemeVars?` | 主题变量快照 |
| `slacker_tea_window` / `slacker_novel_window` / `slacker_novel_float` | — | `string` | 独立窗口 创建/聚焦/恢复 |
| `slacker_novel_*` | 多 | 多 | 小说书架/目录/章节/下载目录选择 |

### 关键实现细节

- **东财 GB18030 自动转码**：所有 stock 命令统一用 `encoding_rs::GBK` 解码 body 再 `serde_json::from_str`
- **请求头注入**：`em_client()` 单例自带 `User-Agent: Chrome` + `Referer: https://www.eastmoney.com/`，避免 403/空响应
- **TLS**：`reqwest` 启用 `native-tls` (Windows SChannel)，兼容性最佳
- **增量编译关闭**：`profile.dev.incremental = false` 规避 rustc ICE
- **GB18030 前端兜底**：`ipc.ts` 的 `emText()` 先试 UTF-8 再回退 GB18030

---

## 前端插件 (@slacker/ui-slacker)

### 入口产物 (tsdown)
| 入口 | 产物 | 用途 |
|------|------|------|
| `src/index.ts` | `lib/index.mjs` | 给 dsh 主应用加载的共享库 |
| `src/client/main-tea.tsx` | `lib/tea.js` | 茶水间独立窗口 (`tea.html`) |
| `src/client/main-stock-mini.tsx` | `lib/stock-mini.js` | 股票悬浮窗 (`stock-mini.html`) |

### StockView (`src/client/stock/StockView.tsx`)
- **搜索**：300ms 防抖 → `stockSearch` → 下拉列表 (沪/深/北标签) → 点击加入自选并打开详情
- **自选卡片**：价格、涨跌幅、分时 sparkline (SVG path)、点击展开 K 线详情
- **K 线详情**：7 种周期 × 3 种复权，手写 SVG 蜡烛图 (640×240 viewBox，红涨绿跌)
- **悬浮窗启动**：`stockMiniOpen('toggle')` → `slacker_stock_mini`

### StockMiniWindow (`src/client/stock/StockMiniWindow.tsx`)
- 透明无边框、置顶、240×380、最小 200×260
- 5 秒轮询 `kvGet('watchlist')` + `stockQuotes` (跨窗口同步不依赖事件)
- 头部拖拽区、置顶切换、关闭按钮、末尾刷新时间

### 国际化 (`src/client/locales.ts`)
- 中英双语，`SlackerKey` 类型约束
- Stock 相关 key：`stock.title/searchPh/added/noResult/mini/.../pk1..pk7/adjustQfq/Hfq/None`

---

## 独立窗口 HTML 模板

所有独立窗口共享同一套 **ModuleLoader shim** (`tea.html` / `novel.html` / `stock-mini.html`)：

1. 原生 CSS 变量主题 (`--dsw-alias-*`)
2. `__ModuleLoader__`：相对路径 require + 模块缓存
3. React 18 UMD (`vendor/react*.js`) + `ReactJSXRuntime` 兼容层
4. 主题同步：启动 `slacker_theme_get` + 监听 `slacker:theme` 事件，实时应用根变量
5. 入口标记：`window.__SLACKER_TEA__` / `__SLACKER_NOVEL_READER__` / `__SLACKER_STOCK_MINI__`

---

## 同步流程 (`standalone-assets.cjs`)

`beforeDevCommand` / `beforeBuildCommand` 自动运行：

```js
// 1. vendor 资源
resources/vendor/*.js → ui/vendor/

// 2. 独立窗口 HTML
tea.html / novel.html / stock-mini.html → ui/

// 3. 插件产物
plugins/novel/lib/{client,novel-reader}.js → ui/@slacker/novel/
plugins/ui-slacker/lib/{tea,stock-mini,client}.js → ui/@slacker/ui-slacker/
```

> **注意**：前端修改后需 `tsdown` 重新打包，再运行同步脚本，`tauri dev` 才会加载最新代码。

---

## 开发调试技巧

### 1. 仅前端热重载
```bash
# 终端 1：前端 watch
cd shell/plugins/ui-slacker && npx tsdown --watch
# 终端 2：同步
node shell/scripts/standalone-assets.cjs
# tauri dev 会自动热更 UI
```

### 2. 纯浏览器调试 Stock UI
直接用浏览器打开 `shell/ui/tea.html`（`file://` 协议）：
- 无 Tauri 桥时自动回退 `fetch` 直连东财 (已加 CORS 允许)
- 可验证搜索、K 线 SVG、悬浮窗按钮 (无壳下为 no-op)

### 3. Playwright E2E
```bash
# 用任意 Playwright 脚本打开 shell/ui/tea.html 即可回归验证
```
- `--disable-web-security --allow-file-access-from-files` 绕过 file:// CORS
- 可截图 `stock-kline.png` 回归对比

### 4. 常见坑及排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `Command not found` | Rust 二进制未重建 / `tauri dev` 未重启 | `cargo clean && cargo build` + 杀进程重启 |
| 东财返回乱码 | 响应为 GB18030，按 UTF-8 解码 | 已修：Rust `decode_em_bytes` + 前端 `emText` 双兜底 |
| 东财空响应 / 403 | 缺 UA/Referer / 走 HTTP 被拒 | 已修：`em_client()` 注入 headers + 全站 HTTPS |
| `rustls` 握手失败 | Windows 环境证书链问题 | 已修：改 `native-tls` (SChannel) |
| 悬浮窗不刷新 | 5s 轮询未触发 | 检查 `kvGet('watchlist')` 是否写入、`stockMiniOpen('toggle')` 是否创建窗口 |
| 增量编译 ICE | rustc 1.97.1 bug | `Cargo.toml: incremental = false` 已设置 |

---

## 发布检查清单

- [ ] `cargo build --release` 通过
- [ ] `shell/ui/` 所有资源为最新 (跑过 `standalone-assets`)
- [ ] `tauri.conf.json` 的 `identifier` / `version` / `bundle` 正确
- [ ] 图标 `src-tauri/icons/icon.ico` 存在
- [ ] `Cargo.toml` 版本号同步
- [ ] 无硬编码本地路径 / 测试数据

---

## 许可证

[AGPL-3.0](./LICENSE)