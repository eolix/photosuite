//! Destructive pixel operations on layers (Image → Adjustments, flips, fills).

use photosuite_compose::{Buffer, adjust};
use photosuite_doc::{Adjustment, Document, Layer, LayerContent};
use photosuite_geom::Rect;
use photosuite_raster::{Surface, from_rgba, to_rgba};

/// Apply an adjustment destructively to a surface, weighted by an optional selection.
/// Applies `adj` to a surface (any colour model and depth, via straight RGBA) through the
/// selection; `mode` is the document's, for the tone transfer (e.g. Exposure in Grayscale).
pub fn adjust_surface(s: &mut Surface, adj: &Adjustment, selection: Option<&Surface>, mode: photosuite_color::ColorMode) {
    let r = s.content_bounds();
    if r.is_empty() {
        return;
    }
    let out = adjusted(s, r, adj, selection, mode);
    s.write_region(r, &out);
}

/// Applies `adj` to a layer mask through the selection. Untouched mask pixels count (they read as
/// the mask's default value), and without a selection the default changes too, since a mask
/// reaches past the canvas: Invert turns a reveal-all mask into a hide-all one (#780).
pub fn adjust_mask(s: &mut Surface, adj: &Adjustment, selection: Option<&Surface>) {
    let mode = photosuite_color::ColorMode::Grayscale;
    if let Some(sel) = selection {
        let r = sel.content_bounds();
        if !r.is_empty() {
            let out = adjusted(s, r, adj, Some(sel), mode);
            s.write_region(r, &out);
            s.prune();
        }
        return;
    }
    let fmt = s.format();
    let unit = Rect::from_xywh(0, 0, 1, 1);
    let mut out = Surface::with_default(fmt, &adjusted(&Surface::with_default(fmt, &s.default_pixel()), unit, adj, None, mode));
    let r = s.tile_bounds();
    if !r.is_empty() {
        out.write_region(r, &adjusted(s, r, adj, None, mode));
    }
    out.prune();
    *s = out;
}

/// `s`'s pixels over `r` (untouched ones included) with `adj` applied through the selection, encoded.
fn adjusted(s: &Surface, r: Rect, adj: &Adjustment, selection: Option<&Surface>, mode: photosuite_color::ColorMode) -> Vec<f32> {
    let fmt = s.format();
    let n = fmt.channels();
    let raw = s.read_region(r);
    let mut buf = Buffer { rect: r, px: raw.chunks_exact(n).map(|p| to_rgba(&fmt, p)).collect() };
    let orig = buf.clone();
    // 32-bit documents get the float behaviour of an adjustment layer there (Levels doesn't clip);
    // integer depths keep the unrounded, clipped curves.
    let depth = (fmt.sample == photosuite_color::SampleType::F32).then_some(fmt.sample);
    adjust::apply_depth(adj, &mut buf, adjust::Transfer::for_document(mode, fmt.sample), depth);
    let w = r.width() as usize;
    let mut out = Vec::with_capacity(raw.len());
    for (i, (a, o)) in buf.px.iter().zip(&orig.px).enumerate() {
        let k = selection.map_or(1.0, |sel| sel.sample_channel(r.x0 + (i % w) as i32, r.y0 + (i / w) as i32, 0));
        let mixed: [f32; 4] = std::array::from_fn(|c| o[c] + (a[c] - o[c]) * k);
        let mut enc = [0.0f32; 8];
        let m = photosuite_raster::from_rgba_into(&fmt, mixed, &mut enc);
        out.extend_from_slice(&enc[..m]);
    }
    out
}

/// Fill (respecting selection coverage) with a straight RGBA colour.
pub fn fill_surface(s: &mut Surface, area: Rect, color: [f32; 4], selection: Option<&Surface>, lock_transparency: bool) {
    let fmt = s.format();
    let n = fmt.channels();
    let mut region = s.read_region(area);
    let w = area.width() as usize;
    for (i, px) in region.chunks_exact_mut(n).enumerate() {
        let x = area.x0 + (i % w) as i32;
        let y = area.y0 + (i / w) as i32;
        let k = selection.map_or(1.0, |sel| sel.sample_channel(x, y, 0));
        if k <= 0.0 {
            continue;
        }
        let d = to_rgba(&fmt, px);
        let sa = color[3] * k;
        let oa = sa + d[3] * (1.0 - sa);
        let mut o = [0.0f32; 4];
        if oa > 0.0 {
            for c in 0..3 {
                o[c] = (color[c] * sa + d[c] * d[3] * (1.0 - sa)) / oa;
            }
        }
        o[3] = if lock_transparency { d[3] } else { oa };
        let mut enc = [0.0f32; 8];
        photosuite_raster::from_rgba_into(&fmt, o, &mut enc);
        px.copy_from_slice(&enc[..n]);
    }
    s.write_region(area, &region);
}

/// Clear pixels (make transparent) within the selection.
pub fn clear_surface(s: &mut Surface, area: Rect, selection: Option<&Surface>) {
    let fmt = s.format();
    let n = fmt.channels();
    if !fmt.alpha {
        return;
    }
    let mut region = s.read_region(area);
    let w = area.width() as usize;
    for (i, px) in region.chunks_exact_mut(n).enumerate() {
        let k = selection.map_or(1.0, |sel| sel.sample_channel(area.x0 + (i % w) as i32, area.y0 + (i / w) as i32, 0));
        px[n - 1] *= 1.0 - k;
        // Fully cleared pixels become the empty pixel, so bounds and tile pruning see them as gone.
        if px[n - 1] <= 0.0 {
            px.fill(0.0);
        }
    }
    s.write_region(area, &region);
    s.prune();
}

/// Remap a surface through a pixel-coordinate mapping (used for flips/rotations).
pub fn remap_surface(s: &Surface, map: impl Fn(i32, i32) -> (i32, i32)) -> Surface {
    let r = s.content_bounds();
    let mut out = Surface::with_default(s.format(), &s.default_pixel());
    let n = s.channels();
    let raw = s.read_region(r);
    let w = r.width() as usize;
    for (i, px) in raw.chunks_exact(n).enumerate() {
        let (x, y) = (r.x0 + (i % w) as i32, r.y0 + (i / w) as i32);
        let (nx, ny) = map(x, y);
        out.write_pixel(nx, ny, px);
    }
    out
}

/// Merge `upper` onto `lower` producing a raster layer (Layer → Merge Down).
pub fn merge_down(doc_bounds: Rect, lower: &Layer, upper: &Layer, format: photosuite_color::PixelFormat) -> Layer {
    let area = [lower, upper].iter().map(|l| l.surface().map(|s| s.content_bounds()).unwrap_or(doc_bounds)).fold(Rect::EMPTY, |a, b| a.union(&b));
    let stack = vec![lower.clone(), upper.clone()];
    let mut tmp = Document::new("merge", doc_bounds.size(), format.mode, format.sample);
    tmp.layers = stack;
    let buf = photosuite_compose::render(&tmp, area);
    let mut s = Surface::new(format);
    let data: Vec<f32> = buf.px.iter().flat_map(|p| from_rgba(&format, *p)).collect();
    if !area.is_empty() {
        s.write_region(area, &data);
        s.prune();
    }
    let mut merged = Layer::new(lower.name.clone(), LayerContent::Raster(s));
    merged.id = lower.id;
    merged.blend = lower.blend;
    merged.opacity = 1.0;
    merged
}
