//! Desktop shell for BGSIM.
//!
//! The React UI is served by the bundled Python engine (`engine/server.py`),
//! which also serves `dist/` — so the window just points at that local URL and
//! everything (API, assets, saves) stays on one origin, exactly like `npm start`.
//!
//! The engine is started on a free port when the app launches and killed when it
//! exits; its save folder is redirected into the per-user app-data directory
//! because the installed resources are read-only.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The running engine process, so it can be stopped with the app.
struct EngineProcess(Mutex<Option<Child>>);

/// Ask the OS for a free loopback port, then immediately give it back to the
/// engine. The window is tiny, and the port is only bound for the few ms it
/// takes to start Python.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(8790)
}

/// The port the engine gets. A stable port matters more than it looks: the
/// webview's origin is `http://127.0.0.1:<port>`, and localStorage (layout,
/// sound, time-limit prefs) is keyed by origin — a random port every launch
/// would silently reset all of it. Falls back to an OS-assigned port only when
/// the preferred ones are taken (e.g. a second copy of the app).
fn pick_port() -> u16 {
    // 8787 = dev engine, 8790 = multiplayer relay, 8799 = test engine.
    for port in [8801u16, 8802, 8803] {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    free_port()
}

/// Repo root while developing, resource root once installed.
fn engine_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("engine"));
        candidates.push(res.join("resources").join("engine"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("engine"));
            candidates.push(dir.join("resources").join("engine"));
        }
    }
    // `tauri dev` runs from src-tauri/target/debug; the sources are two levels up.
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../engine"));
    candidates.into_iter().find(|dir| dir.join("server.py").is_file())
}

fn health_ok(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    let mut buf = [0u8; 32];
    match stream.read(&mut buf) {
        Ok(n) => buf[..n].starts_with(b"HTTP/1.1 200") || buf[..n].starts_with(b"HTTP/1.0 200"),
        Err(_) => false,
    }
}

fn spawn_engine(app: &AppHandle) -> Result<(u16, Child), String> {
    let dir = engine_dir(app).ok_or_else(|| "找不到 engine/server.py".to_string())?;
    let python = dir.join("runtime").join("python.exe");
    if !python.is_file() {
        return Err(format!("找不到 Python 运行时：{}", python.display()));
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("无法定位用户数据目录：{err}"))?;
    let _ = std::fs::create_dir_all(&data);

    let port = pick_port();
    let mut command = Command::new(&python);
    command
        .arg(dir.join("server.py"))
        .arg("--port")
        .arg(port.to_string())
        .env("BGSIM_DATA", &data)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up next to the app.
        command.creation_flags(0x0800_0000);
    }
    let child = command
        .spawn()
        .map_err(|err| format!("无法启动引擎：{err}"))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if health_ok(port) {
            return Ok((port, child));
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    Err("引擎启动超时".to_string())
}

/// Fill most of the screen instead of a fixed 1600×940: the UI scales itself to
/// the window (see `useStageScale`), so a bigger window just means a bigger
/// board. Clamped so it still fits on 1920×1080 and never gets silly on 4K.
fn default_size(app: &AppHandle) -> (f64, f64) {
    let mut width = 1600.0f64;
    let mut height = 940.0f64;
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        if scale > 0.0 {
            let area = monitor.work_area().size;
            let logical_w = area.width as f64 / scale;
            let logical_h = area.height as f64 / scale;
            width = (logical_w * 0.92).clamp(1600.0, 2400.0);
            height = (logical_h * 0.94).clamp(940.0, 1400.0);
        }
    }
    (width, height)
}

fn build_window(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let (width, height) = default_size(app);
    let url: tauri::Url = format!("http://127.0.0.1:{port}/").parse().unwrap();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("酒馆战棋 · 模拟器")
        .inner_size(width, height)
        .min_inner_size(1200.0, 720.0)
        .resizable(true)
        .center()
        // The tavern is dark; a light title bar looks pasted on.
        .theme(Some(tauri::Theme::Dark))
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(EngineProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            match spawn_engine(&handle) {
                Ok((port, child)) => {
                    *handle.state::<EngineProcess>().0.lock().unwrap() = Some(child);
                    if let Err(err) = build_window(&handle, port) {
                        eprintln!("[bgsim] 无法创建窗口：{err}");
                    }
                }
                Err(err) => {
                    // Still open a window so the failure is not silent.
                    eprintln!("[bgsim] {err}");
                    let _ = build_window(&handle, free_port());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(mut child) = handle.state::<EngineProcess>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
