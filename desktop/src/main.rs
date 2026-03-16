// Prevents additional console window on Windows (not relevant for Linux/macOS but good practice)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod speech;

use std::process::Command;
use std::sync::{Arc, Mutex};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::WebviewWindowBuilder,
    Manager,
    WindowEvent,
};

/// Resolve the hivecommand CLI path by following symlinks
fn hivecommand_cli_path() -> String {
    // Try readlink -f on the standard install path
    if let Ok(output) = Command::new("readlink")
        .args(["-f", "/usr/local/bin/hivecommand"])
        .output()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() && std::path::Path::new(&path).exists() {
            return path;
        }
    }
    // Fallback: check ~/.local/bin
    if let Ok(home) = std::env::var("HOME") {
        let local_path = format!("{}/.local/bin/hivecommand", home);
        if std::path::Path::new(&local_path).exists() {
            return local_path;
        }
    }
    // Last resort: rely on PATH
    "hivecommand".to_string()
}

/// Check if HiveCommand server is currently running
fn is_server_running(cli: &str) -> bool {
    // Check PID file approach: resolve install dir from CLI, check .hivecommand.pid
    if let Ok(output) = Command::new(cli).arg("status").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        return stdout.contains("running");
    }
    false
}

/// Check if the systemd/launchd service is installed
fn is_service_installed() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/etc/systemd/system/hivecommand.service").exists()
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::Path::new(&format!(
                "{}/Library/LaunchAgents/com.aigenius.hivecommand.plist",
                home
            ))
            .exists();
        }
        false
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

fn main() {
    let cli_path = hivecommand_cli_path();
    let cli_path_arc = Arc::new(cli_path);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(speech::SpeechState::new())
        .invoke_handler(tauri::generate_handler![
            speech::stt_check_model,
            speech::stt_list_models,
            speech::stt_set_model,
            speech::stt_download_model,
            speech::stt_start,
            speech::stt_stop,
            speech::stt_unload_model,
            speech::stt_status,
            speech::stt_list_devices,
            speech::stt_set_device,
        ])
        .setup(move |app| {
            let cli = cli_path_arc.clone();

            // Create main window programmatically
            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External("http://localhost:42010".parse().unwrap()),
            )
            .title("HiveCommand")
            .inner_size(1400.0, 900.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .visible(true)
            .build()?;

            // Determine initial state
            let running = is_server_running(&cli);
            let service_installed = is_service_installed();

            // Build tray menu items
            let show = MenuItemBuilder::with_id("show", "Open Dashboard").build(app)?;

            let status_text = if running { "Status: Running" } else { "Status: Stopped" };
            let status = MenuItemBuilder::with_id("status", status_text)
                .enabled(false)
                .build(app)?;

            let separator1 = tauri::menu::PredefinedMenuItem::separator(app)?;

            let start_item = MenuItemBuilder::with_id("start", "Start Server")
                .enabled(!running)
                .build(app)?;
            let stop_item = MenuItemBuilder::with_id("stop", "Stop Server")
                .enabled(running)
                .build(app)?;

            let separator2 = tauri::menu::PredefinedMenuItem::separator(app)?;

            let service_label = if service_installed {
                "Uninstall Service (auto-start)"
            } else {
                "Install Service (auto-start)"
            };
            let service_item = MenuItemBuilder::with_id("service_toggle", service_label)
                .build(app)?;

            let separator3 = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show)
                .item(&status)
                .item(&separator1)
                .item(&start_item)
                .item(&stop_item)
                .item(&separator2)
                .item(&service_item)
                .item(&separator3)
                .item(&quit)
                .build()?;

            // Shared state for updating menu items
            let status_item = Arc::new(Mutex::new(status));
            let start_item = Arc::new(Mutex::new(start_item));
            let stop_item = Arc::new(Mutex::new(stop_item));
            let service_item = Arc::new(Mutex::new(service_item));

            // Clone refs for the menu event handler
            let cli_menu = cli.clone();
            let status_ref = status_item.clone();
            let start_ref = start_item.clone();
            let stop_ref = stop_item.clone();
            let service_ref = service_item.clone();

            // Build tray icon.
            // On Linux, libappindicator always shows the menu on any click
            // (menu_on_left_click is unsupported). So we keep the menu attached
            // and put "Open Dashboard" as the top item for easy access.
            // On macOS, left-click opens the window directly, right-click shows menu.
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("HiveCommand")
                .menu(&menu)
                .show_menu_on_left_click(false) // Works on macOS, no-op on Linux
                .on_menu_event(move |app, event| {
                    let cli = cli_menu.clone();
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "start" => {
                            let status_ref = status_ref.clone();
                            let start_ref = start_ref.clone();
                            let stop_ref = stop_ref.clone();
                            std::thread::spawn(move || {
                                let _ = Command::new(cli.as_str())
                                    .arg("start")
                                    .stdout(std::process::Stdio::null())
                                    .stderr(std::process::Stdio::null())
                                    .status();
                                // Update menu state
                                if let Ok(s) = status_ref.lock() {
                                    let _ = s.set_text("Status: Running");
                                }
                                if let Ok(s) = start_ref.lock() {
                                    let _ = s.set_enabled(false);
                                }
                                if let Ok(s) = stop_ref.lock() {
                                    let _ = s.set_enabled(true);
                                }
                            });
                        }
                        "stop" => {
                            let status_ref = status_ref.clone();
                            let start_ref = start_ref.clone();
                            let stop_ref = stop_ref.clone();
                            std::thread::spawn(move || {
                                let _ = Command::new(cli.as_str())
                                    .arg("stop")
                                    .stdout(std::process::Stdio::null())
                                    .stderr(std::process::Stdio::null())
                                    .status();
                                if let Ok(s) = status_ref.lock() {
                                    let _ = s.set_text("Status: Stopped");
                                }
                                if let Ok(s) = start_ref.lock() {
                                    let _ = s.set_enabled(true);
                                }
                                if let Ok(s) = stop_ref.lock() {
                                    let _ = s.set_enabled(false);
                                }
                            });
                        }
                        "service_toggle" => {
                            let service_ref = service_ref.clone();
                            std::thread::spawn(move || {
                                let installed = is_service_installed();
                                let cmd = if installed {
                                    "uninstall-service"
                                } else {
                                    "install-service"
                                };
                                // Service install/uninstall needs root on Linux (systemd).
                                // Use pkexec for a graphical sudo prompt since there's no terminal.
                                // On macOS, launchd operates in user space (no sudo needed).
                                let result = if cfg!(target_os = "linux") {
                                    Command::new("pkexec")
                                        .args([cli.as_str(), cmd])
                                        .stdout(std::process::Stdio::null())
                                        .stderr(std::process::Stdio::null())
                                        .status()
                                } else {
                                    Command::new(cli.as_str())
                                        .arg(cmd)
                                        .stdout(std::process::Stdio::null())
                                        .stderr(std::process::Stdio::null())
                                        .status()
                                };
                                let _ = result;
                                // Update label based on new state
                                let now_installed = is_service_installed();
                                let label = if now_installed {
                                    "Uninstall Service (auto-start)"
                                } else {
                                    "Install Service (auto-start)"
                                };
                                if let Ok(s) = service_ref.lock() {
                                    let _ = s.set_text(label);
                                }
                            });
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // On macOS this fires for left-click (menu_on_left_click=false).
                    // On Linux this doesn't fire (libappindicator handles all clicks).
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Start inactivity watcher to auto-unload whisper model after 5 min idle
            speech::start_inactivity_watcher(app.handle().clone());

            Ok(())
        })
        // Intercept window close: hide to tray instead of quitting
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running HiveCommand desktop app");
}
