//! Recent files on the Home screen: a thumbnail and "how long ago" for each.
//!
//! Thumbnails live outside the preferences file, which is saved often and should stay small: one
//! PNG per recent file in `…/app.photosuite/recent-thumbs/`, pruned to the list. PNG, so a
//! transparent document keeps its transparency instead of turning black.

/// Card thumbnails are 180 pt; this covers a 2× display.
pub const THUMB_PX: u32 = 360;

/// The thumbnail file for `path`: a stable hash of it. (`std`'s hasher may change between Rust
/// releases, which would orphan every thumbnail on an upgrade, so FNV-1a is spelled out.)
pub fn thumb_name(path: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}.png")
}

/// Encode a document's composite as a thumbnail PNG.
pub fn thumbnail_png(doc: &photosuite_doc::Document) -> Option<Vec<u8>> {
    let buf = photosuite_compose::thumbnail_buffer(doc, THUMB_PX);
    let img = crate::canvas::buffer_to_image(&buf);
    let (w, h) = (img.size[0] as u32, img.size[1] as u32);
    if w == 0 || h == 0 {
        return None;
    }
    let data: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_srgba_unmultiplied()).collect();
    let image = photosuite_codecs::Image::from_u8(w, h, photosuite_codecs::ChannelLayout::Rgba, data).ok()?;
    photosuite_codecs::encode(&image, photosuite_codecs::Format::Png, &photosuite_codecs::EncodeOptions::default()).ok()
}

/// Delete thumbnails whose file is no longer on the recent list, so none outlives its entry.
#[cfg(not(target_arch = "wasm32"))]
pub fn prune(dir: &std::path::Path, keep: &[String]) {
    let wanted: Vec<String> = keep.iter().map(|p| thumb_name(p)).collect();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.ends_with(".png") && !wanted.contains(&name) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The thumbnail for `path` as a texture, decoded once and cached until the file changes.
#[cfg(not(target_arch = "wasm32"))]
pub fn texture(ctx: &egui::Context, dir: &std::path::Path, path: &str) -> Option<egui::TextureId> {
    let file = dir.join(thumb_name(path));
    let stamp = std::fs::metadata(&file).and_then(|m| m.modified()).ok()?;
    let key = egui::Id::new(("recent-thumb", path.to_string()));
    if let Some((s, tex)) = ctx.data(|d| d.get_temp::<(std::time::SystemTime, egui::TextureHandle)>(key))
        && s == stamp
    {
        return Some(tex.id());
    }
    let image = photosuite_codecs::decode(&std::fs::read(&file).ok()?).ok()?;
    let color = egui::ColorImage::from_rgba_unmultiplied([image.width() as usize, image.height() as usize], &image.to_rgba8());
    let tex = ctx.load_texture(format!("recent-{}", thumb_name(path)), color, egui::TextureOptions::LINEAR);
    let id = tex.id();
    ctx.data_mut(|d| d.insert_temp(key, (stamp, tex)));
    Some(id)
}

/// Milliseconds since the Unix epoch, now.
#[cfg(not(target_arch = "wasm32"))]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// "41 minutes ago", as PhotoSuite wrote it — in English there too, so no catalogue rows.
pub fn age_text(opened_ms: u64, now_ms: u64) -> String {
    if opened_ms == 0 {
        return String::new();
    }
    let s = now_ms.saturating_sub(opened_ms) / 1000;
    let (n, unit) = match s {
        0..60 => return "Just now".into(),
        60..3600 => (s / 60, "minute"),
        3600..86_400 => (s / 3600, "hour"),
        86_400..2_592_000 => (s / 86_400, "day"),
        _ => (s / 2_592_000, "month"),
    };
    if n == 1 { format!("1 {unit} ago") } else { format!("{n} {unit}s ago") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ages_read_like_photosuites() {
        let m = 60_000;
        assert_eq!(age_text(0, 10 * m), "");
        assert_eq!(age_text(10 * m, 10 * m + 30_000), "Just now");
        assert_eq!(age_text(10 * m, 11 * m), "1 minute ago");
        assert_eq!(age_text(1, 41 * m + 1), "41 minutes ago");
        assert_eq!(age_text(1, 60 * m + 1), "1 hour ago");
        assert_eq!(age_text(1, 3 * 24 * 60 * m + 1), "3 days ago");
        assert_eq!(age_text(1, 61 * 24 * 60 * m + 1), "2 months ago");
    }

    #[test]
    fn thumbnail_names_are_stable_and_distinct() {
        assert_eq!(thumb_name("/a/b.psd"), thumb_name("/a/b.psd"));
        assert_ne!(thumb_name("/a/b.psd"), thumb_name("/a/c.psd"));
        // Pinned, so a hasher change can never silently orphan everyone's thumbnails.
        assert_eq!(thumb_name(""), "cbf29ce484222325.png");
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod disk_tests {
    use crate::PhotosuiteApp;

    /// Opening a file records when, writes its thumbnail, and clearing the list removes both.
    #[test]
    fn opening_a_file_writes_its_thumbnail_and_clearing_removes_it() {
        let dir = std::env::temp_dir().join(format!("photosuite-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let services = crate::Services { recent_thumbs_dir: Some(dir.clone()), ..Default::default() };
        let mut app = PhotosuiteApp::new(photosuite_engine::Session::new(), services);
        app.run("file.new", serde_json::json!({"width": 64, "height": 48})).unwrap();
        let path = "/work/card.png";
        if let Some(st) = app.session.active_mut() {
            st.path = Some(path.to_string());
        }
        app.push_recent(path);
        let thumb = dir.join(super::thumb_name(path));
        assert!(thumb.is_file(), "thumbnail written");
        assert!(photosuite_codecs::decode(&std::fs::read(&thumb).unwrap()).is_ok(), "and readable");
        assert!(app.session.prefs().recent_opened.get(path).copied().unwrap_or(0) > 0, "opened time recorded");
        app.clear_recent();
        assert!(!thumb.exists(), "clearing the list removes the thumbnail");
        assert!(app.session.prefs().recent_opened.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
