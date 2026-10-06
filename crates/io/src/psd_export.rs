//! [`Document`] → PSD/PSB.

use photosuite_color::{ColorMode, PixelFormat, SampleType};
use photosuite_doc::{Document, Layer, LayerContent, LayerMask};
use photosuite_psd::file::{GlobalLayerMask, LayerInfoPlacement};
use photosuite_psd::layer::{BlendingRanges, ChannelData, LayerFlags, LayerInfo, LayerMask as PsdMask, MaskData, MaskParameters};
use photosuite_psd::resources::{ImageResource, ResolutionInfo, ids, version_info_resource};
use photosuite_psd::{
    BlendMode as PsdBlend, ColorMode as PsdMode, Compression, Header, ImageData, LayerRecord, PsdFile, Rect as PsdRect, SectionType, TaggedBlock, Version,
};
use photosuite_raster::Surface;

use crate::adjust_map;
use crate::blocks;
use crate::pixels::{deinterleave, encode_be, psd_depth};
use crate::psd_import::REGENERATED;

/// Options for [`document_to_psd_with`].
#[derive(Debug, Clone, Default)]
pub struct PsdExportOptions {
    /// Write PSB even when the document fits PSD limits.
    pub force_psb: bool,
}

struct Ex {
    fmt: PixelFormat,
    /// Document resolution (for generated type-layer data).
    dpi: f32,
    /// Character/paragraph styles written into every type layer's engine data.
    text_styles: photosuite_doc::TextStyles,
    mask_fmt: PixelFormat,
    cc: usize,
    cmyk: bool,
    version: Version,
    next_id: u32,
    /// PSD ids assigned to document layers (kept from `psd_id` when unique).
    layer_ids: std::collections::HashMap<photosuite_doc::LayerId, u32>,
    canvas: photosuite_geom::Rect,
    records: Vec<LayerRecord>,
    warnings: Vec<String>,
    /// Guides (artboard blocks list the guides inside each board).
    guides: photosuite_doc::Guides,
    /// Layer comps to regenerate into each layer's `cmls`; None = preserved data still matches.
    comps: Option<(Vec<photosuite_doc::LayerComp>, Option<photosuite_doc::LayerComp>)>,
}

fn psd_mode(m: ColorMode) -> PsdMode {
    match m {
        ColorMode::Grayscale => PsdMode::Grayscale,
        ColorMode::Cmyk => PsdMode::Cmyk,
        ColorMode::Lab => PsdMode::Lab,
        _ => PsdMode::Rgb,
    }
}

fn to_psd_rect(r: photosuite_geom::Rect) -> PsdRect {
    PsdRect { top: r.y0, left: r.x0, bottom: r.y1, right: r.x1 }
}

fn q255(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

impl Ex {
    fn compression(&self) -> Compression {
        if self.fmt.sample == SampleType::F32 { Compression::ZipPrediction } else { Compression::Rle }
    }

    fn encode(&self, id: i16, plane: &[u8], w: usize, h: usize) -> ChannelData {
        let depth = psd_depth(self.fmt.sample);
        ChannelData::encode(id, self.compression(), plane, w, h, depth, self.version)
            .or_else(|_| ChannelData::encode(id, Compression::Raw, plane, w, h, depth, self.version))
            .unwrap_or(ChannelData { id, compression: Some(Compression::Raw), data: plane.to_vec() })
    }

    fn empty_channels(&self) -> Vec<ChannelData> {
        (-1..self.cc as i16).map(|id| self.encode(id, &[], 0, 0)).collect()
    }

    fn pixel_channels(&mut self, s: &Surface, name: &str) -> (PsdRect, Vec<ChannelData>) {
        let s = if s.format() != self.fmt {
            self.warnings.push(format!("layer \"{name}\": pixels converted from {:?} to {:?}", s.format(), self.fmt));
            s.convert(self.fmt)
        } else {
            s.clone()
        };
        let r = s.content_bounds();
        if r.is_empty() {
            return (PsdRect::default(), self.empty_channels());
        }
        let mut bytes = s.to_interleaved(r);
        if self.fmt.mode == ColorMode::Lab && self.fmt.sample == SampleType::U16 {
            crate::pixels::lab16_chroma(&mut bytes, self.cc + 1, false);
        }
        let mut invert = vec![self.cmyk; self.cc];
        invert.push(false);
        let planes = deinterleave(&bytes, self.cc + 1, self.fmt.sample, &invert);
        drop(bytes);
        let (w, h) = (r.width() as usize, r.height() as usize);
        // Alpha (-1) first, then the colour channels; each compressed on its own thread.
        let order: Vec<(i16, &Vec<u8>)> =
            std::iter::once((-1, &planes[self.cc])).chain(planes.iter().take(self.cc).enumerate().map(|(c, p)| (c as i16, p))).collect();
        let ch = crate::pixels::par_map(order, |(id, plane)| self.encode(id, plane, w, h));
        (to_psd_rect(r), ch)
    }

    fn mask(&self, m: &LayerMask, vector: Option<(f32, f32)>) -> (MaskData, Option<ChannelData>) {
        let s = if m.surface.format() != self.mask_fmt { m.surface.convert(self.mask_fmt) } else { m.surface.clone() };
        let default = s.default_pixel().first().copied().unwrap_or(0.0);
        let r = s.content_bounds();
        let (w, h) = (r.width() as usize, r.height() as usize);
        let plane = if r.is_empty() { Vec::new() } else { deinterleave(&s.to_interleaved(r), 1, self.mask_fmt.sample, &[false]).remove(0) };
        let mut flags = 0u8;
        if !m.linked {
            flags |= PsdMask::FLAG_RELATIVE;
        }
        if !m.enabled {
            flags |= PsdMask::FLAG_DISABLED;
        }
        let parameters = mask_parameters(Some((m.density, m.feather)), vector);
        if parameters.is_some() {
            flags |= PsdMask::FLAG_PARAMETERS;
        }
        let pm = PsdMask {
            rect: if r.is_empty() { PsdRect::default() } else { to_psd_rect(r) },
            default_color: q255(default),
            flags,
            trailing: if parameters.is_none() { vec![0, 0] } else { Vec::new() },
            parameters,
            real: None,
            real_first: true,
        };
        (MaskData::Mask(pm), Some(self.encode(-2, &plane, w, h)))
    }

    /// Ids for section dividers: above every layer id.
    fn fresh_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    fn layer_id(&mut self, l: &Layer) -> u32 {
        match self.layer_ids.get(&l.id) {
            Some(id) => *id,
            None => self.fresh_id(),
        }
    }

    fn record(&mut self, l: &Layer, extra: Vec<TaggedBlock>, pixels: Option<&Surface>) -> LayerRecord {
        let id = self.layer_id(l);
        let (rect, mut channels) = match pixels {
            Some(s) => self.pixel_channels(s, &l.name),
            None => (PsdRect::default(), self.empty_channels()),
        };
        let mut mask = MaskData::None;
        // Vector mask density/feather live in the mask parameters, with or without a user mask.
        let vector = l.vector_mask.as_ref().map(|vm| (vm.density, vm.feather));
        if let Some(m) = &l.mask {
            let (md, ch) = self.mask(m, vector);
            mask = md;
            channels.extend(ch);
        } else if let Some(parameters) = mask_parameters(None, vector) {
            // Parameters only: no user mask channel, so nothing hides on re-import.
            mask = MaskData::Mask(PsdMask {
                rect: PsdRect::default(),
                default_color: 255,
                flags: PsdMask::FLAG_PARAMETERS,
                parameters: Some(parameters),
                real: None,
                trailing: Vec::new(),
                real_first: true,
            });
        }
        let mut flags = LayerFlags(0);
        flags.set_hidden(!l.visible);
        flags.set_transparency_protected(l.locks.transparency);
        let mut blocks = vec![TaggedBlock::unicode_name(&l.name), TaggedBlock::layer_id(id)];
        let lspf = blocks::lspf_from_locks(&l.locks);
        if lspf != 0 {
            blocks.push(TaggedBlock::protection(lspf));
        }
        if l.label != photosuite_doc::LabelColor::None {
            blocks.push(TaggedBlock::sheet_color(blocks::label_index(l.label)));
        }
        blocks.push(TaggedBlock::fill_opacity(q255(l.fill_opacity)));
        // Effects: the original lfx2 while the effects are unchanged (or
        // could not be decoded at all); otherwise regenerated.
        let fx = &l.effects;
        let lfx2 = match effects_unchanged(l) {
            Some(true) | None if fx.psd_raw.is_some() => fx.psd_raw.as_ref().map(|r| r.to_vec()),
            _ => (!fx.items.is_empty()).then(|| crate::effects_map::write_lfx2(fx.enabled, &fx.items)),
        };
        if let Some(d) = lfx2 {
            let key = if l.is_group() { *b"lfxs" } else { *b"lfx2" };
            blocks.push(TaggedBlock::new(key, d));
        }
        blocks.extend(extra);
        // Layer-level blocks keep their pad byte inside the length, as Photoshop writes them:
        // readers such as psd-tools do not skip a pad after an odd length, so a regenerated
        // odd-length `lfx2` misaligned every block after it (#200).
        for b in &mut blocks {
            if b.data.len() % 2 == 1 && b.padding.is_none() {
                b.data.push(0);
            }
        }
        LayerRecord {
            rect,
            channels,
            blend_mode: PsdBlend::from_key(l.blend.psd_key()),
            opacity: q255(l.opacity),
            clipping: u8::from(l.clipped),
            flags,
            filler: 0,
            mask,
            blending_ranges: crate::blocks::ranges_from_blend_if(&l.blend_if, self.cc),
            name: legacy_name(&l.name),
            blocks,
            extra_trailing: Vec::new(),
        }
    }

    /// Content blocks for `l`: preserved raw blocks (with `psd_raw`
    /// overrides) plus regenerated adjustment/fill blocks. A preserved
    /// adjustment or fill block is reused verbatim while it still decodes to
    /// the layer's current parameters; otherwise it is regenerated.
    fn content_blocks(&mut self, l: &Layer) -> Vec<TaggedBlock> {
        let mut raw: Vec<([u8; 4], Vec<u8>)> = l.psd_blocks.iter().filter(|(k, _)| !REGENERATED.contains(&k)).map(|(k, d)| (*k, d.to_vec())).collect();
        // A stale multi-effects block would override the regenerated lfx2.
        if effects_unchanged(l) == Some(false) {
            raw.retain(|(k, _)| k != b"lmfx");
        }
        let mut regenerated: Vec<([u8; 4], Vec<u8>)> = Vec::new();
        // `keys` is in the importer's priority order (`psd_raw` came from the first key present),
        // not file order: Photoshop writes `PlLd` before `SoLd`, and overwriting the first match
        // in file order put `soLD` data under the `PlLd` key (#200).
        let set_principal = |raw: &mut Vec<([u8; 4], Vec<u8>)>, keys: &[&[u8; 4]], data: Option<&std::sync::Arc<Vec<u8>>>| {
            let Some(d) = data else { return };
            match keys.iter().find_map(|k| raw.iter().position(|(rk, _)| rk == *k)) {
                Some(i) => raw[i].1 = d.to_vec(),
                None => raw.push((*keys[0], d.to_vec())),
            }
        };
        let fill_rule = |raw: &mut Vec<([u8; 4], Vec<u8>)>, regenerated: &mut Vec<([u8; 4], Vec<u8>)>, f: &photosuite_doc::Fill| {
            let keep = raw.iter().any(|(k, d)| matches!(k, b"SoCo" | b"GdFl" | b"PtFl") && blocks::parse_fill(k, d).as_ref() == Some(f));
            if !keep {
                raw.retain(|(k, _)| !matches!(k, b"SoCo" | b"GdFl" | b"PtFl"));
                regenerated.push(blocks::write_fill(f));
            }
        };
        match &l.content {
            LayerContent::Adjustment(a) => {
                let channels = match self.fmt.mode {
                    ColorMode::Rgb => adjust_map::Channels::Rgb,
                    ColorMode::Grayscale => adjust_map::Channels::Gray,
                    ColorMode::Cmyk => adjust_map::Channels::Cmyk,
                    ColorMode::Lab => adjust_map::Channels::Lab,
                    _ => adjust_map::Channels::Other,
                };
                let cged = raw.iter().find(|(k, _)| k == b"CgEd").map(|(_, d)| d.clone());
                let keep = raw.iter().any(|(k, d)| adjust_map::ADJUSTMENT_KEYS.contains(&k) && adjust_map::parse(k, d, cged.as_deref(), channels) == *a);
                if !keep {
                    raw.retain(|(k, _)| !adjust_map::ADJUSTMENT_KEYS.contains(&k) && k != b"CgEd");
                    let w = adjust_map::write(a);
                    if w.is_empty() {
                        self.warnings.push(format!("layer \"{}\": {} adjustment is not yet written to PSD", l.name, a.label()));
                    }
                    regenerated.extend(w);
                }
            }
            LayerContent::Fill(f) => fill_rule(&mut raw, &mut regenerated, f),
            LayerContent::Shape(sh) => {
                if let Some(f) = &sh.fill {
                    fill_rule(&mut raw, &mut regenerated, f);
                }
                let (w, h) = (self.canvas.width(), self.canvas.height());
                crate::vector_map::shape_blocks(sh, &mut raw, w, h, self.dpi);
            }
            LayerContent::Text(t) => {
                // Text layers without PSD data (created here) get a generated TySh.
                let generated = t.psd_raw.is_none().then(|| std::sync::Arc::new(photosuite_text::psd::build_tysh(t, self.dpi, None)));
                let src = t.psd_raw.as_ref().or(generated.as_ref());
                // Character/paragraph style sheets from the document's styles.
                let styled = src.and_then(|d| crate::text_styles_map::export_tysh(d, t, &self.text_styles, self.dpi)).map(std::sync::Arc::new);
                set_principal(&mut raw, &[b"TySh"], styled.as_ref().or(src));
                if !raw.iter().any(|(k, _)| k == b"TySh") {
                    self.warnings.push(format!("layer \"{}\": text layer written as pixels (no TySh data)", l.name));
                }
            }
            LayerContent::Smart(sm) => {
                set_principal(&mut raw, smart_keys(sm.psd_raw.as_deref().map(Vec::as_slice)), sm.psd_raw.as_ref());
                if !raw.iter().any(|(k, _)| matches!(k, b"SoLd" | b"PlLd" | b"SoLE")) {
                    self.warnings.push(format!("layer \"{}\": smart object written as pixels", l.name));
                }
            }
            LayerContent::Raster(_) | LayerContent::Group(_) => {}
        }
        // Effects reference point: written from the field (in place, keeping block order).
        match l.effects.reference {
            Some((x, y)) => {
                let data: Vec<u8> = x.to_be_bytes().into_iter().chain(y.to_be_bytes()).collect();
                match raw.iter_mut().find(|(k, _)| k == b"fxrp") {
                    Some(e) => e.1 = data,
                    None => raw.push((*b"fxrp", data)),
                }
            }
            None => raw.retain(|(k, _)| k != b"fxrp"),
        }
        // Advanced Blending channel restrictions: written from the field (in place).
        match crate::blocks::brst_data(l.excluded_channels) {
            Some(data) => match raw.iter_mut().find(|(k, _)| k == b"brst") {
                Some(e) => e.1 = data,
                None => raw.push((*b"brst", data)),
            },
            None => raw.retain(|(k, _)| k != b"brst"),
        }
        if !matches!(l.content, LayerContent::Shape(_)) {
            self.vector_mask_block(l, &mut raw);
        }
        crate::comps_map::artboard_block(&self.guides, l, &mut raw);
        if let Some((comps, last)) = &self.comps {
            // Ids are assigned to every layer before emitting.
            let id = self.layer_ids.get(&l.id).copied().unwrap_or(0);
            crate::comps_map::set_cmls(&mut raw, crate::comps_map::write_cmls(comps, last.as_ref(), l, id));
        }
        regenerated.into_iter().chain(raw).map(|(k, d)| TaggedBlock::new(k, d)).collect()
    }

    /// Keeps, regenerates or removes the `vmsk`/`vsms` block of a non-shape layer.
    fn vector_mask_block(&mut self, l: &Layer, raw: &mut Vec<([u8; 4], Vec<u8>)>) {
        let (w, h) = (self.canvas.width(), self.canvas.height());
        let pos = raw.iter().position(|(k, _)| k == b"vsms" || k == b"vmsk");
        match (&l.vector_mask, pos) {
            (None, Some(_)) => raw.retain(|(k, _)| k != b"vsms" && k != b"vmsk"),
            (None, None) => {}
            (Some(vm), Some(i)) if crate::vector_map::vector_mask_block_matches(&raw[i].1, vm, w, h) => {}
            (Some(vm), pos) => {
                let data = crate::vector_map::vector_mask_bytes(vm, w, h);
                match pos {
                    Some(i) => raw[i].1 = data,
                    None => raw.push((*b"vmsk", data)),
                }
            }
        }
    }

    /// Pixels for a fill layer: Photoshop's cached rendering while valid,
    /// otherwise our own rendering of the fill over the canvas.
    fn fill_pixels(&self, l: &Layer, f: &photosuite_doc::Fill) -> Surface {
        if let Some(c) = &l.fill_cache
            && c.fill == *f
        {
            return c.surface.clone();
        }
        // In the frame the layer's masks give it, like the compositor (masks are stored apart).
        let buf = photosuite_compose::render_fill_content(l, f, self.canvas, &[]);
        let mut s = Surface::new(self.fmt);
        let vals: Vec<f32> = buf.px.iter().flat_map(|p| photosuite_raster::from_rgba(&self.fmt, *p)).collect();
        s.write_region(self.canvas, &vals);
        s.prune();
        s
    }

    fn emit(&mut self, layers: &[Layer]) {
        for l in layers {
            let extra = self.content_blocks(l);
            match &l.content {
                LayerContent::Group(g) => {
                    let id = self.fresh_id();
                    self.records.push(LayerRecord {
                        channels: self.empty_channels(),
                        blending_ranges: BlendingRanges::full(self.cc),
                        name: b"</Layer group>".to_vec(),
                        blocks: vec![
                            TaggedBlock::unicode_name("</Layer group>"),
                            TaggedBlock::layer_id(id),
                            TaggedBlock::section_divider(SectionType::BoundingDivider, None, None),
                        ],
                        ..Default::default()
                    });
                    self.emit(&g.children);
                    let kind = if g.expanded { SectionType::OpenFolder } else { SectionType::ClosedFolder };
                    let lsct = TaggedBlock::section_divider(kind, Some(PsdBlend::from_key(l.blend.psd_key())), None);
                    let r = self.record(l, std::iter::once(lsct).chain(extra).collect(), None);
                    self.records.push(r);
                }
                LayerContent::Raster(s) => {
                    let r = self.record(l, extra, Some(s));
                    self.records.push(r);
                }
                LayerContent::Adjustment(_) => {
                    let r = self.record(l, extra, None);
                    self.records.push(r);
                }
                LayerContent::Fill(f) => {
                    let px = self.fill_pixels(l, f);
                    let r = self.record(l, extra, Some(&px));
                    self.records.push(r);
                }
                LayerContent::Text(t) => {
                    let r = self.record(l, extra, t.cache.as_ref());
                    self.records.push(r);
                }
                LayerContent::Shape(sh) => {
                    let r = self.record(l, extra, sh.cache.as_ref());
                    self.records.push(r);
                }
                LayerContent::Smart(sm) => {
                    let r = self.record(l, extra, sm.cache.as_ref());
                    self.records.push(r);
                }
            }
        }
    }
}

/// Resource 1026 (Layer › Link Layers): one u16 group id per layer record, in the order
/// [`Ex::emit`] writes records (a group's bounding divider, its children, then the group).
/// Imported ids that fit in a u16 are kept, so unchanged files write the same bytes; otherwise
/// groups are renumbered by first appearance. `None` when no layer is linked.
fn link_group_resource(layers: &[Layer]) -> Option<Vec<u8>> {
    fn walk(layers: &[Layer], out: &mut Vec<Option<u64>>) {
        for l in layers {
            if let LayerContent::Group(g) = &l.content {
                out.push(None);
                walk(&g.children, out);
            }
            out.push(l.link_group);
        }
    }
    let mut per = Vec::new();
    walk(layers, &mut per);
    if per.iter().all(Option::is_none) {
        return None;
    }
    let fits = per.iter().flatten().all(|&g| (1..=u64::from(u16::MAX)).contains(&g));
    let mut seen: Vec<u64> = Vec::new();
    let ids = per.iter().map(|g| match *g {
        None => 0u16,
        Some(g) if fits => g as u16,
        Some(g) => {
            let i = seen.iter().position(|&s| s == g).unwrap_or_else(|| {
                seen.push(g);
                seen.len() - 1
            });
            u16::try_from(i + 1).unwrap_or(u16::MAX)
        }
    });
    Some(ids.flat_map(u16::to_be_bytes).collect())
}

/// Whether the layer's effects still equal what its preserved `lmfx`/`lfx2`
/// decodes to. `None` when there is nothing preserved or it can't be decoded.
/// Block keys a smart object's `psd_raw` may be written under, in priority order. The data says
/// which it is: `PlLd` holds a `plcL` structure, `SoLd`/`SoLE` a `soLD` one (Adobe PSD spec,
/// "Placed Layer" and "Placed Layer Data"). Writing one under the other's key makes the block
/// unreadable.
fn smart_keys(data: Option<&[u8]>) -> &'static [&'static [u8; 4]] {
    match data.and_then(|d| d.get(..4)) {
        Some(b"plcL") => &[b"PlLd"],
        Some(b"soLD") => &[b"SoLd", b"SoLE"],
        _ => &[b"SoLd", b"PlLd", b"SoLE"],
    }
}

fn effects_unchanged(l: &Layer) -> Option<bool> {
    let src = l.psd_blocks.iter().find(|(k, _)| k == b"lmfx").map(|(_, d)| d.clone()).or_else(|| l.effects.psd_raw.clone())?;
    let (m, items) = crate::effects_map::parse_lfx2(&src)?;
    Some(m == l.effects.enabled && items == l.effects.items)
}

fn legacy_name(s: &str) -> Vec<u8> {
    s.chars().map(|c| if c.is_ascii() && !c.is_ascii_control() { c as u8 } else { b'?' }).take(255).collect()
}

pub(crate) fn unicode_names_resource(names: &[&str]) -> Vec<u8> {
    let mut v = Vec::new();
    for n in names {
        let units: Vec<u16> = n.encode_utf16().chain(std::iter::once(0)).collect();
        v.extend_from_slice(&(units.len() as u32).to_be_bytes());
        for u in units {
            v.extend_from_slice(&u.to_be_bytes());
        }
    }
    v
}

pub(crate) fn pascal_names_resource(names: &[&str]) -> Vec<u8> {
    let mut v = Vec::new();
    for n in names {
        let b = legacy_name(n);
        v.push(b.len() as u8);
        v.extend_from_slice(&b);
    }
    v
}

fn guides_resource(doc: &Document) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&1u32.to_be_bytes());
    v.extend_from_slice(&576u32.to_be_bytes());
    v.extend_from_slice(&576u32.to_be_bytes());
    let n = doc.guides.horizontal.len() + doc.guides.vertical.len();
    v.extend_from_slice(&(n as u32).to_be_bytes());
    for (list, dir) in [(&doc.guides.vertical, 0u8), (&doc.guides.horizontal, 1u8)] {
        for p in list {
            v.extend_from_slice(&((p * 32.0).round() as i32).to_be_bytes());
            v.push(dir);
        }
    }
    v
}

fn cmyk_of(fmt: &PixelFormat) -> bool {
    fmt.mode == ColorMode::Cmyk
}

/// The merged image's planes (colour channels, then alpha), big-endian, matted against white
/// when `matte`; with whether any pixel needs the alpha channel and whether any is below 1.
fn merged_planes(doc: &Document, fmt: &PixelFormat, cmyk: bool, matte: bool) -> (Vec<u8>, bool, bool) {
    let sample = fmt.sample;
    let cc = fmt.mode.color_channels();
    let bps = sample.bytes();
    let n = doc.size.area() as usize;
    let plane = n * bps;
    let mut planes = vec![0u8; plane * (cc + 1)];
    let (mut has_alpha, mut translucent) = (false, false);
    let white = photosuite_raster::from_rgba(fmt, [1.0, 1.0, 1.0, 1.0]);
    let canvas = doc.bounds();
    let w = canvas.width() as usize;
    let space = photosuite_compose::cmyk_space(doc);
    let lab16 = fmt.mode == ColorMode::Lab && sample == SampleType::U16;
    let _ = photosuite_compose::render_bands(doc, canvas, 0, |band| -> Result<(), ()> {
        // Retain alpha whenever it differs from opaque at the stored precision.
        has_alpha |= band.px.iter().any(|p| match sample {
            SampleType::U8 => q255(p[3]) < 255,
            SampleType::U16 => (p[3].clamp(0.0, 1.0) * 65535.0 + 0.5) as u16 != u16::MAX,
            SampleType::F32 => p[3] != 1.0,
        });
        translucent |= band.px.iter().any(|p| p[3] < 1.0);
        let start = (band.rect.y0 - canvas.y0) as usize * w;
        // Converted and encoded on all cores, then copied into each plane.
        let parts = crate::pixels::par_map(crate::pixels::bands(band.px.len()), |range| {
            // The composite came through the document's CMYK profile: convert back through it too.
            photosuite_color::convert::with_cmyk_space(space.as_ref(), || {
                let mut out: Vec<Vec<u8>> = vec![Vec::with_capacity(range.len() * bps); cc + 1];
                let mut v = [0.0f32; 5];
                for p in &band.px[range.clone()] {
                    photosuite_raster::from_rgba_into(fmt, *p, &mut v);
                    for c in 0..=cc {
                        // Matte against white like Photoshop (see `pixels::matte`).
                        let m = if c < cc && matte { crate::pixels::matte(v[c], v[cc], white[c]) } else { v[c] };
                        let x = if cmyk && c < cc { 1.0 - m } else { m };
                        // 16-bit Lab a*/b* use Photoshop's 0..65280 scale (`pixels::lab16_chroma`).
                        let x = if lab16 && (c == 1 || c == 2) { x * (crate::pixels::LAB16_CHROMA_MAX / 65535.0) } else { x };
                        encode_be(x, sample, &mut out[c]);
                    }
                }
                (range.start, out)
            })
        });
        for (at, part) in parts {
            for (c, src) in part.iter().enumerate() {
                let o = c * plane + (start + at) * bps;
                planes[o..o + src.len()].copy_from_slice(src);
            }
        }
        Ok(())
    });
    (planes, has_alpha, translucent)
}

/// Converts a document to a PSD file model (see [`document_to_psd_with`]).
pub fn document_to_psd(doc: &Document) -> PsdFile {
    document_to_psd_with(doc, &PsdExportOptions::default()).0
}

/// Converts a document to a PSD/PSB file model, returning warnings about
/// anything that could not be represented. The merged composite is rendered
/// with `photosuite_compose::flatten`.
pub fn document_to_psd_with(doc: &Document, opts: &PsdExportOptions) -> (PsdFile, Vec<String>) {
    if doc.mode == ColorMode::Multichannel {
        return crate::multichannel_map::document_to_psd(doc, opts.force_psb);
    }
    let fmt = doc.pixel_format();
    let sample = fmt.sample;
    let cc = fmt.mode.color_channels();
    let big = doc.size.width > 30_000 || doc.size.height > 30_000;
    let version = if opts.force_psb || big { Version::Psb } else { Version::Psd };
    let mut ex = Ex {
        fmt,
        dpi: doc.resolution_dpi,
        text_styles: doc.text_styles.clone(),
        mask_fmt: PixelFormat::new(ColorMode::Grayscale, sample, false),
        cc,
        cmyk: fmt.mode == ColorMode::Cmyk,
        version,
        next_id: 0,
        layer_ids: Default::default(),
        canvas: doc.bounds(),
        records: Vec::new(),
        warnings: Vec::new(),
        guides: doc.guides.clone(),
        comps: (!crate::comps_map::comps_unchanged(doc)).then(|| (doc.layer_comps.clone(), doc.last_document_state.clone())),
    };
    if big && !opts.force_psb {
        ex.warnings.push("document exceeds 30000 px; written as PSB".into());
    }
    if fmt.mode != doc.mode {
        ex.warnings.push(format!("{:?} document written as {:?}", doc.mode, fmt.mode));
    }
    // Assign layer ids up front (stable across round trips): keep unique
    // `psd_id`s, number the rest after them; dividers come after all.
    {
        let walk = doc.walk();
        let mut used = std::collections::HashSet::new();
        for (_, _, l) in &walk {
            if let Some(id) = l.psd_id
                && used.insert(id)
            {
                ex.layer_ids.insert(l.id, id);
            }
        }
        let mut next = 1u32;
        for (_, _, l) in &walk {
            if let std::collections::hash_map::Entry::Vacant(e) = ex.layer_ids.entry(l.id) {
                while used.contains(&next) {
                    next += 1;
                }
                used.insert(next);
                e.insert(next);
            }
        }
        ex.next_id = used.iter().copied().max().unwrap_or(0);
    }
    ex.emit(&doc.layers);

    // Merged composite, rendered and encoded in bands (no full-size float composite). Matting
    // against white only changes pixels with alpha < 1; if some are slightly translucent but all
    // round to opaque (so no alpha channel is written), encode once more without the matte.
    let (mut planes, has_alpha, translucent) = merged_planes(doc, &fmt, cmyk_of(&fmt), true);
    if !has_alpha && translucent {
        planes = merged_planes(doc, &fmt, cmyk_of(&fmt), false).0;
    }
    let n = doc.size.area() as usize;
    if !has_alpha {
        planes.truncate(cc * n * sample.bytes());
    }
    let canvas = doc.bounds();
    let max_extra = 56 - cc - usize::from(has_alpha);
    if doc.channels.len() > max_extra {
        ex.warnings.push(format!("only {max_extra} alpha channels fit in PSD; the rest were dropped"));
    }
    let mut extra: Vec<_> = doc.channels.iter().take(max_extra).collect();
    // Saved in Quick Mask mode: the mask is written as the last extra channel and flagged by
    // resource 1022 (quick mask info: channel id, initially-empty flag), as Photoshop does.
    let quick_mask_id = match &doc.quick_mask {
        Some(q) if extra.len() < max_extra => {
            extra.push(q);
            Some((cc + usize::from(has_alpha) + extra.len() - 1) as u16)
        }
        Some(_) => {
            ex.warnings.push("Quick Mask was dropped because the PSD channel limit was reached".into());
            None
        }
        None => None,
    };
    for a in &extra {
        let s = if a.surface.format() != ex.mask_fmt { a.surface.convert(ex.mask_fmt) } else { a.surface.clone() };
        let bytes = s.to_interleaved(canvas);
        planes.extend(deinterleave(&bytes, 1, sample, &[false]).remove(0));
    }
    let channels = (cc + usize::from(has_alpha) + extra.len()) as u16;
    let header = Header::new(version, doc.size.width, doc.size.height, channels, psd_depth(sample), psd_mode(fmt.mode));
    let mcomp = if sample == SampleType::F32 { Compression::Raw } else { Compression::Rle };
    let image_data = ImageData::encode(mcomp, &planes, &header)
        .or_else(|_| ImageData::encode(Compression::Raw, &planes, &header))
        .unwrap_or(ImageData { compression: Compression::Raw, data: planes });

    // Resources.
    let mut resources = vec![
        ImageResource::new(ids::RESOLUTION_INFO, ResolutionInfo::from_dpi(f64::from(doc.resolution_dpi)).to_bytes()),
        ImageResource::new(ids::GLOBAL_ANGLE, (doc.global_light.angle.round() as i32).to_be_bytes().to_vec()),
        ImageResource::new(ids::GLOBAL_ALTITUDE, (doc.global_light.altitude.round() as i32).to_be_bytes().to_vec()),
    ];
    if let Some(icc) = &doc.icc_profile {
        resources.push(ImageResource::new(ids::ICC_PROFILE, icc.to_vec()));
    }
    if !doc.guides.horizontal.is_empty() || !doc.guides.vertical.is_empty() {
        resources.push(ImageResource::new(1032, guides_resource(doc)));
    }
    if !extra.is_empty() {
        let names: Vec<&str> = extra.iter().map(|a| a.name.as_str()).collect();
        resources.push(ImageResource::new(1006, pascal_names_resource(&names)));
        resources.push(ImageResource::new(1045, unicode_names_resource(&names)));
        resources.push(ImageResource::new(crate::channel_map::DISPLAY_INFO, crate::channel_map::display_info(&extra)));
    }
    if let Some(id) = quick_mask_id {
        let mut data = id.to_be_bytes().to_vec();
        data.push(0);
        resources.push(ImageResource::new(crate::channel_map::QUICK_MASK_INFO, data));
    }
    // Paths: saved paths (2000+), the work path (1025), the clipping path name (2999).
    {
        use crate::vector_map::{CLIPPING_PATH, WORK_PATH, path_from_resource, path_to_records};
        let (w, h) = (doc.size.width, doc.size.height);
        let max = (*crate::vector_map::SAVED_PATHS.end() - *crate::vector_map::SAVED_PATHS.start() + 1) as usize;
        if doc.paths.len() > max {
            ex.warnings.push(format!("only {max} saved paths fit in PSD; the rest were dropped"));
        }
        for (i, p) in doc.paths.iter().take(max).enumerate() {
            let data = match &p.psd_raw {
                Some(r) if path_from_resource(r, w, h).as_ref() == Some(&p.path) => r.to_vec(),
                _ => path_to_records(&p.path, w, h).to_bytes(),
            };
            let mut r = ImageResource::new(crate::vector_map::SAVED_PATHS.start() + i as u16, data);
            r.name = legacy_name(&p.name);
            resources.push(r);
        }
        if let Some(wp) = &doc.work_path {
            resources.push(ImageResource::new(WORK_PATH, path_to_records(wp, w, h).to_bytes()));
        }
        let raw_clip = doc.metadata.psd_resources.iter().find(|(id, _, _)| *id == CLIPPING_PATH);
        let raw_name = raw_clip.map(|(_, _, d)| {
            let n = usize::from(d.first().copied().unwrap_or(0));
            d.get(1..1 + n).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
        });
        if let Some(c) = &doc.clipping_path
            && raw_name.as_deref() != Some(c.name.as_str())
        {
            // Pascal name, then flatness as 16.16 fixed (best effort; see vector_map docs).
            let mut data = vec![0u8];
            let name = legacy_name(&c.name);
            data[0] = name.len() as u8;
            data.extend_from_slice(&name);
            data.extend_from_slice(&((c.flatness.max(0.0) * 65536.0) as u32).to_be_bytes());
            resources.push(ImageResource::new(CLIPPING_PATH, data));
        }
    }
    if let Some(groups) = link_group_resource(&doc.layers) {
        resources.push(ImageResource::new(ids::LAYER_GROUP_INFO, groups));
    }
    if let Some(x) = &doc.metadata.xmp {
        resources.push(ImageResource::new(ids::XMP, x.as_bytes().to_vec()));
    }
    if let Some(e) = &doc.metadata.exif {
        resources.push(ImageResource::new(ids::EXIF, e.to_vec()));
    }
    let mut global_blocks = Vec::new();
    for (sig, key, data) in &crate::annotations_map::export_blocks(doc, crate::pattern_map::export_global_blocks(doc)) {
        let mut tb = TaggedBlock::new(*key, data.to_vec());
        tb.signature = *sig;
        // Photoshop pads document-level (global) blocks to a multiple of 4, and readers such as
        // psd-tools step to the next block that way: an even pad after `CAI ` (77 bytes)
        // misaligned every block after it (#200).
        tb.padding = Some(vec![0; (4 - data.len() % 4) % 4]);
        global_blocks.push(tb);
    }
    let comps_resource = ex.comps.is_some().then(|| crate::comps_map::write_comps_resource(doc));
    let slices_resource = crate::slices_map::export_resource(doc, &ex.layer_ids);
    for (id, name, data) in &doc.metadata.psd_resources {
        // Layer comps: the preserved list while unchanged, else regenerated (or dropped) below.
        if *id == crate::comps_map::LAYER_COMPS && comps_resource.is_some() {
            continue;
        }
        // Slices: the preserved resource while unchanged, else regenerated (or dropped) below.
        if *id == crate::slices_map::SLICES && slices_resource.is_some() {
            continue;
        }
        // Measurement scale / count resources: only while they still describe the document.
        if !crate::annotations_map::keep_resource(doc, *id) {
            continue;
        }
        // A preserved clipping-path resource is only valid while it names the current one.
        if *id == crate::vector_map::CLIPPING_PATH {
            let n = usize::from(data.first().copied().unwrap_or(0));
            let raw_name = data.get(1..1 + n).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            if doc.clipping_path.as_ref().is_none_or(|c| c.name != raw_name) {
                continue;
            }
        }
        let mut r = ImageResource::new(*id, data.to_vec());
        r.name = legacy_name(name);
        resources.push(r);
    }
    if let Some(data) = crate::annotations_map::fresh_scale_resource(doc) {
        resources.push(ImageResource::new(crate::annotations_map::MEASUREMENT_SCALE, data));
    }
    if let Some(Some(data)) = comps_resource {
        resources.push(ImageResource::new(crate::comps_map::LAYER_COMPS, data));
    }
    if let Some(Some(data)) = slices_resource {
        resources.push(ImageResource::new(crate::slices_map::SLICES, data));
    }
    resources.push(version_info_resource(true));

    let has_layers = !ex.records.is_empty();
    let placement = match (has_layers, sample) {
        (true, SampleType::U16) => LayerInfoPlacement::GlobalBlock { index: 0, signature: *b"8BIM", key: *b"Lr16", padding: None },
        (true, SampleType::F32) => LayerInfoPlacement::GlobalBlock { index: 0, signature: *b"8BIM", key: *b"Lr32", padding: None },
        _ => LayerInfoPlacement::Section,
    };
    let records = std::mem::take(&mut ex.records);
    let mut layer_info = has_layers.then_some(LayerInfo { merged_alpha: has_alpha, layers: records, padding: None });
    if let Some(info) = &mut layer_info {
        // Photoshop pads the layer info to 4 bytes (an even pad misaligns readers after a global
        // `Lr16`/`Lr32` block, #200). A length that cannot be computed keeps the even default.
        if info.pad_to(version, 4).is_err() {
            info.padding = None;
        }
    }
    let file = PsdFile {
        header,
        color_mode_data: Vec::new(),
        resources,
        layer_info,
        layer_info_placement: placement,
        global_layer_mask: (has_layers || !global_blocks.is_empty()).then(GlobalLayerMask::default),
        global_blocks,
        layer_mask_trailing: Vec::new(),
        image_data,
    };
    (file, ex.warnings)
}

/// PSD mask parameters for a user mask's and a vector mask's (density, feather); `None` when
/// every value is the default (density 1, feather 0).
fn mask_parameters(user: Option<(f32, f32)>, vector: Option<(f32, f32)>) -> Option<MaskParameters> {
    let density = |v: Option<(f32, f32)>| v.and_then(|(d, _)| (d < 1.0).then(|| q255(d)));
    let feather = |v: Option<(f32, f32)>| v.and_then(|(_, f)| (f != 0.0).then_some(f64::from(f)));
    let p =
        MaskParameters { flags: 0, user_density: density(user), user_feather: feather(user), vector_density: density(vector), vector_feather: feather(vector) };
    let flags = u8::from(p.user_density.is_some())
        | u8::from(p.user_feather.is_some()) << 1
        | u8::from(p.vector_density.is_some()) << 2
        | u8::from(p.vector_feather.is_some()) << 3;
    (flags != 0).then_some(MaskParameters { flags, ..p })
}
