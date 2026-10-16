//! Optional status icon in the macOS menu bar / Windows notification area.
//! Off by default. It shows how many threads are working or waiting for
//! approval and brings the main window forward; it does not change how the
//! app quits or keep runs alive after the window closes.
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, Wry,
};

const TRAY_ID: &str = "mythra-status";

#[derive(Default)]
pub(crate) struct TrayState {
    status_item: Mutex<Option<MenuItem<Wry>>>,
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn status_text(working: u32, approvals: u32) -> String {
    let working_text = match working {
        0 => "No threads working".to_string(),
        1 => "1 thread working".to_string(),
        count => format!("{count} threads working"),
    };
    match approvals {
        0 => working_text,
        1 => format!("{working_text} · 1 waiting for approval"),
        count => format!("{working_text} · {count} waiting for approval"),
    }
}

#[tauri::command]
pub(crate) fn tray_configure(app: AppHandle, state: State<'_, TrayState>, enabled: bool) -> Result<(), String> {
    let mut status_item = state.status_item.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !enabled {
        status_item.take();
        let _ = app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    if status_item.is_some() && app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let status = MenuItem::with_id(&app, "tray-status", status_text(0, 0), false, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|error| error.to_string())?;
    let show = MenuItem::with_id(&app, "tray-show", "Show Mythra Code", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(&app, &[&status, &separator, &show]).map_err(|error| error.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Mythra Code")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "tray-show" {
                show_main_window(app);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Windows: a left click opens the app; the menu stays on the right
            // button. macOS shows the menu on click, which includes Show.
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !cfg!(target_os = "macos") {
                    show_main_window(tray.app_handle());
                }
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    if !cfg!(target_os = "macos") {
        builder = builder.show_menu_on_left_click(false);
    }
    builder.build(&app).map_err(|error| error.to_string())?;
    *status_item = Some(status);
    Ok(())
}

#[tauri::command]
pub(crate) fn tray_status(app: AppHandle, state: State<'_, TrayState>, working: u32, approvals: u32) -> Result<(), String> {
    let status_item = state.status_item.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(item) = status_item.as_ref() else {
        return Ok(());
    };
    let text = status_text(working, approvals);
    item.set_text(&text).map_err(|error| error.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Mythra Code · {text}")));
    }
    Ok(())
}
