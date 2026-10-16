// Desktop wrapper: runs the PourGateLLM gateway as a hidden child process and shows its dashboard in a
// native window. On Windows the installer ships its own Node.js runtime; elsewhere `node` (22.13+) is used.
//
// The app lives in the system tray: closing the window hides it, and "Quit" in the tray menu stops the
// gateway and exits (which also lets the uninstaller replace the files).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, File, OpenOptions},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_opener::OpenerExt as _;

const PREFERRED_PORT: u16 = 43117;
const MAIN: &str = "main";

/// The gateway child process plus what is needed to start it again.
struct Gateway {
    child: Mutex<Option<Child>>,
    port: u16,
    resources: PathBuf,
    data: PathBuf,
    envs: Mutex<Vec<(String, String)>>,
    #[cfg(windows)]
    job: Option<job::Job>,
}

struct FirstRun {
    password: String,
    token: String,
}

/// Windows job object: when the app dies for any reason (crash, Task Manager, uninstaller), the OS ends the
/// gateway with it, so no orphaned node.exe can keep the install folder locked.
#[cfg(windows)]
mod job {
    use std::{ffi::c_void, mem, os::windows::io::AsRawHandle, process::Child, ptr};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct Job(HANDLE);
    // The handle is only used to assign processes and is closed with the process.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    pub fn create() -> Option<Job> {
        unsafe {
            let handle = CreateJobObjectW(ptr::null(), ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                return None;
            }
            Some(Job(handle))
        }
    }

    impl Job {
        pub fn assign(&self, child: &Child) {
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }
    }
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
                "# PourGateLLM settings. Add provider keys (e.g. GROQ_API_KEYS=...) here or in the dashboard, then restart the gateway from the tray menu.\nPOURGATE_ADMIN_PASSWORD={password}\nPOURGATE_TOKENS={token}\n"
            ),
        )?;
        first = Some(FirstRun { password, token });
    }
    Ok((read_env(&path)?, first))
}

fn read_env(path: &Path) -> std::io::Result<Vec<(String, String)>> {
    let text = fs::read_to_string(path)?;
    Ok(text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect())
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

/// 43117 when it is free; otherwise any free port, so a second copy or a stale process cannot block startup.
fn pick_port() -> u16 {
    for candidate in [PREFERRED_PORT, 0] {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", candidate)) {
            if let Ok(addr) = listener.local_addr() {
                return addr.port();
            }
        }
    }
    PREFERRED_PORT
}

fn spawn_gateway(gw: &Gateway) -> Option<Child> {
    // Append so a restart keeps the earlier lines; the session start truncates the file.
    let log = OpenOptions::new().create(true).append(true).open(gw.data.join("gateway.log")).ok()?;
    let mut cmd = Command::new(node_binary(&gw.resources));
    cmd.args(["--no-warnings", "dist/index.js"])
        .current_dir(&gw.resources)
        .envs(gw.envs.lock().unwrap().iter().cloned())
        .env("PORT", gw.port.to_string())
        .env("POURGATE_DB", gw.data.join("pourgate.db"))
        .env("POURGATE_STATIC_DIR", gw.resources.join("public"))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().ok()?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    let child = cmd.spawn().ok()?;
    #[cfg(windows)]
    if let Some(job) = &gw.job {
        job.assign(&child);
    }
    Some(child)
}

fn stop_gateway(gw: &Gateway) {
    if let Some(mut child) = gw.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn restart_gateway(app: &AppHandle) {
    let gw = app.state::<Gateway>();
    stop_gateway(&gw);
    // Settings may have been edited since the last start.
    if let Ok(envs) = read_env(&gw.data.join(".env")) {
        *gw.envs.lock().unwrap() = envs;
    }
    if let Some(child) = spawn_gateway(&gw) {
        *gw.child.lock().unwrap() = Some(child);
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_url(app: &AppHandle, url: &str) {
    let _ = app.opener().open_url(url, None::<&str>);
}

fn open_path(app: &AppHandle, path: &Path) {
    let _ = app.opener().open_path(path.display().to_string(), None::<&str>);
}

struct Labels {
    open: &'static str,
    browser: &'static str,
    data: &'static str,
    log: &'static str,
    restart: &'static str,
    autostart: &'static str,
    quit: &'static str,
}

fn labels() -> Labels {
    let italian = sys_locale::get_locale().map(|l| l.to_lowercase().starts_with("it")).unwrap_or(false);
    if italian {
        Labels {
            open: "Apri PourGateLLM",
            browser: "Apri la dashboard nel browser",
            data: "Apri la cartella dei dati",
            log: "Apri il file di log",
            restart: "Riavvia il gateway",
            autostart: "Avvia con Windows",
            quit: "Esci e chiudi il gateway",
        }
    } else {
        Labels {
            open: "Open PourGateLLM",
            browser: "Open the dashboard in the browser",
            data: "Open the data folder",
            log: "Open the log file",
            restart: "Restart the gateway",
            autostart: "Start with the system",
            quit: "Quit and stop the gateway",
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let l = labels();
    let open = MenuItem::with_id(app, "open", l.open, true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", l.browser, true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", l.data, true, None::<&str>)?;
    let log = MenuItem::with_id(app, "log", l.log, true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", l.restart, true, None::<&str>)?;
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", l.autostart, true, enabled, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", l.quit, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &browser, &sep1, &data, &log, &restart, &autostart, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("PourGateLLM")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "browser" => {
                let port = app.state::<Gateway>().port;
                open_url(app, &format!("http://127.0.0.1:{port}"));
            }
            "data" => {
                let data = app.state::<Gateway>().data.clone();
                open_path(app, &data);
            }
            "log" => {
                let log = app.state::<Gateway>().data.join("gateway.log");
                open_path(app, &log);
            }
            "restart" => restart_gateway(app),
            "autostart" => {
                let manager = app.autolaunch();
                let _ = if manager.is_enabled().unwrap_or(false) { manager.disable() } else { manager.enable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    let app = tauri::Builder::default()
        // A second launch only brings the running instance forward (it would otherwise fight over the port).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let resources = app.path().resource_dir()?.join("server");
            let data = app.path().app_data_dir()?;
            let (envs, first) = ensure_env(&data)?;
            let log_path = data.join("gateway.log");
            File::create(&log_path)?; // fresh log per session

            let port = pick_port();
            let gateway = Gateway {
                child: Mutex::new(None),
                port,
                resources,
                data: data.clone(),
                envs: Mutex::new(envs),
                #[cfg(windows)]
                job: job::create(),
            };
            // A failure to start is shown by the loading page (it times out); the log has the reason.
            if let Some(child) = spawn_gateway(&gateway) {
                *gateway.child.lock().unwrap() = Some(child);
            }
            app.manage(gateway);

            // Hand the first-run credentials and the log location to the loading page. The script only
            // defines them for the local app page, never for the gateway's own origin.
            let info = serde_json::json!({
                "firstRun": first.is_some(),
                "password": first.as_ref().map(|f| f.password.clone()),
                "token": first.as_ref().map(|f| f.token.clone()),
                "logPath": log_path.display().to_string(),
                "port": port.to_string(),
            });
            let script = format!("if (location.port !== '{port}') window.__PG__ = {info};");
            let window: WebviewWindow = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
                .title("PourGateLLM")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 560.0)
                .visible(!hidden || first.is_some())
                .initialization_script(&script)
                .build()?;
            // Closing the window keeps the gateway running in the tray; only "Quit" stops it.
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = handle.hide();
                }
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(gw) = handle.try_state::<Gateway>() {
                stop_gateway(&gw);
            }
        }
    });
}
