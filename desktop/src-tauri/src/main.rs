//! AnviDeck desktop app (#240).
//!
//! Starts the Bun server as a sidecar with private stdin/stdout pipes, waits for it to say which
//! loopback port serves reads, opens the window on the UI bundled in the app, and carries the
//! window's writes to the sidecar over its stdin. No write is reachable on any port.
//!
//! If the server cannot start, or stops while the app is open, the window says so (a banner over
//! the page) instead of going quietly blank.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

const RS: char = '\u{1e}';
const WRITE_METHODS: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Option<Child>>>,
    pending: Pending,
    next_id: AtomicU64,
}

/// A banner over the page saying the server is not there. Run in the window; it needs no
/// permission and survives the page's own re-renders (it is appended to <html>, not <body>).
fn banner_js(msg: &str) -> String {
    let text = serde_json::to_string(msg).unwrap_or_else(|_| "\"AnviDeck's server stopped.\"".into());
    format!(
        "(function(){{var d=document.getElementById('anvideck-server-gone')||document.createElement('div');\
d.id='anvideck-server-gone';d.setAttribute('role','alert');\
d.style.cssText='position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:10px 16px;background:#5c1d1d;color:#fff;font:13px/1.4 ui-monospace,monospace;border-bottom:1px solid #a33';\
d.textContent={text};document.documentElement.appendChild(d);}})();"
    )
}

/// The window shows only AnviDeck's own pages. A web link (a PR, an issue) opens in the default
/// browser instead, so no remote page ever runs inside the app, next to its write command.
fn is_own_page(url: &tauri::Url) -> bool {
    matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
}

fn open_outside(url: &tauri::Url) {
    if url.scheme() != "https" && url.scheme() != "http" {
        return;
    }
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(url.as_str()).spawn();
    #[cfg(target_os = "linux")]
    let r = Command::new("xdg-open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let r = Command::new("explorer").arg(url.as_str()).spawn();
    if let Err(e) = r {
        eprintln!("[anvideck] could not open {url} in the browser: {e}");
    }
}

fn say_server_gone(app: &AppHandle, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&banner_js(msg));
    }
}

/// The one command the window has: one write, sent to the sidecar, answered with {status, body}.
#[tauri::command]
async fn write(state: tauri::State<'_, Sidecar>, method: String, path: String, body: Value) -> Result<Value, String> {
    if !WRITE_METHODS.contains(&method.as_str()) {
        return Err(format!("{method} is not a write"));
    }
    if !path.starts_with("/api/") {
        return Err("a write's path must start with /api/".into());
    }
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);
    let mut req = json!({ "id": id, "method": method, "path": path });
    if !body.is_null() {
        req["body"] = body;
    }
    {
        let mut guard = state.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("AnviDeck's server has stopped")?;
        writeln!(stdin, "{req}").and_then(|_| stdin.flush()).map_err(|e| {
            state.pending.lock().unwrap().remove(&id);
            format!("could not reach AnviDeck's server: {e}")
        })?;
    }
    // A write can take long (a merge waits on GitHub); the sidecar answers every request it reads.
    rx.await.map_err(|_| "AnviDeck's server stopped before answering".to_string())
}

fn sidecar_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ANVIDECK_SIDECAR") {
        return p.into();
    }
    // Bundled and `tauri dev` both put the externalBin next to the app's own executable.
    let exe = std::env::current_exe().expect("no current exe");
    exe.parent().expect("exe has no folder").join("anvideck-server")
}

fn main() {
    let spawned = Command::new(sidecar_path())
        .env("ANVIDECK_DESKTOP", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn();
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let handle: Arc<OnceLock<AppHandle>> = Arc::new(OnceLock::new());
    // Why the server is not there, when it is not: shown in the window instead of the screens.
    let gone: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let (ready_tx, ready_rx) = mpsc::channel::<u16>();
    let mut stdin = None;

    match spawned {
        Err(e) => {
            *gone.lock().unwrap() = Some(format!("AnviDeck's server could not start ({e}). Nothing on this screen can load; reinstall or rebuild the app."));
        }
        Ok(mut c) => {
            stdin = c.stdin.take();
            let stdout = c.stdout.take().expect("sidecar stdout");
            *child.lock().unwrap() = Some(c);
            let (pend, kid, app, why) = (pending.clone(), child.clone(), handle.clone(), gone.clone());
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Some(rest) = line.strip_prefix(RS) else {
                        println!("[server] {line}");
                        continue;
                    };
                    if let Some(j) = rest.strip_prefix("ANVIDECK-READY ") {
                        if let Some(port) = serde_json::from_str::<Value>(j).ok().and_then(|v| v["port"].as_u64()) {
                            let _ = ready_tx.send(port as u16);
                        }
                    } else if let Some(j) = rest.strip_prefix("ANVIDECK-REPLY ") {
                        if let Ok(v) = serde_json::from_str::<Value>(j) {
                            if let Some(id) = v["id"].as_u64() {
                                if let Some(tx) = pend.lock().unwrap().remove(&id) {
                                    let _ = tx.send(json!({ "status": v["status"], "body": v["body"] }));
                                }
                            }
                        }
                    }
                }
                // stdout closed: the sidecar is gone. Fail every write still waiting, and say so.
                pend.lock().unwrap().clear();
                let mut code = None;
                for _ in 0..20 {
                    if let Some(c) = kid.lock().unwrap().as_mut() {
                        if let Ok(Some(st)) = c.try_wait() {
                            code = Some(st.code().map_or("killed by a signal".to_string(), |n| format!("exit code {n}")));
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                let msg = format!(
                    "AnviDeck's server stopped ({}). Screens will not update and actions will not go through; quit and reopen AnviDeck.",
                    code.unwrap_or_else(|| "still exiting".into())
                );
                eprintln!("[anvideck] {msg}");
                *why.lock().unwrap() = Some(msg.clone());
                if let Some(app) = app.get() {
                    say_server_gone(app, &msg);
                }
            });
        }
    }

    // Without a port there is nothing to read from; the window still opens and says why.
    let port = if gone.lock().unwrap().is_some() {
        0
    } else {
        match ready_rx.recv_timeout(Duration::from_secs(60)) {
            Ok(p) => p,
            Err(_) => {
                let mut g = gone.lock().unwrap();
                if g.is_none() {
                    *g = Some("AnviDeck's server did not report its port within 60 s. Quit and reopen AnviDeck.".into());
                }
                0
            }
        }
    };

    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let app = builder
        .manage(Sidecar {
            stdin: Mutex::new(stdin),
            child: child.clone(),
            pending,
            next_id: AtomicU64::new(1),
        })
        .invoke_handler(tauri::generate_handler![write])
        .setup(move |app| {
            let _ = handle.set(app.handle().clone());
            let mut init = String::new();
            if port != 0 {
                init.push_str(&format!("window.__ANVIDECK_ORIGIN__ = 'http://127.0.0.1:{port}';"));
            }
            // Already gone before the window opened: say so as soon as the page has loaded.
            if let Some(msg) = gone.lock().unwrap().clone() {
                init.push_str(&format!("window.addEventListener('DOMContentLoaded', function(){{{}}});", banner_js(&msg)));
            }
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AnviDeck")
                .inner_size(1440.0, 900.0)
                .initialization_script(&init)
                .on_navigation(|url| {
                    if is_own_page(url) {
                        return true;
                    }
                    open_outside(url);
                    false
                })
                .on_new_window(|url, _| {
                    open_outside(&url);
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AnviDeck");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let s = handle.state::<Sidecar>();
            // Closing stdin tells the sidecar to stop its agents and exit; kill it if it lingers.
            s.stdin.lock().unwrap().take();
            let taken = s.child.lock().unwrap().take();
            if let Some(mut c) = taken {
                for _ in 0..30 {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    });
}
