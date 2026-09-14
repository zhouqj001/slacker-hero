# Slacker Shell — 桌面摸鱼四件套

Tauri 2 桌面壳,一个半透明小窗装下整个摸鱼日常:**茶水间 + 股票行情 + 小说阅读器 + 贪吃蛇/2048**。

从 [slacker-hero](https://github.com) monorepo 中独立出来的最小可运行项目,零运行时 JS 依赖(React 以 UMD 方式直接注入)。

---

## 功能

| 模块 | 说明 |
|------|------|
| **茶水间** | 独立无边框透明窗口,老板键 (Ctrl+Shift+H) 秒隐藏 |
| **股票行情** | 自选列表、搜索加自选、K 线详情 (手写 SVG 蜡烛图)、桌面置顶悬浮窗 |
| **小说阅读器** | 本地 TXT 书架、章节切分、进度持久化、网络书源阅读 |
| **迷你游戏** | 贪吃蛇、2048,分数本地存储 |

数据源为东方财富公开接口,全链路 HTTPS + GB18030 自动转码。

---

## 快速开始

### 环境

- Node.js ≥ 18 (推荐 pnpm)
- Rust 稳定版 (Windows 建议 MSVC)
- Tauri 2 前置:WebView2、Visual Studio Build Tools

### 首次安装

```bash
npm run setup
```

等价于:根装 `@tauri-apps/cli` → 两个插件各自 `pnpm install + bundle` → 同步独立窗口资源到 `shell/ui/`。

### 运行

```bash
npm run shell        # 开发模式 (tauri dev)
cd shell && cargo build --release   # 生产构建
```

详细文档见 [`SHELL_README.md`](SHELL_README.md)。

---

## 目录结构

```
slacker-shell/
├── package.json              # 根脚本: setup / shell
├── SHELL_README.md           # 完整开发文档
├── shell/
│   ├── src-tauri/            # Rust 后端 (slacker_* 命令、窗口、快捷键)
│   │   └── resources/        # 独立窗口 HTML + React UMD vendor
│   ├── plugins/
│   │   ├── ui-slacker/       # 茶水间/股票/游戏 前端 (tsdown)
│   │   └── novel/            # 小说阅读器前端 (tsdown)
│   ├── scripts/
│   │   └── standalone-assets.cjs  # 同步 HTML/JS → shell/ui/
│   └── ui/                   # 运行时资源 (自动生成,不入库)
```

---

## 技术栈

- **Tauri 2** (Rust + WebView2)
- **React 18** (UMD,零打包依赖)
- **tsdown (Rolldown)** — 多入口打包
- **reqwest + native-tls** — Windows SChannel,东财接口安全请求
- **encoding_rs** — GB18030 自动解码

---

## 许可证

[MIT](LICENSE)