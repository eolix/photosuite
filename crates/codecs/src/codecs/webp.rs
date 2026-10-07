//! WebP: decode lossy/lossless (first frame) and encode lossless via `image-webp`; encode lossy
//! via `webp-rust`, re-wrapped here in an extended (VP8X) container so ICC, EXIF and XMP are kept
//! (WebP container spec). ICC/EXIF/XMP both ways.

use std::io::Cursor;

use crate::Format;
use crate::error::CodecError;
use crate::fidelity::Plan;
use crate::image::{ChannelLayout, DecodeWarning, Image, Metadata, SampleType};
use crate::options::{EncodeOptions, Limits};

const F: Format = Format::WebP;

fn err(e: impl std::fmt::Display) -> CodecError {
    CodecError::malformed(F, e)
}

pub(crate) fn decode(bytes: &[u8], limits: &Limits) -> Result<Image, CodecError> {
    let mut dec = image_webp::WebPDecoder::new(Cursor::new(bytes)).map_err(err)?;
    dec.set_memory_limit(limits.alloc_usize());
    let (w, h) = dec.dimensions();
    let layout = if dec.has_alpha() { ChannelLayout::Rgba } else { ChannelLayout::Rgb };
    limits.check(w, h, layout, SampleType::U8)?;
    let size = dec.output_buffer_size().ok_or_else(|| err("image too large"))?;
    let mut buf = vec![0u8; size];
    dec.read_image(&mut buf).map_err(err)?;
    let icc = dec.icc_profile().ok().flatten();
    let exif = dec.exif_metadata().ok().flatten();
    let xmp = dec.xmp_metadata().ok().flatten().and_then(|b| String::from_utf8(b).ok());
    let mut img = Image::from_u8(w, h, layout, buf)?;
    img.icc = icc;
    img.meta = Metadata { exif, xmp, ..Default::default() };
    if dec.is_animated() && dec.num_frames() > 1 {
        img.warnings.push(DecodeWarning::MoreFrames { total: Some(dec.num_frames()) });
    }
    Ok(img)
}

pub(crate) fn encode(src: &Image, plan: Plan, opts: &EncodeOptions) -> Result<Vec<u8>, CodecError> {
    if !opts.webp_lossless {
        return encode_lossy(src, opts);
    }
    let img = src.converted(plan.layout, plan.sample);
    let ct = match img.layout() {
        ChannelLayout::Gray => image_webp::ColorType::L8,
        ChannelLayout::GrayA => image_webp::ColorType::La8,
        ChannelLayout::Rgb => image_webp::ColorType::Rgb8,
        ChannelLayout::Rgba => image_webp::ColorType::Rgba8,
        l => return Err(CodecError::encode(F, format!("unsupported layout {l:?}"))),
    };
    let mut out = Vec::new();
    let mut enc = image_webp::WebPEncoder::new(&mut out);
    if opts.embed_icc
        && let Some(icc) = &img.icc
    {
        enc.set_icc_profile(icc.clone());
    }
    if opts.embed_metadata {
        if let Some(exif) = &img.meta.exif {
            // The pixels are written as they are shown: never let a viewer rotate them again.
            enc.set_exif_metadata(crate::orientation::upright_exif(exif).into_owned());
        }
        if let Some(xmp) = &img.meta.xmp {
            enc.set_xmp_metadata(crate::orientation::upright_xmp(xmp).as_bytes().to_vec());
        }
    }
    enc.encode(img.data(), img.width(), img.height(), ct).map_err(|e| CodecError::encode(F, e))?;
    Ok(out)
}

fn encode_lossy(src: &Image, opts: &EncodeOptions) -> Result<Vec<u8>, CodecError> {
    let img = src.converted(ChannelLayout::Rgba, SampleType::U8);
    let (w, h) = (img.width(), img.height());
    let buf = webp_rust::ImageBuffer { width: w as usize, height: h as usize, rgba: img.data().to_vec() };
    let config = webp_rust::LossyEncodingConfig { quality: f32::from(opts.webp_quality.min(100)), ..Default::default() };
    let simple = webp_rust::encode_lossy_with_config(&buf, &config, None).map_err(|e| CodecError::encode(F, e))?;
    let icc = img.icc.as_deref().filter(|_| opts.embed_icc);
    let exif = img.meta.exif.as_deref().filter(|_| opts.embed_metadata);
    let xmp = img.meta.xmp.as_deref().map(str::as_bytes).filter(|_| opts.embed_metadata);
    if icc.is_none() && exif.is_none() && xmp.is_none() {
        return Ok(simple);
    }
    remux(&simple, w, h, icc, exif, xmp)
}

/// Whether a still WebP is lossless (`VP8L`) or lossy (`VP8 `); `None` for anything else
/// (not a WebP, animated, truncated).
pub fn is_lossless(bytes: &[u8]) -> Option<bool> {
    let chunks = chunks(bytes).ok()?;
    if chunks.iter().any(|(id, _)| id == b"ANIM") {
        return None;
    }
    chunks.iter().find_map(|(id, _)| match id {
        b"VP8L" => Some(true),
        b"VP8 " => Some(false),
        _ => None,
    })
}

/// One RIFF chunk: (fourcc, payload).
type Chunk<'a> = ([u8; 4], &'a [u8]);

/// The chunks of a RIFF/WEBP file.
fn chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>, CodecError> {
    if bytes.len() < 12 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WEBP") {
        return Err(CodecError::encode(F, "encoder produced no WebP container"));
    }
    let mut out = Vec::new();
    let mut at = 12usize;
    while let Some(head) = bytes.get(at..at.saturating_add(8)) {
        let mut id = [0u8; 4];
        id.copy_from_slice(&head[..4]);
        let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
        let start = at + 8;
        let data = bytes.get(start..start.saturating_add(len)).ok_or_else(|| CodecError::encode(F, "truncated WebP chunk"))?;
        out.push((id, data));
        at = start.saturating_add(len).saturating_add(len & 1);
    }
    Ok(out)
}

/// Rebuilds a lossy WebP as VP8X + ICCP + ALPH + VP8 + EXIF + XMP, in the spec's order.
fn remux(simple: &[u8], w: u32, h: u32, icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&[u8]>) -> Result<Vec<u8>, CodecError> {
    let parts = chunks(simple)?;
    let get = |id: &[u8; 4]| parts.iter().find(|(k, _)| k == id).map(|(_, d)| *d);
    let vp8 = get(b"VP8 ").ok_or_else(|| CodecError::encode(F, "encoder produced no VP8 data"))?;
    let alph = get(b"ALPH");
    if w == 0 || h == 0 || w > 1 << 24 || h > 1 << 24 {
        return Err(CodecError::encode(F, "image too large for WebP"));
    }
    let mut flags = 0u8;
    if icc.is_some() {
        flags |= 0x20;
    }
    if alph.is_some() {
        flags |= 0x10;
    }
    if exif.is_some() {
        flags |= 0x08;
    }
    if xmp.is_some() {
        flags |= 0x04;
    }
    let mut vp8x = vec![flags, 0, 0, 0];
    vp8x.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
    let mut body = b"WEBP".to_vec();
    let mut put = |id: &[u8; 4], data: &[u8]| -> Result<(), CodecError> {
        let len = u32::try_from(data.len()).map_err(|_| CodecError::encode(F, "chunk too large"))?;
        body.extend_from_slice(id);
        body.extend_from_slice(&len.to_le_bytes());
        body.extend_from_slice(data);
        if data.len() % 2 == 1 {
            body.push(0);
        }
        Ok(())
    };
    put(b"VP8X", &vp8x)?;
    if let Some(d) = icc {
        put(b"ICCP", d)?;
    }
    if let Some(d) = alph {
        put(b"ALPH", d)?;
    }
    put(b"VP8 ", vp8)?;
    if let Some(d) = exif {
        put(b"EXIF", d)?;
    }
    if let Some(d) = xmp {
        put(b"XMP ", d)?;
    }
    let size = u32::try_from(body.len()).map_err(|_| CodecError::encode(F, "file too large"))?;
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}
