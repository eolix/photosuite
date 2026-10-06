//! EXIF / TIFF orientation (tag 274): reading it, applying it to the pixels,
//! and rewriting it to 1 ("top-left", upright) once the pixels are upright.
//!
//! Decoders apply the orientation by default (like Photoshop and every photo
//! viewer), so a document is always edited upright. Encoders then write
//! Orientation = 1, so a viewer never rotates the already-upright pixels a
//! second time.
//!
//! Orientation values (TIFF 6.0, EXIF 2.3): 1 = upright, 2 = mirrored, 3 =
//! rotated 180°, 4 = flipped vertically, 5 = transposed, 6 = needs a 90°
//! clockwise turn, 7 = transverse, 8 = needs a 90° counter-clockwise turn.
//! Anything malformed, truncated or out of range reads as 1.

use std::borrow::Cow;

use crate::error::CodecError;
use crate::image::Image;

/// The TIFF/EXIF Orientation tag.
const TAG_ORIENTATION: u16 = 274;
/// TIFF field types that can hold the orientation.
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
/// IFD0 entries we look at, at most (real files have a few dozen).
const MAX_ENTRIES: usize = 1024;

/// Byte order of a TIFF structure.
#[derive(Clone, Copy)]
enum Order {
    Little,
    Big,
}

impl Order {
    fn u16(self, b: &[u8], at: usize) -> Option<u16> {
        let s: [u8; 2] = b.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(match self {
            Order::Little => u16::from_le_bytes(s),
            Order::Big => u16::from_be_bytes(s),
        })
    }

    fn u32(self, b: &[u8], at: usize) -> Option<u32> {
        let s: [u8; 4] = b.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(match self {
            Order::Little => u32::from_le_bytes(s),
            Order::Big => u32::from_be_bytes(s),
        })
    }
}

/// The TIFF payload of an EXIF block (a JPEG-style `Exif\0\0` prefix is skipped).
fn tiff_body(b: &[u8]) -> &[u8] {
    b.strip_prefix(b"Exif\0\0").unwrap_or(b)
}

/// Locates the Orientation entry in IFD0: `(byte order, value offset, field type)`.
fn find_entry(b: &[u8]) -> Option<(Order, usize, u16)> {
    let order = match b.get(0..4)? {
        [b'I', b'I', 42, 0] => Order::Little,
        [b'M', b'M', 0, 42] => Order::Big,
        _ => return None,
    };
    let ifd = usize::try_from(order.u32(b, 4)?).ok()?;
    let count = usize::from(order.u16(b, ifd)?).min(MAX_ENTRIES);
    let first = ifd.checked_add(2)?;
    for i in 0..count {
        let e = first.checked_add(i.checked_mul(12)?)?;
        let tag = order.u16(b, e)?;
        if tag != TAG_ORIENTATION {
            continue;
        }
        let ty = order.u16(b, e.checked_add(2)?)?;
        let n = order.u32(b, e.checked_add(4)?)?;
        if n == 0 || !matches!(ty, TYPE_SHORT | TYPE_LONG) {
            return None;
        }
        // One SHORT or LONG always fits in the 4-byte value field.
        return Some((order, e.checked_add(8)?, ty));
    }
    None
}

/// The orientation (1–8) recorded in a TIFF-structured block: an EXIF payload
/// (with or without the `Exif\0\0` prefix) or a whole TIFF file. Missing,
/// malformed or out-of-range values give 1.
pub fn exif_orientation(exif: &[u8]) -> u16 {
    let b = tiff_body(exif);
    let value = find_entry(b).and_then(|(order, at, ty)| match ty {
        TYPE_SHORT => order.u16(b, at),
        _ => order.u32(b, at).and_then(|v| u16::try_from(v).ok()),
    });
    value.filter(|v| (1..=8).contains(v)).unwrap_or(1)
}

/// `exif` with its Orientation rewritten to 1, borrowed when there is nothing
/// to change (no tag, already 1, or unparseable).
pub fn upright_exif(exif: &[u8]) -> Cow<'_, [u8]> {
    let prefix = exif.len() - tiff_body(exif).len();
    let Some((order, at, ty)) = find_entry(tiff_body(exif)) else {
        return Cow::Borrowed(exif);
    };
    let current = match ty {
        TYPE_SHORT => order.u16(tiff_body(exif), at).map(u32::from),
        _ => order.u32(tiff_body(exif), at),
    };
    if current == Some(1) {
        return Cow::Borrowed(exif);
    }
    let one: Vec<u8> = match (ty, order) {
        (TYPE_SHORT, Order::Little) => 1u16.to_le_bytes().to_vec(),
        (TYPE_SHORT, Order::Big) => 1u16.to_be_bytes().to_vec(),
        (_, Order::Little) => 1u32.to_le_bytes().to_vec(),
        (_, Order::Big) => 1u32.to_be_bytes().to_vec(),
    };
    let mut out = exif.to_vec();
    let Some(at) = prefix.checked_add(at) else { return Cow::Borrowed(exif) };
    match at.checked_add(one.len()).and_then(|end| out.get_mut(at..end)) {
        Some(slot) => {
            slot.copy_from_slice(&one);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(exif),
    }
}

/// `xmp` with any `tiff:Orientation` (attribute or element form) set to 1,
/// borrowed when there is nothing to change.
pub fn upright_xmp(xmp: &str) -> Cow<'_, str> {
    const KEY: &str = "tiff:Orientation";
    if !xmp.contains(KEY) {
        return Cow::Borrowed(xmp);
    }
    let mut out = String::with_capacity(xmp.len());
    let mut rest = xmp;
    let mut changed = false;
    while let Some(i) = rest.find(KEY) {
        let (head, tail) = rest.split_at(i + KEY.len());
        out.push_str(head);
        rest = tail;
        // `tiff:Orientation="6"`, `tiff:Orientation='6'` or `<tiff:Orientation>6<`.
        let open = rest.char_indices().take_while(|&(_, c)| c.is_ascii_whitespace() || matches!(c, '=' | '"' | '\'' | '>')).last();
        let Some((at, c)) = open else { continue };
        if !matches!(c, '"' | '\'' | '>') {
            continue;
        }
        let start = at + 1;
        let digits = rest.get(start..).map_or(0, |s| s.bytes().take_while(u8::is_ascii_digit).count());
        if digits == 0 || rest.get(start..start + digits) == Some("1") {
            continue;
        }
        out.push_str(rest.get(..start).unwrap_or_default());
        out.push('1');
        rest = rest.get(start + digits..).unwrap_or_default();
        changed = true;
    }
    out.push_str(rest);
    if changed { Cow::Owned(out) } else { Cow::Borrowed(xmp) }
}

/// Source pixel index for output pixel `(0, y2)` and the step per output column, for
/// orientation `o` of a `w`×`h` source (values 2–8; see the module docs).
fn walk(o: u16, w: isize, h: isize, y2: isize) -> (isize, isize) {
    match o {
        2 => (y2 * w + w - 1, -1),
        3 => ((h - 1 - y2) * w + w - 1, -1),
        4 => ((h - 1 - y2) * w, 1),
        5 => (y2, w),
        6 => ((h - 1) * w + y2, -w),
        7 => ((h - 1) * w + (w - 1 - y2), -w),
        8 => (w - 1 - y2, w),
        _ => (y2 * w, 1),
    }
}

/// Output columns per block: a block's source pixels (for a 90° turn, `BLOCK`
/// rows × the band height) stay in cache while it is written.
const BLOCK: usize = 64;
/// Output rows per parallel band.
const BAND: usize = 64;

/// Writes the oriented pixels of one band of output rows, `N` bytes per pixel.
fn band<const N: usize>(src: &[[u8; N]], dst: &mut [[u8; N]], o: u16, (w, h): (usize, usize), ow: usize, y0: usize) {
    let (wi, hi) = (w as isize, h as isize);
    let rows = dst.len() / ow.max(1);
    for x0 in (0..ow).step_by(BLOCK) {
        let x1 = (x0 + BLOCK).min(ow);
        for r in 0..rows {
            let (base, step) = walk(o, wi, hi, (y0 + r) as isize);
            let Some(out) = dst.get_mut(r * ow + x0..r * ow + x1) else { return };
            let mut i = base + x0 as isize * step;
            for px in out {
                if let Some(s) = usize::try_from(i).ok().and_then(|i| src.get(i)) {
                    *px = *s;
                }
                i += step;
            }
        }
    }
}

/// Orients `src` (`N` bytes per pixel) into a new buffer, a band of rows per task.
fn orient_n<const N: usize>(src: &[u8], o: u16, (w, h): (usize, usize), ow: usize) -> Vec<u8> {
    let mut out = vec![0u8; src.len()];
    let (s, _) = src.as_chunks::<N>();
    let (d, _) = out.as_chunks_mut::<N>();
    let per = (BAND * ow).max(1);
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        d.par_chunks_mut(per).enumerate().for_each(|(b, chunk)| band(s, chunk, o, (w, h), ow, b * BAND));
    }
    #[cfg(target_arch = "wasm32")]
    for (b, chunk) in d.chunks_mut(per).enumerate() {
        band(s, chunk, o, (w, h), ow, b * BAND);
    }
    out
}

/// Pixel-format-agnostic orientation: any byte size per pixel.
fn orient_bytes(src: &[u8], bpp: usize, o: u16, (w, h): (usize, usize), ow: usize) -> Vec<u8> {
    match bpp {
        1 => orient_n::<1>(src, o, (w, h), ow),
        2 => orient_n::<2>(src, o, (w, h), ow),
        3 => orient_n::<3>(src, o, (w, h), ow),
        4 => orient_n::<4>(src, o, (w, h), ow),
        5 => orient_n::<5>(src, o, (w, h), ow),
        6 => orient_n::<6>(src, o, (w, h), ow),
        8 => orient_n::<8>(src, o, (w, h), ow),
        10 => orient_n::<10>(src, o, (w, h), ow),
        12 => orient_n::<12>(src, o, (w, h), ow),
        16 => orient_n::<16>(src, o, (w, h), ow),
        _ => orient_n::<20>(src, o, (w, h), ow),
    }
}

impl Image {
    /// The image turned upright for orientation `o` (1–8; anything else is
    /// treated as 1 and returns the image unchanged). Width and height swap
    /// for 5–8, as does the DPI, and the EXIF and XMP orientation are
    /// rewritten to 1 so the result is not rotated again on display or export.
    pub fn oriented(self, o: u16) -> Result<Image, CodecError> {
        if !(2..=8).contains(&o) {
            return Ok(self);
        }
        let (w, h) = (self.width() as usize, self.height() as usize);
        let swap = o >= 5;
        let (ow, oh) = if swap { (h, w) } else { (w, h) };
        let (layout, sample) = (self.layout(), self.sample_type());
        let bpp = layout.channels() * sample.bytes();
        // Every layout/sample pair is 1–20 bytes per pixel and has a fixed-size path.
        if !matches!(bpp, 1..=6 | 8 | 10 | 12 | 16 | 20) || w == 0 || h == 0 {
            return Err(CodecError::InvalidImage(format!("cannot orient {layout:?} {sample:?} {w}x{h}")));
        }
        let data = orient_bytes(self.data(), bpp, o, (w, h), ow);
        let mut meta = self.meta.clone();
        if let Some(e) = &mut meta.exif
            && let Cow::Owned(fixed) = upright_exif(e)
        {
            *e = fixed;
        }
        if let Some(x) = &mut meta.xmp
            && let Cow::Owned(fixed) = upright_xmp(x)
        {
            *x = fixed;
        }
        if swap {
            meta.dpi = meta.dpi.map(|(x, y)| (y, x));
        }
        let icc = self.icc.clone();
        Ok(Image::from_raw(ow as u32, oh as u32, layout, sample, data)?.with_icc(icc).with_meta(meta))
    }
}
