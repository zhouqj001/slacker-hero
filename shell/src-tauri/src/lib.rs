/**
 * Slacker shell: spawns the dsh web runtime, parses its tokenized
 * URL from stdout, and navigates the main window to it. The shell owns the
 * process lifecycle (auto-restart, cleanup on exit) and exposes shell
 * commands to the remote page for the slacker overlay.
 */
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use std::collections::HashMap;
use tauri::{Emitter, Listener, Manager, RunEvent, State, WindowEvent};

/** Shared shell state: child process handle and the parsed dsh URL. */
struct ShellState {
    child: Mutex<Option<Child>>,
    url: Mutex<String>,
    /// dsh 主窗广播过来的根 CSS 变量快照（供独立窗调色）。
    theme_vars: Mutex<Option<serde_json::Value>>,
    /// 悬浮小窗进入前的阅读窗口状态：true 表示当前正是浮条（避免重复钉位/重复记录）。
    novel_was_floating: Mutex<bool>,
    /// 悬浮前阅读窗口的位置（物理像素）。
    novel_float_prev_pos: Mutex<Option<(i32, i32)>>,
    /// 悬浮前阅读窗口的尺寸（物理像素）。
    novel_float_prev_size: Mutex<Option<(u32, u32)>>,
    /// 展开设置/退出浮条时记录下的浮条位置（物理像素）：关闭设置缩回时回到原位，而非再贴底居中。
    novel_float_return_pos: Mutex<Option<(i32, i32)>>,
    /// 本地 TXT 章节目录缓存（name → 各章字节区间）：避免反复整本读取 + 正则切章。
    novel_toc_cache: Mutex<HashMap<String, Vec<NovelChapterBound>>>,
}

/** Result shape of the boot command. */
#[derive(Serialize)]
struct BootInfo {
    url: String,
    restarted: bool,
}

/** dsh CLI entry inside the npm-installed runtime (vendor/dsh-runtime),
 * relative to the repo root (cwd = src-tauri at spawn). The runtime's
 * node_modules is gitignored — restore with `npm install` in that dir. */
const DSH_BIN: &str = "vendor/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js";

/** Wait until a local TCP port accepts a connection. */
fn wait_port(host: &str, port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect((host, port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

/** Find a free TCP port by binding to port 0. */
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(3199)
}

/** Resolved dsh runtime: node executable, entry script, spawn cwd, DSH_HOME. */
struct DshRuntime {
    node: std::path::PathBuf,
    dsh_bin: std::path::PathBuf,
    dsh_cwd: std::path::PathBuf,
    home: std::path::PathBuf,
}

/** Extract the bundled runtime zip in one pass. Entries under profiles/ go
 * straight to <base>/home/profiles (the persistent dsh state, survives
 * upgrades); everything else goes to <base>/runtime (wiped on upgrade).
 * Each side carries a .version marker keyed by the zip fingerprint: matching
 * markers skip extraction entirely, a changed zip re-extracts only the stale
 * side. (Previously the profile was extracted into runtime/ and then copied
 * to home/ — a second ~15k-file write that cost minutes under Defender.) */
fn extract_packaged_runtime(
    zip_path: &std::path::Path,
    base: &std::path::Path,
    fingerprint: &str,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let runtime_dir = base.join("runtime");
    let profile_root = base.join("home").join("profiles");
    let runtime_marker = runtime_dir.join(".version");
    let profile_marker = profile_root.join(".profile-version");
    let marker_ok = |p: &std::path::Path| {
        std::fs::read_to_string(p).map(|v| v == fingerprint).unwrap_or(false)
    };
    let runtime_fresh = marker_ok(&runtime_marker);
    let profile_fresh = marker_ok(&profile_marker)
        && profile_root.join("slacker").join("node_modules").exists();
    if runtime_fresh && profile_fresh {
        return Ok(());
    }
    // Markers are only written after a full pass, so anything on disk now is
    // a leftover from an interrupted run — clear the stale sides up front.
    if !runtime_fresh && runtime_dir.exists() {
        std::fs::remove_dir_all(&runtime_dir).map_err(|e| format!("clean old runtime: {e}"))?;
    }
    if !profile_fresh {
        let slacker = profile_root.join("slacker");
        if slacker.exists() {
            std::fs::remove_dir_all(&slacker).map_err(|e| format!("clean old profile: {e}"))?;
        }
    }
    std::fs::create_dir_all(&runtime_dir).map_err(|e| format!("create runtime dir: {e}"))?;
    let file = std::fs::File::open(zip_path).map_err(|e| format!("open runtime zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("read runtime zip: {e}"))?;
    let total = archive.len();
    // First-launch prep is pure I/O on tens of thousands of small files
    // (minutes under AV scanning): report progress so it doesn't read as a
    // hang. Throttled; payload { done, total }.
    let mut last_emit = Instant::now();
    for i in 0..archive.len() {
        if last_emit.elapsed() >= Duration::from_millis(250) {
            last_emit = Instant::now();
            let _ = app.emit(
                "slacker:boot-progress",
                serde_json::json!({ "done": i, "total": total }),
            );
        }
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        // profiles/ holds the persistent dsh state; the rest (node dist +
        // dsh runtime) is disposable and gets wiped on upgrades.
        let (root, rel) = match rel.strip_prefix("profiles").ok() {
            Some(rest) => (profile_root.clone(), rest.to_path_buf()),
            None => (runtime_dir.clone(), rel),
        };
        let out = root.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("zip mkdir {}: {e}", rel.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("zip mkdir {}: {e}", rel.display()))?;
        }
        let mut out_file = std::fs::File::create(&out)
            .map_err(|e| format!("zip create {}: {e}", rel.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("zip write {}: {e}", rel.display()))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
    }
    let _ = app.emit(
        "slacker:boot-progress",
        serde_json::json!({ "done": total, "total": total }),
    );
    if !runtime_fresh {
        std::fs::write(&runtime_marker, fingerprint)
            .map_err(|e| format!("write runtime marker: {e}"))?;
    }
    if !profile_fresh {
        std::fs::create_dir_all(&profile_root).map_err(|e| format!("create profiles dir: {e}"))?;
        std::fs::write(&profile_marker, fingerprint)
            .map_err(|e| format!("write profile marker: {e}"))?;
    }
    Ok(())
}

/** Runtime from the installer bundle (pack-runtime.cjs zip under resources):
 * embedded node + dsh runtime + pre-installed profile — zero machine deps
 * (no system node/pnpm, no junctions, no network). None when the zip is
 * absent, i.e. `tauri dev`, which keeps using the repo checkout. */
fn packaged_runtime(app: &tauri::AppHandle) -> Option<Result<DshRuntime, String>> {
    let zip_path = app
        .path()
        .resource_dir()
        .ok()?
        // resources keep their src-tauri-relative layout in the bundle:
        // resources/runtime/dsh-runtime.zip -> $RESOURCE/resources/runtime/...
        .join("resources")
        .join("runtime")
        .join("dsh-runtime.zip");
    if !zip_path.exists() {
        return None;
    }
    Some((|| {
        let base = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("app local data dir: {e}"))?
            .join("dsh");
        let runtime_dir = base.join("runtime");
        // Fingerprint the bundled zip (size + entry count), not the app
        // version: re-issued installers within the same version (rebuilt
        // release tag, newer bundled node) must still wipe the stale runtime.
        let zip_len = std::fs::metadata(&zip_path)
            .map_err(|e| format!("stat runtime zip: {e}"))?
            .len();
        let entries = zip::ZipArchive::new(std::io::BufReader::new(
            std::fs::File::open(&zip_path).map_err(|e| format!("open runtime zip: {e}"))?,
        ))
        .map_err(|e| format!("read runtime zip: {e}"))?
        .len();
        let fingerprint = format!("{zip_len}:{entries}");
        extract_packaged_runtime(&zip_path, &base, &fingerprint, app)?;

        // DSH_HOME persists across upgrades. The extract already routed
        // profiles/ straight into home/profiles (single pass); runtime/ is
        // the disposable node + dsh layer wiped on upgrade.
        let home = base.join("home");

        // Bundled node: Windows always ships x64 (runs under ARM emulation,
        // dodging cross-arch npm optional deps); the mac zip carries both.
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let node_rel: String = match std::env::consts::OS {
            "windows" => "node/win32-x64/node.exe".into(),
            "macos" => format!("node/darwin-{arch}/bin/node"),
            _ => format!("node/linux-{arch}/bin/node"),
        };
        let node = runtime_dir.join(node_rel);
        if !node.exists() {
            return Err(format!("bundled node missing: {}", node.display()));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755));
        }
        let dsh_bin = runtime_dir
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if !dsh_bin.exists() {
            return Err(format!("bundled dsh runtime missing: {}", dsh_bin.display()));
        }
        Ok(DshRuntime {
            node,
            dsh_bin,
            dsh_cwd: runtime_dir.join("dsh"),
            home,
        })
    })())
}

/** Dev-checkout runtime: repo layout discovered from cwd (shell/src-tauri),
 * junction-mapped plugins and a pnpm-installed profile under .dsh-dev. */
fn dev_runtime() -> Result<DshRuntime, String> {
    // Dev shape: cwd is the src-tauri dir; resolve the repo root from there.
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let repo_root = cwd
        .ancestors()
        .nth(2)
        .ok_or("cannot resolve repo root")?
        .to_path_buf();

    let home = repo_root.join(".dsh-dev").join("shell-home");
    std::fs::create_dir_all(&home).map_err(|e| format!("create dsh home: {e}"))?;

    // The profile's file: dependencies (@slacker/novel, @slacker/ui-slacker)
    // are written relative to the template's depth (shell/dsh-profile/slacker,
    // 3 levels below the repo root), but the synced home profile sits one level
    // deeper, so pnpm resolves them to <home>/plugins/<name>. Map that path
    // onto the real plugins dir with a junction (needs no admin rights).
    let plugins_link = home.join("plugins");
    if !plugins_link.exists() {
        let plugins_target = repo_root.join("shell").join("plugins");
        #[cfg(target_os = "windows")]
        {
            let status = Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&plugins_link)
                .arg(&plugins_target)
                .status()
                .map_err(|e| format!("create plugins junction: {e}"))?;
            if !status.success() {
                return Err(format!(
                    "mklink /J failed: {} -> {}",
                    plugins_link.display(),
                    plugins_target.display()
                ));
            }
        }
        #[cfg(not(target_os = "windows"))]
        std::os::unix::fs::symlink(&plugins_target, &plugins_link)
            .map_err(|e| format!("create plugins symlink: {e}"))?;
    }

    // Sync the versioned profile template (shell/dsh-profile/slacker) into the
    // home so the slacker overlay row rides the profile layer, never a vendor
    // edit — vendor upgrades stay `git pull`-clean.
    let profile_src = repo_root.join("shell").join("dsh-profile").join("slacker");
    let profile_dst = home.join("profiles").join("slacker");
    std::fs::create_dir_all(&profile_dst).map_err(|e| format!("create profile dir: {e}"))?;
    for entry in std::fs::read_dir(&profile_src).map_err(|e| format!("read profile template: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let name = entry.file_name();
            std::fs::copy(entry.path(), profile_dst.join(&name))
                .map_err(|e| format!("sync profile file {}: {e}", name.to_string_lossy()))?;
        }
    }

    // The file sync above intentionally skips node_modules (too large to copy).
    // dsh resolves profile bundles from <DSH_HOME>/profiles/slacker/node_modules,
    // so on first boot (fresh clone / wiped home) install them from the synced
    // package.json. auto-install-peers must stay off: the @deepseek-ai/dsh-*
    // peers are provided by the dsh runtime, and the plugins' semver ranges
    // do not match the runtime's prerelease versions.
    if !profile_dst.join("node_modules").exists() {
        println!("[slacker] profile node_modules missing; running pnpm install...");
        // Windows: pnpm ships as pnpm.cmd/ps1 shims (e.g. under nvm4w), and
        // Command::new("pnpm") only resolves pnpm.exe — invoke the shim.
        #[cfg(target_os = "windows")]
        let mut install = Command::new("pnpm.cmd");
        #[cfg(not(target_os = "windows"))]
        let mut install = Command::new("pnpm");
        let status = install
            .args(["install", "--config.auto-install-peers=false"])
            .current_dir(&profile_dst)
            .status()
            .map_err(|e| format!("run pnpm install for dsh profile: {e} (is pnpm on PATH?)"))?;
        if !status.success() {
            return Err(
                "pnpm install failed for the dsh profile; run it manually in shell/dsh-profile/slacker"
                    .into(),
            );
        }
    }

    // The runtime's node_modules is gitignored; a fresh clone without the
    // one-time `npm install` in vendor/dsh-runtime would otherwise fail with
    // a cryptic MODULE_NOT_FOUND inside dsh's stderr log after a 60s timeout.
    let dsh_bin = repo_root.join(DSH_BIN);
    if !dsh_bin.exists() {
        return Err(
            "dsh runtime missing: run `npm install` in vendor/dsh-runtime (see vendor/dsh-runtime/package.json)"
                .into(),
        );
    }
    Ok(DshRuntime { node: "node".into(), dsh_bin, dsh_cwd: repo_root, home })
}

/**
 * Spawn the dsh web server and return its tokenized URL.
 * Runtime source: the installer-bundled zip (packaged) when present, else
 * the repo checkout (dev). The URL line ("dsh web: http://…?token=…") is
 * parsed from stdout; newer dsh may append " (LAN: http://…)" to the line,
 * so only the first token is taken as the URL.
 */
fn spawn_dsh_web(app: &tauri::AppHandle) -> Result<String, String> {
    let port = free_port();
    let rt = match packaged_runtime(app) {
        Some(rt) => rt?,
        None => dev_runtime()?,
    };

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(&rt.node);
    cmd.arg(&rt.dsh_bin)
        .arg("--profile")
        .arg("slacker")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-open")
        .current_dir(&rt.dsh_cwd)
        .env("DSH_HOME", &rt.home)
        .stdout(Stdio::piped());
    // Bundled node: prepend its dir to the child PATH so anything the dsh
    // runtime shells out to (`node`, file-archivers, …) resolves the pinned
    // binary rather than whatever happens to be installed on the machine.
    if rt.node.is_absolute() {
        if let Some(node_dir) = rt.node.parent() {
            let path_env = std::env::var_os("PATH").unwrap_or_default();
            let prepended = std::env::join_paths(
                std::iter::once(node_dir.to_path_buf()).chain(std::env::split_paths(&path_env)),
            );
            if let Ok(pre) = prepended {
                cmd.env("PATH", pre);
            }
        }
    }
    // Keep stderr on disk: when dsh fails to boot (e.g. bundle resolution),
    // the port wait times out with no clue — this log holds the real error.
    let stderr_log = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(rt.home.join("dsh-web-stderr.log"))
        .map_err(|e| format!("open dsh stderr log: {e}"))?;
    cmd.stderr(Stdio::from(stderr_log));
    // No stray console window for the node child (release, GUI subsystem).
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("spawn dsh node: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let url_arc = std::sync::Arc::new(Mutex::new(None::<String>));
    {
        let url_arc = url_arc.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("dsh web: ") {
                    // First whitespace token only: the line may end with a
                    // " (LAN: http://…)" suffix in newer dsh releases.
                    if let Some(url) = rest.split_whitespace().next() {
                        if url.starts_with("http") {
                            *url_arc.lock().unwrap() = Some(url.to_string());
                            // Keep reading so the pipe does not fill; dsh stays chatty.
                        }
                    }
                }
            }
        });
    }

    if !wait_port("127.0.0.1", port, Duration::from_secs(60)) {
        let _ = child.kill();
        return Err(format!(
            "dsh web did not listen on port {port} within 60s; real error: {}",
            rt.home.join("dsh-web-stderr.log").display()
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(u) = url_arc.lock().unwrap().clone() {
            *app.state::<ShellState>().url.lock().unwrap() = u.clone();
            *app.state::<ShellState>().child.lock().unwrap() = Some(child);
            println!("[slacker] boot url stored (len={})", u.len());
            selftest_browser_auth(&u, &rt.home);
            return Ok(u);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("dsh web listened but printed no URL within 10s".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/** One raw HTTP/1.1 exchange over a fresh TcpStream (Connection: close);
 * returns the full response text, capped at 1 MiB. */
fn http_exchange(host: &str, port: u16, request: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut stream = TcpStream::connect((host, port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    stream.write_all(request.as_bytes()).ok()?;
    let mut buf = Vec::new();
    stream.take(1 << 20).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/** First response line + any set-cookie header, for the self-test log. */
fn summarize_response(resp: &str) -> String {
    let status = resp.lines().next().unwrap_or("(empty response)").to_string();
    let cookie = resp
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "(no set-cookie)".into());
    let body: String = resp
        .split("\r\n\r\n")
        .nth(1)
        .map(|b| b.chars().take(160).collect())
        .unwrap_or_default();
    format!("{status}\n  {cookie}\n  body: {body:?}")
}

/**
 * After boot, replay the browser auth handshake over raw HTTP and log the
 * exchange to <home>/dsh-web-selftest.log. GET /?token=… must answer 303
 * with a set-cookie, and that cookie must then authenticate GET / — this
 * splits reported "dsh web authentication required" 401s into server-side
 * failures (this log shows 401s too) versus WebView-side cookie/navigation
 * failures (this log shows 303/200 while the window still shows the 401).
 */
fn selftest_browser_auth(url: &str, home: &std::path::Path) {
    let rest = match url.strip_prefix("http://") {
        Some(rest) => rest,
        None => {
            let _ = std::fs::write(
                home.join("dsh-web-selftest.log"),
                format!("selftest: unexpected url scheme: {url}\n"),
            );
            return;
        }
    };
    let (authority, path_query) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    let request = |extra: &str| {
        format!(
            "GET {path_query} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n{extra}\r\n"
        )
    };
    let mut log = format!("selftest @ {url}\n");

    let first = authority
        .split_once(':')
        .map(|(h, p)| (h.to_string(), p.parse::<u16>().unwrap_or(80)))
        .unwrap_or((authority.to_string(), 80));
    match http_exchange(&first.0, first.1, &request("")) {
        Some(resp) => {
            log.push_str("step1 token URL:\n  ");
            log.push_str(&summarize_response(&resp).replace('\n', "\n  "));
            log.push('\n');
            // Relay the minted cookie into step 2 exactly as a browser would.
            let cookie = resp
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
                .and_then(|l| l.split(':').nth(1))
                .map(|pair| pair.trim().split(';').next().unwrap_or("").trim().to_string());
            match cookie {
                Some(cookie) if !cookie.is_empty() => {
                    let second = http_exchange(&first.0, first.1, &request(&format!("Cookie: {cookie}\r\n")));
                    match second {
                        Some(resp) => {
                            log.push_str("step2 cookie GET /:\n  ");
                            log.push_str(&summarize_response(&resp).replace('\n', "\n  "));
                            log.push('\n');
                        }
                        None => log.push_str("step2 cookie GET /: connection failed\n"),
                    }
                }
                _ => log.push_str("step2 skipped: step1 minted no cookie\n"),
            }
        }
        None => log.push_str("step1 token URL: connection failed\n"),
    }
    let _ = std::fs::write(home.join("dsh-web-selftest.log"), log);
}

/**
 * Boot (or reboot) the dsh runtime and return its URL.
 * @returns the tokenized web URL and whether an existing child was replaced.
 */
#[tauri::command]
async fn shell_boot(app: tauri::AppHandle) -> Result<BootInfo, String> {
    // NOTE(Windows): sync commands run on the main thread — spawn_dsh_web
    // parks up to 60s waiting for the dsh port, which froze the whole window
    // ("not responding"). Run the blocking boot on the async runtime's
    // blocking pool; the command resolves without touching the main thread.
    tauri::async_runtime::spawn_blocking(move || shell_boot_blocking(&app))
        .await
        .map_err(|e| format!("boot task failed: {e}"))?
}

fn shell_boot_blocking(app: &tauri::AppHandle) -> Result<BootInfo, String> {
    let state = app.state::<ShellState>();
    let restarted = state.child.lock().unwrap().is_some();
    if restarted {
        if let Some(mut c) = state.child.lock().unwrap().take() {
            let _ = c.kill();
        }
        // The tea / novel-reader windows still point at the dead origin (old
        // port+token); close them so the next open re-targets the fresh URL.
        for label in ["tea", "novel-reader"] {
            if let Some(win) = app.get_webview_window(label) {
                let _ = win.close();
            }
        }
    }
    let url = spawn_dsh_web(app)?;
    // Navigate from the Rust side. wry's navigate() maps to WebView2's
    // Navigate() — a browser-initiated navigation, like typing in the address
    // bar. The splash page used to call window.location.replace(info.url),
    // which makes tauri.localhost the cross-site initiator of the navigation
    // chain; with dsh's SameSite=Strict auth cookie, the 303 redirect-follow
    // request then drops the cookie and dsh answers 401. Confirmed with a
    // Chrome lab: JS-initiated cross-site navigation -> GET / after the 303
    // arrives cookie-less, browser-initiated navigation -> cookie present.
    if let Ok(parsed) = tauri::Url::parse(&url) {
        if let Some(win) = app.get_webview_window("main") {
            win.navigate(parsed)
                .map_err(|e| format!("navigate to {url} failed: {e}"))?;
        }
    }
    Ok(BootInfo { url, restarted })
}

/** Current dsh URL, if booted. */
#[tauri::command]
fn shell_url(state: State<ShellState>) -> String {
    state.url.lock().unwrap().clone()
}

/**
 * Remote-IPC proof for the slacker overlay: read a UTF-8 text file.
 * Real slacker views (novels, shelves) will build on this seam.
 * @param path - absolute or repo-relative file path.
 */
#[tauri::command]
fn shell_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/* ── slacker kv: the zone's persistence seam ─────────────────────
 * The dsh webview origin changes on every boot (fresh port + token),
 * so localStorage is dead there; all slacker state lands on disk via
 * these commands. Storage: <app_local_data_dir>/slacker/kv.json, a flat
 * string→string JSON map — small, diffable, human-inspectable. */

/** Resolve (and create) the slacker data dir under the app data dir. */
fn slacker_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // app_local_data_dir（Windows: %LOCALAPPDATA%\<id>）——与 WebView2 数据同根，
    // 避免与 app_data_dir(Roaming) 分裂两处状态。
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app local data dir: {e}"))?
        .join("slacker");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create slacker dir: {e}"))?;
    Ok(dir)
}

/** Load the kv map; missing or malformed file reads as empty. */
fn kv_load(app: &tauri::AppHandle) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = slacker_data_dir(app)?.join("kv.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text)
            .map_err(|e| format!("parse kv.json: {e}")),
        Err(_) => Ok(serde_json::Map::new()),
    }
}

/** Read one slacker kv value (null when absent). */
#[tauri::command]
fn slacker_kv_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    Ok(kv_load(&app)?
        .get(&key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string))
}

/** Write one slacker kv value (whole map rewritten; file stays tiny).
 * 落盘成功后广播 `slacker:kv-changed`，让书架等跨窗口部件实时刷新。 */
#[tauri::command]
fn slacker_kv_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let mut map = kv_load(&app)?;
    map.insert(key.clone(), serde_json::Value::String(value));
    let json = serde_json::to_string_pretty(&map).map_err(|e| format!("serialize kv: {e}"))?;
    let path = slacker_data_dir(&app)?.join("kv.json");
    std::fs::write(&path, json).map_err(|e| format!("write kv.json: {e}"))?;
    app.emit("slacker:kv-changed", &key).ok();
    Ok(())
}

/* ── slacker novels: shelf storage under <app_data_dir>/slacker/novels ──
 * Plain .txt, one file per book; the reader pages by character offset. */

/** Built-in demo book, seeded once when the shelf is created empty. */
const DEMO_NOVEL_NAME: &str = "示例·茶水间观察笔记";
const DEMO_NOVEL_TEXT: &str = "\u{300a}茶水间观察笔记\u{300b}

一
工位与工位之间，隔着一层薄薄的挡板；而敬业与偷闲之间，隔着的往往只是一杯没喝完的咖啡。咖啡凉了，理由就熟了。

二
老陈是茶水间的常客。他泡茶讲究，第一遍水倒掉，第二遍才喝。有人问他为什么，他说：等水凉的这个过程，叫思考。

三
下午三点是一天中最微妙的时刻。会议室里坐着的人在看表，会议室外走着的人在看他。大家都很忙，只是忙的东西不太一样。

四
键盘声是最诚实的背景音。噼里啪啦的未必在写代码，也可能在写周报；安安静静的未必在发呆，也可能在改一个谁都不想碰的老 bug。

五
茶水间的冰箱门上贴着一张便利贴：牛奶是大家的，快乐也是。没人知道是谁写的，但每个人打开冰箱的时候，都会顺手看它一眼。

六
下班的电梯里，人群安静得像散场。有人盯着楼层数字，有人对着手机微笑。一天就这么过去了，明天，茶水间的水壶还会准时响起来。

（完）
";

/** 默认小说目录：优先「启动 exe 同目录 /novels」（探针可写），
 * 否则回退 <app_local_data>/slacker/novels。 */
fn default_novels_dir() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let dir = exe_dir.join("novels");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    // 探针：exe 旁可能是只读目录（如 Program Files 或安装映像）。
    let probe = dir.join(".slacker_write_probe");
    if std::fs::write(&probe, b"").is_ok() {
        let _ = std::fs::remove_file(probe);
        Some(dir)
    } else {
        None
    }
}

/** Resolve (and create) the novels dir: kv `novel.downloadDir` 优先，
 * 未设置用 default_novels_dir，再回退 slacker_data_dir。 */
fn novels_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(custom) = kv_load(app)?
        .get("novel.downloadDir")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
    {
        let dir = std::path::PathBuf::from(custom);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create custom novels dir: {e}"))?;
        return Ok(dir);
    }
    if let Some(dir) = default_novels_dir() {
        return Ok(dir);
    }
    let dir = slacker_data_dir(app)?.join("novels");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create novels dir: {e}"))?;
    Ok(dir)
}

/** 当前生效的小说目录（暴露给前端设置面板展示）。 */
#[tauri::command]
fn slacker_novel_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = novels_dir(&app)?;
    Ok(dir.to_string_lossy().into_owned())
}

/** 校验并设置小说下载目录；空字符串恢复默认（exe 同目录）。
 * 非空时验证：路径解析可用 + 存在即可创建 + 目录可写（探针），任一失败返回错误文案。 */
#[tauri::command]
fn slacker_novel_set_dir(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let trimmed = dir.trim();
    if !trimmed.is_empty() {
        let path = std::path::PathBuf::from(trimmed);
        std::fs::create_dir_all(&path).map_err(|e| format!("无法创建目录 {trimmed}: {e}"))?;
        let probe = path.join(".slacker_write_probe");
        std::fs::write(&probe, b"").map_err(|e| format!("目录不可写 {trimmed}: {e}"))?;
        let _ = std::fs::remove_file(probe);
    }
    slacker_kv_set(app, "novel.downloadDir".to_string(), trimmed.to_string())
}

/** 原生「选择文件夹」对话框；用户取消返回 null。
 * 默认定位到当前生效的小说下载目录（novels_dir），若无法解析则留给系统默认位置。 */
#[tauri::command]
fn slacker_novel_pick_dir(app: tauri::AppHandle) -> Option<String> {
    let mut dlg = rfd::FileDialog::new().set_title("选择小说下载目录");
    if let Ok(dir) = novels_dir(&app) {
        dlg = dlg.set_directory(dir);
    }
    dlg.pick_folder().map(|p| p.to_string_lossy().into_owned())
}

/** Sanitize a shelf name into a safe file stem (no separators/reserved). */
fn novel_path(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if name.trim().is_empty()
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err(format!("invalid novel name: {name:?}"));
    }
    Ok(novels_dir(app)?.join(format!("{name}.txt")))
}

/* ── slacker novels: shelf storage under <app_data_dir>/slacker/novels ──
 * Plain .txt, one file per book; chapter splitting happens client-side
 * (same regex set as the original app's local reader). */

/** Save (or overwrite) a novel by name. */
#[tauri::command]
fn slacker_novel_save(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    name: String,
    content: String,
) -> Result<(), String> {
    std::fs::write(novel_path(&app, &name)?, content)
        .map_err(|e| format!("save novel {name}: {e}"))?;
    // 覆盖会改变切章结果：旧目录缓存作废。
    state.novel_toc_cache.lock().unwrap().remove(&name);
    Ok(())
}

/** Delete a novel by name. */
#[tauri::command]
fn slacker_novel_delete(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    name: String,
) -> Result<(), String> {
    std::fs::remove_file(novel_path(&app, &name)?)
        .map_err(|e| format!("delete novel {name}: {e}"))?;
    state.novel_toc_cache.lock().unwrap().remove(&name);
    Ok(())
}

/** List shelf names (sorted); seeds the demo book on a fresh empty shelf. */
#[tauri::command]
fn slacker_novel_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = novels_dir(&app)?;
    // Seed once: only when the shelf exists but holds nothing.
    let is_empty = std::fs::read_dir(&dir)
        .map(|mut d| d.next().is_none())
        .unwrap_or(false);
    if is_empty {
        let _ = std::fs::write(dir.join(format!("{DEMO_NOVEL_NAME}.txt")), DEMO_NOVEL_TEXT);
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read novels dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| {
            let raw = e.file_name();
            let name = raw.to_string_lossy();
            name.strip_suffix(".txt").map(str::to_string)
        })
        .collect();
    names.sort_by(|a, b| a.cmp(b));
    Ok(names)
}

/** Load a novel's full text (chapter splitting happens client-side,
 * mirroring the original app's local reader). */
#[tauri::command]
fn slacker_novel_load(app: tauri::AppHandle, name: String) -> Result<String, String> {
    std::fs::read_to_string(novel_path(&app, &name)?)
        .map_err(|e| format!("load novel {name}: {e}"))
}

/* ── 大文件：切章在 Rust 侧，前端只按章索取 ───────────────────────────
 * 原实现把整本 txt `read_to_string` → IPC → 前端 splitChapters → fullText 常驻，
 * 超大文件（数十~数百 MB）载入阻塞、内存成倍放大。现在：
 *  - 目录：Rust 内同款正则切章（字节偏移，一次整本读 + 缓存区间表）；
 *  - 正文：按（titleStart 派生出的字节区间）seek + 定点读取，只传当前章。
 * 偏移全部在 Rust 内部字节空间自洽，前端拿不到全文，也不需要全文偏移。 */

/** 一章的字节区间（内部结构，缓存在 ShellState）。 */
#[derive(Clone)]
struct NovelChapterBound {
    name: String,
    is_volume: bool,
    start: usize,
    end: usize,
}

/** 回给前端的目录条目：前端只做展示/计数/索引跳转，不拿任何偏移。 */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NovelTocEntry {
    name: String,
    is_volume: bool,
}

/** 卷标题正则（同客户端 local-toc.ts VOLUME_PATTERNS，逐条内联 (?m)/(?mi)）。 */
fn novel_volume_res() -> &'static [regex::Regex] {
    static RES: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        const PATS: [&str; 5] = [
            r"(?m)^[\t ]*第[零一二三四五六七八九十百千万0-9]+[卷篇部](?:[·：:  　].*)?[\t ]*$",
            r"(?m)^[\t ]*[卷篇部][零一二三四五六七八九十百千万0-9]+(?:[·：:  　].*)?[\t ]*$",
            r"(?m)^[\t ]*(?:上|中|下)[部卷](?:[·：:  　].*)?[\t ]*$",
            r"(?mi)^[\t ]*Volume\s+[0-9IVXLCDM]+(?:[.\s].*)?[\t ]*$",
            r"(?m)^[\t ]*卷[零一二三四五六七八九十百千万0-9]+(?:[·：:  　].*)?[\t ]*$",
        ];
        PATS.iter().map(|p| regex::Regex::new(p).expect("novel volume pattern")).collect()
    })
}

/** 章节标题正则（同客户端 CHAPTER_PATTERNS）。 */
fn novel_chapter_res() -> &'static [regex::Regex] {
    static RES: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        const PATS: [&str; 6] = [
            r"(?m)^[\t ]*第[零一二三四五六七八九十百千万0-9]+[章节回](?:[·：:  　].*)?[\t ]*$",
            r"(?mi)^[\t ]*Chapter\s+[0-9IVXLCDM]+(?:[.\s].*)?[\t ]*$",
            r"(?m)^[\t ]*[0-9]{1,4}[、.][\t ]*\S+[\t ]*$",
            r"(?m)^[\t ]*(?:序章|楔子|引子|前言|序言|后记|尾声|番外(?:篇)?)(?:[·：:  　].*)?[\t ]*$",
            r"(?m)^[\t ]*第[0-9]+[节话](?:[·：:  　].*)?[\t ]*$",
            r"(?m)^[\t ]*正文\s+第[零一二三四五六七八九十百千万0-9]+[章节回][\t ]*$",
        ];
        PATS.iter().map(|p| regex::Regex::new(p).expect("novel chapter pattern")).collect()
    })
}

/** 流式扫描整本切出章节字节区间（语义同客户端 splitChapters）。
 * 逐行读、只记标题行的字节偏移，大文件也只占常量内存；调用方放
 * spawn_blocking 跑，不再像旧版那样整本 read_to_string + 全文正则
 * （那会先把全应用冻住几秒）。 */
fn scan_novel_toc(path: &std::path::Path, name: &str) -> Result<Vec<NovelChapterBound>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("load novel {name}: {e}"))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    // (标题行首偏移, 正文起点, 标题, 是否卷)；行序天然有序，无需再排序去重。
    let mut marks: Vec<(usize, usize, String, bool)> = Vec::new();
    let mut offset = 0usize;
    let mut line = String::new();
    let mut guard = 0usize;
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| format!("load novel {name}: {e}"))?;
        if n == 0 {
            break;
        }
        // trim_end 吃掉行尾 \r\n 与空白：整行匹配标题正则，顺带修正旧版
        // CRLF 文件因行尾 \r 不在 [\t ]* 里而匹配不上的缺陷。
        let trimmed = line.trim_end();
        if !trimmed.is_empty() && guard < 100_000 {
            let whole = |m: regex::Match<'_>| m.start() == 0 && m.end() == trimmed.len();
            // 卷先判：同一行若同时命中卷/章模式，按旧语义保留为卷。
            let is_volume = novel_volume_res().iter().any(|re| re.find(trimmed).map(whole).unwrap_or(false));
            let is_chapter = !is_volume
                && novel_chapter_res().iter().any(|re| re.find(trimmed).map(whole).unwrap_or(false));
            if is_volume || is_chapter {
                guard += 1;
                marks.push((offset, offset + trimmed.len(), trimmed.to_string(), is_volume));
            }
        }
        offset += n;
    }
    if marks.is_empty() {
        // 空文件回空目录；有内容但无标题则整本当一章（同旧行为）。
        return Ok(if offset == 0 {
            Vec::new()
        } else {
            vec![NovelChapterBound { name: "全文".into(), is_volume: false, start: 0, end: offset }]
        });
    }
    let total = offset;
    let n = marks.len();
    Ok((0..n)
        .map(|i| {
            // 正文起点 = 标题行尾（换行前），终点 = 下一标题行首；末章到文件尾。
            let (_, start, title, is_volume) = &marks[i];
            NovelChapterBound {
                name: title.clone(),
                is_volume: *is_volume,
                start: *start,
                end: if i + 1 < n { marks[i + 1].0 } else { total },
            }
        })
        .collect())
}

/** 懒取（缓存）章节目录；扫描放阻塞线程池，避免大文件冻住主线程。 */
async fn novel_toc_cached(
    app: &tauri::AppHandle,
    state: &State<'_, ShellState>,
    name: &str,
) -> Result<Vec<NovelChapterBound>, String> {
    if let Some(hit) = state.novel_toc_cache.lock().unwrap().get(name) {
        return Ok(hit.clone());
    }
    let path = novel_path(app, name)?;
    let name_owned = name.to_string();
    let chapters = tauri::async_runtime::spawn_blocking(move || scan_novel_toc(&path, &name_owned))
        .await
        .map_err(|e| format!("scan novel {name}: {e}"))??;
    state.novel_toc_cache.lock().unwrap().insert(name.to_string(), chapters.clone());
    Ok(chapters)
}

/** 章节目录（只回展示所需字段）。 */
#[tauri::command]
async fn slacker_novel_toc(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    name: String,
) -> Result<Vec<NovelTocEntry>, String> {
    let chapters = novel_toc_cached(&app, &state, &name).await?;
    Ok(chapters
        .iter()
        .map(|c| NovelTocEntry { name: c.name.clone(), is_volume: c.is_volume })
        .collect())
}

/** 读取某一章正文：按缓存字节区间 seek 定点读取，不整本读入内存。
 * 返回该章原文（未 trim），与客户端 splitChapters/getChapterText 语义一致。 */
#[tauri::command]
async fn slacker_novel_chapter(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    name: String,
    index: usize,
) -> Result<String, String> {
    let chapters = novel_toc_cached(&app, &state, &name).await?;
    let ch = chapters
        .get(index)
        .ok_or_else(|| format!("novel {name}: chapter index {index} out of range"))?;
    let start = ch.start.min(ch.end);
    let len = ch.end - start;
    if len == 0 {
        return Ok(String::new());
    }
    let path = novel_path(&app, &name)?;
    let mut file = std::fs::File::open(&path).map_err(|e| format!("open novel {name}: {e}"))?;
    file.seek(SeekFrom::Start(start as u64)).map_err(|e| format!("seek novel {name}: {e}"))?;
    let mut buf = Vec::with_capacity(len);
    file.take(len as u64).read_to_end(&mut buf).map_err(|e| format!("read novel {name}: {e}"))?;
    // start/end 都是正则匹配边界（字符边界），整文件合法 UTF-8 时此处必然成功。
    String::from_utf8(buf)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("novel {name} is not valid UTF-8: {e}"))
}

/* ── slacker stocks: A-share quotes via eastmoney's open ulist endpoint ──
 * Plain http + UTF-8 JSON; no key, no CORS (fetched Rust-side). */

/** One watchlist row. */
#[derive(Serialize)]
struct StockQuote {
    code: String,
    name: String,
    price: f64,
    change: f64,
    change_pct: f64,
}

/** Map a 6-digit A-share code to an eastmoney secid (1.=SH, 0.=SZ). */
fn secid(code: &str) -> Option<String> {
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let market = match code.as_bytes()[0] {
        b'6' | b'5' | b'9' => '1',
        b'0' | b'3' => '0',
        _ => return None,
    };
    Some(format!("{market}.{code}"))
}

/** Fetch live quotes for a batch of codes.
 * Primary: eastmoney ulist. Fallback: Tencent qt.gtimg.cn — the eastmoney
 * quote domain runs dynamic rate-limit bans (TLS handshake OK, connection
 * killed ~0.1s after the request → IncompleteMessage) lasting minutes to
 * tens of minutes; without a fallback every card degrades to "—". */
#[tauri::command]
async fn slacker_stock_quotes(codes: Vec<String>) -> Result<Vec<StockQuote>, String> {
    let secids: Vec<String> = codes.iter().filter_map(|c| secid(c)).collect();
    if secids.is_empty() {
        return Ok(Vec::new());
    }
    match fetch_em_quotes(&secids).await {
        Ok(rows) if !rows.is_empty() => Ok(rows),
        em => fetch_qq_quotes(&codes).await.map_err(|qq| match em {
            Ok(_) => qq,
            Err(e) => format!("{e}; {qq}"),
        }),
    }
}

async fn fetch_em_quotes(secids: &[String]) -> Result<Vec<StockQuote>, String> {
    let url = format!(
        "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14&secids={}",
        secids.join(",")
    );
    let body = em_client().get(&url).send().await
        // Debug 格式带完整原因链（hyper/io/DNS/TLS），顶层 Display 只有 "error sending request"。
        .map_err(|e| format!("quote http: {e:?}"))?
        .bytes()
        .await
        .map_err(|e| format!("quote body: {e}"))?;
    let body = decode_em_bytes(&body);
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("quote json: {e}"))?;
    let rows = v["data"]["diff"].as_array().cloned().unwrap_or_default();
    Ok(rows
        .iter()
        .map(|q| StockQuote {
            code: q["f12"].as_str().unwrap_or("").to_string(),
            name: q["f14"].as_str().unwrap_or("").to_string(),
            price: q["f2"].as_f64().unwrap_or(0.0),
            change: q["f4"].as_f64().unwrap_or(0.0),
            change_pct: q["f3"].as_f64().unwrap_or(0.0),
        })
        .collect())
}

/** Backup quotes from Tencent qt.gtimg.cn: GBK text, one `v_XXX="a~b~…"` line
 * per symbol. Fields: [1]=name [2]=code [3]=last [31]=change [32]=change%. */
async fn fetch_qq_quotes(codes: &[String]) -> Result<Vec<StockQuote>, String> {
    let syms: Vec<String> = codes.iter().filter_map(|c| {
        secid(c).map(|s| if s.starts_with('1') { format!("sh{c}") } else { format!("sz{c}") })
    }).collect();
    if syms.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("https://qt.gtimg.cn/q={}", syms.join(","));
    let body = http_client().get(&url).send().await
        .map_err(|e| format!("quote qq http: {e:?}"))?
        .bytes()
        .await
        .map_err(|e| format!("quote qq body: {e}"))?;
    let text = decode_em_bytes(&body);
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((_, rest)) = line.split_once('=') else { continue };
        let p: Vec<&str> = rest.trim().trim_end_matches(';').trim_matches('"').split('~').collect();
        if p.len() < 33 {
            continue;
        }
        out.push(StockQuote {
            code: p[2].to_string(),
            name: p[1].to_string(),
            price: p[3].parse().unwrap_or(0.0),
            change: p[31].parse().unwrap_or(0.0),
            change_pct: p[32].parse().unwrap_or(0.0),
        });
    }
    Ok(out)
}

/** One watchlist row's intraday trend line. */
#[derive(Serialize)]
struct StockTrend {
    code: String,
    points: Vec<f64>,
}

/** Fetch today's intraday minute closes (eastmoney trends2) per code.
 * One http round-trip per code, sequential — watchlists are small. */
#[tauri::command]
async fn slacker_stock_trends(codes: Vec<String>) -> Result<Vec<StockTrend>, String> {
    let secids: Vec<String> = codes.iter().filter_map(|c| secid(c)).collect();
    if secids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(secids.len());
    for sec in secids {
        let url = format!(
            "https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid={sec}&fields1=f1,f2,f3&fields2=f51,f53&ndays=1&iscr=1"
        );
        let body = match em_client().get(&url).send().await {
            Ok(r) => r.text().await.unwrap_or_default(),
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let rows = v["data"]["trends"].as_array().cloned().unwrap_or_default();
        let points: Vec<f64> = rows
            .iter()
            .filter_map(|r| r.as_str())
            .filter_map(|r| r.split(',').nth(1)?.parse::<f64>().ok())
            .collect();
        if points.is_empty() {
            continue;
        }
        let code = sec.split('.').nth(1).unwrap_or(&sec).to_string();
        out.push(StockTrend { code, points });
    }
    Ok(out)
}

/** One stock search hit. */
#[derive(Serialize)]
struct StockSearchItem {
    code: String,
    name: String,
    market: String,
}

/** Simple percent-encode for the search query (http::Uri rejects non-ASCII). */
fn q_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/** Decode a stock HTTP response: try UTF-8 first, fall back to GB18030.
 *  eastmoney quote/search/kline claim application/json but return GBK bytes;
 *  Tencent qt.gtimg.cn quotes are GBK text too. */
fn decode_em_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            cow.into_owned()
        }
    }
}

/** Fetch stock-name search hits (eastmoney suggest adapter). */
#[tauri::command]
async fn slacker_stock_search(query: String) -> Result<Vec<StockSearchItem>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
let url = format!(
            "https://searchadapter.eastmoney.com/api/suggest/get?input={}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=15&markettype=&mktnum=&jys=&classify=&securitytype=&status=&ut=D43BF722C8E33BDC906FB84D85E326E8",
            q_encode(query.trim())
        );
        let body = em_client().get(&url).send().await
            .map_err(|e| format!("search http: {e:?}"))?
            .bytes()
            .await
            .map_err(|e| format!("search body: {e}"))?;
    let body = decode_em_bytes(&body);
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("search json: {e}"))?;
    let rows = v["QuotationCodeTable"]["Data"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for item in rows {
        let code = item["Code"].as_str().unwrap_or("").to_string();
        let name = item["Name"].as_str().unwrap_or("").to_string();
        let market = match item["MktNum"].as_str().unwrap_or("") {
            "1" => "sh",
            "0" => "sz",
            "100" => "bj",
            _ => continue, // 过滤基金、美股、港股等非 A 股标的
        };
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) || name.is_empty() {
            continue;
        }
        out.push(StockSearchItem { code, name, market: market.into() });
    }
    Ok(out)
}

/** One kline bar. */
#[derive(Serialize)]
struct StockKlineItem {
    time: String,
    open: f64,
    close: f64,
    high: f64,
    low: f64,
    volume: f64,
}

#[tauri::command]
async fn slacker_stock_kline(
    code: String,
    period: String,
    adjust: String,
    count: Option<usize>,
) -> Result<Vec<StockKlineItem>, String> {
    let Some(secid) = secid(&code) else { return Ok(Vec::new()) };
    let fqt = match adjust.as_str() {
        "qfq" => 1,
        "hfq" => 2,
        _ => 0,
    };
    let lmt = count.unwrap_or(120);
    // https via rustls-tls; eastmoney rejects plain-http quote/kline pulls.
    let url = format!(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}&klt={period}&fqt={fqt}&lmt={lmt}&beg=19900101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&ut=D43BF722C8E33BDC906FB84D85E326E8"
    );
    let body = em_client().get(&url).send().await
        .map_err(|e| format!("kline http: {e:?}"))?
        .bytes()
        .await
        .map_err(|e| format!("kline body: {e}"))?;
    let body = decode_em_bytes(&body);
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("kline json: {e}"))?;
    let rows = v["data"]["klines"].as_array().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let s = row.as_str().unwrap_or("");
        let p: Vec<&str> = s.split(',').collect();
        if p.len() < 6 {
            continue;
        }
        out.push(StockKlineItem {
            time: p[0].to_string(),
            open: p[1].parse().unwrap_or(0.0),
            close: p[2].parse().unwrap_or(0.0),
            high: p[3].parse().unwrap_or(0.0),
            low: p[4].parse().unwrap_or(0.0),
            volume: p[5].parse().unwrap_or(0.0),
        });
    }
    Ok(out)
}

/* ── slacker http: generic fetch for the book-source engine ────────
 * The dsh webview cannot reach cross-origin sites (CORS), so the engine
 * rides this shell command: redirects ≤5 and gzip handled Rust-side;
 * the body crosses IPC as base64 and charset decoding (UTF-8→GBK
 * fallback) stays in the webview where TextDecoder lives. */

use base64::Engine as _;

/** One fetch reply. */
#[derive(Serialize)]
struct HttpReply {
    status: u16,
    final_url: String,
    body_b64: String,
}

/** Shared client: bounded redirects, sane timeout, gzip on. */
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("build slacker http client")
    })
}

/** Shared client with eastmoney-friendly headers (UA + Referer). */
fn em_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36")
            // push2/push2his 行情域有动态风控：被临时封禁时 TCP/TLS 握手正常、
            // 请求发出 ~0.1s 内被掐断（reqwest 报 IncompleteMessage），IPv4/
            // IPv6、任意 UA/Referer 均一样，通常几分钟~几十分钟自动解封。绑
            // IPv4 出口规避本机移动宽带 IPv6 链路的不确定性；quotes 挂时另有
            // 腾讯 qt.gtimg.cn 兜底（fetch_qq_quotes）。
            .local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert("Referer", reqwest::header::HeaderValue::from_static("https://www.eastmoney.com/"));
                h
            })
            .build()
            .expect("build eastmoney client")
    })
}

/** Fetch one URL for the book-source engine.
 * @param url - absolute http(s) URL.
 * @param method - "GET" or "POST".
 * @param headers - request headers (UA etc.) as key/value pairs.
 * @param body - POST body, if any.
 */
#[tauri::command]
async fn slacker_http_fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<HttpReply, String> {
    let client = http_client();
    let req = match method.to_ascii_uppercase().as_str() {
        "POST" => client.post(&url),
        _ => client.get(&url),
    };
    let mut req = req;
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let (Some(b), "POST") = (&body, method.to_ascii_uppercase().as_str()) {
        req = req.body(b.clone());
    }
    let resp = req.send().await.map_err(|e| format!("http {url}: {e}"))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("http body {url}: {e}"))?;
    // Cap the payload so a broken rule cannot blow up the IPC channel.
    let bytes = &bytes[..bytes.len().min(8 * 1024 * 1024)];
    Ok(HttpReply {
        status,
        final_url,
        body_b64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/* ── slacker zhihu: thin proxy for the Zhihu recommendation feed ──
 * We only attach the user's cookie + browser-ish headers and forward;
 * all feed logic (paging via paging.next, four-layer dedup, HTML
 * cleanup, 400-char chunking) lives in the tea-room frontend. */

/** Zhihu-friendliness: Chrome UA + Referer/Origin/Accept/fetch marker.
 * Requests are additionally signed per-call via x-zse-93/96 (zhihu_sign). */
fn zhihu_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36")
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert("Referer", reqwest::header::HeaderValue::from_static("https://www.zhihu.com/"));
                h.insert("Origin", reqwest::header::HeaderValue::from_static("https://www.zhihu.com"));
                h.insert("Accept", reqwest::header::HeaderValue::from_static("application/json, text/plain, */*"));
                h.insert("x-requested-with", reqwest::header::HeaderValue::from_static("fetch"));
                h
            })
            .build()
            .expect("build zhihu client")
    })
}

/* ── zse96 v2 request signature ────────────────────────────────────────────
 * Zhihu risk control 403s unsigned /api/v3|v4 calls even with a valid
 * cookie, so every API request carries x-zse-96 = "2.0_" +
 * encrypt(md5(zse93 + path?query + d_c0 [+ body])). Block cipher + custom
 * base64 faithfully ported from the reference JS implementation used by
 * zhihu-mcp-server (itself a port of the zhihu-plus-plus reverse
 * engineering, both AGPL-3.0). Round-trip verified against that JS via
 * the unit tests at the bottom of this file. */

const ZHIHU_ZSE93: &str = "101_3_3.0";

/** Round-key table of the SM4-flavoured block cipher. */
const ZK: [u32; 32] = [
    1170614578, 1024848638, 1413669199, 3951632832, 3528873006, 2921909214, 4151847688, 3997739139,
    1933479194, 3323781115, 3888513386, 460404854, 3747539722, 2403641034, 2615871395, 2119585428,
    2265697227, 2035090028, 2773447226, 4289380121, 4217216195, 2200601443, 3051914490, 1579901135,
    1321810770, 456816404, 2903323407, 4065664991, 330002838, 3506006750, 363569021, 2347096187,
];

/** S-box of the block cipher. */
const ZB: [u8; 256] = [
    20, 223, 245, 7, 248, 2, 194, 209, 87, 6, 227, 253, 240, 128, 222, 91, 237, 9, 125, 157, 230,
    93, 252, 205, 90, 79, 144, 199, 159, 197, 186, 167, 39, 37, 156, 198, 38, 42, 43, 168, 217,
    153, 15, 103, 80, 189, 71, 191, 97, 84, 247, 95, 36, 69, 14, 35, 12, 171, 28, 114, 178, 148,
    86, 182, 32, 83, 158, 109, 22, 255, 94, 238, 151, 85, 77, 124, 254, 18, 4, 26, 123, 176, 232,
    193, 131, 172, 143, 142, 150, 30, 10, 146, 162, 62, 224, 218, 196, 229, 1, 192, 213, 27, 110,
    56, 231, 180, 138, 107, 242, 187, 54, 120, 19, 44, 117, 228, 215, 203, 53, 239, 251, 127, 81,
    11, 133, 96, 204, 132, 41, 115, 73, 55, 249, 147, 102, 48, 122, 145, 106, 118, 74, 190, 29, 16,
    174, 5, 177, 129, 63, 113, 99, 31, 161, 76, 246, 34, 211, 13, 60, 68, 207, 160, 65, 111, 82,
    165, 67, 169, 225, 57, 112, 244, 155, 51, 236, 200, 233, 58, 61, 47, 100, 137, 185, 64, 17, 70,
    234, 163, 219, 108, 170, 166, 59, 149, 52, 105, 24, 212, 78, 173, 45, 0, 116, 226, 119, 136,
    206, 135, 175, 195, 25, 92, 121, 208, 126, 139, 3, 75, 141, 21, 130, 98, 241, 40, 154, 66, 184,
    49, 181, 46, 243, 88, 101, 183, 8, 23, 72, 188, 104, 179, 210, 134, 250, 201, 164, 89, 216,
    202, 220, 50, 221, 152, 140, 33, 235, 214,
];

/** Custom base64 alphabet ('=' and '+' are ordinary digits here; 65 chars
 *  in the reference — the last is never indexed, kept as-is). */
const ZSE_ALPHABET: &[u8; 65] =
    b"6fpLRqJO8M/c3jnYxFkUVC4ZIG12SiH=5v0mXDazWBTsuw7QetbKdoPyAl+hN9rgE";
/** Fixed whitening key (ASCII). */
const ZSE_KEY16: [u8; 16] = *b"059053f7d15e01d7";

/** One block: 32 Feistel-ish rounds over S-box ZB + round keys ZK, output
 *  words written back in reverse order. */
fn zse_r_block(input: &[u8; 16]) -> [u8; 16] {
    let mut tr = [0u32; 36];
    for (i, w) in input.chunks_exact(4).enumerate() {
        tr[i] = u32::from_be_bytes([w[0], w[1], w[2], w[3]]);
    }
    for i in 0..32 {
        let t = tr[i + 1] ^ tr[i + 2] ^ tr[i + 3] ^ ZK[i];
        let ti = u32::from_be_bytes([
            ZB[(t >> 24) as usize],
            ZB[((t >> 16) & 0xFF) as usize],
            ZB[((t >> 8) & 0xFF) as usize],
            ZB[(t & 0xFF) as usize],
        ]);
        tr[i + 4] = tr[i] ^ (ti
            ^ ti.rotate_left(2)
            ^ ti.rotate_left(10)
            ^ ti.rotate_left(18)
            ^ ti.rotate_left(24));
    }
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&tr[35].to_be_bytes());
    out[4..8].copy_from_slice(&tr[34].to_be_bytes());
    out[8..12].copy_from_slice(&tr[33].to_be_bytes());
    out[12..16].copy_from_slice(&tr[32].to_be_bytes());
    out
}

/** CBC-ish chaining: each cipher block doubles as the next block's IV. */
fn zse_x_blocks(data: &[u8], iv0: &[u8; 16]) -> Vec<u8> {
    let mut iv = *iv0;
    let mut out = vec![0u8; data.len()];
    for (chunk, dst) in data.chunks_exact(16).zip(out.chunks_exact_mut(16)) {
        let mut mixed = [0u8; 16];
        for (m, (d, k)) in mixed.iter_mut().zip(chunk.iter().zip(iv.iter())) {
            *m = d ^ k;
        }
        iv = zse_r_block(&mixed);
        dst.copy_from_slice(&iv);
    }
    out
}

/** Custom base64: every 4th processed byte is XOR-masked with 0x3A, groups
 *  of 3 bytes are taken from the END of the buffer, chars low-to-high. */
fn zse_custom_encode(bytes: &[u8]) -> String {
    let mut bytes = bytes.to_vec();
    let rem = bytes.len() % 3;
    if rem != 0 {
        bytes.extend(std::iter::repeat_n(0u8, 3 - rem));
    }
    let mask = |i: usize| (58u32 >> (8 * (i % 4) as u32)) as u8;
    let mut out = String::with_capacity(bytes.len() / 3 * 4);
    let mut i = 0usize;
    let mut p = bytes.len() as isize - 1;
    while p >= 0 {
        let mut v = (bytes[p as usize] ^ mask(i)) as u32;
        i += 1;
        v |= ((bytes[p as usize - 1] ^ mask(i)) as u32) << 8;
        i += 1;
        v |= ((bytes[p as usize - 2] ^ mask(i)) as u32) << 16;
        i += 1;
        for shift in [0u32, 6, 12, 18] {
            out.push(ZSE_ALPHABET[((v >> shift) & 63) as usize] as char);
        }
        p -= 3;
    }
    out
}

/** Full encrypt: seed(210,0) + md5hex + PKCS-ish pad, first block whitened
 *  with KEY16 ^ 0x2A, then chained blocks. Input is always the 32-char
 *  lowercase md5 hex (encodeURIComponent is the identity there). */
fn zse_encrypt_v4(md5_hex: &str) -> String {
    let mut plain: Vec<u8> = Vec::with_capacity(48);
    plain.push(210);
    plain.push(0);
    plain.extend(md5_hex.bytes());
    let pad = 16 - plain.len() % 16;
    plain.extend(std::iter::repeat_n(pad as u8, pad));
    let mut first = [0u8; 16];
    for (f, (p, k)) in first.iter_mut().zip(plain.iter().zip(ZSE_KEY16.iter())) {
        *f = p ^ k ^ 42;
    }
    let c0 = zse_r_block(&first);
    let mut cipher = vec![0u8; plain.len()];
    cipher[0..16].copy_from_slice(&c0);
    cipher[16..].copy_from_slice(&zse_x_blocks(&plain[16..], &c0));
    zse_custom_encode(&cipher)
}

/** Pull the d_c0 value out of the raw Cookie header string ("" if absent;
 *  the reference still signs with an empty d_c0, so keep that behaviour). */
fn zhihu_d_c0(cookie: &str) -> &str {
    for part in cookie.split(';') {
        if let Some(v) = part.trim().strip_prefix("d_c0=") {
            return v;
        }
    }
    ""
}

/** x-zse-96 = "2.0_" + encrypt(md5(zse93 + path?query + d_c0 [+ body])). */
fn zhihu_sign(url: &str, dc0: &str, body: Option<&str>) -> String {
    // path?query = everything after the host (string split, like the ref).
    let after = url.split("//").nth(1).unwrap_or(url);
    let path_query = format!("/{}", after.splitn(2, '/').nth(1).unwrap_or(""));
    let mut source = format!("{ZHIHU_ZSE93}+{path_query}+{dc0}");
    if let Some(b) = body {
        source.push('+');
        source.push_str(b);
    }
    let digest = format!("{:x}", md5::compute(source.as_bytes()));
    format!("2.0_{}", zse_encrypt_v4(&digest))
}

/** GET with the user cookie + request signature; parses the JSON body.
 *  Only 401 maps to the distinct auth error (frontend shows the cookie
 *  banner); 403 would mean risk control / signature mismatch, NOT a dead
 *  cookie, so it stays a plain error instead of nagging the user. */
async fn zhihu_get(url: &str, cookie: &str) -> Result<serde_json::Value, String> {
    let sig = zhihu_sign(url, zhihu_d_c0(cookie), None);
    let resp = zhihu_client().get(url)
        .header("Cookie", cookie)
        .header("x-zse-93", ZHIHU_ZSE93)
        .header("x-zse-96", sig)
        .send().await
        .map_err(|e| format!("zhihu http: {e:?}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| format!("zhihu body: {e}"))?;
    match status.as_u16() {
        401 => return Err("ZHIHU_AUTH HTTP 401: cookie 已失效，请更新 Cookie".into()),
        403 => return Err("zhihu http 403: 知乎风控拦截（非 Cookie 失效），请稍后再试".into()),
        _ => {}
    }
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("zhihu json: {e}"))?;
    Ok(v)
}

/** One page of the Zhihu recommendation feed (raw API JSON passthrough).
 * `page_number` starts at 1; `end_offset` accumulates item counts across
 * pages; `session_token` comes from the previous page's paging.next (omit
 * on the first request). `limit` only when a non-default page size is used. */
#[tauri::command]
async fn slacker_zhihu_feed(
    cookie: String,
    page_number: u32,
    end_offset: u32,
    session_token: Option<String>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let mut url = format!(
        "https://www.zhihu.com/api/v3/feed/topstory/recommend?action=down&desktop=true&page_number={page_number}&end_offset={end_offset}"
    );
    if let Some(token) = session_token.as_deref().filter(|t| !t.is_empty()) {
        url.push_str("&session_token=");
        url.push_str(&urlencode_component(token));
    }
    if let Some(n) = limit {
        url.push_str(&format!("&limit={n}"));
    }
    zhihu_get(&url, &cookie).await
}

/** Full content of one feed target (raw API JSON; `content` HTML inside).
 * @param kind - "answer" | "article" | "pin".
 */
#[tauri::command]
async fn slacker_zhihu_content(
    kind: String,
    target_id: String,
    cookie: String,
) -> Result<serde_json::Value, String> {
    let url = match kind.as_str() {
        "answer" => format!("https://www.zhihu.com/api/v4/answers/{target_id}?include=content"),
        "article" => format!("https://www.zhihu.com/api/v4/articles/{target_id}?include=content"),
        "pin" => format!("https://www.zhihu.com/api/v4/pins/{target_id}"),
        other => return Err(format!("unsupported zhihu content kind: {other}")),
    };
    zhihu_get(&url, &cookie).await
}

/** One page of root comments for one feed target (raw API JSON passthrough:
 * `{ data: [...], paging: { is_end, ... } }`). `offset` is the item offset
 * of this page (0 for the first). */
#[tauri::command]
async fn slacker_zhihu_comments(
    kind: String,
    target_id: String,
    cookie: String,
    offset: u32,
    limit: u32,
) -> Result<serde_json::Value, String> {
    let base = match kind.as_str() {
        "answer" => format!("https://www.zhihu.com/api/v4/answers/{target_id}/root_comments"),
        "article" => format!("https://www.zhihu.com/api/v4/articles/{target_id}/root_comments"),
        "pin" => format!("https://www.zhihu.com/api/v4/pins/{target_id}/root_comments"),
        other => return Err(format!("unsupported zhihu comments kind: {other}")),
    };
    let url = format!("{base}?offset={offset}&limit={limit}&order=normal&status=open");
    zhihu_get(&url, &cookie).await
}

/** Fire-and-forget "already read" feedback so the feed stops repeating.
 * Returns success only on HTTP 2xx; the frontend trips a breaker after 3
 * consecutive failures and stops reporting for the session. */
#[tauri::command]
async fn slacker_zhihu_report_read(
    items: Vec<serde_json::Value>,
    cookie: String,
) -> Result<bool, String> {
    let payload = serde_json::json!({ "read_data_list": items });
    let body = payload.to_string();
    let sig = zhihu_sign(
        "https://www.zhihu.com/api/v3/feed/topstory/feedback/read",
        zhihu_d_c0(&cookie), Some(&body),
    );
    let resp = zhihu_client()
        .post("https://www.zhihu.com/api/v3/feed/topstory/feedback/read")
        .header("Cookie", cookie)
        .header("x-zse-93", ZHIHU_ZSE93)
        .header("x-zse-96", sig)
        .header("Content-Type", "application/json")
        .body(body)
        .send().await
        .map_err(|e| format!("zhihu read http: {e:?}"))?;
    Ok(resp.status().is_success())
}

/** Validate the stored cookie against GET /api/v4/me. */
#[tauri::command]
async fn slacker_zhihu_me(cookie: String) -> Result<serde_json::Value, String> {
    zhihu_get("https://www.zhihu.com/api/v4/me", &cookie).await
}

/** Proxy-fetch a zhimg image and return it as a data URL. WebView-side
 * loads of pic*.zhimg.com get cut by anti-hotlinking/risk control (every
 * image ends up hidden), so we fetch with the same browser-ish client as
 * the APIs (Cookie + Referer + full UA) and inline the bytes instead. */
#[tauri::command]
async fn slacker_zhihu_image(url: String, cookie: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| format!("bad image url: {url}"))?;
    let host = parsed.host_str().unwrap_or("").to_string();
    // Only the zhimg CDN: keeps this command from becoming an SSRF gadget.
    if host != "zhimg.com" && !host.ends_with(".zhimg.com") {
        return Err(format!("not a zhimg host: {host}"));
    }
    let resp = zhihu_client().get(parsed)
        .header("Cookie", cookie)
        .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        .send().await
        .map_err(|e| format!("zhihu image http: {e:?}"))?;
    let status = resp.status();
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .trim()
        .to_ascii_lowercase();
    let bytes = resp.bytes().await.map_err(|e| format!("zhihu image body: {e}"))?;
    if !status.is_success() {
        return Err(format!("zhihu image HTTP {status}: {host}"));
    }
    if !ctype.starts_with("image/") {
        return Err(format!("zhihu image not an image: {ctype}"));
    }
    // Cap at 10 MB so a huge original cannot blow up the IPC channel.
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("zhihu image too large".into());
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{ctype};base64,{b64}"))
}

/** encodeURIComponent for a single query value (ASCII-safe superset). */
fn urlencode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/* ── slacker tea window: the break room as its own OS window ──────
 * Now loads a standalone HTML (tea.html) that mounts SlackerOverlay directly,
 * completely bypassing dsh. No token, no dsh boot, instant startup. */

/// 确保茶水窗存在：已存在则聚焦，否则加载本地 tea.html。
async fn ensure_tea_window(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;
    if let Some(win) = app.get_webview_window("tea") {
        win.set_focus().map_err(|e| format!("focus tea window: {e}"))?;
        return Ok("focused".into());
    }
    WebviewWindowBuilder::new(app, "tea", WebviewUrl::App("tea.html".into()))
        .title("茶水间")
        .inner_size(400.0, 660.0)
        .min_inner_size(340.0, 480.0)
        .maximizable(false)
        .decorations(false)
        .shadow(true)
        .build()
        .map_err(|e| format!("build tea window: {e}"))?;
    Ok("created".into())
}

/// Toggle (or force-close) the tea room window.
/// @param action - "toggle": close if open, else create; "close": close if open.
#[tauri::command]
async fn slacker_tea_window(
    app: tauri::AppHandle,
    action: String,
) -> Result<String, String> {
    // NOTE(Windows): window creation inside a command MUST be async — sync
    // commands run on the main thread and WebviewWindowBuilder::build()
    // deadlocks waiting for events that thread itself must pump.
    // Trace line for the terminal running `pnpm shell` (dev diagnostics).
    println!("[slacker] tea window invoked: action={action}");
    if let Some(win) = app.get_webview_window("tea") {
        if action == "close" || action == "toggle" {
            win.close().map_err(|e| format!("close tea window: {e}"))?;
            println!("[slacker] tea window closed");
            return Ok("closed".into());
        }
        if action == "minimize" {
            win.minimize().map_err(|e| format!("minimize tea window: {e}"))?;
            println!("[slacker] tea window minimized");
            return Ok("minimized".into());
        }
        return Ok("focused".into());
    }
    if action == "close" {
        return Ok("absent".into());
    }
    let res = ensure_tea_window(&app).await;
    println!("[slacker] tea window {}", res.as_deref().unwrap_or("request failed"));
    res
}

/* ── slacker novel window: the reader as its own silent window ──
 * Now loads a standalone HTML (novel.html) that mounts NovelView directly.
 * On creation the book is injected via an initialization script
 * (window.__SLACKER_NOVEL_BOOK__, document_start); an existing window
 * switches books via the 'slacker:novel-open' event instead. */

/// Open (create+fill or focus+retarget) / close the novel reader window.
/// @param action - "open": create or focus; "close": close if open.
/// @param book - optional book JSON (ShelfBookMeta) to read in that window.
#[tauri::command]
async fn slacker_novel_window(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    action: String,
    book: Option<serde_json::Value>,
) -> Result<String, String> {
    println!("[slacker] novel window invoked: action={action}");
    if let Some(win) = app.get_webview_window("novel-reader") {
        if action == "close" {
            // 浮条态关窗：先把当前位置记下来（拖到哪，下次开回来还是哪）——对摸鱼要紧。
            if *state.novel_was_floating.lock().unwrap() {
                if let Ok(pos) = win.outer_position() {
                    *state.novel_float_return_pos.lock().unwrap() = Some((pos.x, pos.y));
                }
            }
            win.close().map_err(|e| format!("close novel window: {e}"))?;
            println!("[slacker] novel window closed");
            return Ok("closed".into());
        }
        // 已存在的窗口：通过事件换书。
        if let Some(b) = &book {
            let _ = app.emit_to("novel-reader", "slacker:novel-open", b);
        }
        win.set_focus().map_err(|e| format!("focus novel window: {e}"))?;
        return Ok("focused".into());
    }
    if action == "close" {
        return Ok("absent".into());
    }
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;
    // 带书开窗：书目用 initialization_script 在 document_start 注入（早于页面
    // 任何脚本），替代旧的「sleep 500ms 再 emit」——那个兜底偶尔赶不上监听。
    let book_json = book
        .as_ref()
        .and_then(|b| serde_json::to_string(b).ok())
        .unwrap_or_else(|| "null".into());
    let init_script = format!(
        "(function () {{
            if (window.top !== window) return;
            // 资产缺失时 webview 会回落到 index.html（茶水间首页）；自愈跳回阅读页。
            if (!/novel\\.html$/.test(location.pathname)) {{
                if (!sessionStorage.getItem('__slackerNovelRetry')) {{
                    sessionStorage.setItem('__slackerNovelRetry', '1');
                    location.replace('novel.html');
                }}
                return;
            }}
            window.__SLACKER_NOVEL_BOOK__ = {book_json};
        }})();"
    );
    // 新窗口从正常阅读形态开始：清掉上一轮残留的浮条状态
    // （return_pos 不清，保留「拖到哪下次开回来还是哪」的跨窗记忆）。
    *state.novel_was_floating.lock().unwrap() = false;
    *state.novel_float_prev_pos.lock().unwrap() = None;
    *state.novel_float_prev_size.lock().unwrap() = None;
    let _win = WebviewWindowBuilder::new(&app, "novel-reader", WebviewUrl::App("novel.html".into()))
        .title("阅读")
        .inner_size(500.0, 760.0)
        .min_inner_size(400.0, 520.0)
        .maximizable(false)
        .decorations(false)
        // 透明窗口下的 DWM 阴影会画出一圈黑/灰虚线框；悬浮皮肤要求无边框线。
        .shadow(false)
        // 悬浮小窗（浮条皮肤）需要透出底层工作软件；页面根背景由 NovelView 兜底。
        .transparent(true)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| {
            eprintln!("[slacker] build novel window failed: {e}");
            format!("build novel window: {e}")
        })?;
    println!("[slacker] novel window created");
    Ok("created".into())
}

/* ── 悬浮小窗（novel 皮肤的第五态「悬浮」） ──
 * 把阅读弹窗收成屏幕底部一条极小的半透明细条、置顶、可选鼠标穿透
 * （点击直接打到底层工作软件）。退出时还原为正常阅读窗口。 */

#[tauri::command]
async fn slacker_novel_resize(
    app: tauri::AppHandle,
    wide: bool,
) -> Result<String, String> {
    let Some(win) = app.get_webview_window("novel-reader") else {
        return Ok("absent".into());
    };
    use tauri::LogicalSize;
    if wide {
        // 文档皮肤：WPS/Office 大窗。
        win.set_resizable(true).map_err(|e| e.to_string())?;
        win.set_size(LogicalSize::new(820.0, 960.0)).map_err(|e| e.to_string())?;
        win.set_min_size(Some(LogicalSize::new(500.0, 600.0))).map_err(|e| e.to_string())?;
    } else {
        // 普通阅读：还原默认紧凑窗。
        win.set_size(LogicalSize::new(500.0, 760.0)).map_err(|e| e.to_string())?;
        win.set_min_size(Some(LogicalSize::new(400.0, 520.0))).map_err(|e| e.to_string())?;
    }
    let _ = win.set_focus();
    Ok(if wide { "widened" } else { "restored" }.into())
}

#[tauri::command]
async fn slacker_novel_float(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    float: bool,
) -> Result<String, String> {
    let Some(win) = app.get_webview_window("novel-reader") else {
        return Ok("absent".into());
    };
    use tauri::{LogicalSize, PhysicalPosition, Position};

    let was_floating = *state.novel_was_floating.lock().unwrap();

    if float {
        // ── 进入 / 刷新浮条 ──
        win.set_always_on_top(true).map_err(|e| e.to_string())?;
        win.set_resizable(false).map_err(|e| e.to_string())?;
        if !was_floating {
            // 首次进入：先记录阅读窗口当前状态（收缩前！），退出时才能原样还原。
            if let Ok(pos) = win.outer_position() {
                *state.novel_float_prev_pos.lock().unwrap() = Some((pos.x, pos.y));
            }
            if let Ok(sz) = win.inner_size() {
                *state.novel_float_prev_size.lock().unwrap() = Some((sz.width, sz.height));
            }
            // 再收窄成浮条；有上次浮条位置（展开设置前拖到哪）就回原位，否则首进贴底居中。
            win.set_min_size(Some(LogicalSize::new(260.0, 34.0))).map_err(|e| e.to_string())?;
            win.set_size(LogicalSize::new(360.0, 48.0)).map_err(|e| e.to_string())?;
            if let Some((x, y)) = *state.novel_float_return_pos.lock().unwrap() {
                win.set_position(Position::Physical(PhysicalPosition::new(x, y)))
                    .map_err(|e| e.to_string())?;
            } else if let Ok(Some(mon)) = app.primary_monitor() {
                let scale = win.scale_factor().unwrap_or(1.0);
                let lw = 360.0f64;
                let lh = 48.0f64;
                let pw = (lw * scale) as i32;
                let ph = (lh * scale) as i32;
                let p = mon.position();
                let s = mon.size();
                let x = p.x + (s.width as i32 - pw) / 2;
                let y = p.y + s.height as i32 - ph - 56;
                win.set_position(Position::Physical(PhysicalPosition::new(x, y)))
                    .map_err(|e| e.to_string())?;
            }
            *state.novel_was_floating.lock().unwrap() = true;
        } else {
            // 再次进入/展开缩回/关窗重开后刷新：位置若记录过就贴回（拖到哪回哪），
            // 否则保持系统当前位；尺寸仍强制 360×48，防状态分叉残留大高度。
            win.set_min_size(Some(LogicalSize::new(260.0, 34.0))).map_err(|e| e.to_string())?;
            win.set_size(LogicalSize::new(360.0, 48.0)).map_err(|e| e.to_string())?;
            if let Some((x, y)) = *state.novel_float_return_pos.lock().unwrap() {
                win.set_position(Position::Physical(PhysicalPosition::new(x, y)))
                    .map_err(|e| e.to_string())?;
            }
        }
        let _ = win.set_focus();
        Ok("floating".into())
    } else {
        // ── 退出浮条，还原为之前的阅读窗口 ──
        // 先记录当前浮条位置（此刻尚未还原/移动），关闭设置缩回时回到原位。
        if was_floating {
            if let Ok(pos) = win.outer_position() {
                *state.novel_float_return_pos.lock().unwrap() = Some((pos.x, pos.y));
            }
        }
        win.set_always_on_top(false).map_err(|e| e.to_string())?;
        win.set_resizable(true).map_err(|e| e.to_string())?;
        if let Some((w, h)) = *state.novel_float_prev_size.lock().unwrap() {
            win.set_size(tauri::PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
        } else {
            win.set_size(LogicalSize::new(500.0, 760.0)).map_err(|e| e.to_string())?;
        }
        if let Some((x, y)) = *state.novel_float_prev_pos.lock().unwrap() {
            win.set_position(Position::Physical(PhysicalPosition::new(x, y)))
                .map_err(|e| e.to_string())?;
        }
        win.set_min_size(Some(LogicalSize::new(400.0, 520.0))).map_err(|e| e.to_string())?;
        *state.novel_was_floating.lock().unwrap() = false;
        Ok("restored".into())
    }
}

/* ── slacker stock mini: the watchlist as a persistent desktop sliver ──
 * A small transparent, borderless, always-on-top window (stock-mini.html)
 * that mirrors the watchlist panel in the break room. Unlike the novel
 * float bar it stays narrow-and-tall (a stock ticker), not a wide strip. */

/// Toggle (or force-close) the stock mini window.
/// @param action - "toggle": close if open, else create; "close": close if open.
#[tauri::command]
async fn slacker_stock_mini(
    app: tauri::AppHandle,
    action: String,
) -> Result<String, String> {
    println!("[slacker] stock mini invoked: action={action}");
    if let Some(win) = app.get_webview_window("stock-mini") {
        if action == "close" || action == "toggle" {
            win.close().map_err(|e| format!("close stock mini window: {e}"))?;
            println!("[slacker] stock mini window closed");
            return Ok("closed".into());
        }
        win.set_focus().map_err(|e| format!("focus stock mini window: {e}"))?;
        return Ok("focused".into());
    }
    if action == "close" {
        return Ok("absent".into());
    }
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;
    WebviewWindowBuilder::new(&app, "stock-mini", WebviewUrl::App("stock-mini.html".into()))
        .title("自选行情")
        .inner_size(240.0, 380.0)
        .min_inner_size(200.0, 260.0)
        .maximizable(false)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .build()
        .map_err(|e| format!("build stock mini window: {e}"))?;
    println!("[slacker] stock mini window created");
    Ok("created".into())
}

/// 独立窗取肤色：返回壳最近缓存到的 dsh 根 CSS 变量快照（可为空）。
#[tauri::command]
fn slacker_theme_get(state: State<'_, ShellState>) -> Option<serde_json::Value> {
    state.theme_vars.lock().unwrap().clone()
}

/** Run the shell: state, commands, and child cleanup on exit. */
pub fn run() {
    // 全局快捷键：
    //   Ctrl+Shift+H —— 老板键，广播进隐身态（dsh 主应用共用同一组合同可并存）。
    //   Ctrl+Alt+←/→  —— 悬浮小窗专用翻页（穿透时窗口收不到键盘，需全局转发）。
    use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
    let gs_plugin = match tauri_plugin_global_shortcut::Builder::new().with_shortcuts([
        "ctrl+shift+h",
        "ctrl+alt+arrowright",
        "ctrl+alt+arrowleft",
    ]) {
        Ok(b) => b
            .with_handler(|app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                let ctrl_alt = shortcut.mods.contains(Modifiers::CONTROL)
                    && shortcut.mods.contains(Modifiers::ALT);
                if ctrl_alt && shortcut.key == Code::ArrowRight {
                    let _ = app.emit("slacker:novel-page-next", ());
                } else if ctrl_alt && shortcut.key == Code::ArrowLeft {
                    let _ = app.emit("slacker:novel-page-prev", ());
                } else {
                    let _ = app.emit("slacker:boss-key", ());
                }
            })
            .build(),
        Err(e) => {
            eprintln!("[slacker] global shortcuts unavailable: {e}");
            tauri_plugin_global_shortcut::Builder::new().build()
        }
    };

    tauri::Builder::default()
        .manage(ShellState {
            child: Mutex::new(None),
            url: Mutex::new(String::new()),
            theme_vars: Mutex::new(None),
            novel_was_floating: Mutex::new(false),
            novel_float_prev_pos: Mutex::new(None),
            novel_float_prev_size: Mutex::new(None),
    novel_float_return_pos: Mutex::new(None),
            novel_toc_cache: Mutex::new(HashMap::new()),
        })
        .plugin(gs_plugin)
        .setup(|app| {
            // 主题桥：收 dsh 主窗广播的根 CSS 变量快照，供独立窗调色。
            // 事件由 dsh 主窗（client 的 theme-bridge）以 `slacker:theme` 发出。
            {
                let handle = app.handle().clone();
                let hook = handle.clone();
                handle.listen("slacker:theme", move |event| {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                        *hook.state::<ShellState>().theme_vars.lock().unwrap() = Some(payload);
                    }
                });
            }
            // 托盘：显示主窗 / 退出。主窗 ✕ 走 RunEvent（真退），托盘提供
            // "回收站常驻"的恢复入口。
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let tea_i = MenuItem::with_id(app, "tea", "茶水间", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &tea_i, &quit_i])?;
            let mut builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "tea" => {
                        // 菜单回调非 async 上下文：自起任务避免阻塞事件泵。
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = ensure_tea_window(&app).await {
                                eprintln!("[slacker] open tea from tray failed: {e}");
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell_boot,
            shell_url,
            shell_read_text,
            slacker_kv_get,
            slacker_kv_set,
            slacker_novel_save,
            slacker_novel_list,
            slacker_novel_toc,
            slacker_novel_chapter,
            slacker_novel_load,
            slacker_novel_delete,
            slacker_novel_dir,
            slacker_novel_set_dir,
            slacker_novel_pick_dir,
            slacker_stock_quotes,
            slacker_stock_trends,
            slacker_stock_search,
            slacker_stock_kline,
            slacker_stock_mini,
            slacker_zhihu_feed,
            slacker_zhihu_content,
            slacker_zhihu_comments,
            slacker_zhihu_report_read,
            slacker_zhihu_me,
            slacker_zhihu_image,
            slacker_http_fetch,
            slacker_tea_window,
            slacker_novel_window,
    slacker_novel_float,
            slacker_novel_resize,
            slacker_theme_get
        ])
        .build(tauri::generate_context!())
        .expect("error while building slacker shell")
        .run(|app, event| {
            match &event {
                // 主窗 ✕ = 缩进托盘（右下角驻留），不退出：托盘「退出」才是真退。
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } if label.as_str() == "main" => {
                    api.prevent_close();
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
                _ => {}
            }
            if let RunEvent::Exit = event {
                if let Some(mut c) = app.state::<ShellState>().child.lock().unwrap().take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        });
}

#[cfg(test)]
mod zse96_tests {
    use super::*;

    /** Golden values generated with the reference JS implementation
     *  (zse-signer.js from zhihu-mcp-server, a zhihu-plus-plus port) run
     *  under node; guards the hand-ported cipher against regressions. */
    #[test]
    fn zse96_matches_reference_js() {
        assert_eq!(
            zse_encrypt_v4("848951efd31705cb9bcbd5251310516a"),
            "kvD4f6R8CYndvScnkVe2uQPcc3QiLwzACx6skQyfOjRQZC9BPv4agkhnuy6pxn9Z"
        );
        assert_eq!(
            zhihu_sign(
                "https://www.zhihu.com/api/v4/feed/topstory/recommend?limit=6&after_id=0",
                "AbC.123|456|xyz=", None,
            ),
            "2.0_XFOy1FkR=6r/yHkZoZhK1NeWnoN/OFrfc=bt3DdAuqQlMHbX9vbhQ+8fGQwOZrkl"
        );
        assert_eq!(
            zhihu_sign(
                "https://www.zhihu.com/api/v3/feed/topstory/feedback/read",
                "AbC.123|456|xyz=", Some(r#"{"read_data_list":[]}"#),
            ),
            "2.0_eMMW/iN38v6zlBiXOVznVWBy3=2Ch4lnKnyBJGJCMgZ4P5n0C+5ikTG3ZlSn=1SD"
        );
    }

    #[test]
    fn d_c0_extraction() {
        assert_eq!(zhihu_d_c0("a=1; d_c0=AbC.123|456|xyz=; z_c0=zz"), "AbC.123|456|xyz=");
        assert_eq!(zhihu_d_c0("d_c0=lead"), "lead");
        assert_eq!(zhihu_d_c0("no_cookie_here"), "");
    }
}
