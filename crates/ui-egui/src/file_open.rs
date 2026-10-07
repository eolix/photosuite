//! Opening files from disk: File › Open, Open Recent, drag-and-drop onto the window (except onto
//! a document's canvas, which places the file as a layer), command-line paths at launch
//! and the OS's "open these documents" requests (macOS Finder double-click, Open With, drops on the
//! Dock icon) all go through [`PhotosuiteApp::open_file`], so each one names the document after the
//! file, remembers its path (File › Save writes back to it) and adds it to Open Recent. Failures
//! are shown as errors (status bar + notice); import warnings as a notice.

use crate::{PhotosuiteApp, notices};
use photosuite_engine::file_cmds::{is_template, untitled_name};

/// A request from the operating system, delivered by the platform shell through
/// [`Services::os_events`](crate::Services::os_events).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OsEvent {
    /// Open these files (absolute paths), e.g. a Finder double-click.
    Open(Vec<String>),
    /// Quit (e.g. the Dock menu's Quit, log out): goes through the normal close path, which asks
    /// about unsaved changes.
    Quit,
}

/// Where files dropped on the window land, as in the reference app. winit 0.30's drops carry no
/// position, so it comes from the OS ([`Services::cursor_pos`](crate::Services::cursor_pos));
/// unknown counts as elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropTarget {
    /// The active document's canvas: placed as layers (Place Embedded), each in Free Transform.
    Canvas,
    /// The tab strip: opened with their tabs from this position (the strip shows it while files
    /// hover).
    Tabs(usize),
    /// Anywhere else (panels, a dialog, no document): opened like File › Open.
    Elsewhere,
}

/// A dropped file's name ("dropped" when it has none).
fn dropped_name(f: &egui::DroppedFileHandle) -> String {
    f.path().file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "dropped".into())
}

/// The file name of `path` (the document's display name), or `path` itself when it has none.
pub fn display_name(path: &str) -> String {
    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| path.to_string())
}

impl PhotosuiteApp {
    /// Open `bytes` read from the file at `path`: the document is named after the file, keeps
    /// `path` for File › Save, and `path` goes to the top of Open Recent. Returns the import
    /// warnings (also shown to the user).
    pub fn open_file(&mut self, path: &str, bytes: &[u8]) -> Result<Vec<String>, String> {
        // Brushes/gradients go to the preset libraries (no document, no Open Recent entry).
        if let Some(r) = crate::preset_files_ui::open(self, path, bytes) {
            return r.map(|()| Vec::new());
        }
        // A PDF of several pages asks which one first (Import PDF), as Photoshop does.
        #[cfg(not(target_arch = "wasm32"))]
        if path.to_ascii_lowercase().ends_with(".pdf") {
            let pages = photosuite_engine::file_cmds::pdf_pages(bytes);
            if pages > 1 && std::path::Path::new(path).is_file() {
                crate::file_ui::open_pdf_dialog(self, path, pages);
                self.push_recent(path);
                return Ok(Vec::new());
            }
        }
        if self.background_jobs {
            // The path and Open Recent are recorded when the background open finishes.
            crate::jobs_ui::start_open(self, &display_name(path), Some(path.to_string()), crate::jobs_ui::bytes(bytes))?;
            return Ok(Vec::new());
        }
        let warnings = self.open_bytes(&display_name(path), bytes)?;
        self.opened_from(path, Some(bytes));
        Ok(warnings)
    }

    /// Record that the active document was just opened from `path`: File › Save writes back to it
    /// (unless it's a template), with the save options read from its `bytes` when the caller has
    /// them, and it goes to the top of Open Recent.
    pub(crate) fn opened_from(&mut self, path: &str, bytes: Option<&[u8]>) {
        if !is_template(path)
            && let Some(st) = self.session.active_mut()
        {
            st.path = Some(path.to_string());
            if let Some(bytes) = bytes {
                st.save_options = save_options_of(path, bytes);
            }
        }
        self.push_recent(path);
    }

    /// The name a file called `name` opens under: its own, or the first free "Untitled-N" for a
    /// template.
    pub(crate) fn open_name(&self, name: &str) -> String {
        if !is_template(name) {
            return name.to_string();
        }
        untitled_name(tl!("Untitled"), |n| self.session.documents().iter().any(|d| d.doc.name == n) || self.jobs.opens.iter().any(|o| o.name == n))
    }

    /// Read and open the file at `path` (see [`open_file`](Self::open_file)).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn open_path(&mut self, path: &str) -> Result<Vec<String>, String> {
        // Documents opening in the background are read on the worker too (a 2 GB PSB read
        // would block the window). Preset files (brushes, gradients) go the usual way.
        let ext = std::path::Path::new(path).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if self.background_jobs && !crate::preset_files_ui::PRESET_EXTS.contains(&ext.as_str()) {
            crate::jobs_ui::start_open(self, &display_name(path), Some(path.to_string()), photosuite_engine::jobs::OpenSource::Path(path.to_string()))?;
            return Ok(Vec::new());
        }
        let bytes = photosuite_format::read_file(std::path::Path::new(path)).map_err(|e| format!("{path}: {e}"))?;
        self.open_file(path, &bytes)
    }

    #[cfg(target_arch = "wasm32")]
    pub fn open_path(&mut self, path: &str) -> Result<Vec<String>, String> {
        Err(format!("cannot open paths on the web: {path}"))
    }

    /// Open several files, reporting each failure to the user instead of stopping. Relative paths
    /// are resolved against the working directory so the remembered path stays valid. Returns how
    /// many opened.
    pub fn open_paths(&mut self, paths: &[String]) -> usize {
        let mut opened = 0;
        for p in paths {
            let abs = absolute(p);
            match self.open_path(&abs) {
                Ok(_) => opened += 1,
                Err(e) => self.open_failed(&display_name(p), &e),
            }
        }
        opened
    }

    /// Show "Couldn't open <name>: <error>" as an error (status bar + notice).
    pub fn open_failed(&mut self, name: &str, err: &str) {
        self.failed(format!("Couldn't open {name}: {err}"));
    }

    /// Log `msg` and show it as an error (status bar + notice).
    fn failed(&mut self, msg: String) {
        log::warn!("{msg}");
        notices::error(self, msg);
    }

    /// Files dropped onto the window at `at` (the pointer, when known), routed by [`DropTarget`].
    /// Preset files (brushes, gradients) always go to their libraries. Native drops carry an
    /// absolute path, read in bounded reads (#375) rather than egui's whole-file read.
    pub fn open_dropped(&mut self, ctx: &egui::Context, files: Vec<egui::DroppedFileHandle>, at: Option<egui::Pos2>) {
        let target = self.drop_target(ctx, at);
        let mut slot = match target {
            DropTarget::Tabs(slot) => Some(slot),
            DropTarget::Canvas | DropTarget::Elsewhere => None,
        };
        for f in files {
            let name = dropped_name(&f);
            if target == DropTarget::Canvas && !crate::preset_files_ui::is_preset_file(&name) {
                self.drop_places.push_back(f);
                continue;
            }
            match self.open_dropped_file(&f, &name, slot) {
                Ok(true) => slot = slot.map(|s| s + 1),
                Ok(false) => {}
                Err(e) => self.open_failed(&name, &e),
            }
        }
    }

    /// Where a drop at `at` lands. Over a window or dialog it's neither the canvas nor the tabs.
    pub(crate) fn drop_target(&self, ctx: &egui::Context, at: Option<egui::Pos2>) -> DropTarget {
        let Some(p) = at.filter(|p| ctx.layer_id_at(*p).is_none_or(|l| l.order == egui::Order::Background)) else {
            return DropTarget::Elsewhere;
        };
        if let Some(strip) = self.tab_strip.as_ref().filter(|s| s.rect.contains(p)) {
            return DropTarget::Tabs(strip.slot(p.x));
        }
        // The canvas shown last frame may belong to a document closed since.
        if self.session.active().is_some() && self.drop_canvas_rect.is_some_and(|r| r.contains(p)) {
            return DropTarget::Canvas;
        }
        DropTarget::Elsewhere
    }

    /// Open one dropped file; with `slot`, its tab goes there (when it finishes opening, for
    /// background opens). True when it took the slot.
    fn open_dropped_file(&mut self, f: &egui::DroppedFileHandle, name: &str, slot: Option<usize>) -> Result<bool, String> {
        // Opens append: a background open's tab, or a document.
        let (docs, opens) = (self.session.documents().len(), self.jobs.opens.len());
        if f.path().is_absolute() {
            self.open_path(&f.path().to_string_lossy())?;
        } else {
            self.open_bytes(name, &crate::read_dropped(&**f)?)?;
        }
        let Some(slot) = slot else { return Ok(false) };
        if let Some(tab) = self.jobs.opens.get_mut(opens) {
            tab.slot = Some(slot);
            return Ok(true);
        }
        Ok(self.run("document.move", serde_json::json!({"document": docs, "to": slot})).is_ok())
    }

    /// Place the next file dropped on the canvas and start Free Transform on it, once no other
    /// transform is in progress (so several files are placed and transformed one after another).
    pub(crate) fn place_next_dropped(&mut self, ctx: &egui::Context) {
        while self.ui.transform.is_none() {
            let Some(f) = self.drop_places.pop_front() else { return };
            let placed = if f.path().is_absolute() {
                self.run("file.placeEmbedded", serde_json::json!({"path": f.path().to_string_lossy()}))
            } else {
                crate::read_dropped(&*f).and_then(|bytes| self.place_bytes(&dropped_name(&f), bytes, None))
            };
            match placed {
                Ok(_) => {
                    if let Err(e) = crate::transform_tool::begin_placed(self, ctx) {
                        self.ui.status = e;
                    }
                }
                Err(e) => self.failed(crate::i18n::fmt(tl!("Couldn't place {name}: {error}"), &[("name", &dropped_name(&f)), ("error", &e)])),
            }
        }
    }

    /// Place a file's bytes as a smart object layer (File › Place; `linked`: Place Linked, to that
    /// path), for files that weren't read from a path the command can read.
    pub(crate) fn place_bytes(&mut self, name: &str, bytes: Vec<u8>, linked: Option<String>) -> Result<serde_json::Value, String> {
        let r = photosuite_engine::file_cmds::place_bytes(&mut self.session, name, bytes, linked, &serde_json::json!({})).map_err(|e| e.to_string());
        self.sync_views();
        r
    }

    /// Handle the OS requests queued since the last frame.
    pub(crate) fn drain_os_events(&mut self, ctx: &egui::Context) {
        let events = self.services.os_events.as_mut().map(|f| f()).unwrap_or_default();
        for e in events {
            match e {
                OsEvent::Open(paths) => {
                    self.open_paths(&paths);
                    // Bring the window forward when another app (Finder, the Dock) asked us to open.
                    ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
                    ctx.request_repaint();
                }
                OsEvent::Quit => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            }
        }
    }
}

/// The settings to save `bytes` (the file at `path`) again with: a JPEG's quality, read from its
/// quantisation tables, and whether a WebP is lossy. WebP doesn't record its quality, so a lossy
/// one saves at 75 (libwebp's default). Other formats are lossless or have nothing to keep.
pub(crate) fn save_options_of(path: &str, bytes: &[u8]) -> photosuite_engine::SaveOptions {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let mut o = photosuite_engine::SaveOptions::default();
    match ext.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" => o.jpeg_quality = photosuite_codecs::jpeg_quality(bytes),
        "webp" if photosuite_codecs::webp_is_lossless(bytes) == Some(false) => o.webp_quality = Some(75),
        _ => {}
    }
    o
}

#[cfg(not(target_arch = "wasm32"))]
fn absolute(p: &str) -> String {
    std::path::absolute(p).map(|a| a.to_string_lossy().to_string()).unwrap_or_else(|_| p.to_string())
}

#[cfg(target_arch = "wasm32")]
fn absolute(p: &str) -> String {
    p.to_string()
}

#[cfg(test)]
mod tests;
