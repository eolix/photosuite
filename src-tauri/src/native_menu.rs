//! macOS menu bar renderer: builds native menus from the webview JSON spec.
//!
//! Application commands are defined in `src/ui/menu/menu-bar-data.js` (see `src/ui/menu/README.md`).
//! This crate maps `path` indices to `photosuite:menu-action` events; it does not own menu content
//! except the macOS App submenu (About, Services, Hide, Quit) and a Preferences shortcut at path `[1, 18]`.
//! Quit is routed through the webview via `photosuite:quit-requested` so unsaved work is prompted for.

use serde::Deserialize;
use serde_json::json;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder,
};
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const CHROME_EVENT: &str = "photosuite:chrome";
const MENU_ACTION_EVENT: &str = "photosuite:menu-action";
const QUIT_REQUEST_EVENT: &str = "photosuite:quit-requested";

/// Menu id of the macOS App submenu Quit row. It routes through the webview so
/// the unsaved-work prompt runs before the process ends.
const QUIT_MENU_ID: &str = "ps/app/quit";

/// Display name for the App submenu and its About / Hide / Quit rows. Reads the
/// configured product name so the menu shows "PhotoSuite", not the crate name.
fn product_name<R: Runtime, M: Manager<R>>(app: &M) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone())
}

/// Ask the webview to start a quit: it prompts for unsaved work and calls the
/// `photosuite_exit_app` command once the user confirms. Returns false when the
/// webview could not be reached, so callers can fall back to closing outright.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) -> bool {
    match app.get_webview_window("main") {
        Some(win) => win.emit(QUIT_REQUEST_EVENT, json!({})).is_ok(),
        None => false,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuItemSpec {
    label: String,
    #[serde(default)]
    path: Vec<u32>,
    #[serde(default)]
    submenu: Vec<NativeMenuItemSpec>,
    accelerator: Option<String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    checked: Option<bool>,
    #[serde(default)]
    separator_after: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct NativeMenuTopSpec {
    pub title: String,
    pub items: Vec<NativeMenuItemSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuInstallSpec {
    pub menus: Vec<NativeMenuTopSpec>,
    #[serde(default)]
    pub hide_html_menu_bar: bool,
}

fn path_item<R: Runtime, M: Manager<R>>(
    app: &M,
    path: &[u32],
    label: &str,
    accelerator: Option<&str>,
    enabled: bool,
) -> tauri::Result<MenuItem<R>> {
    let id = format!(
        "ps/menu/{}",
        path.iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("/")
    );
    let mut builder = MenuItemBuilder::with_id(id, label).enabled(enabled);
    if let Some(accel) = accelerator {
        builder = builder.accelerator(accel);
    }
    builder.build(app)
}

fn path_check_item<R: Runtime, M: Manager<R>>(
    app: &M,
    path: &[u32],
    label: &str,
    accelerator: Option<&str>,
    enabled: bool,
    checked: bool,
) -> tauri::Result<CheckMenuItem<R>> {
    let id = format!(
        "ps/menu/{}",
        path.iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("/")
    );
    let mut builder = CheckMenuItemBuilder::with_id(id, label)
        .enabled(enabled)
        .checked(checked);
    if let Some(accel) = accelerator {
        builder = builder.accelerator(accel);
    }
    builder.build(app)
}

fn emit_menu_path<R: Runtime>(app: &AppHandle<R>, path: Vec<u32>) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("main") {
        win.emit(
            MENU_ACTION_EVENT,
            json!({
                "path": path
            }),
        )?;
    }
    Ok(())
}

fn dispatch_menu_id<R: Runtime>(app: &AppHandle<R>, raw_id: &str) -> tauri::Result<()> {
    if raw_id == QUIT_MENU_ID {
        request_quit(app);
        return Ok(());
    }
    const PREFIX: &str = "ps/menu/";
    if !raw_id.starts_with(PREFIX) {
        return Ok(());
    }
    let tail = &raw_id[PREFIX.len()..];
    let mut path = Vec::new();
    for part in tail.split('/') {
        if part.is_empty() {
            continue;
        }
        if let Ok(n) = part.parse::<u32>() {
            path.push(n);
        } else {
            return Ok(());
        }
    }
    if path.len() >= 2 {
        emit_menu_path(app, path)?;
    }
    Ok(())
}

fn append_items<'a, R: Runtime, M: Manager<R>>(
    app: &'a M,
    mut builder: SubmenuBuilder<'a, R, M>,
    items: &'a [NativeMenuItemSpec],
) -> tauri::Result<SubmenuBuilder<'a, R, M>> {
    for item in items {
        if !item.path.is_empty() {
            if let Some(checked) = item.checked {
                let menu_item = path_check_item(
                    app,
                    &item.path,
                    &item.label,
                    item.accelerator.as_deref(),
                    item.enabled,
                    checked,
                )?;
                builder = builder.item(&menu_item);
            } else {
                let menu_item = path_item(
                    app,
                    &item.path,
                    &item.label,
                    item.accelerator.as_deref(),
                    item.enabled,
                )?;
                builder = builder.item(&menu_item);
            }
        } else if !item.submenu.is_empty() {
            let nested = append_items(
                app,
                SubmenuBuilder::new(app, item.label.as_str()).enabled(item.enabled),
                &item.submenu,
            )?
            .build()?;
            builder = builder.item(&nested);
        }
        if item.separator_after {
            builder = builder.separator();
        }
    }
    Ok(builder)
}

#[cfg(target_os = "macos")]
fn build_app_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<tauri::menu::Submenu<R>> {
    let app_name = product_name(app);
    let quit_item = MenuItemBuilder::with_id(QUIT_MENU_ID, format!("Quit {app_name}"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    SubmenuBuilder::new(app, app_name.as_str())
        .item(&PredefinedMenuItem::about(
            app,
            Some(&format!("About {app_name}")),
            None,
        )?)
        .separator()
        .item(&path_item(
            app,
            &[1, 18],
            "Preferences…",
            Some("CmdOrCtrl+,"),
            true,
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("Services"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some(&format!("Hide {app_name}")))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("Hide Others"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("Show All"))?)
        .separator()
        .item(&quit_item)
        .build()
}

#[cfg(target_os = "macos")]
pub fn install_native_menus_from_spec<R: Runtime>(
    app: &AppHandle<R>,
    spec: NativeMenuInstallSpec,
) -> tauri::Result<()> {
    let app_menu = build_app_submenu(app)?;
    let mut top_refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![&app_menu];

    let mut owned_submenus = Vec::new();
    for top in &spec.menus {
        let submenu = append_items(
            app,
            SubmenuBuilder::new(app, top.title.as_str()),
            &top.items,
        )?
        .build()?;
        owned_submenus.push(submenu);
    }
    for submenu in &owned_submenus {
        top_refs.push(submenu);
    }

    let menu = MenuBuilder::new(app).items(&top_refs).build()?;
    app.set_menu(menu)?;

    if spec.hide_html_menu_bar {
        let payload = json!({ "hideHtmlMenuBar": true });
        for (_, win) in app.webview_windows() {
            let _ = win.emit(CHROME_EVENT, payload.clone());
        }
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install_native_menus_from_spec<R: Runtime>(
    _app: &AppHandle<R>,
    _spec: NativeMenuInstallSpec,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install_native_menus<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

pub fn handle_menu_activation<R: Runtime>(app: &AppHandle<R>, event: &tauri::menu::MenuEvent) {
    let raw = event.id().as_ref();
    if let Err(err) = dispatch_menu_id(app, raw) {
        eprintln!("photosuite: menu dispatch failed: {err}");
    }
}
