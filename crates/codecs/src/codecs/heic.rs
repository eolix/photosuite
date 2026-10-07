//! HEIC / HEIF (ISO/IEC 23008-12 with HEVC pictures): decode only, through `heic-rs` (pure Rust,
//! no unsafe). The primary image comes out as RGB or RGBA, 8-bit, or 16-bit when the HEVC
//! stream is deeper than 8 bits (iPhone 10-bit photos). Grids, rotation, mirroring and clean
//! aperture are applied by the decoder; ICC, EXIF and XMP are kept. EXIF orientation is left as
//! it is: in HEIF the `irot`/`imir` properties orient the image, and readers ignore the tag.

use crate::Format;
use crate::error::CodecError;
use crate::image::{ChannelLayout, Image, Metadata, SampleType};
use crate::options::Limits;

const F: Format = Format::Heic;

fn err(e: heic_rs::Error) -> CodecError {
    match e {
        heic_rs::Error::Unsupported(what) => CodecError::unsupported(F, what),
        heic_rs::Error::PixelLimit { pixels, max_pixels } => CodecError::LimitExceeded(format!("{pixels} pixels exceed max {max_pixels}")),
        e => CodecError::malformed(F, e),
    }
}

pub(crate) fn decode(bytes: &[u8], limits: &Limits) -> Result<Image, CodecError> {
    let info = heic_rs::probe(bytes).map_err(err)?;
    let layout = if info.has_alpha { ChannelLayout::Rgba } else { ChannelLayout::Rgb };
    let sample = if info.bit_depth > 8 { SampleType::U16 } else { SampleType::U8 };
    limits.check(info.width, info.height, layout, sample)?;
    let out_layout = match (layout, sample) {
        (ChannelLayout::Rgba, SampleType::U16) => heic_rs::PixelLayout::Rgba16,
        (ChannelLayout::Rgba, _) => heic_rs::PixelLayout::Rgba8,
        (_, SampleType::U16) => heic_rs::PixelLayout::Rgb16,
        _ => heic_rs::PixelLayout::Rgb8,
    };
    let opts = heic_rs::DecodeOptions::default().with_layout(out_layout).with_max_pixels(Some(limits.max_pixels)).with_alpha(true);
    // heic-rs is meant never to panic, but a damaged stream can still overflow its arithmetic
    // (heic-rs 0.1.1: `color/kernel.rs`, with overflow checks on). A file must not take the app
    // down, so a panic in the decoder is reported as a malformed file.
    let pic = std::panic::catch_unwind(|| heic_rs::decode(bytes, &opts))
        .map_err(|_| CodecError::malformed(F, "the HEVC stream is damaged (the decoder stopped)"))?
        .map_err(err)?;
    // The output layout is what was asked for; the size is the probed one after transforms.
    let mut img = Image::from_raw(pic.width, pic.height, layout, sample, pic.data)?;
    let (icc, meta) = metadata(bytes);
    img.icc = icc;
    img.meta = meta;
    Ok(img)
}

/// The primary image's ICC profile, EXIF (a TIFF block, as the other codecs keep it) and XMP.
/// Unreadable metadata is dropped rather than failing a picture that decoded.
fn metadata(bytes: &[u8]) -> (Option<Vec<u8>>, Metadata) {
    let Ok(ctx) = heic_rs::context::Context::open(bytes) else { return (None, Metadata::default()) };
    let id = ctx.meta.primary;
    let icc = ctx.props(id).ok().and_then(|p| ctx.icc(&p).map(<[u8]>::to_vec)).filter(|p| !p.is_empty());
    let exif = ctx.exif(id).ok().flatten().map(<[u8]>::to_vec).filter(|e| !e.is_empty());
    let xmp = ctx.xmp_item(id).and_then(|x| ctx.item_data(x).ok()).and_then(|d| String::from_utf8(d.into_owned()).ok());
    (icc, Metadata { exif, xmp, ..Default::default() })
}
