//! Filter Gallery thumbnails: every filter on the same picture (the beach, `assets/img/beach.jpg`),
//! whatever the document, as PS-JS showed them. They are rendered at the cells' size in physical
//! pixels, with each filter's defaults and black / white colours, so a set depends only on that
//! size: it is kept in memory, and on desktop in `…/app.photosuite/filter-gallery-thumbnails.json`
//! (PNGs, base64), and rendered again only when the size changes (another display density) or the
//! app or a filter changes ([`signature`]).

use std::sync::Arc;

use photosuite_algo::GalleryFilter;
use photosuite_color::PixelFormat;
use photosuite_geom::Rect;
use photosuite_raster::Surface;
use serde_json::{Value, json};

/// The picture every thumbnail shows.
const SAMPLE_JPG: &[u8] = include_bytes!("../../../assets/img/beach.jpg");

/// Bump when a gallery filter's output changes without the app version changing (a dev build),
/// so a stored set rendered by the old filter isn't reused.
const REVISION: u32 = 1;

/// One cell's thumbnail size, in points.
pub const THUMB_PT: [usize; 2] = [80, 56];

/// A set of thumbnails for one [`signature`]: one image per [`GalleryFilter::ALL`] entry, `None`
/// until rendered (they are rendered a few per frame).
pub struct ThumbSet {
    pub signature: String,
    pub images: Vec<Option<Arc<egui::ColorImage>>>,
    /// The picture at this size, made on first use.
    source: Option<Surface>,
    /// Already on disk (loaded from there, or written once complete).
    stored: bool,
}

impl ThumbSet {
    fn empty(signature: String) -> Self {
        ThumbSet { signature, images: vec![None; GalleryFilter::ALL.len()], source: None, stored: false }
    }

    pub fn complete(&self) -> bool {
        self.images.iter().all(Option::is_some)
    }
}

/// The thumbnail size in physical pixels at `pixels_per_point`.
pub fn size_px(pixels_per_point: f32) -> [usize; 2] {
    let ppp = if pixels_per_point.is_finite() { pixels_per_point.clamp(0.5, 4.0) } else { 1.0 };
    THUMB_PT.map(|v| ((v as f32 * ppp).round() as usize).max(1))
}

/// What a stored set must match: its size, [`REVISION`], the app version and the filter list.
pub fn signature(px: [usize; 2]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in GalleryFilter::ALL.iter().flat_map(|f| f.key().bytes().chain([0])) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{}x{}-r{REVISION}-{}-{h:016x}", px[0], px[1], env!("CARGO_PKG_VERSION"))
}

/// The picture as a `w × h` surface: scaled to cover it (bicubic) and centred.
fn sample(px: [usize; 2]) -> Option<Surface> {
    let img = photosuite_codecs::decode(SAMPLE_JPG).ok()?;
    let (sw, sh) = img.dimensions();
    let rgba = img.to_rgba8();
    let mut src = Surface::new(PixelFormat::RGBA8);
    let data: Vec<f32> = rgba.iter().map(|v| f32::from(*v) / 255.0).collect();
    src.write_region(Rect::new(0, 0, sw as i32, sh as i32), &data);
    let (w, h) = (px[0] as f64, px[1] as f64);
    let k = (w / f64::from(sw.max(1))).max(h / f64::from(sh.max(1)));
    let scaled = photosuite_algo::resample::resize_surface(&src, k, k, photosuite_algo::resample::Resample::Bicubic);
    let b = scaled.content_bounds();
    let (x0, y0) = (b.x0 + (b.width() as i32 - px[0] as i32) / 2, b.y0 + (b.height() as i32 - px[1] as i32) / 2);
    let mut out = Surface::new(PixelFormat::RGBA8);
    let rect = Rect::new(x0, y0, x0 + px[0] as i32, y0 + px[1] as i32);
    out.write_region(Rect::new(0, 0, px[0] as i32, px[1] as i32), &scaled.read_region(rect));
    Some(out)
}

/// Renders up to `budget` missing thumbnails of `set`, the `first` filters before the others (the
/// open categories). Returns how many it rendered.
pub fn render_some(set: &mut ThumbSet, px: [usize; 2], first: &[usize], budget: usize) -> usize {
    if set.source.is_none() {
        set.source = sample(px);
    }
    let Some(src) = &set.source else { return 0 };
    let order = first.iter().copied().chain(0..GalleryFilter::ALL.len());
    let mut done = 0;
    for i in order {
        if done == budget {
            break;
        }
        let (Some(f), Some(None)) = (GalleryFilter::ALL.get(i), set.images.get(i)) else { continue };
        let p = json!({"effects": [{"filter": f.key()}], "foreground": [0.0, 0.0, 0.0, 1.0], "background": [1.0, 1.0, 1.0, 1.0]});
        let out = crate::gallery_ui::render(src, &p);
        let img = crate::gallery_ui::image(&out, px[0], px[1]);
        if let Some(slot) = set.images.get_mut(i) {
            *slot = Some(Arc::new(img));
        }
        done += 1;
    }
    done
}

/// The set for `signature`: `current` when it matches, else the stored one when that matches, else
/// a new empty set to render.
pub fn take(current: Option<ThumbSet>, signature: &str, file: Option<&std::path::Path>) -> ThumbSet {
    if let Some(s) = current.filter(|s| s.signature == signature) {
        return s;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(images) = file.and_then(|f| std::fs::read(f).ok()).and_then(|b| from_json(&b, signature)) {
        return ThumbSet { signature: signature.to_string(), images: images.into_iter().map(|i| Some(Arc::new(i))).collect(), source: None, stored: true };
    }
    #[cfg(target_arch = "wasm32")]
    let _ = file;
    ThumbSet::empty(signature.to_string())
}

/// Writes a complete set to `file` once (failures are ignored: the set is simply rendered again
/// next time).
pub fn store(set: &mut ThumbSet, file: Option<&std::path::Path>) {
    if set.stored || !set.complete() {
        return;
    }
    set.stored = true;
    #[cfg(not(target_arch = "wasm32"))]
    if let (Some(file), Some(bytes)) = (file, to_json(set)) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, bytes);
    }
    #[cfg(target_arch = "wasm32")]
    let _ = file;
}

/// `{"signature", "thumbnails": {filterKey: base64 PNG}}`.
fn to_json(set: &ThumbSet) -> Option<Vec<u8>> {
    use base64::Engine;
    let mut thumbs = serde_json::Map::new();
    for (f, img) in GalleryFilter::ALL.iter().zip(&set.images) {
        let img = img.as_ref()?;
        let data: Vec<u8> = img.pixels.iter().flat_map(|c| c.to_srgba_unmultiplied()).collect();
        let image = photosuite_codecs::Image::from_u8(img.size[0] as u32, img.size[1] as u32, photosuite_codecs::ChannelLayout::Rgba, data).ok()?;
        let png = photosuite_codecs::encode(&image, photosuite_codecs::Format::Png, &photosuite_codecs::EncodeOptions::default()).ok()?;
        thumbs.insert(f.key().to_string(), json!(base64::engine::general_purpose::STANDARD.encode(png)));
    }
    serde_json::to_vec(&json!({"signature": set.signature, "thumbnails": thumbs})).ok()
}

/// The stored images when the file is for `signature` and has every filter at the right size.
fn from_json(bytes: &[u8], signature: &str) -> Option<Vec<egui::ColorImage>> {
    use base64::Engine;
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("signature").and_then(Value::as_str) != Some(signature) {
        return None;
    }
    let thumbs = v.get("thumbnails")?.as_object()?;
    let px = signature.split('-').next()?.split_once('x')?;
    let (w, h): (u32, u32) = (px.0.parse().ok()?, px.1.parse().ok()?);
    GalleryFilter::ALL
        .iter()
        .map(|f| {
            let png = base64::engine::general_purpose::STANDARD.decode(thumbs.get(f.key())?.as_str()?).ok()?;
            let img = photosuite_codecs::decode_as(photosuite_codecs::Format::Png, &png).ok()?;
            (img.dimensions() == (w, h)).then(|| egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &img.to_rgba8()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picture_fills_every_size() {
        for ppp in [1.0, 1.5, 2.0, 3.0] {
            let px = size_px(ppp);
            let s = sample(px).expect("the bundled picture decodes");
            let b = s.content_bounds();
            assert_eq!((b.width() as usize, b.height() as usize), (px[0], px[1]), "{ppp}");
            let mid = s.read_region(Rect::new(px[0] as i32 / 2, 2, px[0] as i32 / 2 + 1, 3));
            assert!(mid[3] > 0.99, "opaque, no empty border");
        }
        assert_eq!(size_px(f32::NAN), THUMB_PT);
        assert_eq!(size_px(100.0), THUMB_PT.map(|v| v * 4));
    }

    #[test]
    fn signatures_follow_the_size() {
        assert_eq!(signature(size_px(2.0)), signature([160, 112]));
        assert_ne!(signature(size_px(1.0)), signature(size_px(2.0)));
        assert!(signature([80, 56]).starts_with("80x56-r"));
    }

    #[test]
    fn a_complete_set_is_stored_and_read_back_for_its_size_only() {
        let px = size_px(1.0);
        let sig = signature(px);
        let mut set = take(None, &sig, None);
        while render_some(&mut set, px, &[3], 8) > 0 {}
        assert!(set.complete());
        let dir = std::env::temp_dir().join(format!("photosuite-gallery-thumbs-{}", std::process::id()));
        let file = dir.join("filter-gallery-thumbnails.json");
        store(&mut set, Some(&file));
        let first = set.images[0].clone();
        let back = take(None, &sig, Some(&file));
        assert!(back.complete() && back.stored, "read from the file, nothing to render");
        assert_eq!(back.images[0].as_ref().map(|i| i.size), first.as_ref().map(|i| i.size));
        assert_eq!(back.images[0].as_ref().map(|i| i.pixels.clone()), first.as_ref().map(|i| i.pixels.clone()), "PNG is lossless");
        // Another display density: rendered again, not taken from the file.
        let other = take(None, &signature(size_px(2.0)), Some(&file));
        assert!(!other.stored && other.images.iter().all(Option::is_none));
        // The set in memory is reused as it is.
        assert!(take(Some(back), &sig, None).stored);
        // A damaged file is ignored.
        std::fs::write(&file, b"{\"signature\": 3").unwrap();
        assert!(!take(None, &sig, Some(&file)).stored);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
