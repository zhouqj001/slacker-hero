/**
 * Slacker shell: spawns the vendored dsh web runtime, parses its tokenized
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

/** Vendor dsh entry, relative to the repo root (cwd = src-tauri at spawn). */
const DSH_BIN: &str = "vendor/deepseek-harness/apps/cli/lib/bin.js";

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

/**
 * Spawn the vendored dsh web server and return its tokenized URL.
 * The URL line ("dsh web: http://…?token=…") is parsed from stdout.
 */
fn spawn_dsh_web(app: &tauri::AppHandle) -> Result<String, String> {
    let port = free_port();
    let repo_root = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|_| None::<std::path::PathBuf>)
        .unwrap_or_default();
    let _ = repo_root;
    // Dev shape: cwd is the src-tauri dir; resolve the repo root from there.
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let repo_root = cwd
        .ancestors()
        .nth(2)
        .ok_or("cannot resolve repo root")?
        .to_path_buf();

    let home = repo_root.join(".dsh-dev").join("shell-home");
    std::fs::create_dir_all(&home).map_err(|e| format!("create dsh home: {e}"))?;

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
    // peers are provided by the vendored runtime, and their semver ranges only
    // match prereleases that are not on the public registry.
    if !profile_dst.join("node_modules").exists() {
        println!("[slacker] profile node_modules missing; running pnpm install...");
        let status = Command::new("pnpm")
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

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("node");
    cmd.arg(DSH_BIN)
        .arg("--profile")
        .arg("slacker")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-open")
        .current_dir(&repo_root)
        .env("DSH_HOME", &home)
        .stdout(Stdio::piped());
    // Keep stderr on disk: when dsh fails to boot (e.g. bundle resolution),
    // the port wait times out with no clue — this log holds the real error.
    let stderr_log = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(home.join("dsh-web-stderr.log"))
        .map_err(|e| format!("open dsh stderr log: {e}"))?;
    cmd.stderr(Stdio::from(stderr_log));
    // No stray console window for the node child (release, GUI subsystem).
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn node: {e} (is Node.js on PATH?)"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let url_arc = std::sync::Arc::new(Mutex::new(None::<String>));
    {
        let url_arc = url_arc.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("dsh web: ") {
                    let url = rest.trim().to_string();
                    if url.starts_with("http") {
                        *url_arc.lock().unwrap() = Some(url);
                        // Keep reading so the pipe does not fill; dsh stays chatty.
                    }
                }
            }
        });
    }

    if !wait_port("127.0.0.1", port, Duration::from_secs(60)) {
        let _ = child.kill();
        return Err(format!(
            "dsh web did not listen on port {port} within 60s; real error: {}",
            home.join("dsh-web-stderr.log").display()
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(u) = url_arc.lock().unwrap().clone() {
            *app.state::<ShellState>().url.lock().unwrap() = u.clone();
            *app.state::<ShellState>().child.lock().unwrap() = Some(child);
            println!("[slacker] boot url stored (len={})", u.len());
            return Ok(u);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err("dsh web listened but printed no URL within 10s".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/**
 * Boot (or reboot) the dsh runtime and return its URL.
 * @returns the tokenized web URL and whether an existing child was replaced.
 */
#[tauri::command]
fn shell_boot(app: tauri::AppHandle, state: State<ShellState>) -> Result<BootInfo, String> {
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
    let url = spawn_dsh_web(&app)?;
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

/** 切章（字节偏移版；算法 = 客户端 splitChapters：全匹配 → 按位排序 →
 * 同位置去重（卷先到保留）→ 正文起点取标题 match 结束、终点取下条目前题起点）。 */
fn split_novel_chapters(text: &str) -> Vec<NovelChapterBound> {
    if text.is_empty() {
        return Vec::new();
    }
    struct Mark {
        index: usize,
        len: usize,
        line: String,
        is_volume: bool,
    }
    let mut marks: Vec<Mark> = Vec::new();
    for (is_volume, res) in [(true, novel_volume_res()), (false, novel_chapter_res())] {
        for re in res {
            let mut guard = 0usize;
            for m in re.find_iter(text) {
                guard += 1;
                if guard > 100_000 {
                    break;
                }
                let line = m.as_str();
                if line.trim().is_empty() {
                    continue;
                }
                marks.push(Mark {
                    index: m.start(),
                    len: m.as_str().len(),
                    line: line.to_string(),
                    is_volume,
                });
            }
        }
    }
    marks.sort_by_key(|m| m.index);
    let mut seen: HashMap<usize, ()> = HashMap::new();
    let mut deduped: Vec<Mark> = Vec::with_capacity(marks.len());
    for m in marks {
        if seen.insert(m.index, ()).is_none() {
            deduped.push(m);
        }
    }
    if deduped.is_empty() {
        return vec![NovelChapterBound { name: "全文".into(), is_volume: false, start: 0, end: text.len() }];
    }
    let n = deduped.len();
    (0..n)
        .map(|i| {
            let m = &deduped[i];
            let end = if i + 1 < n { deduped[i + 1].index } else { text.len() };
            NovelChapterBound {
                name: m.line.trim().to_string(),
                is_volume: m.is_volume,
                start: m.index + m.len,
                end,
            }
        })
        .collect()
}

/** 懒取（缓存）章节目录。 */
fn novel_toc_cached(
    app: &tauri::AppHandle,
    state: &State<'_, ShellState>,
    name: &str,
) -> Result<Vec<NovelChapterBound>, String> {
    if let Some(hit) = state.novel_toc_cache.lock().unwrap().get(name) {
        return Ok(hit.clone());
    }
    let text = std::fs::read_to_string(novel_path(app, name)?)
        .map_err(|e| format!("load novel {name}: {e}"))?;
    let chapters = split_novel_chapters(&text);
    state.novel_toc_cache.lock().unwrap().insert(name.to_string(), chapters.clone());
    Ok(chapters)
}

/** 章节目录（只回展示所需字段）。 */
#[tauri::command]
fn slacker_novel_toc(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    name: String,
) -> Result<Vec<NovelTocEntry>, String> {
    let chapters = novel_toc_cached(&app, &state, &name)?;
    Ok(chapters
        .iter()
        .map(|c| NovelTocEntry { name: c.name.clone(), is_volume: c.is_volume })
        .collect())
}

/** 读取某一章正文：按缓存字节区间 seek 定点读取，不整本读入内存。
 * 返回该章原文（未 trim），与客户端 splitChapters/getChapterText 语义一致。 */
#[tauri::command]
fn slacker_novel_chapter(
    app: tauri::AppHandle,
    state: State<'_, ShellState>,
    name: String,
    index: usize,
) -> Result<String, String> {
    let chapters = novel_toc_cached(&app, &state, &name)?;
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
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36")
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
 * Plain GET v3/v4 APIs need no x-zse-95/96 signatures. */
fn zhihu_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(std::time::Duration::from_secs(15))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36")
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

/** GET with the user cookie; parses the JSON body. 401/403 maps to a
 * distinct auth error so the frontend can show the cookie banner. */
async fn zhihu_get(url: &str, cookie: &str) -> Result<serde_json::Value, String> {
    let resp = zhihu_client().get(url)
        .header("Cookie", cookie)
        .send().await
        .map_err(|e| format!("zhihu http: {e:?}"))?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| format!("zhihu body: {e}"))?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(format!("ZHIHU_AUTH HTTP {status}: cookie 已失效，请更新 Cookie"));
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

/** Fire-and-forget "already read" feedback so the feed stops repeating.
 * Returns success only on HTTP 2xx; the frontend trips a breaker after 3
 * consecutive failures and stops reporting for the session. */
#[tauri::command]
async fn slacker_zhihu_report_read(
    items: Vec<serde_json::Value>,
    cookie: String,
) -> Result<bool, String> {
    let payload = serde_json::json!({ "read_data_list": items });
    let resp = zhihu_client()
        .post("https://www.zhihu.com/api/v3/feed/topstory/feedback/read")
        .header("Cookie", cookie)
        .header("Content-Type", "application/json")
        .body(payload.to_string())
        .send().await
        .map_err(|e| format!("zhihu read http: {e:?}"))?;
    Ok(resp.status().is_success())
}

/** Validate the stored cookie against GET /api/v4/me. */
#[tauri::command]
async fn slacker_zhihu_me(cookie: String) -> Result<serde_json::Value, String> {
    zhihu_get("https://www.zhihu.com/api/v4/me", &cookie).await
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
 * Book data is passed via Tauri event 'slacker:novel-open' after window creation. */

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
        .build()
        .map_err(|e| {
            eprintln!("[slacker] build novel window failed: {e}");
            format!("build novel window: {e}")
        })?;
    // 窗口创建后，若带书则发事件让 NovelView 打开。
    // 新建窗口的页面导航是异步的，立即 emit 会赶在 NovelView 挂载监听前
    // 到达而被丢弃；延迟一小段（本地页面导航耗时远小于该值）确保监听已就绪。
    if let Some(b) = book {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let _ = app.emit_to("novel-reader", "slacker:novel-open", b);
        });
    }
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
            slacker_zhihu_report_read,
            slacker_zhihu_me,
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
