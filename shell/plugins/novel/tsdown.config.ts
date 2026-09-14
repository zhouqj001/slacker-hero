/**
 * Standalone tsdown config for the novel plugin.
 *
 * Self-contained on purpose: the vendored dsh preset (packages/client/tsdown.client.ts)
 * is wired to the vendor workspace layout (its manifest glob cannot see this
 * package), so this config replicates only the parts the plugin needs:
 *
 * 1. Node half: src/index.ts + src/invariant.ts -> lib/ (ESM, everything inlined;
 *    every @deepseek-ai import is type-only and erased).
 * 2. Client half: src/client/index.ts -> lib/client.js (CJS, browser). `react` and
 *    `react/jsx-runtime` stay external — the dsh shell shares one instance through
 *    its frozen module table; inlining a second React breaks hooks. Everything
 *    else inlines. The artifact carries the __ModuleLoader__ closure-factory
 *    banner/footer the loader expects, stamped with this plugin's id.
 * 3. CSS: *.module.css compiles via lightningcss into a style injector emitting
 *    hashed class names — the same contract the vendored preset implements.
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

/** Plugin id stamped into the loader handoff and onto injected style tags. */
const PLUGIN_ID = '@slacker/novel'

const HERE = dirname(fileURLToPath(import.meta.url))

const CSS_VIRTUAL_PREFIX = '\0novel-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector with the CSS-modules class map. */
function styleInjectionModule(fileId: string, css: string, classMap?: Record<string, string>): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${PLUGIN_ID}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Locate a stylesheet import against the package sources. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  const boundary = emitted.indexOf(`${sep}src${sep}`)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + `${sep}src${sep}`.length))
}

/** Shared runtime modules the dsh shell provides through its module table. */
const PLATFORM_EXTERNALS = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

const node: UserConfig = {
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  // tsdown 0.22 emits .mjs for ESM unconditionally; the exports map follows it.
  dts: false,
  clean: false,
  sourcemap: true,
}

/** CSS-modules plugin working for any client build of this package. */
function cssPlugin(buildName: string) {
  return {
    name: buildName,
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = readFileSync(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

/**
 * One browser entry per build, fully self-contained. The dsh shell registers
 * only the manifest loader entries in its module table — any shared chunk a
 * multi-entry build would emit ("NovelView-*.cjs") misses the table and the
 * plugin refuses to boot. Each entry must inline everything except react.
 */
function browserClient(options: {
  name: string
  entry: Record<string, string>
  dts?: boolean
}): UserConfig {
  return {
    name: options.name,
    entry: options.entry,
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: options.dts ?? false,
    sourcemap: true,
    clean: false,
    // The shell's module table answers react; everything else inlines.
    deps: {
      neverBundle: specifier => PLATFORM_EXTERNALS.has(specifier),
      alwaysBundle: specifier => !PLATFORM_EXTERNALS.has(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    // zustand-style probes need these baked in or the factory throws at boot.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [cssPlugin(`${options.name}-css-modules`)],
    outputOptions: {
      entryFileNames: '[name].js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

const client = browserClient({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  dts: true,
})

const novelReader = browserClient({
  name: `${PLUGIN_ID}/novel-reader`,
  entry: { 'novel-reader': 'src/client/main-novel-reader.tsx' },
})

export default defineConfig([
  { ...node, name: PLUGIN_ID },
  client,
  novelReader,
])
