/**
 * 瑙勫垯姹傚€煎櫒
 *
 * 鏀寔 CSS / JSONPath(鏋佺畝) / 姝ｅ垯 / 缁勫悎瀛?literal/template/firstOf/concat)
 *
 * 涓婁笅鏂囷紙Context锛夋湁涓夌褰㈡€侊細
 * - DOM 鑺傜偣锛圗lement锛夛細CSS/regex(text/html) 鐩存帴浣滅敤锛宩son 瑙勫垯鏃犳剰涔?
 * - JSON 鏁版嵁锛堜换鎰忓€硷級锛歫son 瑙勫垯浣滅敤锛宑ss 瑙勫垯鏃犳剰涔?
 * - 瀛楃涓诧細regex/template/concat/firstOf 鍙綔鐢?
 *
 * 鍙橀噺琛?vars锛歵emplate 瑙勫垯鐢?{{key}} 鍙栧€硷紱鍒楄〃鎶藉彇鏃?item 鍚勫瓧娈典骇鐗╀細鍚堝苟杩?vars 渚涘悗缁紩鐢?
 */
import type { Rule, CssRule, Extract, CleanOp } from "./types.ts";

/* ======================================================================
 * 涓婁笅鏂?
 * ====================================================================== */

export type EvalContext =
  | { kind: "dom"; node: Element | Document }
  | { kind: "json"; data: unknown }
  | { kind: "text"; text: string };

export interface EvalEnv {
  /** 鍙橀噺琛?*/
  vars: Record<string, string>;
  /** 绔欑偣鏍癸紝鐢ㄤ簬 {{base}} 鍙婄浉瀵?URL 琛ュ叏 */
  base: string;
}

/* ======================================================================
 * 鍏ュ彛
 * ====================================================================== */

/** 姹傚€间竴鏉¤鍒欙紝杩斿洖瀛楃涓诧紙鍙兘涓虹┖涓诧級 */
export function evalRule(rule: Rule, ctx: EvalContext, env: EvalEnv): string {
  switch (rule.via) {
    case "css":
      return evalCss(rule, ctx, env);
    case "json":
      return evalJson(rule, ctx);
    case "regex":
      return evalRegex(rule, ctx);
    case "literal":
      return rule.value;
    case "template":
      return applyTemplate(rule.template, env.vars);
    case "firstOf": {
      for (const r of rule.rules) {
        const v = evalRule(r, ctx, env);
        if (v && v.trim()) return v;
      }
      return "";
    }
    case "concat": {
      const sep = rule.separator ?? "";
      return rule.rules.map((r) => evalRule(r, ctx, env)).join(sep);
    }
  }
}

/* ======================================================================
 * CSS
 * ====================================================================== */

function evalCss(rule: CssRule, ctx: EvalContext, _env: EvalEnv): string {
  if (ctx.kind !== "dom") return "";
  const root = ctx.node;
  // self-or-descendant 璇箟锛氬厛鐪?root 鑷韩鏄惁鍖归厤锛屽啀鏌ュ悗浠?
  let el: Element | null = null;
  try {
    if (root instanceof Element && root.matches(rule.select)) {
      el = root;
    } else {
      el = root.querySelector(rule.select);
    }
  } catch {
    return "";
  }
  if (!el) return "";
  return extractFromElement(el, rule.extract ?? "text", rule.clean);
}

/** 浠庡厓绱犳娊鍙栨枃鏈?HTML/灞炴€э紝骞跺仛 clean 鍚庡鐞?*/
export function extractFromElement(
  el: Element,
  extract: Extract,
  clean?: CleanOp[],
): string {
  let raw: string;
  if (extract === "text") {
    raw = el.textContent ?? "";
  } else if (extract === "html") {
    // innerHTML 鏍囩杞崲琛屽悗娓呯悊
    raw = el.innerHTML
      .replace(/<br\s*\/?>(?!\n)/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  } else {
    raw = el.getAttribute(extract.attr) ?? "";
  }
  raw = raw.trim();
  if (clean) {
    for (const op of clean) {
      if ("replace" in op) {
        const re = new RegExp(op.replace.pattern, op.replace.flags ?? "g");
        raw = raw.replace(re, op.replace.with);
      } else if ("trim" in op) {
        raw = raw.trim();
      }
    }
  }
  return raw;
}

/* ======================================================================
 * JSONPath锛堟瀬绠€瀹炵幇锛?
 * 鏀寔锛?.a.b / $.a[0] / $.a[*].b / $[0].a / $.. 涓嶆敮鎸侀€掑綊涓嬮檷
 * ====================================================================== */

function evalJson(rule: { select: string }, ctx: EvalContext): string {
  if (ctx.kind !== "json") return "";
  const path = rule.select.replace(/^\$\.?/, "");
  if (path === "" || path === "$") {
    return stringify(ctx.data);
  }
  // 瑙ｆ瀽璺緞娈?
  const segs = parseJsonPath(path);
  let cur: unknown = ctx.data;
  for (const seg of segs) {
    if (cur == null) return "";
    if (seg.type === "key") {
      cur = (cur as Record<string, unknown>)[seg.name];
    } else if (seg.type === "index") {
      cur = (cur as unknown[])[seg.idx];
    } else if (seg.type === "wildcard") {
      // 鍙栫涓€涓?
      const arr = cur as unknown[];
      cur = Array.isArray(arr) ? arr[0] : undefined;
    }
  }
  return stringify(cur);
}

type PathSeg =
  | { type: "key"; name: string }
  | { type: "index"; idx: number }
  | { type: "wildcard" };

function parseJsonPath(path: string): PathSeg[] {
  const segs: PathSeg[] = [];
  // 鍖归厤 a.b[0][*].c
  const re = /([a-zA-Z_$][\w$]*)|\[(\d+)\]|\[\*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) {
      segs.push({ type: "key", name: m[1] });
    } else if (m[2] !== undefined) {
      segs.push({ type: "index", idx: Number(m[2]) });
    } else {
      segs.push({ type: "wildcard" });
    }
  }
  return segs;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ======================================================================
 * 姝ｅ垯
 * ====================================================================== */

function evalRegex(
  rule: { pattern: string; flags?: string; group?: number; source?: "text" | "html" },
  ctx: EvalContext,
): string {
  let text = "";
  if (ctx.kind === "text") {
    text = ctx.text;
  } else if (ctx.kind === "dom") {
    text =
      rule.source === "html"
        ? (ctx.node as Element).innerHTML ?? ""
        : (ctx.node as Element).textContent ?? "";
  } else {
    text = stringify(ctx.data);
  }
  try {
    const re = new RegExp(rule.pattern, rule.flags ?? "");
    const m = re.exec(text);
    if (!m) return "";
    const g = rule.group ?? 0;
    return m[g] ?? "";
  } catch {
    return "";
  }
}

/* ======================================================================
 * 妯℃澘
 * ====================================================================== */

/** {{var}} 鏇挎崲锛涙湭瀹氫箟鍙橀噺淇濈暀鍘熸牱 */
export function applyTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_full, key: string) => {
    return key in vars ? vars[key] : `{{${key}}}`;
  });
}

/* ======================================================================
 * 鍒楄〃鎶藉彇
 * ====================================================================== */

export interface ListItem {
  [field: string]: string;
}

/**
 * 鎸夊垪琛ㄨ鍒欐娊鍙栧鏉¤褰?
 * @param htmlOrJson 鍘熷鍝嶅簲锛圚TML 瀛楃涓?鎴?宸?parse 鐨?JSON锛?
 * @param list ListRule
 * @param env 鐜鍙橀噺
 */
export function evalList(
  source: string | unknown,
  list: {
    via?: "css" | "json";
    select: string;
    item: Record<string, Rule>;
  },
  env: EvalEnv,
): ListItem[] {
  const via = list.via ?? "css";
  if (via === "css") {
    if (typeof source !== "string") return [];
    const doc = parseHtml(source);
    if (!doc) return [];
    let nodes: Element[] = [];
    try {
      nodes = Array.from(doc.querySelectorAll(list.select));
    } catch {
      return [];
    }
    return nodes.map((node) => {
      const item: ListItem = {};
      const ctx: EvalContext = { kind: "dom", node };
      for (const [field, rule] of Object.entries(list.item)) {
        item[field] = evalRule(rule, ctx, env);
      }
      return item;
    });
  } else {
    // json
    let data: unknown = source;
    if (typeof source === "string") {
      try {
        data = JSON.parse(source);
      } catch {
        return [];
      }
    }
    // select 浣滀负 JSONPath 瀹氫綅鏁扮粍
    const arr = jsonSelectArray(data, list.select);
    return arr.map((d) => {
      const item: ListItem = {};
      const ctx: EvalContext = { kind: "json", data: d };
      for (const [field, rule] of Object.entries(list.item)) {
        item[field] = evalRule(rule, ctx, env);
      }
      return item;
    });
  }
}

/** JSONPath 瀹氫綅鍒版暟缁勶細$.data.list 鈫?鍙栬璺緞涓嬬殑鏁扮粍 */
function jsonSelectArray(data: unknown, path: string): unknown[] {
  const p = path.replace(/^\$\.?/, "");
  if (p === "" || p === "$") return Array.isArray(data) ? data : [];
  const segs = parseJsonPath(p);
  let cur: unknown = data;
  for (const seg of segs) {
    if (cur == null) return [];
    if (seg.type === "key") {
      cur = (cur as Record<string, unknown>)[seg.name];
    } else if (seg.type === "index") {
      cur = (cur as unknown[])[seg.idx];
    } else if (seg.type === "wildcard") {
      // 灞曞紑涓烘暟缁勭户缁?
      cur = cur as unknown[];
    }
  }
  return Array.isArray(cur) ? cur : cur == null ? [] : [cur];
}

/* ======================================================================
 * HTML 瑙ｆ瀽
 * ====================================================================== */

let parser: DOMParser | null = null;

/** 瑙ｆ瀽 HTML 瀛楃涓蹭负 Document锛堢紦瀛?DOMParser锛?*/
export function parseHtml(html: string): Document | null {
  if (!html) return null;
  if (!parser) parser = new DOMParser();
  try {
    return parser.parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

/* ======================================================================
 * 鐩稿 URL 琛ュ叏
 * ====================================================================== */

/** 鐩稿 URL 琛ュ叏涓虹粷瀵?URL锛涘凡鏄粷瀵圭殑鐩存帴杩斿洖 */
export function resolveUrl(url: string, base: string): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return base.split(":")[0] + ":" + url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
