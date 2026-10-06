//! Preset libraries bundled with the app (`resources/`): brushes, gradients, custom shapes and
//! patterns. Brushes, gradients and shapes persist in the preset store, so each is imported
//! once its store has loaded, and only when its group is missing (deleting one brings it back on
//! the next launch). The pattern library isn't persisted, so patterns are parsed on a background
//! thread on every launch: the small seed set at startup, the large one the first time the
//! Patterns panel is shown.

use crate::PhotosuiteApp;

/// What kind of preset a library file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Brushes,
    Gradients,
    Shapes,
    /// Patterns parsed at startup.
    Patterns,
    /// Patterns parsed when the Patterns panel is first shown.
    PatternsOnDemand,
}

/// One bundled library: its kind, the panel group it becomes, and its file.
#[derive(Clone, Debug)]
pub struct Library {
    pub kind: Kind,
    pub group: String,
    pub path: String,
}

/// A finished background pattern load: (group, patterns or the error).
type PatternLoad = (String, Result<Vec<photosuite_doc::Pattern>, String>);

/// Run-time state of the bundled libraries.
#[derive(Default)]
pub struct State {
    /// Waiting for the preset store before importing.
    pending: Vec<Library>,
    /// Pattern libraries not requested yet.
    on_demand: Vec<Library>,
    #[cfg(not(target_arch = "wasm32"))]
    jobs: Vec<std::sync::mpsc::Receiver<PatternLoad>>,
}

impl State {
    pub fn new(libs: Vec<Library>) -> State {
        let (on_demand, pending) = libs.into_iter().partition(|l| l.kind == Kind::PatternsOnDemand);
        State { pending, on_demand, ..Default::default() }
    }
}

fn has_group(app: &PhotosuiteApp, kind: Kind, group: &str) -> bool {
    match kind {
        Kind::Brushes => app.session.tools.presets.iter().any(|p| p.group == group),
        Kind::Gradients => app.session.presets.gradients.iter().any(|g| g.name == group),
        Kind::Shapes => app.session.presets.shapes.iter().any(|g| g.name == group),
        Kind::Patterns | Kind::PatternsOnDemand => false,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn spawn_patterns(app: &mut PhotosuiteApp, lib: Library) {
    let (tx, rx) = std::sync::mpsc::channel();
    app.bundled.jobs.push(rx);
    std::thread::spawn(move || {
        let _ = tx.send((lib.group, photosuite_engine::pattern_cmds::read_pattern_file(&lib.path)));
    });
}

#[cfg(target_arch = "wasm32")]
fn spawn_patterns(_app: &mut PhotosuiteApp, _lib: Library) {}

/// Every frame: import what is due, attach finished pattern loads.
pub fn tick(app: &mut PhotosuiteApp) {
    // Brush presets persist in the store, which loads in the background: wait for it.
    if app.services.preset_store.is_none() && !app.bundled.pending.is_empty() {
        for lib in std::mem::take(&mut app.bundled.pending) {
            if lib.kind == Kind::Patterns {
                spawn_patterns(app, lib);
                continue;
            }
            if has_group(app, lib.kind, &lib.group) {
                continue;
            }
            let cmd = match lib.kind {
                Kind::Brushes => "brush.presets.importAbr",
                Kind::Gradients => "gradient.presets.importGrd",
                _ => "shape.presets.importCsh",
            };
            if let Err(e) = app.run(cmd, serde_json::json!({"path": lib.path, "group": lib.group})) {
                log::warn!("bundled {} not loaded: {e}", lib.group);
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut done = Vec::new();
        app.bundled.jobs.retain(|rx| match rx.try_recv() {
            Ok(r) => {
                done.push(r);
                false
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => true,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => false,
        });
        for (group, r) in done {
            match r {
                Ok(pats) => photosuite_engine::pattern_cmds::attach_group(&mut app.session, &group, pats),
                Err(e) => log::warn!("bundled patterns {group} not loaded: {e}"),
            }
        }
    }
}

/// The Patterns panel is showing: start loading the libraries kept for that moment.
pub fn patterns_wanted(app: &mut PhotosuiteApp) {
    for lib in std::mem::take(&mut app.bundled.on_demand) {
        spawn_patterns(app, lib);
    }
}

/// Whether pattern libraries are still loading (the panel can say so).
pub fn patterns_loading(app: &PhotosuiteApp) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        !app.bundled.jobs.is_empty()
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = app;
        false
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn res(rel: &str) -> String {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources").join(rel).to_string_lossy().into_owned()
    }

    #[test]
    fn bundled_libraries_load_into_their_panels_once() {
        let libs = vec![
            Library { kind: Kind::Gradients, group: "uiGradients".into(), path: res("gradients/uigradients.grd") },
            Library { kind: Kind::Shapes, group: "Font Awesome".into(), path: res("shapes/shapes.csh") },
            Library { kind: Kind::Brushes, group: "Markers".into(), path: res("brushes/Markers.abr") },
            Library { kind: Kind::Patterns, group: "Subtle Patterns".into(), path: res("patterns/patterns.pat") },
        ];
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), Default::default());
        app.bundled = State::new(libs.clone());
        tick(&mut app);
        assert!(has_group(&app, Kind::Gradients, "uiGradients"));
        assert!(app.session.presets.shapes.iter().any(|g| g.name == "Font Awesome" && g.items.len() > 2000));
        assert!(has_group(&app, Kind::Brushes, "Markers"));
        // Patterns arrive from the background thread.
        for _ in 0..200 {
            tick(&mut app);
            if !patterns_loading(&app) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let g = app.session.presets.pattern_groups.iter().find(|g| g.name == "Subtle Patterns").expect("patterns attached");
        assert!(!g.items.is_empty());
        // A second launch with the groups present imports nothing again.
        let shapes = app.session.presets.shapes.len();
        app.bundled = State::new(libs.into_iter().filter(|l| l.kind != Kind::Patterns).collect());
        tick(&mut app);
        assert_eq!(app.session.presets.shapes.len(), shapes);
    }
}
