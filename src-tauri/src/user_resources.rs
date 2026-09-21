//! The preset libraries a user keeps between launches: brush, gradient,
//! pattern, shape and swatch sets, and their scripts.
//!
//! Each one is a plain file in `{app_data_dir}/resources`, named as the user
//! saved it. A folder of real files means the set can be inspected, backed up,
//! synced or added to from outside the app, and needs no schema of its own.
//!
//! Bytes do not travel through here: the front end reads a listed path with
//! `read_file_raw` and writes with `save_file`, both of which move raw binary
//! rather than JSON.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const RESOURCES_DIR_NAME: &str = "resources";

#[derive(Debug, Serialize, Clone)]
pub struct UserResourceEntry {
    /// File name as saved, e.g. `extra_brushes.abr`.
    pub name: String,
    /// Absolute path, so the front end never joins paths itself.
    pub path: String,
    pub size: u64,
}

fn resources_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join(RESOURCES_DIR_NAME))
}

/// Characters Windows refuses in a file name. The other platforms allow most of
/// them, so a name using one would save on macOS and fail on Windows.
const WINDOWS_RESERVED_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Device names Windows reserves, with or without an extension: `CON.abr` is
/// just as unusable there as `CON`.
const WINDOWS_RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Leaves room under Windows' 260-character path limit once joined with the
/// app data directory, which is itself around seventy characters there.
const MAX_RESOURCE_NAME_LEN: usize = 120;

/// A resource name must be one ordinary file name that works on all three
/// platforms.
///
/// The same rules are applied everywhere rather than per-platform, so a library
/// saved on one machine can be copied to another and still load. Unicode names
/// are fine — only the characters Windows genuinely rejects are refused.
fn is_safe_resource_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > MAX_RESOURCE_NAME_LEN {
        return false;
    }
    if name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    if name.contains(WINDOWS_RESERVED_CHARS) || name.chars().any(|c| (c as u32) < 0x20) {
        return false;
    }
    // Windows drops these silently, so the file would not be found again.
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_RESERVED_STEMS.contains(&stem.as_str()) {
        return false;
    }
    let path = Path::new(name);
    path.components().count() == 1 && path.file_name().is_some_and(|n| n == name)
}

fn resource_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if !is_safe_resource_name(name) {
        return Err(format!("invalid resource name {name:?}"));
    }
    Ok(resources_root(app)?.join(name))
}

/// Create the resources folder if it is not there yet and return its path.
#[tauri::command]
pub fn ensure_resources_directory(app: tauri::AppHandle) -> Result<String, String> {
    let root = resources_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

/// List the saved libraries. Sub-folders and unreadable entries are skipped, so
/// a stray directory in there does not stop the rest from loading.
#[tauri::command]
pub fn list_user_resources(app: tauri::AppHandle) -> Result<Vec<UserResourceEntry>, String> {
    let root = resources_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if name.starts_with('.') {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(UserResourceEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name,
            size,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Resolve a name to the path `save_file` should write to.
#[tauri::command]
pub fn user_resource_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let path = resource_path(&app, &name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Forget one saved library. Removing something already gone is not an error.
#[tauri::command]
pub fn delete_user_resource(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = resource_path(&app, &name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::is_safe_resource_name;

    #[test]
    fn accepts_ordinary_library_names() {
        assert!(is_safe_resource_name("extra_brushes.abr"));
        assert!(is_safe_resource_name("_all_.aco"));
        assert!(is_safe_resource_name("my gradients (2).grd"));
    }

    #[test]
    fn accepts_names_in_any_language() {
        // Unicode is fine everywhere; only Windows' own rejects are refused.
        assert!(is_safe_resource_name("Pinsel-Zürich.abr"));
        assert!(is_safe_resource_name("ブラシ.abr"));
        assert!(is_safe_resource_name("Кисти.grd"));
    }

    #[test]
    fn refuses_names_windows_cannot_hold() {
        // Legal on APFS and ext4, unusable on NTFS — refused everywhere so a
        // library saved on one machine still opens on another.
        for name in [
            "my:brushes.abr", "a<b>.abr", "a>b.abr", "q\"uote.abr",
            "pipe|.abr", "star*.abr", "what?.abr",
        ] {
            assert!(!is_safe_resource_name(name), "{name} should be refused");
        }
    }

    #[test]
    fn refuses_windows_device_names() {
        for name in ["CON", "CON.abr", "nul.grd", "COM1.abr", "LPT9.pat", "aux.shc"] {
            assert!(!is_safe_resource_name(name), "{name} should be refused");
        }
        // Only the exact stems are reserved.
        assert!(is_safe_resource_name("CONTOURS.shc"));
        assert!(is_safe_resource_name("console.abr"));
    }

    #[test]
    fn refuses_endings_windows_silently_strips() {
        assert!(!is_safe_resource_name("trailing."));
        assert!(!is_safe_resource_name("brushes.abr "));
        assert!(!is_safe_resource_name(" leading.abr"));
        // A space inside the name is ordinary and stays allowed.
        assert!(is_safe_resource_name("my gradients (2).grd"));
    }

    #[test]
    fn refuses_a_name_too_long_for_the_windows_path_limit() {
        assert!(is_safe_resource_name(&("x".repeat(116) + ".abr")));
        assert!(!is_safe_resource_name(&("x".repeat(200) + ".abr")));
    }

    #[test]
    fn refuses_anything_that_leaves_the_folder() {
        assert!(!is_safe_resource_name(""));
        assert!(!is_safe_resource_name("."));
        assert!(!is_safe_resource_name(".."));
        assert!(!is_safe_resource_name("../settings.json"));
        assert!(!is_safe_resource_name("nested/brushes.abr"));
        assert!(!is_safe_resource_name("nested\\brushes.abr"));
        assert!(!is_safe_resource_name("/etc/passwd"));
    }
}

