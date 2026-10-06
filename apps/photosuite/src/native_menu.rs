//! The native macOS menu bar.
//!
//! macOS puts an application's menus in the system bar at the top of the screen, not in the
//! window. egui can only draw an in-window bar, so on macOS the app builds a real `NSMenu`
//! through [`muda`] and suppresses the egui one.
//!
//! One source of truth either way: the menu is built from
//! [`photosuite_ui_egui::menus::visible_menu_items`], the same list the in-window bar draws, so
//! Edit › Menus hiding applies here too.
//!
//! Three things have to stay in step with the app:
//!
//! * **Structure** — rebuilt when the set of visible commands changes (Edit › Menus, a plugin
//!   appearing, the recent-files list).
//! * **Enabled and checked state** — polled per frame through
//!   [`photosuite_ui_egui::menus::is_enabled`] and `checked`, which answer per command id
//!   without allocating the whole item list. A handle is only touched when its value actually
//!   changed, because every setter crosses into Objective-C.
//! * **Clicks** — `muda` posts to a process-wide channel; [`NativeMenu::poll`] drains it and
//!   dispatches through the same `menus::invoke` the in-window bar uses.

use std::collections::HashMap;

use muda::accelerator::Accelerator;
use muda::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use photosuite_ui_egui::PhotosuiteApp;
use photosuite_ui_egui::i18n::{self, Lang};

/// Owns the `NSMenu` and the handles needed to keep it in step.
pub struct NativeMenu {
    menu: Menu,
    /// Plain items, by command id.
    normal: HashMap<String, MenuItem>,
    /// Checkable items, by command id.
    checkable: HashMap<String, CheckMenuItem>,
    /// Menu clicks, forwarded by the handler installed in [`NativeMenu::install`].
    events: std::sync::mpsc::Receiver<MenuEvent>,
    /// Last pushed enabled/checked values, so unchanged items are not re-set.
    state: HashMap<String, (bool, Option<bool>)>,
    /// Identifies the current structure; a change rebuilds the bar.
    shape: u64,
}

/// A cheap fingerprint of "which commands are visible, with which labels and shortcuts".
///
/// Hashing the item list is far cheaper than rebuilding an `NSMenu`, and it changes exactly
/// when the structure must: hiding items, a plugin registering, a file joining Open Recent.
fn shape_of(items: &[photosuite_ui_egui::menus::MenuItem], lang: Lang) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    // A language change relabels every item, so it rebuilds the bar like any other change.
    lang.code().hash(&mut h);
    for it in items {
        it.id.hash(&mut h);
        it.label.hash(&mut h);
        it.path.hash(&mut h);
        it.shortcut.hash(&mut h);
        it.checked.is_some().hash(&mut h);
    }
    h.finish()
}

/// The App menu's Quit; dispatched as `file.exit`.
const APP_QUIT: &str = "app.quit";

/// The interface language from Preferences, as the in-window bar resolves it.
fn lang_of(app: &PhotosuiteApp) -> Lang {
    Lang::from_pref(&app.session.prefs().interface.language)
}

/// Our shortcut strings ("Cmd+Alt+Shift+O") are already muda's accelerator syntax.
fn accelerator(sc: Option<&String>) -> Option<Accelerator> {
    let s = sc?;
    match s.parse::<Accelerator>() {
        Ok(a) => Some(a),
        Err(e) => {
            log::warn!("native menu: shortcut {s:?} not understood ({e})");
            None
        }
    }
}

impl NativeMenu {
    /// Build the bar and install it as the application menu. Call once the `NSApp` exists —
    /// inside `eframe`'s creation callback or later, never before.
    ///
    /// Clicks are forwarded through a handler that also requests a repaint. egui runs no frames
    /// while idle, so a click left on muda's own channel waited until something else woke the
    /// app — a choice made with the mouse could sit unhandled, which is how File › Quit
    /// "sometimes" did nothing while ⌘Q (a key event, which wakes it) always worked.
    pub fn install(app: &PhotosuiteApp, ctx: &egui::Context) -> Option<Self> {
        let (tx, events) = std::sync::mpsc::channel();
        let wake = ctx.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            let _ = tx.send(event);
            wake.request_repaint();
        }));
        let items = photosuite_ui_egui::menus::visible_menu_items(app);
        let lang = lang_of(app);
        let menu = Menu::new();
        let mut this = Self { menu, events, normal: HashMap::new(), checkable: HashMap::new(), state: HashMap::new(), shape: shape_of(&items, lang) };
        if let Err(e) = this.build(&items, lang) {
            log::error!("native menu: {e}");
            return None;
        }
        this.menu.init_for_nsapp();
        Some(this)
    }

    /// (Re)populate the bar from `items`.
    /// Labels go through the same catalogue the in-window bar uses (`tr` for menu and submenu
    /// titles, `tr_id` for items), falling back to English where a language has no entry.
    fn build(&mut self, items: &[photosuite_ui_egui::menus::MenuItem], lang: Lang) -> muda::Result<()> {
        self.normal.clear();
        self.checkable.clear();
        self.state.clear();

        // The application menu macOS expects first: About, Services, Hide/Show, Quit. Quit is
        // routed through our own command so unsaved work still prompts.
        let app_menu = Submenu::new("PhotoSuite", true);
        let about = MenuItem::with_id("help.about", i18n::tr(lang, "About PhotoSuite"), true, None);
        app_menu.append(&about)?;
        self.normal.insert("help.about".into(), about);
        app_menu.append(&PredefinedMenuItem::separator())?;
        let prefs = MenuItem::with_id("edit.preferences.general", i18n::tr(lang, "Settings…"), true, accelerator(Some(&"Cmd+,".to_string())));
        app_menu.append(&prefs)?;
        self.normal.insert("edit.preferences.general".into(), prefs);
        app_menu.append(&PredefinedMenuItem::separator())?;
        app_menu.append(&PredefinedMenuItem::services(None))?;
        app_menu.append(&PredefinedMenuItem::separator())?;
        // Named explicitly: AppKit's default takes the process name, `photosuite` outside a bundle.
        app_menu.append(&PredefinedMenuItem::hide(Some(i18n::tr(lang, "Hide PhotoSuite"))))?;
        app_menu.append(&PredefinedMenuItem::hide_others(None))?;
        app_menu.append(&PredefinedMenuItem::separator())?;
        // Its own id, dispatched as `file.exit` in `poll`. On macOS quitting lives here only, so
        // File › Exit is left out of the tree below (Windows and Linux keep it).
        let quit = MenuItem::with_id(APP_QUIT, i18n::tr(lang, "Quit PhotoSuite"), true, accelerator(Some(&"Cmd+Q".to_string())));
        app_menu.append(&quit)?;
        self.normal.insert(APP_QUIT.into(), quit);
        self.menu.append(&app_menu)?;

        // On macOS quitting lives in the App menu only, so File › Exit is dropped — and the
        // separators re-tidied, or the one above it would be left at the bottom of File.
        let mut items = items.to_vec();
        items.retain(|it| it.id != "file.exit");
        photosuite_ui_egui::menus::tidy_separators(&mut items);
        let items = items.as_slice();

        // Then the app's own tree, in catalogue order. `path` is the nesting: ["Filter", "Blur"].
        //
        // Only paths that actually carry a command get a submenu. A menu whose every item is
        // hidden (Edit › Menus) can still contribute separators, and creating submenus from
        // those would rebuild the branch as an empty shell — which is how the Type menu came
        // back after being hidden.
        let mut real: std::collections::HashSet<Vec<String>> = std::collections::HashSet::new();
        for it in items.iter().filter(|it| it.id != "---") {
            for depth in 1..=it.path.len() {
                real.insert(it.path[..depth].to_vec());
            }
        }
        let mut subs: HashMap<Vec<String>, Submenu> = HashMap::new();
        for it in items {
            let Some((top, _)) = it.path.split_first() else { continue };
            if !real.contains(&it.path) {
                continue;
            }
            // Create every level of this item's path that does not exist yet.
            for depth in 1..=it.path.len() {
                let key = it.path[..depth].to_vec();
                if subs.contains_key(&key) {
                    continue;
                }
                let title = key.last().cloned().unwrap_or_else(|| top.clone());
                let sub = Submenu::new(i18n::tr(lang, &title), true);
                match depth {
                    1 => self.menu.append(&sub)?,
                    _ => subs[&key[..depth - 1].to_vec()].append(&sub)?,
                }
                subs.insert(key, sub);
            }
            let parent = &subs[&it.path];
            if it.id == "---" {
                parent.append(&PredefinedMenuItem::separator())?;
                continue;
            }
            // The App menu already owns About and Settings.
            if self.normal.contains_key(&it.id) {
                continue;
            }
            match it.checked {
                Some(on) => {
                    let item = CheckMenuItem::with_id(&it.id, i18n::tr_id(lang, &it.id, &it.label), it.enabled, on, accelerator(it.shortcut.as_ref()));
                    parent.append(&item)?;
                    self.state.insert(it.id.clone(), (it.enabled, Some(on)));
                    self.checkable.insert(it.id.clone(), item);
                }
                None => {
                    let item = MenuItem::with_id(&it.id, i18n::tr_id(lang, &it.id, &it.label), it.enabled, accelerator(it.shortcut.as_ref()));
                    parent.append(&item)?;
                    self.state.insert(it.id.clone(), (it.enabled, None));
                    self.normal.insert(it.id.clone(), item);
                }
            }
        }
        Ok(())
    }

    /// Per-frame upkeep: rebuild when the structure changed, otherwise push only the
    /// enabled/checked values that actually moved.
    pub fn sync(&mut self, app: &PhotosuiteApp) {
        let items = photosuite_ui_egui::menus::visible_menu_items(app);
        let lang = lang_of(app);
        let shape = shape_of(&items, lang);
        if shape != self.shape {
            // `init_for_nsapp` installs whatever the Menu holds, so rebuilding in place is
            // enough; dropping and recreating the Menu would detach the bar.
            for _ in 0..self.menu.items().len() {
                let _ = self.menu.remove_at(0);
            }
            if let Err(e) = self.build(&items, lang) {
                log::error!("native menu rebuild: {e}");
            }
            self.menu.init_for_nsapp();
            self.shape = shape;
            return;
        }
        for (id, cached) in self.state.iter_mut() {
            let enabled = photosuite_ui_egui::menus::is_live(id) && photosuite_ui_egui::menus::is_enabled(app, id);
            let checked = photosuite_ui_egui::menus::checked(app, id);
            if cached.0 != enabled {
                if let Some(i) = self.normal.get(id) {
                    i.set_enabled(enabled);
                } else if let Some(i) = self.checkable.get(id) {
                    i.set_enabled(enabled);
                }
                cached.0 = enabled;
            }
            if cached.1 != checked
                && let (Some(i), Some(on)) = (self.checkable.get(id), checked)
            {
                i.set_checked(on);
                cached.1 = checked;
            }
        }
    }

    /// Dispatch any menu clicks that arrived since the last frame.
    pub fn poll(&self, app: &mut PhotosuiteApp, ctx: &egui::Context) {
        while let Ok(event) = self.events.try_recv() {
            let id = if event.id.0 == APP_QUIT { "file.exit".to_string() } else { event.id.0.clone() };
            if let Err(e) = photosuite_ui_egui::menus::invoke(app, ctx, &id, serde_json::json!({})) {
                log::warn!("native menu: {id} failed: {e}");
            }
            ctx.request_repaint();
        }
    }
}

/// Wraps the app so the native bar is polled and synced around each frame.
///
/// The menu is driven from here rather than from inside `PhotosuiteApp::update` because
/// `muda` is a native-only dependency and `photosuite-ui-egui` also compiles to WebAssembly.
pub struct WithNativeMenu {
    pub app: PhotosuiteApp,
    pub menu: NativeMenu,
}

impl eframe::App for WithNativeMenu {
    fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        // Clicks first, so a command runs in the same frame it was chosen.
        self.menu.poll(&mut self.app, ctx);
        self.app.logic(ctx, frame);
        // Then reflect whatever the frame changed (document opened, layer selected, …).
        self.menu.sync(&self.app);
    }

    fn raw_input_hook(&mut self, ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        self.app.raw_input_hook(ctx, raw_input);
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.app.ui(ui, frame);
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        self.app.save(storage);
    }
}
