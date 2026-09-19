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
 *   pnpm/...                   vendored pnpm (pnpm.cjs + PATH shims) so end-user
 *                              machines install/upgrade plugins without a global pnpm
 *   profiles/slacker/...       dsh profile template + hoisted node_modules (bundles
 *                              pre-installed) + deps/<plugin>.tgz (self-contained
 *                              file: deps — see stagePluginTarballs)
 *   profiles/.pack-version     "<files>:<bytes>" stamp of the template; keys
 *                              the shell's re-copy-on-upgrade marker
 *
 * Usage: node scripts/pack-runtime.cjs [--target <rust-target>] [--tgz-only]
 *   --tgz-only restages just the plugin tarballs (cheap; used by
 *   beforeDevCommand so dev installs resolve without a full pack).
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
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');

const extractZip = require('extract-zip');

// >= 22.18.0 required: dsh's bin.js gates on `import.meta.main`, which Node
// only added in v22.18.0/v24.2.0 — older nodes exit silently (exit 0, no
// output, no listener) and the shell reports a boot timeout.
const NODE_VERSION = process.env.RUNTIME_NODE_VERSION || '22.23.2';

// Vendored pnpm: end-user machines install/upgrade marketplace plugins
// through this copy (spawned by dsh from the runtime's PATH), so no global
// pnpm is needed. Must match the `packageManager` pin recorded in the
// profile template's node_modules/.modules.yaml — pnpm refuses store
// layouts written by a different version.
const PNPM_VERSION = process.env.RUNTIME_PNPM_VERSION || '11.7.0';

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

/** md5 of a file — cheap change detection for small tarballs. */
function fileHash (p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Bundle the built plugin packages into the profile template as tgz files
 * (deps/) and point package.json at them (file:./deps/...).
 *
 * The committed deps (file:../../../shell/plugins/<name>) only resolve on
 * the dev machine. On end-user machines the template is copied to the
 * persistent home, the relative source dirs don't exist there, and ANY pnpm
 * mutation (marketplace install/upgrade) fails to resolve the graph.
 * Self-contained tarballs make the shipped profile resolvable everywhere
 * and keep the lockfile entries portable.
 *
 * Returns a stamp (names + hashes) of the produced tarballs; the hoisted
 * install re-runs whenever it changes (plugin rebuild or version bump).
 */
function stagePluginTarballs () {
  const depsDir = path.join(profileDir, 'deps');
  const staging = path.join(cacheDir, 'plugin-tgz');
  fs.mkdirSync(depsDir, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });

  const manifestPath = path.join(profileDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const produced = [];
  let changed = false;

  for (const p of ['novel', 'ui-slacker']) {
    const pkgRoot = path.join(shellDir, 'plugins', p);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    const fileName = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
    run('npm', ['pack', pkgRoot, '--pack-destination', staging], shellDir);
    produced.push(fileName);
    const staged = path.join(staging, fileName);
    const dest = path.join(depsDir, fileName);
    if (!fs.existsSync(dest) || fileHash(dest) !== fileHash(staged)) {
      log(`plugin tarball changed: deps/${fileName}`);
      fs.copyFileSync(staged, dest);
      changed = true;
    }
    manifest.dependencies[pkg.name] = `file:./deps/${fileName}`;
  }

  // Drop tarballs left by older plugin versions.
  for (const f of fs.readdirSync(depsDir)) {
    if (f.endsWith('.tgz') && !produced.includes(f)) {
      log(`removing stale plugin tarball: deps/${f}`);
      fs.rmSync(path.join(depsDir, f), { force: true });
      changed = true;
    }
  }

  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.readFileSync(manifestPath, 'utf8') !== next) {
    fs.writeFileSync(manifestPath, next);
    changed = true;
  }
  const stamp = produced.map((f) => `${f}=${fileHash(path.join(depsDir, f))}`).join(',');
  log(changed ? `plugin tarballs staged (${stamp})` : `plugin tarballs unchanged (${stamp})`);
  return stamp;
}

/**
 * Extract a .tar.gz in pure Node (zlib + manual tar parsing). npm pack
 * tarballs only contain plain files/dirs, but long paths may arrive as PAX
 * ('x') or GNU ('L') extended headers — both handled here.
 */
function extractTarGz (archive, dest) {
  const buf = zlib.gunzipSync(fs.readFileSync(archive));
  const octal = (off, len) =>
    parseInt(buf.toString('ascii', off, off + len).replace(/[\0 ]+$/g, '').trim(), 8) || 0;
  const cstr = (off, len) => buf.toString('utf8', off, off + len).replace(/\0[\s\S]*$/, '');
  let pos = 0;
  let paxPath = null; // path override from a pending PAX extended header
  let gnuName = null; // path override from a pending GNU longname entry
  while (pos + 512 <= buf.length) {
    const hdr = pos;
    if (buf[hdr] === 0 && buf.subarray(hdr, hdr + 512).every((b) => b === 0)) break; // end blocks
    let name = paxPath || gnuName;
    if (!name) {
      const base = cstr(hdr, 100);
      const prefix = cstr(hdr + 345, 155); // ustar long-path split
      name = prefix ? `${prefix}/${base}` : base;
    }
    paxPath = gnuName = null;
    if (name.includes('..')) fail(`tar entry escapes destination: ${name}`);
    const type = String.fromCharCode(buf[hdr + 156]);
    const fsize = octal(hdr + 124, 12);
    const dataOff = hdr + 512;
    if (type === 'x') {
      // PAX extended header: "<len> key=value\n" lines; "path" renames next.
      for (const line of buf.toString('utf8', dataOff, dataOff + fsize).split('\n')) {
        const m = line.match(/^\d+ ([^=]+)=(.*)$/);
        if (m && m[1] === 'path') paxPath = m[2];
      }
    } else if (type === 'L') {
      gnuName = cstr(dataOff, fsize);
    } else if (type === '5') {
      fs.mkdirSync(path.join(dest, name), { recursive: true });
    } else if (type === '0' || type === '\0' || type === '7') {
      const target = path.join(dest, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf.subarray(dataOff, dataOff + fsize));
    }
    // 'g' global pax, 'K' long linkname, '1'/'2' links: nothing to materialize.
    pos = dataOff + Math.ceil(fsize / 512) * 512;
  }
}

/**
 * Vendor pnpm into the runtime tree (pnpm/pnpm.cjs + PATH shims). Cached
 * like the node dists; the download delegates to `npm pack` so registry
 * mirrors configured on the pack machine are honored.
 */
async function vendorPnpm () {
  const archive = path.join(cacheDir, `pnpm-${PNPM_VERSION}.tgz`);
  if (!fs.existsSync(archive)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    run('npm', ['pack', `pnpm@${PNPM_VERSION}`, '--pack-destination', cacheDir], shellDir);
  }
  const extractRoot = path.join(cacheDir, `pnpm-${PNPM_VERSION}`);
  // The entry point must keep its relative layout: bin/pnpm.cjs -> bin/pnpm.mjs
  // -> ../dist/pnpm.mjs (+ dist/node_modules helpers), so vendor the whole
  // package tree rather than the single bin file.
  const cjs = path.join(extractRoot, 'package', 'bin', 'pnpm.cjs');
  if (!fs.existsSync(cjs)) {
    fs.mkdirSync(extractRoot, { recursive: true });
    // Pure-Node extraction: no external bsdtar/GNU tar needed on the pack
    // machine (stock Windows boxes and CI images may lack tar on PATH).
    extractTarGz(archive, extractRoot);
    log(`extracted pnpm-${PNPM_VERSION}.tgz`);
  }

  const pnpmOut = path.join(outDir, 'pnpm');
  fs.rmSync(pnpmOut, { recursive: true, force: true, maxRetries: 3 });
  fs.cpSync(path.join(extractRoot, 'package'), pnpmOut, { recursive: true });

  // Windows shim (node dir is hard-coded: win32-x64 is the only node dist
  // shipped for Windows targets, ARM64 included — see nodeDists).
  fs.writeFileSync(path.join(pnpmOut, 'pnpm.cmd'), [
    '@echo off',
    'setlocal',
    '"%~dp0..\\node\\win32-x64\\node.exe" "%~dp0bin\\pnpm.cjs" %*',
    '',
  ].join('\r\n'));

  // POSIX shim; universal-apple-darwin ships both node dists, so resolve
  // the dir by machine arch at call time.
  const shPath = path.join(pnpmOut, 'pnpm');
  fs.writeFileSync(shPath, [
    '#!/bin/sh',
    'dir="$(cd "$(dirname "$0")" && pwd)"',
    'case "$(uname -s)-$(uname -m)" in',
    '  Darwin-arm64|Darwin-aarch64) node_dir=darwin-arm64 ;;',
    '  Darwin-*) node_dir=darwin-x64 ;;',
    '  *) node_dir=linux-x64 ;;',
    'esac',
    'exec "$dir/../node/$node_dir/bin/node" "$dir/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(shPath, 0o755);
  log(`vendored pnpm@${PNPM_VERSION} -> ${path.relative(repoRoot, pnpmOut)}/`);
}

async function main () {
  const target = parseTarget();
  const tgzOnly = process.argv.includes('--tgz-only');
  log(`target=${target} node=v${NODE_VERSION}${tgzOnly ? ' (tgz-only)' : ''}`);
  const t0 = Date.now();

  // 1. Plugin bundles must exist — the profile install copies them in.
  //    (Also gates --tgz-only: the tarball IS the shipped bundle.)
  for (const p of ['novel', 'ui-slacker']) {
    if (!fs.existsSync(path.join(shellDir, 'plugins', p, 'lib'))) {
      fail(`shell/plugins/${p}/lib missing — run \`npm run setup\` (plugin bundle) first`);
    }
  }

  if (tgzOnly) {
    stagePluginTarballs();
    log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return;
  }

  // 2. dsh runtime node_modules (production deps only; gitignored in the repo).
  if (!fs.existsSync(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    log('installing dsh runtime deps (npm install, one-time)...');
    run('npm', ['install', '--no-audit', '--no-fund'], runtimeDir);
  }

  // 3. Bundle the built plugins into the template (deps/*.tgz, package.json
  //    file:./deps/...) so the hoisted install below locks that graph — the
  //    shipped profile then resolves everywhere, not just on this machine.
  const tgzStamp = stagePluginTarballs();

  // 4. Profile node_modules — hoisted layout: no symlinks, survives zipping,
  //    and dedupes on disk. Installed in the template dir against the tgz
  //    deps, and re-runs whenever the tarball stamp changes.
  const hoistedMarker = path.join(profileDir, 'node_modules', '.pack-hoisted');
  const markerStamp = fs.existsSync(hoistedMarker) ? fs.readFileSync(hoistedMarker, 'utf8').trim() : '';
  if (markerStamp !== tgzStamp) {
    log(markerStamp
      ? 'plugin tarballs changed since last install — reinstalling profile deps hoisted...'
      : 'installing profile deps hoisted (pnpm, one-time)...');
    fs.rmSync(path.join(profileDir, 'node_modules'), { recursive: true, force: true, maxRetries: 3 });
    // RUNTIME_PNPM_STORE: opt-in store location (sandboxed machines / cache reuse);
    // unset keeps pnpm's own default, so CI stays untouched.
    const storeArgs = process.env.RUNTIME_PNPM_STORE
      ? ['--store-dir', process.env.RUNTIME_PNPM_STORE] : [];
    run('pnpm', ['install', '--config.auto-install-peers=false', '--node-linker=hoisted',
      '--no-frozen-lockfile', ...storeArgs], profileDir);
    fs.writeFileSync(hoistedMarker, `${tgzStamp}\n`);
  }

  // 5. Node dist(s) for the target — cached, extracted once.
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

  // 6. Stage the LOOSE resource tree (no zip). Tauri bundles it as plain
  //    files, so first boot runs node + dsh straight from the install dir
  //    with zero unpacking. dereference: true flattens npm's .bin symlinks
  //    into real files (installer bundlers and the packed layout both stay
  //    symlink-free — same guarantee the old zip gave).
  //
  //    Idempotent: the tree is rebuilt only when the sources' fingerprints
  //    (file counts + byte totals, via treeStats) differ from the
  //    .packed-stamp recorded after the last successful copy — copying
  //    ~40k files takes tens of minutes on slow disks, so rebuilds skip it.
  const profileStats = treeStats(profileDir);
  const stamp = JSON.stringify({
    target,
    node: nodeDirs.map(([dir, extracted]) => `${dir}=${path.basename(extracted)}`).join(','),
    dsh: treeStats(path.join(runtimeDir, 'node_modules')),
    profile: profileStats,
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
    const packVersionPath = path.join(outDir, 'profiles', '.pack-version');
    const looksComplete = fs.existsSync(packVersionPath) &&
      // The recorded fingerprint must still match the CURRENT template: an
      // unstamped tree that predates a template change (e.g. one staged
      // before the deps/*.tgz layout) must be rebuilt, not trusted.
      fs.readFileSync(packVersionPath, 'utf8') === `${profileStats.files}:${profileStats.bytes}\n` &&
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

  // 7. Vendor pnpm (AFTER the stamp block: step 6 may rmSync outDir).
  await vendorPnpm();

  const total = treeStats(outDir);
  const mb = (total.bytes / 1048576).toFixed(1);
  log(`done: ${outDir} (${total.files} files, ${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => fail(e.stack || e.message));
