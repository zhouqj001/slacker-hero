/**
 * 书源 v2 类型定义（trnovel-booksource/v2 简化 TS 版）
 *
 * 设计参考 TRNovel 的结构化 JSON 书源格式：每个字段是一条「规则」——
 * 一次 CSS/JSONPath/正则抽取，或组合子（firstOf/concat/literal/template）。
 * 不依赖紧凑字符串 DSL，对人类维护和 AI 生成都友好。
 *
 * 简化范围（相对 TRNovel）：
 * - 暂不支持 JS 逃生舱 / host 对象 / prelude 多步编排 / 字体反爬 fontMap
 * - 暂不支持 render 型 SPA 取页（render/interceptApi 字段保留但引擎忽略）
 * - HTTP 走前端 fetch（Tauri 下建议后续接 plugin-http 绕过 CORS）
 */
export const BOOKSOURCE_SCHEMA = "trnovel-booksource/v2";

/* ======================================================================
 * 抽取目标
 * ====================================================================== */

/** 从选中元素抽取什么 */
export type Extract =
  | "text" // 文本内容（默认，自动 trim）
  | "html" // 内部 HTML（标签转换行后清理，用于正文）
  | { attr: string }; // 某个属性值（如 href/src/content）

/* ======================================================================
 * clean 算子（正文后处理）
 * ====================================================================== */

export interface CleanReplace {
  /** 正则替换 */
  replace: { pattern: string; flags?: string; with: string };
}

export interface CleanTrim {
  /** 去首尾空白 */
  trim: true;
}

export type CleanOp = CleanReplace | CleanTrim;

/* ======================================================================
 * 规则（Rule）—— 判别联合
 * ====================================================================== */

/** CSS 选择器规则：从上下文节点选元素并抽取 */
export interface CssRule {
  via: "css";
  /** 选择器，self-or-descendant 语义 */
  select: string;
  extract?: Extract;
  clean?: CleanOp[];
}

/** JSONPath 规则：从 JSON 数据中取值（极简语法 $.a.b / $.a[0] / $.a[*].b） */
export interface JsonRule {
  via: "json";
  select: string;
}

/** 正则规则：对上下文文本/HTML 做正则匹配 */
export interface RegexRule {
  via: "regex";
  pattern: string;
  flags?: string;
  group?: number;
  /** 对上下文的什么做匹配，默认 text */
  source?: "text" | "html";
}

/** 字面量 */
export interface LiteralRule {
  via: "literal";
  value: string;
}

/** 模板：含 {{var}} 的字符串，变量从当前上下文变量表取 */
export interface TemplateRule {
  via: "template";
  template: string;
}

/** 依次尝试子规则，取第一个非空结果 */
export interface FirstOfRule {
  via: "firstOf";
  rules: Rule[];
}

/** 拼接多个子规则结果 */
export interface ConcatRule {
  via: "concat";
  rules: Rule[];
  separator?: string;
}

export type Rule =
  | CssRule
  | JsonRule
  | RegexRule
  | LiteralRule
  | TemplateRule
  | FirstOfRule
  | ConcatRule;

/* ======================================================================
 * 列表规则 —— 选中多条并按 item 模板逐条抽取
 * ====================================================================== */

export interface ListRule {
  /** 列表选择器后端，默认 css */
  via?: "css" | "json";
  /** 列表容器选择器（选中多个节点） */
  select: string;
  /** 每条结果的字段规则；常见字段：name/url/bookUrl/author/cover/intro/wordCount */
  item: Record<string, Rule>;
  /** 是否分页（列表跨页抓取），暂不实现，保留 */
  nextPage?: Rule;
  maxPages?: number;
}

/* ======================================================================
 * 请求规格
 * ====================================================================== */

export interface RequestSpec {
  /** URL 模板，支持 {{base}}/{{key}}/{{page}}/{{pageSize}} 及自定义变量 */
  url: string;
  method?: "GET" | "POST";
  /** POST body 模板 */
  body?: string;
  headers?: Record<string, string>;
  /** 字符集，默认 auto（UTF-8 失败回退 GBK） */
  charset?: "auto" | "utf-8" | "gbk" | "gb18030";
  /** SPA 渲染取页（暂不支持，保留字段） */
  render?: boolean;
  /** SPA 拦截 API（暂不支持，保留字段） */
  interceptApi?: string;
}

/* ======================================================================
 * 各能力块
 * ====================================================================== */

/** 搜索 */
export interface SearchBlock {
  request: RequestSpec;
  list: ListRule;
  /** 搜索结果项必须含 bookUrl（指向书详情） */
}

/** 浏览（分类）—— 两阶段：entries 生成入口，page 取书 */
export interface ExploreBlock {
  /** 入口源：static 硬编码 或 fetch 动态抓取 */
  entries: ExploreEntry[];
}

export interface ExploreStaticEntry {
  type: "static";
  title: string;
  /** 取页变量（字面量） */
  vars?: Record<string, string>;
}

export interface ExploreFetchEntry {
  type: "fetch";
  request: RequestSpec;
  list: ListRule;
}

export type ExploreEntry = ExploreStaticEntry | ExploreFetchEntry;

/** 浏览的分页规格（所有入口共享） */
export interface ExplorePage {
  request: RequestSpec;
  list: ListRule;
}

/** 书详情 */
export interface BookInfoBlock {
  request?: RequestSpec; // 不填则用搜索/浏览返回的 bookUrl
  /** 字段规则：name/author/cover/intro/wordCount/tocUrl */
  name: Rule;
  author?: Rule;
  cover?: Rule;
  intro?: Rule;
  wordCount?: Rule;
  /** 目录页 URL，不填则用书详情页 URL */
  tocUrl?: Rule;
}

/** 目录 */
export interface TocBlock {
  request?: RequestSpec; // 不填则用 bookInfo.tocUrl 或书详情 URL
  list: ListRule;
  /** item 字段：name/url/isVolume? */
}

/** 正文 */
export interface ContentBlock {
  request?: RequestSpec; // 不填则用目录项 url
  /** 正文规则（通常 extract: "html"） */
  value: Rule;
  /** 下一页规则（分页正文） */
  nextPage?: Rule;
  maxPages?: number;
}

/* ======================================================================
 * 书源
 * ====================================================================== */

export interface HttpConfig {
  /** 默认字符集 */
  charset?: "auto" | "utf-8" | "gbk" | "gb18030";
  /** 默认请求头 */
  headers?: Record<string, string>;
  /** 取页模式：auto（默认）/ reqwest（纯 fetch，撞挑战降级） */
  fetcher?: "auto" | "reqwest";
  /** 预热 URL（拿 cookie） */
  warmup?: string[];
  /** User-Agent */
  userAgent?: string;
}

/** 黄金样例（驱动 doctor 校验 + 运行期自愈） */
export interface BookSample {
  /** 真实书详情 URL */
  bookUrl: string;
  /** 期望书名 */
  name?: string;
  /** 期望最少章节数 */
  minChapters?: number;
  /** 期望含分卷 */
  volumes?: boolean;
  /** 期望正文最少字符数 */
  minContentChars?: number;
}

export interface BookSource {
  schema: typeof BOOKSOURCE_SCHEMA;
  name: string;
  /** 站点根 URL */
  url: string;
  http?: HttpConfig;
  search?: SearchBlock;
  explore?: ExploreBlock & { page: ExplorePage };
  bookInfo: BookInfoBlock;
  toc: TocBlock;
  content: ContentBlock;
  samples?: BookSample[];
}

/* ======================================================================
 * 运行期数据模型
 * ====================================================================== */

export interface SearchResultItem {
  bookUrl: string;
  name: string;
  author?: string;
  cover?: string;
  intro?: string;
  wordCount?: string;
  /** 搜索来源书源名（多源搜索时标注） */
  sourceName?: string;
}

export interface BookInfo {
  name: string;
  author?: string;
  cover?: string;
  intro?: string;
  wordCount?: string;
  tocUrl?: string;
  sourceUrl?: string;
}

export interface TocItem {
  name: string;
  url: string;
  /** 是否卷标题（非章节） */
  isVolume?: boolean;
}

export interface ExploreCategory {
  title: string;
  vars: Record<string, string>;
}

/* ======================================================================
 * doctor 体检结果
 * ====================================================================== */

export type DoctorStatus = "pass" | "fail" | "skip";

export interface DoctorCheck {
  /** 检查项：config/search/explore/bookInfo/toc/content */
  key: string;
  label: string;
  status: DoctorStatus;
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** 全绿 */
  allGreen: boolean;
}
