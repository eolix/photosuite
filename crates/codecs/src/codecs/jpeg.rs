//! JPEG: decode via `zune-jpeg` (gray, YCbCr, CMYK, YCCK), encode via
//! `jpeg-encoder` (gray, RGB, CMYK). Metadata (APP0 JFIF density, APP1
//! EXIF/XMP, APP2 multi-segment ICC, APP14 Adobe) is parsed by our own marker
//! scanner so behaviour does not depend on decoder internals.

use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;

use crate::Format;
use crate::error::CodecError;
use crate::fidelity::Plan;
use crate::image::{ChannelLayout, DecodeWarning, Image, Metadata, SampleType};
use crate::options::{EncodeOptions, Limits};
use crate::orientation::{upright_exif, upright_xmp};

const F: Format = Format::Jpeg;
const EXIF_HEADER: &[u8] = b"Exif\0\0";
const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const ICC_HEADER: &[u8] = b"ICC_PROFILE\0";

#[derive(Default, Debug)]
pub(crate) struct JpegMeta {
    pub icc: Option<Vec<u8>>,
    pub exif: Option<Vec<u8>>,
    pub xmp: Option<String>,
    pub dpi: Option<(f32, f32)>,
    pub adobe_transform: Option<u8>,
    /// (width, height, components) from the first SOFn.
    pub frame: Option<(u32, u32, u8)>,
    /// Quantisation table 0 (luminance), as stored (zig-zag order).
    pub luma_quant: Option<[u16; 64]>,
}

/// Walk the marker segments up to SOS and collect metadata.
pub(crate) fn scan_metadata(b: &[u8]) -> JpegMeta {
    let mut m = JpegMeta::default();
    let mut icc_parts: Vec<(u8, u8, &[u8])> = Vec::new();
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            break;
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 || i + 2 + len > b.len() {
            break;
        }
        let seg = &b[i + 4..i + 2 + len];
        match marker {
            0xE0 if seg.len() >= 12 && seg.starts_with(b"JFIF\0") => {
                let unit = seg[7];
                let x = u16::from_be_bytes([seg[8], seg[9]]) as f32;
                let y = u16::from_be_bytes([seg[10], seg[11]]) as f32;
                if x > 0.0 && y > 0.0 {
                    m.dpi = match unit {
                        1 => Some((x, y)),
                        2 => Some((x * 2.54, y * 2.54)),
                        _ => None,
                    };
                }
            }
            0xE1 if seg.starts_with(EXIF_HEADER) && m.exif.is_none() => {
                m.exif = Some(seg[EXIF_HEADER.len()..].to_vec());
            }
            0xE1 if seg.starts_with(XMP_HEADER) && m.xmp.is_none() => {
                m.xmp = std::str::from_utf8(&seg[XMP_HEADER.len()..]).ok().map(|s| s.trim_end_matches('\0').to_owned());
            }
            0xE2 if seg.len() >= 14 && seg.starts_with(ICC_HEADER) => {
                icc_parts.push((seg[12], seg[13], &seg[14..]));
            }
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) && seg.len() >= 6 && m.frame.is_none() => {
                let h = u16::from_be_bytes([seg[1], seg[2]]) as u32;
                let w = u16::from_be_bytes([seg[3], seg[4]]) as u32;
                m.frame = Some((w, h, seg[5]));
            }
            0xEE if seg.len() >= 12 && seg.starts_with(b"Adobe") => {
                m.adobe_transform = Some(seg[11]);
            }
            0xDB if m.luma_quant.is_none() => m.luma_quant = luma_table(seg),
            _ => {}
        }
        i += 2 + len;
    }
    if !icc_parts.is_empty() {
        icc_parts.sort_by_key(|p| p.0);
        let total = icc_parts[0].1 as usize;
        let seqs_ok = icc_parts.len() == total && icc_parts.iter().enumerate().all(|(k, p)| p.0 as usize == k + 1 && p.1 as usize == total);
        if seqs_ok || icc_parts.len() == 1 {
            m.icc = Some(icc_parts.iter().flat_map(|p| p.2.iter().copied()).collect());
        }
    }
    m
}

/// Table 0 of a DQT segment (which may hold several tables, 8- or 16-bit).
fn luma_table(seg: &[u8]) -> Option<[u16; 64]> {
    let mut at = 0usize;
    while let Some(&pq_tq) = seg.get(at) {
        let wide = pq_tq >> 4 == 1;
        let n = if wide { 128 } else { 64 };
        let data = seg.get(at + 1..at + 1 + n)?;
        if pq_tq & 0x0F == 0 {
            let mut t = [0u16; 64];
            for (k, v) in t.iter_mut().enumerate() {
                *v = if wide { u16::from_be_bytes([*data.get(2 * k)?, *data.get(2 * k + 1)?]) } else { u16::from(*data.get(k)?) };
            }
            return Some(t);
        }
        at += 1 + n;
    }
    None
}

/// A JPEG's EXIF block (the APP1 segment's TIFF data), without decoding the image.
pub fn exif(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.get(0..2) != Some(&[0xFF, 0xD8]) {
        return None;
    }
    scan_metadata(bytes).exif
}

/// ITU-T T.81 Annex K luminance table (the IJG base table `jpeg-encoder` scales too).
const ANNEX_K_LUMA: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109,
    103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/// The IJG 1–100 quality whose scaled Annex K table is closest to this JPEG's luminance table:
/// the quality to save it again at. Exact for files written with IJG-style tables (libjpeg, our
/// encoder, most cameras and editors close to it); an estimate otherwise. `None` when the file
/// has no readable quantisation table.
pub fn estimate_quality(bytes: &[u8]) -> Option<u8> {
    if bytes.get(0..2) != Some(&[0xFF, 0xD8]) {
        return None;
    }
    let table = scan_metadata(bytes).luma_quant?;
    // Compare sums: they don't depend on the table's (zig-zag or natural) order.
    let have: u32 = table.iter().map(|&v| u32::from(v)).sum();
    (1u8..=100).min_by_key(|&q| {
        let q = u32::from(q);
        let scale = if q < 50 { 5000 / q } else { 200 - 2 * q };
        let want: u32 = ANNEX_K_LUMA.iter().map(|&v| ((u32::from(v) * scale + 50) / 100).clamp(1, 255)).sum();
        want.abs_diff(have)
    })
}

/// How a JPEG's data ends, seen from its marker structure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataEnd {
    /// An end-of-image marker follows the scans (or the structure is too odd to tell).
    Complete,
    /// The file ends inside the image data, before the end-of-image marker.
    Truncated,
    /// The file ends before the first scan holds any data: nothing can be decoded.
    Empty,
}

/// Walks the marker segments (skipped by their length) and the entropy-coded scan data
/// (skipped up to the next marker that isn't a stuffed `FF 00`, a restart or a fill byte),
/// so an embedded thumbnail's end marker or data after the end of the image don't count.
fn data_end(b: &[u8]) -> DataEnd {
    // Where the bytes run out: inside the image data once a scan has held some.
    let cut = |scan_data: bool| if scan_data { DataEnd::Truncated } else { DataEnd::Empty };
    let mut i = 2; // past SOI
    let mut scan_data = false;
    loop {
        let Some(&byte) = b.get(i) else { return cut(scan_data) };
        if byte != 0xFF {
            // Not where a marker should be: too odd to judge.
            return DataEnd::Complete;
        }
        let Some(&code) = b.get(i + 1) else { return cut(scan_data) };
        match code {
            0xD9 => return DataEnd::Complete,
            0xFF => i += 1,
            0x01 | 0xD0..=0xD8 => i += 2,
            _ => {
                let Some(len) = b.get(i + 2..i + 4).and_then(|s| <[u8; 2]>::try_from(s).ok()).map(u16::from_be_bytes) else {
                    return cut(scan_data);
                };
                i = i.saturating_add(2 + usize::from(len));
                if code == 0xDA {
                    let start = i;
                    loop {
                        let Some(p) = b.get(i..).and_then(|r| r.iter().position(|&v| v == 0xFF)) else {
                            return cut(scan_data || b.len() > start);
                        };
                        i += p;
                        match b.get(i + 1) {
                            Some(0x00 | 0xD0..=0xD7) => i += 2,
                            Some(0xFF) => i += 1,
                            _ => break,
                        }
                    }
                    scan_data |= i > start;
                }
            }
        }
    }
}

fn err(e: impl std::fmt::Display) -> CodecError {
    CodecError::malformed(F, e)
}

pub(crate) fn decode(bytes: &[u8], limits: &Limits) -> Result<Image, CodecError> {
    let end = data_end(bytes);
    if end == DataEnd::Empty {
        return Err(err("the file ends before any image data"));
    }
    let meta = scan_metadata(bytes);
    if let Some((w, h, nc)) = meta.frame {
        limits.check_bytes(w, h, u64::from(nc.max(1)))?;
    }
    let options = DecoderOptions::default().set_strict_mode(false).set_max_width(65535).set_max_height(65535);
    let mut dec = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    dec.decode_headers().map_err(err)?;
    let (w, h) = dec.dimensions().ok_or_else(|| err("no dimensions"))?;
    let (w, h) = (w as u32, h as u32);
    let input = dec.input_colorspace().ok_or_else(|| err("no colorspace"))?;
    let (out_cs, layout) = match input {
        ColorSpace::Luma | ColorSpace::LumaA => (ColorSpace::Luma, ChannelLayout::Gray),
        ColorSpace::CMYK => (ColorSpace::CMYK, ChannelLayout::Cmyk),
        ColorSpace::YCCK => (ColorSpace::YCCK, ChannelLayout::Cmyk),
        _ => (ColorSpace::RGB, ChannelLayout::Rgb),
    };
    limits.check(w, h, layout, SampleType::U8)?;
    dec.set_options(dec.options().jpeg_set_out_colorspace(out_cs));
    let mut px = dec.decode().map_err(err)?;
    let expected = w as usize * h as usize * layout.channels();
    if px.len() < expected {
        return Err(err("short pixel buffer"));
    }
    px.truncate(expected);
    match input {
        // Adobe-style CMYK is stored inverted (255 = no ink).
        ColorSpace::CMYK => px.iter_mut().for_each(|v| *v = 255 - *v),
        ColorSpace::YCCK => {
            for p in px.as_chunks_mut::<4>().0 {
                let (y, cb, cr) = (p[0] as f32, p[1] as f32 - 128.0, p[2] as f32 - 128.0);
                let c = y + 1.402 * cr;
                let m = y - 0.344_136 * cb - 0.714_136 * cr;
                let yy = y + 1.772 * cb;
                p[0] = c.round().clamp(0.0, 255.0) as u8;
                p[1] = m.round().clamp(0.0, 255.0) as u8;
                p[2] = yy.round().clamp(0.0, 255.0) as u8;
                p[3] = 255 - p[3];
            }
        }
        _ => {}
    }
    let mut img = Image::from_raw(w, h, layout, SampleType::U8, px)?;
    img.icc = meta.icc;
    img.meta = Metadata { exif: meta.exif, xmp: meta.xmp, dpi: meta.dpi, text: Vec::new() };
    if end == DataEnd::Truncated {
        img.warnings.push(DecodeWarning::Truncated { format: F });
    }
    Ok(img)
}

pub(crate) fn encode(src: &Image, plan: Plan, opts: &EncodeOptions) -> Result<Vec<u8>, CodecError> {
    let img = src.converted(plan.layout, plan.sample);
    let (w, h) = img.dimensions();
    let (w16, h16) = match (u16::try_from(w), u16::try_from(h)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => {
            return Err(CodecError::encode(F, "JPEG dimensions are limited to 65535"));
        }
    };
    let ct = match img.layout() {
        ChannelLayout::Gray => jpeg_encoder::ColorType::Luma,
        ChannelLayout::Rgb => jpeg_encoder::ColorType::Rgb,
        ChannelLayout::Cmyk => jpeg_encoder::ColorType::Cmyk,
        l => return Err(CodecError::encode(F, format!("unsupported layout {l:?}"))),
    };
    let mut out = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut out, opts.jpeg_quality.clamp(1, 100));
    // CMYK is always written 4:4:4: subsampled 4-component JPEGs are not
    // decoded consistently across implementations.
    let sampling = if opts.jpeg_chroma_subsampling && img.layout() == ChannelLayout::Rgb {
        jpeg_encoder::SamplingFactor::R_4_2_0
    } else {
        jpeg_encoder::SamplingFactor::R_4_4_4
    };
    enc.set_sampling_factor(sampling);
    let e = |e: jpeg_encoder::EncodingError| CodecError::encode(F, e);
    if opts.embed_metadata {
        if let Some((x, y)) = img.meta.dpi
            && x >= 1.0
            && y >= 1.0
        {
            enc.set_density(jpeg_encoder::Density::Inch { x: x.round().min(65535.0) as u16, y: y.round().min(65535.0) as u16 });
        }
        if let Some(exif) = &img.meta.exif {
            // The pixels are written as they are shown: never let a viewer rotate them again.
            let mut seg = EXIF_HEADER.to_vec();
            seg.extend_from_slice(&upright_exif(exif));
            enc.add_app_segment(1, &seg).map_err(e)?;
        }
        if let Some(xmp) = &img.meta.xmp {
            let mut seg = XMP_HEADER.to_vec();
            seg.extend_from_slice(upright_xmp(xmp).as_bytes());
            enc.add_app_segment(1, &seg).map_err(e)?;
        }
    }
    if opts.embed_icc
        && let Some(icc) = &img.icc
    {
        enc.add_icc_profile(icc).map_err(e)?;
    }
    enc.encode(img.data(), w16, h16, ct).map_err(e)?;
    Ok(out)
}
