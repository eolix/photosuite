mod native_menu;
mod printing;
mod sidebar_plugins;
mod user_resources;

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_store::{JsonValue, StoreExt};

const SETTINGS_STORE: &str = "settings.json";

/// Starting folder for the native open dialog on Linux.
/// Without this, rfd/xdg-desktop-portal often opens the "Recent Files" view, which
/// lists OAuth login URLs from ~/.local/share/recently-used.xbel as if they were
/// files (signup, loginDeepControl, authorize, …) and triggers GLib-GIO-CRITICAL
/// warnings when their size is queried.
fn default_open_directory() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_PICTURES_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return path;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let pictures = PathBuf::from(&home).join("Pictures");
        if pictures.is_dir() {
            return pictures;
        }
        let home_path = PathBuf::from(home);
        if home_path.is_dir() {
            return home_path;
        }
    }
    PathBuf::from("/")
}

/// Reads a remembered folder from the settings store (e.g. "lastOpenDirectory"),
/// returning it only if it still exists on disk.
fn stored_directory(app: &tauri::AppHandle, key: &str) -> Option<PathBuf> {
    if let Ok(store) = app.store(SETTINGS_STORE) {
        if let Some(JsonValue::Object(filesystem)) = store.get("filesystem") {
            if let Some(JsonValue::String(dir)) = filesystem.get(key) {
                let path = PathBuf::from(dir);
                if path.is_dir() {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn open_directory_for_dialog(app: &tauri::AppHandle) -> PathBuf {
    stored_directory(app, "lastOpenDirectory").unwrap_or_else(default_open_directory)
}

/// Persists a folder under `key` in the settings store so the matching dialog
/// reopens there next time.
fn persist_directory(app: &tauri::AppHandle, key: &str, directory: &Path) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    let mut filesystem = store
        .get("filesystem")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    filesystem.insert(
        key.into(),
        JsonValue::String(directory.to_string_lossy().into_owned()),
    );
    store.set("filesystem", JsonValue::Object(filesystem));
    store.save().map_err(|e| e.to_string())
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            CHARS[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            CHARS[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

const IMAGE_OPEN_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "psd", "psb", "svg", "xcf",
    "pdf",
    "ai", "sketch", "xd", "fig", "ora", "clip", "exr", "hdr", "ico",
    // affinity (designer / photo / publisher)
    "af", "afdesign", "afphoto", "afpub", "aftemplate",
    // vector / document formats
    "dxf", "emf", "wmf", "eps", "ps", "cdr",
    // additional raster formats
    "dds", "tga", "ppm", "pgm", "pbm", "pnm", "lif", "fits", "fit", "fts",
    // camera RAW (TIFF-wrapped or vendor; `.raw` is headerless dump → Import Raw)
    "raf", "cr2", "cr3", "crw", "nef", "nrw", "arw", "dng", "orf", "rw2", "pef", "srw", "raw",
    // amiga iff / ilbm
    "iff", "lbm",
];

/// Wire extension filters for the native open dialog.
///
/// **Image open** (File → Open): list supported image/document extensions.
///
/// **Preset / resource import** (brushes, swatches, fonts, …): no filters.
/// rfd maps an empty filter list to “all files” on every desktop backend
/// (Windows `*.*`, GTK with no patterns, NSOpenPanel without allowed types,
/// XDG portal with no MIME/extension filter). Do not use `add_filter(…, &["*"])`
/// for that case — on macOS `*` is not a valid UTType and the panel greys out
/// every row; on GTK `*.` is not a useful pattern either.
fn apply_open_dialog_filters(
    dialog: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
    images_only: bool,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    if images_only {
        dialog
            .set_title("Open Image")
            .add_filter("Images", IMAGE_OPEN_EXTENSIONS)
            .add_filter("All files", &["*"])
    } else {
        dialog.set_title("Open")
    }
}

/// Native multi-file picker. When `images_only` is true (File → Open), the dialog
/// defaults to supported image/document extensions. Otherwise every file is selectable
/// (brush libraries, swatches, fonts, actions, …).
#[tauri::command]
async fn open_files(
    app: tauri::AppHandle,
    images_only: Option<bool>,
) -> Result<Vec<serde_json::Value>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<tauri_plugin_fs::FilePath>>>();
    let start_directory = open_directory_for_dialog(&app);
    let images_only = images_only.unwrap_or(false);

    let dialog = apply_open_dialog_filters(
        app.dialog().file().set_directory(start_directory),
        images_only,
    );
    dialog.pick_files(move |paths| {
        let _ = tx.send(paths);
    });

    let paths = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let file_paths = match paths {
        Some(p) => p,
        None => return Ok(vec![]),
    };

    let mut results = Vec::new();
    let mut last_open_directory: Option<PathBuf> = None;
    for fp in file_paths {
        let path = fp.into_path().map_err(|e| e.to_string())?;
        if last_open_directory.is_none() {
            last_open_directory = path.parent().map(Path::to_path_buf);
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        // Return the path only; the bytes are fetched separately via read_file_raw,
        // which uses tauri::ipc::Response (raw binary). Base64-encoding the bytes into
        // this JSON payload turned an 87MB file into a ~6.7s IPC string transfer.
        results.push(serde_json::json!({
            "name": name,
            "path": path.to_string_lossy().to_string()
        }));
    }

    if let Some(directory) = last_open_directory.as_deref() {
        if let Err(err) = persist_directory(&app, "lastOpenDirectory", directory) {
            eprintln!("PhotoSuite: failed to persist last open directory: {err}");
        }
    }

    Ok(results)
}

/// Shows the native Save dialog seeded with `default_name` and returns the
/// chosen path (or `None` if cancelled). Does not read or write file bytes.
///
/// The starting folder is `default_directory` when it exists, otherwise the
/// folder remembered under `directory_key` (e.g. "lastSaveDirectory" /
/// "lastExportDirectory"), otherwise the platform default. The chosen folder is
/// persisted back under that key.
#[tauri::command]
async fn pick_save_path(
    app: tauri::AppHandle,
    default_name: String,
    default_directory: Option<String>,
    directory_key: Option<String>,
) -> Result<Option<String>, String> {
    let key = directory_key.unwrap_or_else(|| "lastSaveDirectory".to_string());
    let start_directory = default_directory
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| stored_directory(&app, &key))
        .unwrap_or_else(default_open_directory);

    let (tx, rx) = std::sync::mpsc::channel::<Option<tauri_plugin_fs::FilePath>>();

    let mut builder = app
        .dialog()
        .file()
        .set_title("Save")
        .set_directory(start_directory)
        .set_file_name(&default_name);
    if let Some(ext) = Path::new(&default_name)
        .extension()
        .and_then(|e| e.to_str())
    {
        builder = builder.add_filter(ext.to_uppercase(), &[ext.to_lowercase().as_str()]);
    }
    builder.save_file(move |path| {
        let _ = tx.send(path);
    });

    let chosen = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let path = match chosen {
        Some(p) => p.into_path().map_err(|e| e.to_string())?,
        None => return Ok(None),
    };

    if let Some(directory) = path.parent() {
        if let Err(err) = persist_directory(&app, &key, directory) {
            eprintln!("PhotoSuite: failed to persist save directory: {err}");
        }
    }

    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn read_file_raw(path: String) -> Result<tauri::ipc::Response, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

/// Decode the `%XX` escaping the front end applies to a path before putting it
/// in a header.
///
/// Header values carry visible ASCII only: a header cannot hold `Zürich.psd`
/// at all, and the browser refuses to build one containing `ブラシ.abr`. The
/// front end percent-encodes the path's UTF-8 bytes, and this puts it back.
/// The print commands use it for their settings header the same way.
pub(crate) fn percent_decode(encoded: &str) -> Result<String, String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| "truncated percent-escape in path".to_string())?;
            let hex = std::str::from_utf8(hex).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| format!("bad percent-escape %{hex}"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "path is not valid UTF-8".to_string())
}

/// Writes raw bytes to `X-PhotoSuite-Path` on the request. The invoke payload
/// must be a `Uint8Array` / `ArrayBuffer` (binary body), not a JSON object with
/// a byte array field — that keeps large PSD saves off the slow JSON path.
#[tauri::command]
fn save_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    use tauri::ipc::InvokeBody;

    let encoded_path = request
        .headers()
        .get("x-photosuite-path")
        .ok_or_else(|| "missing X-PhotoSuite-Path header".to_string())?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = percent_decode(encoded_path)?;
    let path = path.as_str();

    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => {
            return Err(
                "save_file expects a binary invoke body (Uint8Array), not a JSON payload".to_string(),
            );
        }
    };

    std::fs::write(path, data).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct SystemFontEntry {
    family: String,
    style: String,
    postscript_name: Option<String>,
    path: Option<String>,
}

#[tauri::command]
fn list_system_fonts() -> Result<Vec<SystemFontEntry>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut out: Vec<SystemFontEntry> = Vec::new();
    for face in db.faces() {
        let family = face
            .families
            .first()
            .map(|f| f.0.clone())
            .unwrap_or_else(|| "Unknown".to_string());
        let style = match face.style {
            fontdb::Style::Normal => "Regular",
            fontdb::Style::Italic => "Italic",
            fontdb::Style::Oblique => "Oblique",
        }
        .to_string();

        let path = match &face.source {
            fontdb::Source::File(p) => Some(p.to_string_lossy().to_string()),
            _ => None,
        };

        out.push(SystemFontEntry {
            family,
            style,
            postscript_name: Some(face.post_script_name.clone()),
            path,
        });
    }

    Ok(out)
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(base64_encode(&data))
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn confirm_dialog(
    app: tauri::AppHandle,
    message: String,
    title: String,
) -> Result<bool, String> {
    let (tx, rx) = std::sync::mpsc::channel::<bool>();

    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });

    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn photosuite_install_native_menu(
    app: tauri::AppHandle,
    spec: native_menu::NativeMenuInstallSpec,
) -> Result<(), String> {
    native_menu::install_native_menus_from_spec(&app, spec).map_err(|e| e.to_string())
}

#[tauri::command]
fn photosuite_exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn photosuite_emit_menu_action(
    app: tauri::AppHandle,
    payload: serde_json::Value,
) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "webview window \"main\" not found".to_string())?;
    win.emit("photosuite:menu-action", payload)
        .map_err(|e| e.to_string())
}

/// Event carrying paths the OS asked the app to open.
const OPEN_FILES_EVENT: &str = "photosuite:open-files";

/// Paths the OS handed us before the webview was ready to receive them.
///
/// A double-clicked file arrives either as an argument at launch (Windows, Linux)
/// or as an `Opened` run event (macOS, which may also fire while the app is
/// already running). Both can land before the frontend has a listener, so paths
/// queue here and the webview drains them once it starts.
#[derive(Default)]
struct PendingOpenFiles(std::sync::Mutex<Vec<String>>);

fn queue_open_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingOpenFiles>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.extend(paths.iter().cloned());
        }
    }
    // Harmless when nothing is listening yet: those paths stay queued.
    let _ = app.emit(OPEN_FILES_EVENT, paths);
}

/// File paths among the process arguments, ignoring flags and anything that is
/// not a file on disk.
fn open_paths_from_args() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| Path::new(arg).is_file())
        .collect()
}

/// Drain the queued paths. The webview calls this once during startup.
#[tauri::command]
fn take_pending_open_files(state: tauri::State<PendingOpenFiles>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut pending) => std::mem::take(&mut *pending),
        Err(_) => Vec::new(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingOpenFiles::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| {
            native_menu::handle_menu_activation(app, &event);
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The webview owns the unsaved-work prompt. Hold the window open
                // while it asks; it calls photosuite_exit_app once the user
                // confirms. If the webview cannot be reached the close proceeds,
                // so an unresponsive window is still closable.
                if native_menu::request_quit(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            // Windows and Linux pass a double-clicked file as an argument.
            queue_open_paths(app.handle(), open_paths_from_args());
            // Full menu tree is installed from the webview once MenuBar.data + Locale are ready.
            // Make it easy to access the WebView console while developing.
            #[cfg(debug_assertions)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_files,
            read_file_raw,
            get_app_version,
            save_file,
            pick_save_path,
            list_system_fonts,
            read_file_base64,
            read_file_bytes,
            confirm_dialog,
            photosuite_emit_menu_action,
            photosuite_install_native_menu,
            photosuite_exit_app,
            take_pending_open_files,
            printing::list_printers,
            printing::submit_print_job,
            sidebar_plugins::ensure_plugins_directory,
            sidebar_plugins::discover_sidebar_plugins_command,
            user_resources::ensure_resources_directory,
            user_resources::list_user_resources,
            user_resources::user_resource_path,
            user_resources::delete_user_resource
        ])
        .build(tauri::generate_context!())
        .expect("error while building PhotoSuite")
        .run(|_app, _event| {
            // macOS delivers "Open With" through the app, not through argv, and
            // does so again for every file opened while the app keeps running.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect();
                queue_open_paths(_app, paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn round_trips_what_encode_uri_component_produces() {
        // Each right-hand string is encodeURIComponent() of the left-hand path.
        let cases = [
            ("/Users/me/Desktop/shot.psd", "%2FUsers%2Fme%2FDesktop%2Fshot.psd"),
            ("/Users/me/Zürich.psd", "%2FUsers%2Fme%2FZ%C3%BCrich.psd"),
            ("/Users/me/ブラシ.abr", "%2FUsers%2Fme%2F%E3%83%96%E3%83%A9%E3%82%B7.abr"),
            ("C:\\Users\\Renée\\art.psd", "C%3A%5CUsers%5CRen%C3%A9e%5Cart.psd"),
            ("/tmp/a b+c&d.png", "%2Ftmp%2Fa%20b%2Bc%26d.png"),
        ];
        for (plain, encoded) in cases {
            assert_eq!(percent_decode(encoded).unwrap(), plain, "decoding {encoded}");
        }
    }

    #[test]
    fn passes_through_a_path_needing_no_escaping() {
        assert_eq!(percent_decode("brushes.abr").unwrap(), "brushes.abr");
    }

    #[test]
    fn reports_a_malformed_escape_rather_than_writing_somewhere_odd() {
        assert!(percent_decode("%2").is_err());
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%FF%FE").is_err(), "invalid UTF-8 must be refused");
    }
}
