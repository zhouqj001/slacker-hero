/* Publish the slacker standalone windows into the Tauri frontend dist.
 *
 * tauri.conf.json points frontendDist at ../ui, and WebviewUrl::App("tea.html")
 * / ("novel.html") resolves against THAT directory — not src-tauri/resources.
 * Without these files the webview falls back to index.html (the dsh splash),
 * which calls shell_boot and kills the live dsh server (connection flood).
 *
 * Sources stay canonical elsewhere: HTML in src-tauri/resources (also packed
 * as bundle resources), plugin bundles in each plugin's lib/ dir (tsdown output).
 * This script copies them into ../ui so both `tauri dev` and `tauri build`
 * serve the real standalone pages. Run before every dev/build via
 * beforeDevCommand / beforeBuildCommand.
 *
 * Missing plugin bundles (not yet built) are a warning, not a failure:
 * `tauri dev` still starts; the window will just 404 until you build them.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'ui');
const htmlSrc = path.join(root, 'src-tauri', 'resources');

const vendorDir = path.join(htmlSrc, 'vendor');
fs.mkdirSync(path.join(ui, 'vendor'), { recursive: true });
if (!fs.existsSync(vendorDir)) {
  console.warn(`[standalone-assets] WARN missing vendor dir (standalone pages will 404 their React UMD): ${path.relative(root, vendorDir)}`);
} else for (const f of fs.readdirSync(vendorDir)) {
  fs.copyFileSync(path.join(vendorDir, f), path.join(ui, 'vendor', f));
  console.log(`[standalone-assets] resources/vendor/${f} -> ui/vendor/${f}`);
}

const copies = [
  { src: path.join(htmlSrc, 'tea.html'),       dest: path.join(ui, 'tea.html') },
  { src: path.join(htmlSrc, 'novel.html'),     dest: path.join(ui, 'novel.html') },
  { src: path.join(htmlSrc, 'stock-mini.html'), dest: path.join(ui, 'stock-mini.html') },
  {
    src: path.join(root, 'plugins', 'novel', 'lib', 'client.js'),
    dest: path.join(ui, '@slacker', 'novel', 'client.js'),
  },
  {
    src: path.join(root, 'plugins', 'novel', 'lib', 'novel-reader.js'),
    dest: path.join(ui, '@slacker', 'novel', 'novel-reader.js'),
  },
  {
    src: path.join(root, 'plugins', 'ui-slacker', 'lib', 'tea.js'),
    dest: path.join(ui, '@slacker', 'ui-slacker', 'tea.js'),
  },
  {
    src: path.join(root, 'plugins', 'ui-slacker', 'lib', 'stock-mini.js'),
    dest: path.join(ui, '@slacker', 'ui-slacker', 'stock-mini.js'),
  },
];

let failures = 0;
for (const { src, dest } of copies) {
  if (!fs.existsSync(src)) {
    if (src.includes(`${path.sep}lib${path.sep}`)) {
      console.warn(`[standalone-assets] WARN missing bundle (run pnpm --filter @slacker/* bundle first): ${path.relative(root, src)}`);
    } else {
      console.error(`[standalone-assets] ERROR missing source: ${src}`);
      failures += 1;
    }
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[standalone-assets] ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}

if (failures > 0) {
  console.error(`[standalone-assets] ${failures} required source(s) missing; tauri dev/build aborted`);
  process.exit(1);
}