// Desktop wrapper: runs the PourGateLLM gateway as a hidden child process and shows its dashboard in a
// native window. On Windows the installer ships its own Node.js runtime; elsewhere `node` (22.13+) is used.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const PORT: &str = "43117";

struct Server(Mutex<Option<Child>>);

struct FirstRun {
    password: String,
    token: String,
}

/// Creates `<data>/.env` on first launch with a random admin password and token.
/// Returns the environment to pass to the gateway, and the credentials when they were just created.
fn ensure_env(data: &Path) -> std::io::Result<(Vec<(String, String)>, Option<FirstRun>)> {
    fs::create_dir_all(data)?;
    let path = data.join(".env");
    let mut first = None;
    if !path.exists() {
        let password = uuid::Uuid::new_v4().simple().to_string();
        let token = format!("pg-{}", uuid::Uuid::new_v4().simple());
        fs::write(
            &path,
            format!(
                "# PourGateLLM settings. Add provider keys (e.g. GROQ_API_KEYS=...) here or in the dashboard, then restart the app.\nPOURGATE_ADMIN_PASSWORD={password}\nPOURGATE_TOKENS={token}\n"
            ),
        )?;
        first = Some(FirstRun { password, token });
    }
    let text = fs::read_to_string(&path)?;
    let envs = text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Ok((envs, first))
}

/// The bundled runtime when the installer shipped one, otherwise whatever `node` is on PATH.
fn node_binary(resources: &Path) -> PathBuf {
    let bundled = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("server");
            let data = app.path().app_data_dir()?;
            let (envs, first) = ensure_env(&data)?;
            let log_path = data.join("gateway.log");
            let log = File::create(&log_path)?;

            let mut cmd = Command::new(node_binary(&resources));
            cmd.args(["--no-warnings", "dist/index.js"])
                .current_dir(&resources)
                .envs(envs)
                .env("PORT", PORT)
                .env("POURGATE_DB", data.join("pourgate.db"))
                .env("POURGATE_STATIC_DIR", resources.join("public"))
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone()?))
                .stderr(Stdio::from(log));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
            }
            // A failure to start is shown by the loading page (it times out); the log has the reason.
            if let Ok(child) = cmd.spawn() {
                app.manage(Server(Mutex::new(Some(child))));
            }

            // Hand the first-run credentials and the log location to the loading page. The script only
            // defines them for the local app page, never for the gateway's own origin.
            let info = serde_json::json!({
                "firstRun": first.is_some(),
                "password": first.as_ref().map(|f| f.password.clone()),
                "token": first.as_ref().map(|f| f.token.clone()),
                "logPath": log_path.display().to_string(),
                "port": PORT,
            });
            let script = format!("if (location.port !== '{PORT}') window.__PG__ = {info};");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("PourGateLLM")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 560.0)
                .initialization_script(&script)
                .build()?;
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
