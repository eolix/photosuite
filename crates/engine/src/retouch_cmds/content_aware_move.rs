//! The Content-Aware Move Tool as a command: move or duplicate the selected pixels, and let
//! content-aware fill close the gaps.
//!
//! The selection is the content, `offset` how far the user dragged it. At the new place the content
//! is pasted, its colour fitted to the new surroundings by `color` (0 keeps it, 10 is a full
//! seamless clone as the Patch Tool's), and a band along its edge, inside the selection, is
//! re-synthesised from the surroundings so that it merges in. `structure` sets that band: 7 keeps
//! the content up to the selection's edge, lower values hand a wider band to the surroundings. In
//! `move` mode the place the content left is then filled content-aware (`extend` keeps it). That
//! fill never samples the moved content, so the object doesn't come back as a ghost; the edge band
//! may sample it (it is the context the band blends towards), but not the content's old place.
//! (`content_aware::fill` treats excluded pixels as unknown, so excluding the content there would
//! turn the whole moved area into one hole and smear the band further.)
//!
//! The selection moves with the content, as in Photoshop. A soft selection counts wherever it is
//! above zero (as the Patch Tool's); the band does the blending. The fills are PatchMatch
//! completions and can take seconds on large selections, so the command runs as a background job
//! (#210): with progress, cancellable, and the document unchanged until it applies.

use photosuite_algo::content_aware::{FillOptions, fill_with};

use super::patch::{coverage, offset, selection_area, target_layer};
use super::*;

const CMD: &str = "paint.contentAwareMove";

/// Largest selection, in pixels of its bounding box (as the Patch Tool's). Each fill window is the
/// selection plus a margin; at this size one window holds about 37 M pixels and the completion's
/// working set stays within a few GB.
const MAX_PIXELS: u64 = 16 << 20;

/// Cap on the sampling margin around the content (the window grows with the selection).
const MAX_MARGIN: i32 = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// The content leaves its place, which is filled from the surroundings.
    Move,
    /// The content is duplicated; its place stays.
    Extend,
}

/// A pixel target and a selection to move.
pub(super) fn enabled(s: &Session) -> std::result::Result<(), String> {
    has_pixel_layer(s)?;
    let d = s.active().ok_or("no document open")?;
    if d.doc.selection.is_some() { Ok(()) } else { Err("select the area to move first".into()) }
}

/// Optional whole-number param in `lo..=hi`; absent or null gives `default`.
fn level(p: &Value, k: &str, default: u8, lo: u8, hi: u8) -> Result<u8> {
    match p.get(k) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => match v.as_f64() {
            Some(x) if x.is_finite() && (f64::from(lo)..=f64::from(hi)).contains(&x) => Ok(x.round() as u8),
            _ => Err(bad(CMD, format!("`{k}` must be a number {lo}..{hi}"))),
        },
    }
}

/// What a move does, checked before any work starts.
#[derive(Clone, Copy, Debug)]
struct Plan {
    id: Option<LayerId>,
    canvas: Rect,
    /// The selected area (where the content comes from).
    area: Rect,
    offset: (i32, i32),
    mode: Mode,
    structure: u8,
    color: u8,
    all_layers: bool,
}

fn plan(s: &Session, p: &Value) -> Result<Plan> {
    let mode = match string(p, "mode", "move") {
        "move" => Mode::Move,
        "extend" => Mode::Extend,
        o => return Err(bad(CMD, format!("unknown mode `{o}` (move|extend)"))),
    };
    let structure = level(p, "structure", 4, 1, 7)?;
    let color = level(p, "color", 0, 0, 10)?;
    let (dx, dy) = offset(CMD, p)?;
    let id = target_layer(s, p)?;
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let canvas = d.doc.bounds();
    let sel = d.doc.selection.as_ref().ok_or_else(|| bad(CMD, "select the area to move first"))?;
    let area = selection_area(sel, canvas);
    if area.is_empty() {
        return Err(bad(CMD, "the selection is empty"));
    }
    let pixels = u64::from(area.width()) * u64::from(area.height());
    if pixels > MAX_PIXELS {
        return Err(bad(CMD, format!("the selection is too large to move ({pixels} pixels, at most {MAX_PIXELS})")));
    }
    if (dx, dy) == (0, 0) {
        return Err(bad(CMD, "drag the selection to where the content should go"));
    }
    // Content dropped beyond the edge would be lost: keep it on the canvas, as the Patch Tool does.
    if !canvas.contains_rect(&area.translate(dx, dy)) {
        return Err(bad(CMD, "the moved selection must stay inside the canvas"));
    }
    let all_layers = flag(p, "sampleAllLayers", false) && targets_pixels(p);
    Ok(Plan { id, canvas, area, offset: (dx, dy), mode, structure, color, all_layers })
}

/// Width in pixels of the edge band re-synthesised at the new place, for Structure 1..7 and content
/// `min_side` pixels across. 7 keeps everything; the fractions grow the band roughly geometrically
/// towards 1, so the default 4 blends about a tenth of the content into its surroundings.
fn band_width(structure: u8, min_side: u32) -> usize {
    const FRACTION: [f32; 7] = [0.30, 0.22, 0.15, 0.10, 0.06, 0.03, 0.0];
    let f = FRACTION.get(usize::from(structure.saturating_sub(1))).copied().unwrap_or(0.0);
    if f == 0.0 {
        return 0;
    }
    ((min_side as f32 * f).round() as usize).clamp(2, 128)
}

/// The cells of a `w × h` mask whose whole `(2r+1)²` neighbourhood, as far as it lies on the grid,
/// is set (a square erosion in O(w·h) through a summed-area table). The grid's border doesn't erode:
/// a selection reaching the canvas edge keeps its content there.
fn erode(w: usize, h: usize, m: &[bool], r: usize) -> Vec<bool> {
    if r == 0 {
        return m.to_vec();
    }
    let w1 = w + 1;
    let mut sat = vec![0u32; w1 * (h + 1)];
    for y in 0..h {
        let mut row = 0u32;
        for x in 0..w {
            row += u32::from(m.get(y * w + x).copied().unwrap_or(false));
            sat[(y + 1) * w1 + x + 1] = sat[y * w1 + x + 1] + row;
        }
    }
    let mut out = vec![false; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            if !m.get(y * w + x).copied().unwrap_or(false) {
                continue;
            }
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
            let set = sat[y1 * w1 + x1] + sat[y0 * w1 + x0] - sat[y0 * w1 + x1] - sat[y1 * w1 + x0];
            out[y * w + x] = set as usize == (x1 - x0) * (y1 - y0);
        }
    }
    out
}

/// Where a fill samples from around `r`: as Edit › Content-Aware Fill's automatic sampling area,
/// three quarters of the extent around it (at least 32, at most [`MAX_MARGIN`] pixels).
fn window(r: Rect, canvas: Rect) -> Rect {
    let ext = r.width().max(r.height()) as i32;
    r.inflate((ext * 3 / 4).clamp(32, MAX_MARGIN)).intersect(&canvas)
}

/// The pixels a step works on: the targeted surface, or with Sample All Layers the visible
/// composite (encoded in the target's format).
fn read(doc: &mut Document, plan: &Plan, p: &Value, rect: Rect) -> Result<Region> {
    let (surf, _) = crate::channel_cmds::target_surface(doc, plan.id, p)?;
    if plan.all_layers {
        let fmt = surf.format();
        return Ok(composite_region(doc, None, SampleLayers::All, rect, fmt));
    }
    Ok(Region::read(surf, rect))
}

/// Write `out` over `mask` into the target, replacing the pixels (the result already holds what
/// should show there). With the transparency lock, alpha is kept and transparent pixels stay as
/// they are. Returns the written rectangle.
fn replace(doc: &mut Document, plan: &Plan, p: &Value, out: &Region, mask: &[bool]) -> Result<Rect> {
    let (surf, lock) = crate::channel_cmds::target_surface(doc, plan.id, p)?;
    let fmt = surf.format();
    let a = alpha_index(&fmt);
    let rect = out.rect;
    let mut px = surf.read_region(rect);
    let n = out.ch;
    if px.len() != out.data.len() || mask.len() * n != px.len() {
        return Err(EngineError::Other("internal error: content-aware move buffers disagree in size".into()));
    }
    for ((dst, src), m) in px.chunks_exact_mut(n).zip(out.data.chunks_exact(n)).zip(mask) {
        if !*m {
            continue;
        }
        match a.filter(|_| lock) {
            Some(ai) => {
                if dst.get(ai).is_some_and(|v| *v > 0.0) {
                    for (c, (d, s)) in dst.iter_mut().zip(src).enumerate() {
                        if c != ai {
                            *d = *s;
                        }
                    }
                }
            }
            None => dst.copy_from_slice(src),
        }
    }
    surf.write_region(rect, &px);
    Ok(rect)
}

/// Selection coverage over `rect` as a mask (set wherever it is above zero).
fn mask(sel: &Surface, rect: Rect) -> Vec<bool> {
    coverage(sel, rect).into_iter().map(|c| c > 0.0).collect()
}

/// Fill options: the fill's own colour adaptation (Edit › Content-Aware Fill's default), seeded so
/// the result is reproducible.
fn fill_options() -> FillOptions {
    FillOptions { seed: 0x00ca_4e00, ..FillOptions::default() }
}

/// The new target surface and the rectangle it changed: the content pasted at the offset, then
/// (`move`) its old place filled. Works on `doc`, a copy of the document.
fn run_move(doc: &mut Document, sel: &Surface, plan: &Plan, p: &Value, ctx: &crate::jobs::JobCtx, label: &str) -> Result<(Surface, Rect)> {
    let (dx, dy) = plan.offset;
    let opts = fill_options();
    let split = if plan.mode == Mode::Move { 0.4 } else { 1.0 };
    let cancelled = |_| EngineError::Cancelled;

    // 1. The content at its new place.
    let dst_area = plan.area.translate(dx, dy);
    let win = window(dst_area, plan.canvas);
    let (w, h) = (win.width() as usize, win.height() as usize);
    let here = read(doc, plan, p, win)?;
    let fmt = crate::channel_cmds::target_surface(doc, plan.id, p)?.0.format();
    let n = here.ch;
    // The content with its original surroundings, laid over this window.
    let mut src = read(doc, plan, p, win.translate(-dx, -dy))?;
    src.rect = win;
    let moved = mask(sel, win.translate(-dx, -dy));
    let old_place = mask(sel, win);
    let side = plan.area.width().min(plan.area.height());
    let core = erode(w, h, &moved, band_width(plan.structure, side));
    ctx.check()?;
    // Colour: fit the kept content to the new surroundings (seamless clone), mixed in by `color`.
    let fitted = if plan.color > 0 && core.iter().any(|c| *c) {
        let healed = heal_region(&fmt, &src, &here, &core);
        let k = f32::from(plan.color) / 10.0;
        let mut f = src.clone();
        f.data.iter_mut().zip(&healed.data).for_each(|(s, h)| *s += (h - *s) * k);
        f
    } else {
        src
    };
    let mut buf = here;
    for (i, _) in core.iter().enumerate().filter(|(_, c)| **c) {
        let r = i * n..(i + 1) * n;
        if let (Some(d), Some(s)) = (buf.data.get_mut(r.clone()), fitted.data.get(r)) {
            d.copy_from_slice(s);
        }
    }
    // Structure: the band between the kept core and the selection's edge comes from the surroundings
    // and the kept core (see the module docs), never from the content's old place.
    let band: Vec<bool> = moved.iter().zip(&core).map(|(m, c)| *m && !*c).collect();
    if band.iter().any(|b| *b) {
        let allowed: Vec<bool> = old_place.iter().map(|o| !*o).collect();
        buf.data = ctx.stage(0.0, split, label, |ctl| fill_with(w, h, n, &buf.data, &band, &allowed, &opts, ctl)).map_err(cancelled)?;
    }
    let mut damage = replace(doc, plan, p, &buf, &moved)?;

    // 2. Move: fill the place the content left (where the content didn't land on it).
    if plan.mode == Mode::Move {
        ctx.check()?;
        let win = window(plan.area, plan.canvas);
        let (w, h) = (win.width() as usize, win.height() as usize);
        let img = read(doc, plan, p, win)?;
        let landed = mask(sel, win.translate(-dx, -dy));
        let hole: Vec<bool> = mask(sel, win).iter().zip(&landed).map(|(s, l)| *s && !*l).collect();
        if hole.iter().any(|h| *h) {
            let allowed: Vec<bool> = landed.iter().map(|l| !*l).collect();
            let data = ctx.stage(split, 1.0, label, |ctl| fill_with(w, h, img.ch, &img.data, &hole, &allowed, &opts, ctl)).map_err(cancelled)?;
            damage = damage.union(&replace(doc, plan, p, &Region { rect: win, ch: img.ch, data }, &hole)?);
        }
    }
    let surf = crate::channel_cmds::target_surface(doc, plan.id, p)?.0.clone();
    Ok((surf, damage))
}

pub(super) fn content_aware_move(s: &mut Session, p: &Value) -> Result<Value> {
    let plan = plan(s, p)?;
    let label = if plan.mode == Mode::Move { "Content-Aware Move" } else { "Content-Aware Extend" };
    let d = s.active().ok_or(EngineError::NoDocument)?;
    let doc = d.doc.clone();
    let p = p.clone();
    crate::jobs::run(
        s,
        label,
        true,
        {
            let p = p.clone();
            move |ctx| {
                ctx.progress(0.0, label);
                let mut work = (*doc).clone();
                let sel = doc.selection.as_ref().ok_or_else(|| bad(CMD, "select the area to move first"))?;
                run_move(&mut work, sel, &plan, &p, ctx, label)
            }
        },
        move |s, (surf, damage)| {
            let (dx, dy) = plan.offset;
            s.edit(label, |doc, _| {
                *crate::channel_cmds::target_surface(doc, plan.id, &p)?.0 = surf;
                // The selection follows the content, ready for another drag.
                if let Some(sel) = doc.selection.as_ref() {
                    doc.selection = Some(crate::layer_multi_cmds::shift_surface(sel, dx, dy));
                }
                Ok(())
            })?;
            if let Some(st) = s.active_mut() {
                st.last_damage = Some(damage);
            }
            let mode = if plan.mode == Mode::Move { "move" } else { "extend" };
            Ok(json!({ "damage": damage_json(damage), "offset": [dx, dy], "mode": mode }))
        },
    )
}
