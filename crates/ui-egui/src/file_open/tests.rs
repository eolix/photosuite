use super::*;
use crate::{Services, menus, notices};
use photosuite_color::{ColorMode, SampleType};
use photosuite_doc::Document;
use photosuite_geom::Size;
use serde_json::json;
use std::cell::RefCell;
use std::rc::Rc;

/// Writes recorded by the fake writer: (path, bytes).
type Written = Rc<RefCell<Vec<(String, Vec<u8>)>>>;

/// An app whose importer names the document after the file (like `photosuite-io`) and reports a
/// warning for names containing "warn", and fails for bytes "bad"; the exporter warns for ".png"
/// and the writer records what it wrote.
fn app_with(pick_open: Option<(String, Vec<u8>)>, pick_save: Option<String>) -> (PhotosuiteApp, Written) {
    let written: Written = Rc::default();
    let w = written.clone();
    let mut pick_open = pick_open;
    let services = Services {
        import: Some(Box::new(|name: &str, bytes: &[u8]| {
            if bytes == b"bad" {
                return Err("not an image".into());
            }
            let warnings = if name.contains("warn") { vec!["Adjustment layer \"Curves 1\" was flattened".to_string()] } else { Vec::new() };
            Ok((Document::new(name, Size::new(4, 4), ColorMode::Rgb, SampleType::U8), warnings))
        })),
        export: Some(Box::new(|_doc: &Document, path: &str, _s: &crate::ExportSettings| {
            let warnings = if path.ends_with(".png") { vec!["Layers were flattened".to_string()] } else { Vec::new() };
            Ok((b"out".to_vec(), warnings))
        })),
        pick_open: Some(Box::new(move || pick_open.take().map(|(name, bytes)| (name, Ok(bytes))))),
        pick_save: Some(Box::new(move |_s: &str| pick_save.clone())),
        write: Some(Box::new(move |p: &str, b: &[u8]| {
            w.borrow_mut().push((p.to_string(), b.to_vec()));
            Ok(())
        })),
        ..Default::default()
    };
    (PhotosuiteApp::new(photosuite_engine::Session::new(), services), written)
}

#[test]
fn display_name_is_the_file_name() {
    assert_eq!(display_name("/a/b/photo.psd"), "photo.psd");
    assert_eq!(display_name("photo.psd"), "photo.psd");
    assert_eq!(display_name(""), "");
    assert_eq!(display_name("/"), "/");
}

#[test]
fn open_file_sets_name_path_and_recent() {
    let (mut app, _) = app_with(None, None);
    let w = app.open_file("/pics/cat.psd", b"x").unwrap();
    assert!(w.is_empty());
    let st = app.session.active().unwrap();
    assert_eq!(st.doc.name, "cat.psd");
    assert_eq!(st.path.as_deref(), Some("/pics/cat.psd"));
    assert_eq!(app.ui.recent_files, vec!["/pics/cat.psd".to_string()]);
    assert!(!app.ui.status_error);
    assert!(app.ui.notices.is_empty());
}

#[test]
fn file_open_dialog_sets_path_so_save_writes_in_place() {
    // The dialog returns a full path: the document is named after the file, not the path.
    let (mut app, written) = app_with(Some(("/pics/cat.psd".into(), b"x".to_vec())), None);
    let ctx = egui::Context::default();
    menus::invoke(&mut app, &ctx, "file.open", json!({})).unwrap();
    let st = app.session.active().unwrap();
    assert_eq!(st.doc.name, "cat.psd");
    assert_eq!(st.path.as_deref(), Some("/pics/cat.psd"));
    assert_eq!(app.ui.recent_files.first().map(String::as_str), Some("/pics/cat.psd"));
    // File › Save goes straight back to the file (pick_save would return None = cancelled).
    let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert_eq!(r["path"], "/pics/cat.psd");
    assert_eq!(written.borrow().last().map(|(p, _)| p.clone()).as_deref(), Some("/pics/cat.psd"));
}

#[test]
fn file_open_dialog_opens_every_selected_path() {
    let dir = std::env::temp_dir().join(format!("photosuite-issue-595-open-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let paths = ["one.psd", "two.png"].map(|name| {
        let path = dir.join(name);
        std::fs::write(&path, b"x").unwrap();
        path.to_string_lossy().into_owned()
    });
    let (mut app, _) = app_with(None, None);
    let selected = paths.to_vec();
    app.services.pick_open_paths = Some(Box::new(move || Some(selected.clone())));

    menus::invoke(&mut app, &egui::Context::default(), "file.open", json!({})).unwrap();

    assert_eq!(app.session.documents().len(), 2);
    assert_eq!(
        app.session.documents().iter().map(|doc| doc.path.as_deref()).collect::<Vec<_>>(),
        paths.iter().map(|path| Some(path.as_str())).collect::<Vec<_>>()
    );
    assert_eq!(app.ui.recent_files, vec![paths[1].clone(), paths[0].clone()]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancelling_multi_file_open_does_not_fall_back_to_single_file_picker() {
    let (mut app, _) = app_with(Some(("/pics/unexpected.psd".into(), b"x".to_vec())), None);
    app.services.pick_open_paths = Some(Box::new(|| None));

    menus::invoke(&mut app, &egui::Context::default(), "file.open", json!({})).unwrap();

    assert!(app.session.documents().is_empty());
}

#[test]
fn save_writes_every_writable_format_in_place_and_asks_for_the_rest() {
    let (mut app, written) = app_with(None, None);
    let ctx = egui::Context::default();
    // Layered, native and flat formats alike go straight back to their file.
    for (i, path) in ["/pics/work.pcraft", "/pics/flat.png", "/pics/photo.JPEG", "/pics/scan.tiff", "/pics/icon.bmp"].into_iter().enumerate() {
        app.open_file(path, b"x").unwrap();
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        assert_eq!(r["path"], path, "{path}: {r}");
        assert_eq!(written.borrow().len(), i + 1, "{path}");
        assert!(!app.session.active().unwrap().is_dirty());
    }
    let n = written.borrow().len();
    // A PDF page, a camera raw file and a new document have nothing to write in place: Save As.
    for path in ["/pics/brochure.pdf", "/pics/raw.NEF"] {
        app.open_file(path, b"x").unwrap();
        let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
        let d = app.ui.dialog_mut(r["dialog"].as_u64().unwrap()).unwrap();
        assert!(d.fields.contains_key("__saveAs"), "{path}");
    }
    app.run("file.new", json!({"width": 8, "height": 8})).unwrap();
    let r = menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert!(r["dialog"].is_u64(), "{r}");
    assert_eq!(written.borrow().len(), n);
    // Closing with unsaved changes can't wait for a dialog: it uses the file picker (cancelled here).
    assert_eq!(menus::save_or_pick(&mut app).unwrap_err(), "cancelled");
    // Saved by the exporter (here as a PSD), a file no longer replays the Save As screen's settings.
    app.open_file("/pics/web.png", b"x").unwrap();
    app.session.active_mut().unwrap().save_options.web = Some(json!({"format": "png8"}));
    menus::invoke(&mut app, &ctx, "file.saveAs", json!({"path": "/pics/web.psd"})).unwrap();
    assert_eq!(app.session.active().unwrap().save_options.web, None);
}

#[test]
fn save_keeps_the_quality_the_file_was_opened_with() {
    let seen: Rc<RefCell<Vec<crate::ExportSettings>>> = Rc::default();
    let s2 = seen.clone();
    let services = Services {
        import: Some(Box::new(|name: &str, _b: &[u8]| Ok((Document::new(name, Size::new(4, 4), ColorMode::Rgb, SampleType::U8), Vec::new())))),
        export: Some(Box::new(move |_d: &Document, _p: &str, s: &crate::ExportSettings| {
            s2.borrow_mut().push(s.clone());
            Ok((b"out".to_vec(), Vec::new()))
        })),
        write: Some(Box::new(|_p: &str, _b: &[u8]| Ok(()))),
        ..Default::default()
    };
    let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), services);
    let ctx = egui::Context::default();
    let img = photosuite_codecs::Image::from_u8(8, 8, photosuite_codecs::ChannelLayout::Rgb, vec![128; 8 * 8 * 3]).unwrap();
    let jpeg = photosuite_codecs::encode(&img, photosuite_codecs::Format::Jpeg, &photosuite_codecs::EncodeOptions { jpeg_quality: 42, ..Default::default() }).unwrap();
    app.open_file("/pics/a.jpg", &jpeg).unwrap();
    assert_eq!(app.session.active().unwrap().save_options.jpeg_quality, Some(42));
    menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert_eq!(seen.borrow().last().unwrap().jpeg_quality, Some(42));
    // A lossy WebP stays lossy; a lossless one stays lossless.
    let enc = |lossless| {
        let o = photosuite_codecs::EncodeOptions { webp_lossless: lossless, webp_quality: 60, ..Default::default() };
        photosuite_codecs::encode(&img, photosuite_codecs::Format::WebP, &o).unwrap()
    };
    app.open_file("/pics/lossy.webp", &enc(false)).unwrap();
    menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert_eq!(seen.borrow().last().unwrap().webp_quality, Some(75));
    app.open_file("/pics/lossless.webp", &enc(true)).unwrap();
    menus::invoke(&mut app, &ctx, "file.save", json!({})).unwrap();
    assert_eq!(seen.borrow().last().unwrap().webp_quality, None);
    // Unreadable bytes keep the defaults rather than failing the open.
    assert_eq!(save_options_of("/x.jpg", b"junk"), photosuite_engine::SaveOptions::default());
    assert_eq!(save_options_of("/x.webp", b""), photosuite_engine::SaveOptions::default());
}

#[test]
fn import_warnings_reach_status_notice_and_control_response() {
    let dir = std::env::temp_dir().join(format!("photosuite-open-warn-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("warn.psd");
    std::fs::write(&path, b"x").unwrap();
    let p = path.to_string_lossy().to_string();
    let (mut app, _) = app_with(None, None);
    let ctx = egui::Context::default();
    let r = menus::invoke(&mut app, &ctx, "file.open", json!({ "path": p })).unwrap();
    assert_eq!(r["warnings"][0], "Adjustment layer \"Curves 1\" was flattened");
    assert!(app.ui.status.contains("was flattened"), "{}", app.ui.status);
    assert!(app.ui.status_error);
    assert_eq!(app.ui.notices.len(), 1);
    assert!(!app.ui.notices[0].error);
    assert_eq!(app.ui.notices[0].lines.len(), 1);
    // The document still opened, with its path.
    assert_eq!(app.session.active().and_then(|s| s.path.clone()), Some(p));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn export_warnings_reach_status_notice_and_control_response() {
    let (mut app, _) = app_with(None, None);
    let ctx = egui::Context::default();
    app.open_file("/pics/cat.psd", b"x").unwrap();
    let r = menus::invoke(&mut app, &ctx, "file.saveAs", json!({ "path": "/pics/cat.png" })).unwrap();
    assert_eq!(r["path"], "/pics/cat.png");
    assert_eq!(r["warnings"][0], "Layers were flattened");
    assert!(app.ui.status.contains("Saved cat.png"), "{}", app.ui.status);
    assert_eq!(app.ui.notices.len(), 1);
    // No warnings: no notice, and the response says so.
    let r = menus::invoke(&mut app, &ctx, "file.saveAs", json!({ "path": "/pics/cat.psd" })).unwrap();
    assert_eq!(r["warnings"], json!([]));
    assert_eq!(app.ui.notices.len(), 1);
}

#[test]
fn open_failures_are_errors_and_leave_no_document() {
    let (mut app, _) = app_with(Some(("/pics/broken.psd".into(), b"bad".to_vec())), None);
    let ctx = egui::Context::default();
    menus::invoke(&mut app, &ctx, "file.open", json!({})).unwrap();
    assert!(app.session.documents().is_empty());
    assert!(app.ui.recent_files.is_empty());
    assert!(app.ui.status_error);
    assert!(app.ui.status.starts_with("Couldn't open broken.psd"), "{}", app.ui.status);
    assert!(app.ui.notices.last().is_some_and(|n| n.error));
}

#[test]
fn a_picked_file_that_cannot_be_read_is_reported_like_any_open_failure() {
    let (mut app, _) = app_with(None, None);
    let mut picked = Some(("C:/photos/big.psb".to_string(), Err("The parameter is incorrect. (os error 87)".to_string())));
    app.services.pick_open = Some(Box::new(move || picked.take()));
    app.open_dialog_file();
    assert!(app.session.documents().is_empty());
    assert!(app.ui.status_error);
    let notice = app.ui.notices.last().unwrap();
    assert!(notice.error && notice.title.contains("Couldn't open big.psb: The parameter is incorrect"), "{}", notice.title);
    // Commands that read a picked file (scripts, notes, Place) get the same message as an error.
    app.services.pick_open = Some(Box::new(|| Some(("C:/photos/big.psb".to_string(), Err("denied".to_string())))));
    assert_eq!(app.pick_file_bytes(), Some(Err("big.psb: denied".to_string())));
    app.services.pick_open = Some(Box::new(|| None));
    assert_eq!(app.pick_file_bytes(), None, "cancelled");
}

#[test]
fn open_paths_reports_each_failure_without_panicking() {
    let (mut app, _) = app_with(None, None);
    let missing = std::env::temp_dir().join("photosuite-definitely-missing-file.psd").to_string_lossy().to_string();
    let dir = std::env::temp_dir().to_string_lossy().to_string();
    let n = app.open_paths(&[missing, String::new(), dir, "\u{0}".into()]);
    assert_eq!(n, 0);
    assert!(app.session.documents().is_empty());
    assert!(app.ui.status_error);
    assert_eq!(app.ui.notices.len(), notices::MAX_NOTICES);
    // Bad control params error instead of panicking.
    let ctx = egui::Context::default();
    assert!(menus::invoke(&mut app, &ctx, "file.open", json!({ "path": "" })).is_err());
}

#[test]
fn os_open_events_open_files_with_paths() {
    let dir = std::env::temp_dir().join(format!("photosuite-os-open-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let a = dir.join("a.psd");
    let b = dir.join("b.png");
    std::fs::write(&a, b"x").unwrap();
    std::fs::write(&b, b"x").unwrap();
    let paths: Vec<String> = [&a, &b].iter().map(|p| p.to_string_lossy().to_string()).collect();
    let (mut app, _) = app_with(None, None);
    let mut queue = vec![OsEvent::Open(paths.clone())];
    app.services.os_events = Some(Box::new(move || std::mem::take(&mut queue)));
    let ctx = egui::Context::default();
    app.drain_os_events(&ctx);
    assert_eq!(app.session.documents().len(), 2);
    assert_eq!(app.session.active().and_then(|s| s.path.clone()).as_deref(), Some(paths[1].as_str()));
    assert_eq!(app.ui.recent_files, vec![paths[1].clone(), paths[0].clone()]);
    // Drained: a second poll opens nothing more.
    app.drain_os_events(&ctx);
    assert_eq!(app.session.documents().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn os_quit_and_empty_events_do_not_panic() {
    let (mut app, _) = app_with(None, None);
    let mut queue = vec![OsEvent::Open(Vec::new()), OsEvent::Quit];
    app.services.os_events = Some(Box::new(move || std::mem::take(&mut queue)));
    app.drain_os_events(&egui::Context::default());
    assert!(app.session.documents().is_empty());
}

#[derive(Debug)]
struct FakeDrop(std::path::PathBuf, Result<Vec<u8>, String>);

impl egui::DroppedFile for FakeDrop {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
    fn bytes(&self) -> Result<Vec<u8>, String> {
        self.1.clone()
    }
}

#[test]
fn dropped_files_open_with_path_and_recent() {
    let (mut app, _) = app_with(None, None);
    let dir = std::env::temp_dir().join(format!("photosuite-drop-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let abs = dir.join("dropped.psd");
    std::fs::write(&abs, b"x").unwrap();
    let abs_s = abs.to_string_lossy().to_string();
    app.open_dropped(vec![
        // A desktop drop (absolute path) is read from disk like File › Open (#375), never through
        // egui's whole-file `std::fs::read`.
        std::sync::Arc::new(FakeDrop(abs, Err("egui's reader must not be used".into()))),
        // Unreadable and undecodable drops are errors; no path means no recent entry.
        std::sync::Arc::new(FakeDrop("gone.psd".into(), Err("permission denied".into()))),
        std::sync::Arc::new(FakeDrop("rel.psd".into(), Ok(b"x".to_vec()))),
        std::sync::Arc::new(FakeDrop("".into(), Ok(b"bad".to_vec()))),
    ]);
    assert_eq!(app.session.documents().len(), 2);
    assert_eq!(app.session.documents()[0].path.as_deref(), Some(abs_s.as_str()));
    assert_eq!(app.session.documents()[0].doc.name, "dropped.psd");
    assert_eq!(app.session.documents()[1].path, None);
    assert_eq!(app.ui.recent_files, vec![abs_s]);
    assert!(app.ui.status_error);
    assert_eq!(app.ui.notices.iter().filter(|n| n.error).count(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn notices_are_capped_and_dismissable_state_round_trips() {
    let (mut app, _) = app_with(None, None);
    for i in 0..10 {
        notices::post(&mut app, format!("n{i}"), vec![], false);
    }
    assert_eq!(app.ui.notices.len(), notices::MAX_NOTICES);
    assert_eq!(app.ui.notices.last().map(|n| n.title.as_str()), Some("n9"));
    // Notices are part of the serialized UI state (ui.inspect / ui.set).
    let v = serde_json::to_value(&app.ui).unwrap();
    assert_eq!(v["notices"].as_array().map(Vec::len), Some(notices::MAX_NOTICES));
    let back: crate::UiState = serde_json::from_value(v).unwrap();
    assert_eq!(back.notices, app.ui.notices);
}

#[test]
fn notices_render_without_panicking() {
    let (mut app, _) = app_with(None, None);
    notices::post(&mut app, "Opened a.psd with 9 warnings", (0..9).map(|i| format!("warning {i}")).collect(), false);
    notices::error(&mut app, "Couldn't open b.psd: not an image".into());
    let ctx = egui::Context::default();
    let mut out = ctx.run_ui(Default::default(), |ui| notices::show(&mut app, ui.ctx()));
    out.textures_delta.clear();
    assert_eq!(app.ui.notices.len(), 2);
}

#[test]
fn save_as_is_the_save_for_web_screen_with_document_formats() {
    let dir = std::env::temp_dir().join(format!("photosuite-saveas-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let jpg = dir.join("cat.jpg").to_string_lossy().into_owned();
    let (mut app, written) = app_with(None, Some("/pics/cat.psd".into()));
    let ctx = egui::Context::default();
    app.run("file.new", json!({"width": 32, "height": 24, "name": "cat"})).unwrap();
    // An untitled document starts on PSD, saved through the document exporter.
    let r = menus::invoke(&mut app, &ctx, "file.saveAs", json!({})).unwrap();
    let id = r["dialog"].as_u64().unwrap();
    assert_eq!(app.ui.dialog_mut(id).unwrap().fields["format"], "psd");
    let r = crate::dialogs::confirm(&mut app, id).unwrap();
    assert_eq!(r["path"], "/pics/cat.psd");
    assert_eq!(written.borrow().last().map(|(p, _)| p.clone()).as_deref(), Some("/pics/cat.psd"));
    assert_eq!(app.session.active().and_then(|d| d.path.clone()).as_deref(), Some("/pics/cat.psd"));
    // A web format writes the optimised file, and the document becomes that file.
    app.run("image.invert", json!({})).ok();
    let r = menus::invoke(&mut app, &ctx, "file.saveAs", json!({})).unwrap();
    let id = r["dialog"].as_u64().unwrap();
    let d = app.ui.dialog_mut(id).unwrap();
    d.fields.insert("format".into(), json!("jpeg"));
    d.fields.insert("path".into(), json!(jpg));
    crate::dialogs::confirm(&mut app, id).unwrap();
    assert!(std::fs::read(&jpg).unwrap().starts_with(&[0xff, 0xd8]));
    let st = app.session.active().unwrap();
    assert_eq!(st.path.as_deref(), Some(jpg.as_str()));
    assert_eq!(st.saved_revision, st.revision);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn multi_page_pdfs_ask_which_page() {
    let page = || {
        let img = photosuite_codecs::Image::from_u8(8, 8, photosuite_codecs::ChannelLayout::Rgb, vec![200; 8 * 8 * 3]).unwrap();
        (8u32, 8u32, 72.0f32, photosuite_codecs::encode(&img, photosuite_codecs::Format::Jpeg, &photosuite_codecs::EncodeOptions::default()).unwrap())
    };
    let pdf = photosuite_io::pdf::raster_pdf(&[page(), page(), page()]);
    let dir = std::env::temp_dir().join(format!("photosuite-pdfui-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("deck.pdf").to_string_lossy().into_owned();
    std::fs::write(&path, &pdf).unwrap();
    let (mut app, _) = app_with(None, None);
    app.open_file(&path, &pdf).unwrap();
    assert!(app.session.documents().is_empty(), "nothing opened yet");
    let d = app.ui.dialogs.last().expect("Import PDF");
    assert_eq!(d.fields["__command"], "file.importPdf");
    assert_eq!(d.fields["page"], 1);
    let _ = std::fs::remove_dir_all(&dir);
}
