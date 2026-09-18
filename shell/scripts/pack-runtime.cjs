/* Stage the self-contained dsh runtime as a LOOSE resource tree bundled into
 * installers.
 *
 * The packaged app must boot with ZERO machine dependencies (no system node,
 * no pnpm, no network). This script assembles everything the runtime needs
 * into src-tauri/resources/runtime/ — which tauri bundles as plain files
 * into the installer. First boot runs node + dsh straight from the install
 * dir with ZERO unpacking (the dsh-desktop approach: "asar": false); only
 * the small profile template is copied into the persistent home on boot
 * (see packaged_runtime / materialize_profile in src-tauri/src/lib.rs).
 *
 * Layout (paths are hard-coded in lib.rs — keep in sync):
 *   node/<node-dir>/...        node binary per platform dir (win32-x64, darwin-arm64, darwin-x64, linux-x64)
 *   dsh/node_modules/...       @deepseek-ai/dsh runtime (vendor/dsh-runtime install)
 *   profiles/slacker/...       dsh profile template + hoisted node_modules (bundles pre-installed)
 *   profiles/.pack-version     "<files>:<bytes>" stamp of the template; keys
 *                              the shell's re-copy-on-upgrade marker
 *
 * Usage: node scripts/pack-runtime.cjs [--target <rust-target>] (default: host)
 *   aarch64-pc-windows-msvc intentionally ships the x64 runtime: node-x64 runs
 *   under Windows 11 ARM emulation, sidestepping cross-arch npm optional deps.
 *   universal-apple-darwin ships BOTH darwin dirs; the shell picks by ARCH.
 *
 * Idempotent: installs run only when node_modules is missing (marker
 * node_modules/.pack-hoisted for the profile); node dist archives are cached
 * under src-tauri/target/runtime-pack/.
 *
 * Depends on devDependencies: extract-zip (win node dist).
 * Runs as tauri's beforeBuildCommand (cwd = shell/) and via `npm run pack:runtime`.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const extractZip = require('extract-zip');

// >= 22.18.0 required: dsh's bin.js gates on `import.meta.main`, which Node
// only added in v22.18.0/v24.2.0 — older nodes exit silently (exit 0, no
// output, no listener) and the shell reports a boot timeout.
const NODE_VERSION = process.env.RUNTIME_NODE_VERSION || '22.23.2';

const repoRoot = path.resolve(__dirname, '..', '..');
const shellDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(repoRoot, 'vendor', 'dsh-runtime');
const profileDir = path.join(shellDir, 'dsh-profile', 'slacker');
const cacheDir = path.join(shellDir, 'src-tauri', 'target', 'runtime-pack');
const outDir = path.join(shellDir, 'src-tauri', 'resources', 'runtime');

const log = (m) => console.log(`[pack-runtime] ${m}`);
const fail = (m) => { console.error(`[pack-runtime] ERROR ${m}`); process.exit(1); };

/** Parse --target <rust-target> (falls back to the host triple). */
function parseTarget () {
  const i = process.argv.indexOf('--target');
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[os.arch()] || os.arch();
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

/** Run a command, inheriting stdio; hard-fail on non-zero exit. */
function run (cmd, args, cwd) {
  log(`$ ${cmd} ${args.join(' ')}  (cwd=${path.relative(repoRoot, cwd) || '.'})`);
  // pnpm/npm ship as .cmd shims on Windows — spawnSync needs shell to resolve them.
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`command failed (${cmd}): exit ${r.status}`);
}

/** Download url -> file (follows redirects; nodejs.org does not redirect but stay safe). */
function download (url, dest) {
  return new Promise((resolve, reject) => {
    log(`download ${url}`);
    const get = (u, redirects) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        return get(new URL(res.headers.location, u).href, redirects + 1);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
    get(url, 0);
  });
}

/** nodejs.org dist coordinates for a rust target. Windows ARM reuses x64. */
function nodeDists (target) {
  if (target === 'x86_64-pc-windows-msvc' || target === 'aarch64-pc-windows-msvc') {
    return [{ dir: 'win32-x64', file: `node-v${NODE_VERSION}-win-x64.zip`, kind: 'zip' }];
  }
  if (target === 'universal-apple-darwin' || target.endsWith('aarch64-apple-darwin') || target.endsWith('x86_64-apple-darwin')) {
    return [
      { dir: 'darwin-arm64', file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, kind: 'tgz' },
      { dir: 'darwin-x64', file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, kind: 'tgz' },
    ];
  }
  if (target === 'x86_64-unknown-linux-gnu') {
    return [{ dir: 'linux-x64', file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, kind: 'tgz' }];
  }
  fail(`unsupported target: ${target}`);
}

/** Extract an archive into cacheDir; return the extracted top-level dir path. */
async function extractArchive (archivePath, kind) {
  const into = path.join(cacheDir, path.basename(archivePath).replace(/\.(zip|tar\.gz)$/, ''));
  if (fs.existsSync(into)) return into; // cached across builds
  fs.mkdirSync(cacheDir, { recursive: true });
  if (kind === 'zip') {
    await extractZip(archivePath, { dir: cacheDir });
  } else {
    // bsdtar (win/mac) and GNU tar (linux) both handle .tar.gz.
    const r = spawnSync('tar', ['-xzf', archivePath, '-C', cacheDir], { stdio: 'inherit' });
    if (r.status !== 0) fail(`tar extract failed for ${archivePath}`);
  }
  return into;
}

/** Stats (files, bytes) of a file tree, recursing through real dirs.
 * Symlinks are dereferenced (stat) so stamps match what actually lands on
 * disk after the dereferencing copies below. */
function treeStats (root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(root);
  return { files, bytes };
}

/** The profile template must ship as a plain file tree: `.dsh-module-fallback`
 * is materialized/owned by dsh at boot (healProfileModuleFallback) and any
 * real directory found there makes dsh abort with "exists and is not a
 * symlink" — shipping a template copy of it bricks first boot (v0.0.1
 * regression). */
const PROFILE_SKIP = new Set(['.dsh-module-fallback']);

async function main () {
  const target = parseTarget();
  log(`target=${target} node=v${NODE_VERSION}`);
  const t0 = Date.now();

  // 1. Plugin bundles must exist — the profile install copies them in.
  for (const p of ['novel', 'ui-slacker']) {
    if (!fs.existsSync(path.join(shellDir, 'plugins', p, 'lib'))) {
      fail(`shell/plugins/${p}/lib missing — run \`npm run setup\` (plugin bundle) first`);
    }
  }

  // 2. dsh runtime node_modules (production deps only; gitignored in the repo).
  if (!fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    log('installing dsh runtime deps (npm install, one-time)...');
    run('npm', ['install', '--no-audit', '--no-fund'], runtimeDir);
  }

  // 3. Profile node_modules — hoisted layout: no symlinks, survives zipping,
  //    and dedupes on disk. Installed in the template dir so the committed
  //    pnpm-lock.yaml file: paths resolve as-is.
  const hoistedMarker = path.join(profileDir, 'node_modules', '.pack-hoisted');
  if (!fs.existsSync(hoistedMarker)) {
    log('installing profile deps hoisted (pnpm, one-time)...');
    fs.rmSync(path.join(profileDir, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
    // RUNTIME_PNPM_STORE: opt-in store location (sandboxed machines / cache reuse);
    // unset keeps pnpm's own default, so CI stays untouched.
    const storeArgs = process.env.RUNTIME_PNPM_STORE
      ? ['--store-dir', process.env.RUNTIME_PNPM_STORE] : [];
    run('pnpm', ['install', '--config.auto-install-peers=false', '--node-linker=hoisted',
      '--no-frozen-lockfile', ...storeArgs], profileDir);
    fs.writeFileSync(hoistedMarker, `${Date.now()}\n`);
  }

  // 4. Node dist(s) for the target — cached, extracted once.
  const nodeDirs = []; // [zipDir, extractedDir]
  for (const dist of nodeDists(target)) {
    const archive = path.join(cacheDir, dist.file);
    if (!fs.existsSync(archive)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      await download(`https://nodejs.org/dist/v${NODE_VERSION}/${dist.file}`, archive);
    }
    const extracted = await extractArchive(archive, dist.kind);
    nodeDirs.push([dist.dir, extracted]);
  }

  // 5. Stage the LOOSE resource tree (no zip). Tauri bundles it as plain
  //    files, so first boot runs node + dsh straight from the install dir
  //    with zero unpacking. dereference: true flattens npm's .bin symlinks
  //    into real files (installer bundlers and the packed layout both stay
  //    symlink-free — same guarantee the old zip gave).
  //
  //    Idempotent: the tree is rebuilt only when the sources' fingerprints
  //    (file counts + byte totals, via treeStats) differ from the
  //    .packed-stamp recorded after the last successful copy — copying
  //    ~40k files takes tens of minutes on slow disks, so rebuilds skip it.
  const stamp = JSON.stringify({
    target,
    node: nodeDirs.map(([dir, extracted]) => `${dir}=${path.basename(extracted)}`).join(','),
    dsh: treeStats(path.join(runtimeDir, 'node_modules')),
    profile: treeStats(profileDir),
  });
  const stampPath = path.join(outDir, '.packed-stamp');
  const fresh = fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === `${stamp}\n`;
  if (fresh) {
    log('runtime tree already packed and up to date — skipping copy');
  } else {
    // A tree without a stamp may be the tail of an interrupted run: it is
    // trusted only when the last-written artifacts are all present
    // (.pack-version is written after every copy step completes).
    const nodeBin = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
    const looksComplete = fs.existsSync(path.join(outDir, 'profiles', '.pack-version')) &&
      fs.existsSync(path.join(outDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) &&
      fs.existsSync(path.join(outDir, 'node', nodeDists(target)[0].dir, nodeBin));
    if (looksComplete) {
      log('runtime tree complete but unstamped — trusting it, recording stamp');
    } else {
      fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
      fs.mkdirSync(outDir, { recursive: true });
      for (const [dir, extracted] of nodeDirs) {
        fs.cpSync(extracted, path.join(outDir, 'node', dir), { recursive: true, dereference: true });
      }
      fs.cpSync(path.join(runtimeDir, 'node_modules'), path.join(outDir, 'dsh', 'node_modules'),
        { recursive: true, dereference: true });

      // Profile template (skips dsh-managed state), then stamp its totals
      // next to it: lib.rs keys the persistent-home marker on this file to
      // decide first-boot copy vs reuse across upgrades.
      const profileStats = treeStats(profileDir);
      fs.cpSync(profileDir, path.join(outDir, 'profiles', 'slacker'), {
        recursive: true,
        dereference: true,
        filter: (src) => !PROFILE_SKIP.has(path.basename(src)),
      });
      fs.writeFileSync(path.join(outDir, 'profiles', '.pack-version'),
        `${profileStats.files}:${profileStats.bytes}\n`);
      log(`profile template: ${profileStats.files} files / ${(profileStats.bytes / 1048576).toFixed(1)} MB`);
    }
    fs.writeFileSync(stampPath, `${stamp}\n`);
  }

  const total = treeStats(outDir);
  const mb = (total.bytes / 1048576).toFixed(1);
  log(`done: ${outDir} (${total.files} files, ${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => fail(e.stack || e.message));
