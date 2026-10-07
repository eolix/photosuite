//! Native platform services: file dialogs (rfd), filesystem, codecs.

use photosuite_codecs::{ChannelLayout, EncodeOptions, Image, SampleType as CS};
use photosuite_color::{ColorMode, SampleType};
use photosuite_doc::{Document, Layer, Size};
use photosuite_format::Autosaver;
use photosuite_geom::Rect;
use photosuite_ui_egui::Services;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

/// Everything File › Open reads: PhotoSuite and Photoshop documents, flat images, and Photoshop
/// brushes (.abr) and gradients (.grd), which go to the preset libraries.
const OPEN_EXTS: &[&str] = &[
    "pcraft", "psd", "psb", "png", "jpg", "jpeg", "tif", "tiff", "webp", "gif", "bmp", "tga", "ico", "qoi", "exr", "hdr", "pbm", "pgm", "ppm", "pam", "pfm",
    "dng", "cr2", "cr3", "nef", "nrw", "arw", "pef", "orf", "rw2", "raf", "abr", "grd", "pdf",
];

/// File › Save As formats: (filter name, extensions). The filter matching the suggested name's
/// extension comes first; anything else defaults to Photoshop. The native .pcraft format isn't
/// offered (it still opens, and an opened .pcraft file still saves in place).
const SAVE_FILTERS: &[(&str, &[&str])] =
    &[("Photoshop", &["psd", "psb"]), ("PNG", &["png"]), ("JPEG", &["jpg"]), ("TIFF", &["tif"]), ("OpenEXR", &["exr"]), ("PDF", &["pdf"])];

/// [`SAVE_FILTERS`] with the one for `suggested`'s extension first.
fn save_filters(suggested: &str) -> Vec<(&'static str, &'static [&'static str])> {
    let ext = Path::new(suggested).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let mut v = SAVE_FILTERS.to_vec();
    if let Some(i) = v.iter().position(|(_, exts)| exts.contains(&ext.as_str())) {
        let f = v.remove(i);
        v.insert(0, f);
    }
    v
}

/// Per-user settings directory: `PHOTOSUITE_CONFIG_DIR`, else `<exe dir>/PhotoSuiteData` in
/// portable mode, else the platform convention. Everything the app persists lives under it; see
/// [`crate::app_dirs`].
pub fn config_dir() -> Option<PathBuf> {
    crate::app_dirs::config_dir()
}

pub fn prefs_file() -> Option<PathBuf> {
    config_dir().map(|d| d.join("preferences.json"))
}

/// The brush preset store (one file per preset group plus tip bitmaps; see
/// `photosuite_engine::preset_store`).
pub fn presets_dir() -> Option<PathBuf> {
    config_dir().map(|d| d.join("Presets"))
}

fn recovery_dir() -> Option<PathBuf> {
    config_dir().map(|d| d.join("Recovery"))
}

/// Write `bytes` crash-safely (temp file beside the target, fsync, rename, directory fsync; see
/// [`photosuite_format::atomic`]). Every document write (Save, Save As, Export, Save for Web) and
/// the preferences go through here, so a failed or interrupted save never destroys the old file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    photosuite_format::atomic_write(path, bytes).map_err(|e| e.to_string())
}

/// Where the bundled resources live, first match wins:
///
/// 1. `PHOTOSUITE_RESOURCES`, to point a build at another copy;
/// 2. the app bundle, `Contents/Resources/resources` on macOS;
/// 3. a `resources` folder beside the executable (Windows, portable installs), or
///    `../share/photosuite/resources` relative to it (Linux and FreeBSD packages);
/// 4. `resources/` in the source checkout, for development builds.
pub fn resources_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PHOTOSUITE_RESOURCES").map(PathBuf::from).filter(|p| p.is_dir()) {
        return Some(p);
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("../Resources/resources"),
        exe_dir.join("resources"),
        exe_dir.join("../share/photosuite/resources"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources"),
    ];
    candidates.into_iter().find(|p| p.is_dir()).and_then(|p| p.canonicalize().ok())
}

/// The preset libraries in `resources/` and the panel groups they become (see
/// `photosuite_ui_egui::bundled`). Licences are beside each file and in THIRD-PARTY-NOTICES.md.
pub fn bundled_libraries() -> Vec<photosuite_ui_egui::bundled::Library> {
    use photosuite_ui_egui::bundled::{Kind, Library};
    let Some(root) = resources_dir() else { return Vec::new() };
    [
        (Kind::Gradients, "uiGradients", "gradients/uigradients.grd"),
        (Kind::Shapes, "Font Awesome", "shapes/shapes.csh"),
        (Kind::Brushes, "Markers", "brushes/Markers.abr"),
        (Kind::Brushes, "Paintbrush Set", "brushes/Paintbrush_Set.abr"),
        (Kind::Brushes, "Pencil Scribbles", "brushes/Pencil_Scribbles.abr"),
        (Kind::Patterns, "Subtle Patterns", "patterns/patterns.pat"),
        (Kind::PatternsOnDemand, "Subtle Patterns (more)", "patterns/extra_patterns.pat"),
    ]
    .into_iter()
    .map(|(kind, group, rel)| (kind, group, root.join(rel)))
    .filter(|(_, _, p)| p.is_file())
    .map(|(kind, group, p)| Library { kind, group: group.to_string(), path: p.to_string_lossy().into_owned() })
    .collect()
}

/// Registers the measured lens profiles (`resources/lensfun/lens-database.json`), read the first
/// time Lens Correction needs them; without the file it keeps its generic profiles.
pub fn register_lens_profiles() {
    let Some(path) = resources_dir().map(|d| d.join("lensfun/lens-database.json")) else { return };
    photosuite_engine::lens_cmds::set_lens_database_loader(Box::new(move || match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) => {
            log::warn!("lens profiles not loaded from {}: {e}", path.display());
            None
        }
    }));
}

pub fn native(automation: Option<photosuite_automation::AuthorizedWorkspace>) -> Services {
    let savers: Rc<RefCell<HashMap<u64, Autosaver>>> = Rc::default();
    let savers2 = savers.clone();
    let clip: Rc<RefCell<Option<arboard::Clipboard>>> = Rc::default();
    let automation_read = automation.clone().map(|workspace| {
        Box::new(move |path: &str| {
            let bytes = workspace.read(path).map_err(|error| error.to_string())?;
            let name = Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or(path).to_string();
            Ok((name, bytes))
        }) as photosuite_ui_egui::AutomationReadFn
    });
    let automation_write = automation.clone().map(|workspace| {
        Box::new(move |path: &str, bytes: &[u8]| workspace.write(path, bytes).map_err(|error| error.to_string())) as photosuite_ui_egui::AutomationWriteFn
    });
    let automation_command = automation.map(|_| {
        Box::new(|id: &str, params: &serde_json::Value| {
            photosuite_automation::workspace::authorize_desktop_engine_command(id, params).map_err(|error| error.to_string())
        }) as photosuite_ui_egui::AutomationCommandFn
    });
    Services {
        import: Some(Box::new(|name: &str, bytes: &[u8]| {
            crate::crash_guard::guard("Open", || photosuite_io::import(name, bytes).map(|r| (r.document, r.warnings)).map_err(|e| e.to_string()))
        })),
        export: Some(Box::new(|doc: &Document, path: &str, settings: &photosuite_ui_egui::ExportSettings| {
            let mut opts = photosuite_io::ExportOptions::default();
            if let Some(q) = settings.jpeg_quality {
                opts.encode.jpeg_quality = q;
            }
            if let Some(q) = settings.webp_quality {
                opts.encode.webp_lossless = false;
                opts.encode.webp_quality = q;
            }
            crate::crash_guard::guard("Export", || photosuite_io::export(doc, path, &opts).map(|r| (r.bytes, r.warnings)).map_err(|e| e.to_string()))
        })),
        pick_open: Some(Box::new(|| {
            let path = rfd::FileDialog::new().add_filter("All Formats", OPEN_EXTS).add_filter("PhotoSuite", &["pcraft"]).pick_file()?;
            let bytes = std::fs::read(&path).ok()?;
            Some((path.to_string_lossy().to_string(), bytes))
        })),
        pick_file: Some(Box::new(|filter: &str, exts: &[&str]| {
            Some(rfd::FileDialog::new().add_filter(filter, exts).pick_file()?.to_string_lossy().to_string())
        })),
        resources_dir: resources_dir(),
        user_resources_dir: config_dir().map(|d| d.join("libraries")),
        recent_thumbs_dir: config_dir().map(|d| d.join("recent-thumbs")),
        pick_save: Some(Box::new(|suggested: &str| {
            let p = std::path::Path::new(suggested);
            let mut d = rfd::FileDialog::new();
            for (name, exts) in save_filters(suggested) {
                d = d.add_filter(name, exts);
            }
            if let Some(name) = p.file_name() {
                d = d.set_file_name(name.to_string_lossy());
            }
            Some(d.save_file()?.to_string_lossy().to_string())
        })),
        write: Some(Box::new(|path: &str, bytes: &[u8]| write_atomic(Path::new(path), bytes))),
        automation_read,
        automation_write,
        automation_command,
        encode_png: Some(Box::new(|w, h, rgba| {
            let img = Image::from_u8(w, h, ChannelLayout::Rgba, rgba.to_vec()).map_err(|e| e.to_string())?;
            photosuite_codecs::encode(&img, photosuite_codecs::Format::Png, &EncodeOptions::default()).map_err(|e| e.to_string())
        })),
        inbox: None,
        open_url: Some(Box::new(|url: &str| open::that(url).map_err(|e| e.to_string()))),
        clipboard_set_image: Some({
            let clip = clip.clone();
            Box::new(move |w: u32, h: u32, px: &[u8]| {
                let mut slot = clip.try_borrow_mut().map_err(|_| "clipboard is busy".to_string())?;
                let cb = match slot.as_mut() {
                    Some(c) => c,
                    None => slot.insert(arboard::Clipboard::new().map_err(|e| e.to_string())?),
                };
                cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: std::borrow::Cow::Borrowed(px) }).map_err(|e| e.to_string())
            })
        }),
        clipboard_get_image: Some({
            let clip = clip.clone();
            Box::new(move || {
                let mut slot = clip.try_borrow_mut().ok()?;
                let cb = match slot.as_mut() {
                    Some(c) => c,
                    None => slot.insert(arboard::Clipboard::new().ok()?),
                };
                let img = cb.get_image().ok()?;
                Some((img.width as u32, img.height as u32, img.bytes.into_owned()))
            })
        }),
        load_prefs: Some(Box::new(|| std::fs::read_to_string(prefs_file()?).ok())),
        save_prefs: Some(Box::new(|text: &str| write_atomic(&prefs_file().ok_or("no config directory")?, text.as_bytes()))),
        // Crash recovery: background incremental .pcraft saves into the recovery directory.
        autosave: Some(Box::new(move |doc: &Arc<Document>, revision: u64, path: Option<&str>| {
            let dir = recovery_dir().ok_or("no config directory")?;
            let mut map = savers.borrow_mut();
            let saver = map.entry(doc.id.0).or_insert_with(|| Autosaver::new(&dir, &format!("doc-{}", doc.id.0)));
            saver.request(doc.clone(), revision, path.map(str::to_string), Default::default());
            Ok(())
        })),
        discard_autosave: Some(Box::new(move |id: u64| {
            if let Some(s) = savers2.borrow_mut().remove(&id) {
                let _ = s.discard();
            }
        })),
        recover: Some(Box::new(|| {
            let Some(dir) = recovery_dir() else { return Vec::new() };
            let mut out = Vec::new();
            for entry in photosuite_format::list_recovery(&dir) {
                if let Ok(doc) = photosuite_format::recover(&entry) {
                    out.push((entry.info.original_path.clone(), doc));
                }
                // Recovered documents autosave again under their new ids.
                let _ = photosuite_format::discard_recovery(&dir, &entry);
            }
            out
        })),
        append_text: Some(Box::new(|path: &str, text: &str| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
            f.write_all(text.as_bytes()).map_err(|e| e.to_string())
        })),
        // Set by main once the Apple-event handlers are connected (macOS).
        os_events: None,
        // Set by main, which starts loading the store before the window opens.
        preset_store: None,
    }
}

/// Flat-image import via photosuite-codecs (kept for reference/tests; the app uses photosuite-io).
#[allow(dead_code)]
pub fn import_flat(name: &str, bytes: &[u8]) -> Result<Document, String> {
    let img = photosuite_codecs::decode(bytes).map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    let depth = match img.sample_type() {
        CS::U8 => SampleType::U8,
        CS::U16 => SampleType::U16,
        _ => SampleType::F32,
    };
    let gray = matches!(img.layout(), ChannelLayout::Gray | ChannelLayout::GrayA);
    let cmyk = matches!(img.layout(), ChannelLayout::Cmyk | ChannelLayout::CmykA);
    let mode = if gray {
        ColorMode::Grayscale
    } else if cmyk {
        ColorMode::Cmyk
    } else {
        ColorMode::Rgb
    };
    let target = match mode {
        ColorMode::Grayscale => ChannelLayout::GrayA,
        ColorMode::Cmyk => ChannelLayout::CmykA,
        _ => ChannelLayout::Rgba,
    };
    let sample = match depth {
        SampleType::U8 => CS::U8,
        SampleType::U16 => CS::U16,
        SampleType::F32 => CS::F32,
    };
    let conv = img.convert(target, sample);
    let stem = std::path::Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(name.to_string());
    let mut doc = Document::new(stem, Size::new(w, h), mode, depth);
    doc.icc_profile = img.icc.clone().map(std::sync::Arc::new);
    if let Some((x, _)) = img.meta.dpi {
        doc.resolution_dpi = x;
    }
    let mut layer = Layer::raster("Background", doc.pixel_format());
    let data = conv.to_normalized();
    layer.surface_mut().ok_or("new raster layer has no pixels")?.write_region(Rect::from_xywh(0, 0, w, h), &data);
    doc.layers.push(layer);
    Ok(doc)
}

#[allow(dead_code)]
pub fn export_flat(doc: &Document, path: &str) -> Result<Vec<u8>, String> {
    let format = photosuite_codecs::from_extension(path).ok_or_else(|| format!("unknown file type for {path}"))?;
    let buf = photosuite_compose::flatten(doc);
    let (w, h) = (buf.rect.width(), buf.rect.height());
    let data: Vec<f32> = buf.px.iter().flat_map(|p| *p).collect();
    let img = match doc.depth {
        SampleType::U8 => Image::from_u8(w, h, ChannelLayout::Rgba, buf.to_rgba8().pixels),
        SampleType::U16 => Image::from_u16(w, h, ChannelLayout::Rgba, &data.iter().map(|v| (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16).collect::<Vec<_>>()),
        SampleType::F32 => Image::from_f32(w, h, ChannelLayout::Rgba, &data),
    }
    .map_err(|e| e.to_string())?;
    let img = match &doc.icc_profile {
        Some(icc) if doc.mode == ColorMode::Rgb => img.with_icc(Some((**icc).clone())),
        _ => img,
    };
    photosuite_codecs::encode(&img, format, &EncodeOptions::default()).map_err(|e| e.to_string())
}
