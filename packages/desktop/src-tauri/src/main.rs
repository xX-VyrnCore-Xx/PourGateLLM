// Experimental desktop wrapper: runs the PourGateLLM server as a child process
// (requires Node 22.13+ on PATH) and shows its dashboard in a native window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::Path,
    process::{Child, Command},
    sync::Mutex,
};
use tauri::{Manager, RunEvent};

const PORT: &str = "43117";

struct Server(Mutex<Option<Child>>);

/// Creates `<data>/.env` on first launch with a random admin password and token.
fn ensure_env(data: &Path) -> std::io::Result<Vec<(String, String)>> {
    fs::create_dir_all(data)?;
    let path = data.join(".env");
    if !path.exists() {
        let password = uuid::Uuid::new_v4().simple().to_string();
        let token = format!("pg-{}", uuid::Uuid::new_v4().simple());
        fs::write(
            &path,
            format!(
                "# Edit this file to add provider keys (e.g. GROQ_API_KEYS=...) and restart the app.\nPOURGATE_ADMIN_PASSWORD={password}\nPOURGATE_TOKENS={token}\n"
            ),
        )?;
    }
    let text = fs::read_to_string(&path)?;
    Ok(text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect())
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("server");
            let data = app.path().app_data_dir()?;
            let envs = ensure_env(&data)?;
            let child = Command::new("node")
                .args(["--no-warnings", "dist/index.js"])
                .current_dir(&resources)
                .envs(envs)
                .env("PORT", PORT)
                .env("POURGATE_DB", data.join("pourgate.db"))
                .env("POURGATE_STATIC_DIR", resources.join("public"))
                .spawn()?;
            app.manage(Server(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(server) = handle.try_state::<Server>() {
                if let Some(mut child) = server.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
