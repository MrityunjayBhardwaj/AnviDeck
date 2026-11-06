//! AnviDeck desktop app (#239, spike).
//!
//! Starts the Bun server as a sidecar with private stdin/stdout pipes, waits for it to say which
//! loopback port serves reads, opens the window on the UI bundled in the app, and carries the
//! window's writes to the sidecar over its stdin. No write is reachable on any port.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

const RS: char = '\u{1e}';
const WRITE_METHODS: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Pending,
    next_id: AtomicU64,
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
    let mut child = Command::new(sidecar_path())
        .env("ANVIDECK_DESKTOP", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("could not start AnviDeck's server (sidecar)");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("sidecar stdout");
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let (ready_tx, ready_rx) = mpsc::channel::<u16>();

    let pend = pending.clone();
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
        // stdout closed: the sidecar is gone. Fail every write still waiting.
        pend.lock().unwrap().clear();
    });

    let port = ready_rx
        .recv_timeout(Duration::from_secs(60))
        .expect("AnviDeck's server did not report its port within 60 s");

    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let app = builder
        .manage(Sidecar {
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            pending,
            next_id: AtomicU64::new(1),
        })
        .invoke_handler(tauri::generate_handler![write])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("AnviDeck")
                .inner_size(1440.0, 900.0)
                .initialization_script(&format!("window.__ANVIDECK_ORIGIN__ = 'http://127.0.0.1:{port}';"))
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
