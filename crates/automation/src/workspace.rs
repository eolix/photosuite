//! Capability-based filesystem policy for untrusted automation paths.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use photosuite_format::atomic::RenameRetry;
use serde_json::Value;

use crate::AutomationError;

const DENIED: &str = "automation filesystem access is not granted";

#[derive(Clone)]
struct RootCapability {
    dir: Arc<Dir>,
}

/// Separate directory capabilities for automation reads and writes.
///
/// Root paths are trusted launch-time configuration. Request paths are always
/// untrusted, forward-slash relative paths resolved by `cap-std` beneath the
/// held directory handle. Absolute paths, parent traversal, alternate
/// separators, Windows prefixes and empty components are rejected before I/O.
#[derive(Clone, Default)]
pub struct AuthorizedWorkspace {
    read: Option<RootCapability>,
    write: Option<RootCapability>,
}

impl AuthorizedWorkspace {
    /// Open the configured roots as capabilities. Either authority may be
    /// omitted; omitted authority fails closed.
    pub fn new(read_root: Option<&Path>, write_root: Option<&Path>) -> Result<Self, AutomationError> {
        Ok(Self { read: open_root(read_root, "read")?, write: open_root(write_root, "write")? })
    }

    /// Read one regular file below the configured read root.
    pub fn read(&self, path: &str) -> Result<Vec<u8>, AutomationError> {
        let relative = relative_path(path)?;
        let root = self.read.as_ref().ok_or_else(|| AutomationError::BadRequest(format!("{DENIED}: read authority is absent")))?;
        let mut file = root.dir.open(&relative).map_err(|e| file_error("read", path, e))?;
        let metadata = file.metadata().map_err(|e| file_error("read", path, e))?;
        if !metadata.is_file() {
            return Err(AutomationError::BadRequest(format!("automation read path is not a regular file: `{path}`")));
        }
        // Bounded reads, and a clear error for a file larger than memory (#375).
        photosuite_format::read::read_all(&mut file, metadata.len()).map_err(|e| file_error("read", path, e))
    }

    /// Create or replace one file below the configured write root, crash-safely: the bytes go to
    /// a temporary file beside the target, which is synced and renamed over it (the same steps
    /// as [`photosuite_format::atomic_write`], through the directory capability). On failure
    /// the previous file is untouched and the temporary file is removed.
    ///
    /// The parent directory must already exist. `cap-std` performs path
    /// resolution and file creation relative to the held directory handle, so
    /// a non-existent final target is supported without ambient path access.
    pub fn write(&self, path: &str, bytes: &[u8]) -> Result<(), AutomationError> {
        let relative = relative_path(path)?;
        let root = self.write.as_ref().ok_or_else(|| AutomationError::BadRequest(format!("{DENIED}: write authority is absent")))?;
        let leaf = relative.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let parent = relative.parent().map(Path::to_path_buf).unwrap_or_default();
        let tmp = parent.join(photosuite_format::atomic::temp_name(&leaf));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let written = root.dir.open_with(&tmp, &options).and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        });
        let renamed = written.and_then(|()| photosuite_format::atomic::retry_rename(RenameRetry::platform(), || root.dir.rename(&tmp, &root.dir, &relative)));
        if let Err(e) = renamed {
            let _ = root.dir.remove_file(&tmp);
            return Err(file_error("write", path, e));
        }
        // Flush the directory entry (Unix); best effort, the new bytes are already in place.
        #[cfg(unix)]
        {
            let dir = if parent.as_os_str().is_empty() { PathBuf::from(".") } else { parent };
            if let Ok(d) = root.dir.open(&dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    }
}

fn open_root(path: Option<&Path>, authority: &str) -> Result<Option<RootCapability>, AutomationError> {
    let Some(path) = path else { return Ok(None) };
    if path.as_os_str().is_empty() {
        return Err(AutomationError::BadRequest(format!("automation {authority} root is empty")));
    }
    let dir = Dir::open_ambient_dir(path, ambient_authority())
        .map_err(|e| AutomationError::Io(format!("cannot open automation {authority} root `{}`: {e}", path.display())))?;
    Ok(Some(RootCapability { dir: Arc::new(dir) }))
}

fn relative_path(raw: &str) -> Result<PathBuf, AutomationError> {
    if raw.is_empty() {
        return Err(path_error(raw, "path is empty"));
    }
    if raw.contains('\\') {
        return Err(path_error(raw, "alternate separators are not allowed; use `/`"));
    }
    if raw.starts_with('/') {
        return Err(path_error(raw, "absolute paths are not allowed"));
    }
    if raw.contains(':') {
        return Err(path_error(raw, "drive, device and stream prefixes are not allowed"));
    }
    for component in raw.split('/') {
        if component.is_empty() {
            return Err(path_error(raw, "empty path components are not allowed"));
        }
        if component == "." {
            return Err(path_error(raw, "`.` path components are not allowed"));
        }
        if component == ".." {
            return Err(path_error(raw, "parent traversal is not allowed"));
        }
        if component.ends_with(['.', ' ']) {
            return Err(path_error(raw, "path components ending in a dot or space are not allowed"));
        }
        if is_windows_device_name(component) {
            return Err(path_error(raw, "reserved device names are not allowed"));
        }
    }
    Ok(PathBuf::from(raw))
}

fn is_windows_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$")
        || stem.strip_prefix("COM").is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
        || stem.strip_prefix("LPT").is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

fn path_error(path: &str, reason: &str) -> AutomationError {
    AutomationError::BadRequest(format!("automation path rejected: {reason}: `{path}`"))
}

fn file_error(operation: &str, path: &str, error: std::io::Error) -> AutomationError {
    let kind = error.kind();
    AutomationError::Io(format!("automation {operation} `{path}` failed ({kind:?}): {error}"))
}

/// Filesystem-bearing engine commands have not yet been converted to consume
/// directory capabilities. Automation must use `doc.open`, `doc.save` and
/// `doc.render` for file effects until those commands are migrated.
pub fn authorize_engine_command(id: &str, params: &Value) -> Result<(), AutomationError> {
    let safe_file_command = matches!(
        id,
        "file.new"
            | "file.newFromClipboard"
            | "file.close"
            | "file.closeAll"
            | "file.closeOthers"
            | "file.fileInfo"
            | "file.automate.fitImage"
            | "file.automate.conditionalModeChange"
            | "file.scripts.flattenAllLayerEffects"
            | "file.scripts.flattenAllMasks"
            | "file.scripts.deleteAllEmptyLayers"
            | "file.export.exportPreferences"
    );
    if id.starts_with("file.") && !safe_file_command {
        return Err(command_error(id));
    }
    if (id.starts_with("layer.smartObjects.") && id != "layer.smartObjects.convertToSmartObject")
        || matches!(
            id,
            "pattern.import"
                | "pattern.export"
                // PhotoSuite's shape library import reads a .csh file by path only.
                | "shape.presets.importCsh"
                | "edit.presets.migratePresets"
                | "measurementLog.export"
                | "layer.videoLayers.newVideoLayerFromFile"
                | "layer.videoLayers.replaceFootage"
                | "layer.videoLayers.reloadFrame"
        )
        || command_uses_ambient_path(id, params)
        || profile_command_may_read_ambient(id, params)
        || preferences_may_grant_ambient_paths(id, params)
        || params_contain_ambient_path(id, params)
    {
        return Err(command_error(id));
    }
    Ok(())
}

/// Desktop sessions may already contain user-configured ambient colour-profile
/// paths. Commands which implicitly resolve those settings are denied even
/// when their request parameters contain no path. Fresh headless sessions
/// cannot acquire such settings through the automation interface.
pub fn authorize_desktop_engine_command(id: &str, params: &Value) -> Result<(), AutomationError> {
    authorize_engine_command(id, params)?;
    if id.starts_with("image.mode.") {
        return Err(command_error(id));
    }
    Ok(())
}

/// [`authorize_engine_command`] as the function pointer [`photosuite_engine::Session::authorize`]
/// stores. `actions.play` calls it for every nested step.
pub fn authorize_engine_step(id: &str, params: &Value) -> photosuite_engine::Result<()> {
    authorize_engine_command(id, params).map_err(|e| photosuite_engine::EngineError::Other(e.to_string()))
}

/// [`authorize_desktop_engine_command`] as a [`photosuite_engine::Session::authorize`] hook.
pub fn authorize_desktop_engine_step(id: &str, params: &Value) -> photosuite_engine::Result<()> {
    authorize_desktop_engine_command(id, params).map_err(|e| photosuite_engine::EngineError::Other(e.to_string()))
}

fn params_contain_ambient_path(id: &str, params: &Value) -> bool {
    let keys: &[&str] = match id {
        "image.adjustments.colorLookup" | "layer.newAdjustmentLayer.colorLookup" | "layer.setAdjustment" => &["file"],
        "filter.distort.displace" => &["mapPath"],
        "layer.quickExportAsPng" | "layer.exportAs" | "image.applyDataSet" => &["path"],
        "image.mode.rgb" | "image.mode.grayscale" | "image.mode.cmyk" | "image.mode.lab" => &["profile"],
        "edit.assignProfile" | "edit.convertToProfile" | "edit.profileInfo" | "view.proofSetup" | "view.gamutWarning" => &["profile"],
        "edit.colorSettings" => &["workingRgb", "workingCmyk", "workingGray"],
        _ => &[],
    };
    keys.iter().any(|key| {
        params
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| if matches!(*key, "file" | "mapPath" | "path") { !value.is_empty() } else { looks_like_path(value) })
    })
}

fn profile_command_may_read_ambient(id: &str, params: &Value) -> bool {
    if matches!(id, "color.profileMismatch" | "edit.colorSettings" | "view.proofSetup") {
        return true;
    }
    matches!(id, "edit.assignProfile" | "edit.convertToProfile" | "edit.profileInfo")
        && params.get("profile").and_then(Value::as_str).is_some_and(|profile| {
            matches!(profile, "working" | "default" | "working-cmyk" | "workingCmyk" | "working-rgb" | "workingRgb" | "working-gray" | "workingGray")
        })
}

fn preferences_may_grant_ambient_paths(id: &str, params: &Value) -> bool {
    if id != "prefs.set" {
        return false;
    }
    let direct = params.get("path").and_then(Value::as_str).is_some_and(preference_uses_ambient_filesystem);
    let batch = params.get("values").and_then(Value::as_object).is_some_and(|values| values.keys().any(|path| preference_uses_ambient_filesystem(path)));
    direct || batch
}

fn preference_uses_ambient_filesystem(path: &str) -> bool {
    // The engine skips empty segments (`.scriptEvents.enabled` sets `scriptEvents.enabled`), so
    // judge the first non-empty one; no segment at all is the whole-preferences update.
    let Some(section) = path.split('.').find(|segment| !segment.is_empty()) else { return true };
    matches!(section, "colorSettings" | "scriptEvents" | "historyLog" | "plugIns" | "scratchDisks")
}

fn command_uses_ambient_path(id: &str, params: &Value) -> bool {
    match id {
        "brush.presets.importAbr" | "gradient.presets.importGrd" | "plugin.install" => {
            // `data` wins over `path` in these commands; any `path` without it reads the filesystem.
            params.get("data").is_none() && params.get("path").is_some()
        }
        "plugin.reload" => true,
        _ => false,
    }
}

fn looks_like_path(value: &str) -> bool {
    value.contains('/')
        || value.contains('\\')
        || value.contains(':')
        || value.to_ascii_lowercase().ends_with(".icc")
        || value.to_ascii_lowercase().ends_with(".icm")
}

fn command_error(id: &str) -> AutomationError {
    AutomationError::BadRequest(format!("automation command `{id}` uses ambient filesystem paths and is disabled; use capability-scoped document methods"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(name: &str) -> (PathBuf, PathBuf, AuthorizedWorkspace) {
        let base = std::env::temp_dir().join(format!("photosuite-workspace-{}-{name}", std::process::id()));
        let inside = base.join("inside");
        let outside = base.join("outside");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let workspace = AuthorizedWorkspace::new(Some(&inside), Some(&inside)).unwrap();
        (inside, outside, workspace)
    }

    #[test]
    fn valid_read_and_nonexistent_output_write_stay_in_root() {
        let (inside, _, workspace) = roots("valid");
        std::fs::write(inside.join("read.txt"), b"canary").unwrap();
        assert_eq!(workspace.read("read.txt").unwrap(), b"canary");
        workspace.write("new-output.txt", b"created").unwrap();
        assert_eq!(std::fs::read(inside.join("new-output.txt")).unwrap(), b"created");
    }

    fn temp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".tmp")).collect()
    }

    #[test]
    fn write_replaces_atomically_and_leaves_no_temp_file() {
        let (inside, _, workspace) = roots("atomic");
        std::fs::create_dir_all(inside.join("sub")).unwrap();
        workspace.write("sub/out.psd", b"original").unwrap();
        workspace.write("sub/out.psd", b"replacement").unwrap();
        assert_eq!(std::fs::read(inside.join("sub/out.psd")).unwrap(), b"replacement");
        assert!(temp_files(&inside.join("sub")).is_empty());
        // Renaming over a directory fails: nothing is left behind and the directory survives.
        std::fs::create_dir_all(inside.join("adir")).unwrap();
        assert!(workspace.write("adir", b"x").is_err());
        assert!(inside.join("adir").is_dir());
        assert!(temp_files(&inside).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn write_into_read_only_folder_keeps_the_original() {
        use std::os::unix::fs::PermissionsExt;
        let (inside, _, workspace) = roots("readonly");
        let ro = inside.join("ro");
        std::fs::create_dir_all(&ro).unwrap();
        std::fs::write(ro.join("doc.psd"), b"original").unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o555)).unwrap();
        let root_user = std::fs::File::create(ro.join("probe")).is_ok();
        if !root_user {
            assert!(workspace.write("ro/doc.psd", b"new").is_err());
            assert_eq!(std::fs::read(ro.join("doc.psd")).unwrap(), b"original");
            assert!(temp_files(&ro).is_empty());
        }
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn rejects_absolute_traversal_mixed_prefix_and_malformed_paths_without_panicking() {
        let (_, _, workspace) = roots("reject");
        for path in [
            "",
            "/absolute",
            "../escape",
            "a/../escape",
            "a\\..\\escape",
            "a\\b",
            "C:/escape",
            "a//b",
            "./a",
            "name:stream",
            "NUL",
            "con.txt",
            "folder/COM1.log",
        ] {
            assert!(workspace.read(path).is_err(), "read accepted {path:?}");
            assert!(workspace.write(path, b"x").is_err(), "write accepted {path:?}");
        }
    }

    #[test]
    fn read_and_write_authority_are_separate() {
        let (inside, _, _) = roots("separate");
        std::fs::write(inside.join("read.txt"), b"canary").unwrap();
        let read_only = AuthorizedWorkspace::new(Some(&inside), None).unwrap();
        assert_eq!(read_only.read("read.txt").unwrap(), b"canary");
        assert!(read_only.write("blocked.txt", b"x").is_err());
        let write_only = AuthorizedWorkspace::new(None, Some(&inside)).unwrap();
        assert!(write_only.read("read.txt").is_err());
        write_only.write("written.txt", b"ok").unwrap();
    }

    #[test]
    fn missing_parent_is_a_stable_error_before_any_file_is_created() {
        let (inside, _, workspace) = roots("missing-parent");
        let error = workspace.write("missing/output.txt", b"x").unwrap_err().to_string();
        assert!(error.contains("automation write"), "{error}");
        assert!(!inside.join("missing").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        use std::os::unix::fs::symlink;

        let (inside, outside, workspace) = roots("symlink");
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        symlink(&outside, inside.join("link")).unwrap();
        assert!(workspace.read("link/secret.txt").is_err());
        assert!(workspace.write("link/new.txt", b"blocked").is_err());
        assert!(!outside.join("new.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_symlink_escape_is_rejected_when_supported() {
        use std::os::windows::fs::symlink_dir;

        let (inside, outside, workspace) = roots("windows-link");
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        if symlink_dir(&outside, inside.join("link")).is_err() {
            return;
        }
        assert!(workspace.read("link/secret.txt").is_err());
        assert!(workspace.write("link/new.txt", b"blocked").is_err());
        assert!(!outside.join("new.txt").exists());
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_escape_is_rejected_when_supported() {
        use std::process::Command;

        let (inside, outside, workspace) = roots("windows-junction");
        std::fs::write(outside.join("secret.txt"), b"outside").unwrap();
        let link = inside.join("junction");
        let status = Command::new("cmd.exe").args(["/D", "/C", "mklink", "/J"]).arg(&link).arg(&outside).status();
        if !status.is_ok_and(|status| status.success()) {
            return;
        }
        assert!(workspace.read("junction/secret.txt").is_err());
        assert!(workspace.write("junction/new.txt", b"blocked").is_err());
        assert!(!outside.join("new.txt").exists());
        let _ = std::fs::remove_dir(link);
    }

    #[test]
    fn filesystem_commands_fail_closed() {
        for id in [
            "file.open",
            "file.openAs",
            "file.save",
            "file.saveAs",
            "file.saveACopy",
            "file.export.saveForWebLegacy",
            "pattern.import",
            "shape.presets.importCsh",
            "layer.smartObjects.exportContents",
            "measurementLog.export",
            "layer.videoLayers.reloadFrame",
            "edit.colorSettings",
        ] {
            assert!(authorize_engine_command(id, &serde_json::json!({})).is_err());
        }
        assert!(authorize_engine_command("file.new", &serde_json::json!({})).is_ok());
        // The UI-level examples in docs/control-protocol.md.
        for id in ["view.zoomIn", "window.theme.pro", "edit.search"] {
            assert!(authorize_desktop_engine_command(id, &serde_json::json!({})).is_ok(), "{id}");
        }
        assert!(authorize_engine_command("image.mode.cmyk", &serde_json::json!({})).is_ok());
        assert!(authorize_desktop_engine_command("image.mode.cmyk", &serde_json::json!({})).is_err());
        assert!(authorize_engine_command("image.mode.rgb", &serde_json::json!({"profile": "/outside/profile.icc"})).is_err());
        assert!(authorize_engine_command("image.mode.rgb", &serde_json::json!({"profile": "srgb"})).is_ok());
        assert!(authorize_engine_command("filter.distort.displace", &serde_json::json!({"mapPath": "outside.png"})).is_err());
        assert!(authorize_engine_command("layer.setAdjustment", &serde_json::json!({"file": "outside.cube"})).is_err());
        assert!(authorize_engine_command("prefs.set", &serde_json::json!({"path": "colorSettings.workingRgb", "value": "outside.icc"})).is_err());
        assert!(authorize_engine_step("file.open", &serde_json::json!({})).is_err());
        assert!(authorize_engine_step("actions.play", &serde_json::json!({})).is_ok());
        // An allowed command can't reach a denied one by running it on its own behalf.
        let mut session = photosuite_engine::Session::new();
        session.execute("file.new", serde_json::json!({"width": 4, "height": 4})).unwrap();
        session.authorize = Some(authorize_desktop_engine_step);
        let params = serde_json::json!({"to": "grayscale"});
        assert!(authorize_desktop_engine_command("file.automate.conditionalModeChange", &params).is_ok());
        assert!(session.execute("file.automate.conditionalModeChange", params).is_err());
        assert_eq!(session.active().unwrap().doc.mode, photosuite_engine::doc::ColorMode::Rgb);
        assert!(authorize_desktop_engine_step("file.saveACopy", &serde_json::json!({})).is_err());
    }

    #[test]
    fn apply_data_set_is_judged_by_the_values_it_applies() {
        let mut headless = crate::Headless::new();
        headless.command_run("file.new", serde_json::json!({"width": 8, "height": 8})).unwrap();
        let layer = headless.command_run("layer.new.layer", serde_json::json!({})).unwrap()["layer"].clone();
        let defs = [
            serde_json::json!({"name": "shown", "layer": layer, "type": "visibility"}),
            serde_json::json!({"name": "photo", "layer": layer, "type": "pixelReplacement"}),
        ];
        headless.command_run("image.variables.define", serde_json::json!({"defs": defs})).unwrap();
        let sets = serde_json::json!({"dataSets": [
            {"name": "hidden", "values": [{"variable": "shown", "kind": "visibility", "value": false}]},
            {"name": "swap", "values": [
                {"variable": "shown", "kind": "visibility", "value": false},
                {"variable": "photo", "kind": "pixels", "value": "/outside/photo.png"},
            ]},
        ]});
        headless.command_run("image.variables.dataSets", sets).unwrap();
        let visible = |headless: &crate::Headless| headless.session.active().unwrap().doc.layers.iter().all(|l| l.visible);
        let refused = headless.command_run("image.applyDataSet", serde_json::json!({"name": "swap"})).unwrap_err();
        assert!(refused.to_string().contains("ambient filesystem paths"), "{refused}");
        assert!(visible(&headless), "a refused data set applies none of its values");
        assert!(headless.command_run("image.applyDataSet", serde_json::json!({"name": "hidden"})).is_ok());
        assert!(!visible(&headless));
    }

    #[test]
    fn automation_rejects_ambient_path_commands_and_preferences() {
        for (id, params) in [
            ("brush.presets.importAbr", serde_json::json!({"path": "/outside/set.abr"})),
            ("gradient.presets.importGrd", serde_json::json!({"path": "/outside/set.grd"})),
            ("plugin.install", serde_json::json!({"path": "/outside/plugin.wasm"})),
            ("plugin.reload", serde_json::json!({"path": "/outside/plugins"})),
            ("plugin.reload", serde_json::json!({})),
            ("plugin.install", serde_json::json!({"path": " "})),
        ] {
            assert!(authorize_engine_command(id, &params).is_err(), "{id}: {params}");
        }
        for (id, params) in [
            ("brush.presets.importAbr", serde_json::json!({"data": "QUJD"})),
            ("gradient.presets.importGrd", serde_json::json!({"data": "QUJD"})),
            ("plugin.install", serde_json::json!({"data": "QUJD"})),
        ] {
            assert!(authorize_engine_command(id, &params).is_ok(), "{id}: {params}");
        }
        for path in [
            "",
            "colorSettings",
            "colorSettings.workingRgb",
            "scriptEvents",
            "scriptEvents.enabled",
            ".scriptEvents",
            ".scriptEvents.enabled",
            "historyLog.filePath",
            ".historyLog.filePath",
            "plugIns.additionalPluginsFolder",
            "scratchDisks.disks",
            ".",
            "..historyLog.filePath",
        ] {
            assert!(authorize_engine_command("prefs.set", &serde_json::json!({"path": path, "value": {}})).is_err(), "{path}");
        }
        assert!(
            authorize_engine_command("prefs.set", &serde_json::json!({"values": {"interface.language": "fr", "historyLog.filePath": "/outside/log"}})).is_err()
        );
        assert!(authorize_engine_command("prefs.set", &serde_json::json!({"path": "interface.language", "value": "fr"})).is_ok());
    }

    #[test]
    fn registry_filesystem_path_params_are_classified() {
        let probe = serde_json::json!({
            "path": "/outside/photosuite-probe",
            "file": "/outside/photosuite-probe.icc",
            "mapPath": "/outside/photosuite-probe.png",
            "profile": "/outside/photosuite-probe.icc",
            "workingRgb": "/outside/photosuite-probe.icc",
            "workingCmyk": "/outside/photosuite-probe.icc",
            "workingGray": "/outside/photosuite-probe.icc",
            "input": "/outside/photosuite-input",
            "output": "/outside/photosuite-output",
            "paths": ["/outside/photosuite-probe.psd"],
        });
        let preference_probe = serde_json::json!({"path": ".scriptEvents", "value": {}});
        let unclassified: Vec<_> = photosuite_engine::command_specs()
            .iter()
            .filter(|spec| documents_filesystem_path_params(spec.id, spec.params))
            .filter(|spec| {
                let params = if spec.id == "prefs.set" { &preference_probe } else { &probe };
                authorize_engine_command(spec.id, params).is_ok()
            })
            .map(|spec| spec.id)
            .collect();
        assert!(unclassified.is_empty(), "filesystem path parameters in the command registry need an automation policy: {unclassified:?}");
    }

    fn documents_filesystem_path_params(id: &str, params: &str) -> bool {
        if matches!(id, "prefs.get" | "prefs.reset") {
            return false;
        }
        // These registry descriptions refer to document vector paths, not host files.
        if matches!(
            id,
            "filter.blurGallery.pathBlur"
                | "filter.render.flame"
                | "shape.create"
                | "shape.edit"
                | "shape.info"
                | "shape.presets.list"
                | "shape.presets.new"
                | "path.list"
                | "path.info"
                | "path.set"
                | "path.transform"
                | "path.moveAnchors"
                | "path.moveHandle"
                | "path.bendSegment"
                | "path.convertPoint"
                | "path.clippingPath.set"
                | "path.rename"
                | "select.toWorkPath"
                | "layer.vectorMask.add"
                | "layer.vectorMask.edit"
                | "layer.vectorMask.info"
                | "paint.symmetryFromPath"
                | "edit.defineCustomShape"
                | "layer.combineShapes.unite"
                | "layer.combineShapes.subtractFrontShape"
                | "layer.combineShapes.intersectShapeAreas"
                | "layer.combineShapes.excludeOverlappingShapes"
                | "layer.combineShapes.mergeShapeComponents"
        ) {
            return false;
        }
        params.to_ascii_lowercase().contains("path")
    }

    #[test]
    fn whole_preferences_update_cannot_enable_automation_script_events() {
        let mut headless = crate::headless::Headless::new();
        let result = headless.command_run(
            "prefs.set",
            serde_json::json!({
                "path": "",
                "value": {
                    "scriptEvents": {
                        "enabled": true,
                        "bindings": [{
                            "event": "newDocument",
                            "steps": [["file.saveACopy", {"path": "/outside/canary.psd"}]]
                        }]
                    }
                }
            }),
        );
        assert!(result.is_err());

        for (id, params) in [
            ("brush.presets.importAbr", serde_json::json!({"path": "/outside/set.abr"})),
            ("gradient.presets.importGrd", serde_json::json!({"path": "/outside/set.grd"})),
            ("plugin.install", serde_json::json!({"path": "/outside/plugin.wasm"})),
            ("plugin.reload", serde_json::json!({"path": "/outside/plugins"})),
            ("prefs.set", serde_json::json!({"path": "historyLog.filePath", "value": "/outside/log"})),
            ("prefs.set", serde_json::json!({"values": {"interface.language": "fr", "historyLog.filePath": "/outside/log"}})),
        ] {
            assert!(headless.command_run(id, params).is_err(), "{id}");
        }
        headless.command_run("file.new", serde_json::json!({"width": 5, "height": 5})).unwrap();
        assert!(headless.session.file_menu.event_log.is_empty());
    }
}
