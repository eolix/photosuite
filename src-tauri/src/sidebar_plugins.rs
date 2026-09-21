use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const PLUGINS_DIR_NAME: &str = "plugins";
const MANIFEST_FILE: &str = "plugin.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidebarPluginManifest {
    id: String,
    name: String,
    version: String,
    entry: String,
    icon: String,
    width: u32,
    height: u32,
    themed: Option<bool>,
    min_app_version: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSidebarPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub entry_path: String,
    pub icon_path: String,
    pub width: u32,
    pub height: u32,
    pub themed: bool,
}

pub fn plugins_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .map(|dir| dir.join(PLUGINS_DIR_NAME))
}

fn is_safe_plugin_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    id.chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn is_safe_relative_path(relative: &str) -> bool {
    if relative.is_empty() || relative.contains('\\') {
        return false;
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return false;
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => {}
            _ => return false,
        }
    }
    true
}

fn resolve_plugin_file(plugin_dir: &Path, relative: &str) -> Result<PathBuf, String> {
    if !is_safe_relative_path(relative) {
        return Err(format!("unsafe relative path: {relative}"));
    }
    let resolved = plugin_dir.join(relative);
    let canonical_plugin = plugin_dir
        .canonicalize()
        .map_err(|e| format!("plugin dir missing: {e}"))?;
    let canonical_file = resolved
        .canonicalize()
        .map_err(|e| format!("file not found ({relative}): {e}"))?;
    if !canonical_file.starts_with(&canonical_plugin) {
        return Err(format!("path escapes plugin dir: {relative}"));
    }
    if !canonical_file.is_file() {
        return Err(format!("not a file: {relative}"));
    }
    Ok(canonical_file)
}

fn parse_manifest_bytes(bytes: &[u8]) -> Result<SidebarPluginManifest, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("invalid plugin.json: {e}"))
}

fn version_tuple(version: &str) -> Vec<u32> {
    version
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn version_at_least(current: &str, required: &str) -> bool {
    let current_parts = version_tuple(current);
    let required_parts = version_tuple(required);
    let max_len = current_parts.len().max(required_parts.len());
    for idx in 0..max_len {
        let left = *current_parts.get(idx).unwrap_or(&0);
        let right = *required_parts.get(idx).unwrap_or(&0);
        if left > right {
            return true;
        }
        if left < right {
            return false;
        }
    }
    true
}

fn read_discovered_plugin(
    plugin_dir: &Path,
    app_version: &str,
) -> Result<DiscoveredSidebarPlugin, String> {
    let manifest_path = plugin_dir.join(MANIFEST_FILE);
    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("failed to read {}: {e}", manifest_path.display()))?;
    let manifest = parse_manifest_bytes(&manifest_bytes)?;

    if !is_safe_plugin_id(&manifest.id) {
        return Err(format!(
            "invalid plugin id {:?} (use 1-64 chars: letters, digits, -, _)",
            manifest.id
        ));
    }
    if manifest.name.trim().is_empty() {
        return Err("manifest.name must be non-empty".to_string());
    }
    if manifest.width == 0 || manifest.height == 0 {
        return Err("manifest width and height must be greater than zero".to_string());
    }
    if let Some(min_version) = manifest.min_app_version.as_deref() {
        if !min_version.trim().is_empty() && !version_at_least(app_version, min_version) {
            return Err(format!(
                "requires app version {min_version} (current {app_version})"
            ));
        }
    }

    let entry_path = resolve_plugin_file(plugin_dir, &manifest.entry)?;
    let icon_path = resolve_plugin_file(plugin_dir, &manifest.icon)?;

    Ok(DiscoveredSidebarPlugin {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        entry_path: entry_path.to_string_lossy().into_owned(),
        icon_path: icon_path.to_string_lossy().into_owned(),
        width: manifest.width,
        height: manifest.height,
        themed: manifest.themed.unwrap_or(false),
    })
}

pub fn discover_sidebar_plugins(app: &tauri::AppHandle) -> Result<Vec<DiscoveredSidebarPlugin>, String> {
    let root = plugins_root(app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let app_version = app.package_info().version.to_string();
    let mut discovered = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry_result in entries {
        let entry = entry_result.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }
        let plugin_dir = entry.path();
        let folder_name = plugin_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("<unknown>");
        match read_discovered_plugin(&plugin_dir, &app_version) {
            Ok(spec) => {
                if !seen_ids.insert(spec.id.clone()) {
                    eprintln!(
                        "PhotoSuite: skipping duplicate plugin id {:?} in {}",
                        spec.id,
                        plugin_dir.display()
                    );
                    continue;
                }
                discovered.push(spec);
            }
            Err(err) => {
                eprintln!(
                    "PhotoSuite: skipping plugin folder {}: {err}",
                    folder_name
                );
            }
        }
    }

    discovered.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(discovered)
}

#[tauri::command]
pub fn ensure_plugins_directory(app: tauri::AppHandle) -> Result<String, String> {
    let root = plugins_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn discover_sidebar_plugins_command(app: tauri::AppHandle) -> Result<Vec<DiscoveredSidebarPlugin>, String> {
    discover_sidebar_plugins(&app)
}

#[cfg(test)]
mod tests {
    use super::{is_safe_plugin_id, is_safe_relative_path, version_at_least};

    #[test]
    fn plugin_id_validation() {
        assert!(is_safe_plugin_id("hello-panel"));
        assert!(is_safe_plugin_id("plugin_1"));
        assert!(!is_safe_plugin_id(""));
        assert!(!is_safe_plugin_id("../bad"));
        assert!(!is_safe_plugin_id("has spaces"));
    }

    #[test]
    fn relative_path_validation() {
        assert!(is_safe_relative_path("index.html"));
        assert!(is_safe_relative_path("assets/icon.svg"));
        assert!(!is_safe_relative_path("../escape.html"));
        assert!(!is_safe_relative_path("/abs.html"));
    }

    #[test]
    fn version_compare() {
        assert!(version_at_least("0.9.0", "0.9.0"));
        assert!(version_at_least("1.0.0", "0.9.0"));
        assert!(!version_at_least("0.8.0", "0.9.0"));
    }
}
