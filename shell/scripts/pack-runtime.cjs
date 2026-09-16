/* Build the self-contained dsh runtime zip bundled into installers.
 *
 * The packaged app must boot with ZERO machine dependencies (no system node,
 * no pnpm, no network). This script assembles everything the runtime needs
 * into one deflate zip — shell/src-tauri/resources/runtime/dsh-runtime.zip —
 * which tauri bundles as a resource and the shell extracts on first boot
 * (see spawn_dsh_web / packaged_runtime in src-tauri/src/lib.rs).
 *
 * Zip layout (paths are hard-coded in lib.rs — keep in sync):
 *   node/<node-dir>/...        node binary per platform dir (win32-x64, darwin-arm64, darwin-x64, linux-x64)
 *   dsh/node_modules/...       @deepseek-ai/dsh runtime (vendor/dsh-runtime install)
 *   profiles/slacker/...       dsh profile template + hoisted node_modules (bundles pre-installed)
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
 * Depends on devDependencies: archiver (zip write), extract-zip (win node dist).
 * Runs as tauri's beforeBuildCommand (cwd = shell/) and via `npm run pack:runtime`.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const archiver = require('archiver');
const extractZip = require('extract-zip');

const NODE_VERSION = process.env.RUNTIME_NODE_VERSION || '22.14.0';

const repoRoot = path.resolve(__dirname, '..', '..');
const shellDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(repoRoot, 'vendor', 'dsh-runtime');
const profileDir = path.join(shellDir, 'dsh-profile', 'slacker');
const cacheDir = path.join(shellDir, 'src-tauri', 'target', 'runtime-pack');
const outZip = path.join(shellDir, 'src-tauri', 'resources', 'runtime', 'dsh-runtime.zip');

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

  // 5. Zip it all (deflate). Directories stream straight from their source
  //    roots under their in-zip prefix — no staging copy.
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const a = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    a.on('warning', (e) => console.warn(`[pack-runtime] warn: ${e.message}`));
    a.on('error', reject);
    a.pipe(output);
    for (const [dir, extracted] of nodeDirs) a.directory(extracted, `node/${dir}`);
    a.directory(path.join(runtimeDir, 'node_modules'), 'dsh/node_modules');
    a.directory(profileDir, 'profiles/slacker');
    a.finalize();
  });
  const mb = (fs.statSync(outZip).size / 1048576).toFixed(1);
  log(`done: ${outZip} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => fail(e.stack || e.message));
