//! Camera raw files via `photosuite-raw`: developed to a 16-bit RGB document
//! in ProPhoto RGB (the embedded profile is the built-in ProPhoto-compatible
//! profile), or, for raw variants not decoded yet, the camera's embedded
//! JPEG preview with a warning.

use std::sync::Arc;

use photosuite_codecs::{self as codecs, ChannelLayout, Format, Image};
use photosuite_raw::{DevelopOptions, Limits, RawError};

use crate::flat::image_to_document;
use crate::{ImportResult, IoError};

/// `true` if `bytes` are a camera raw file `photosuite-raw` recognises.
pub fn is_raw(bytes: &[u8]) -> bool {
    photosuite_raw::is_raw(bytes)
}

/// The decode limits shared with the flat codecs.
fn limits() -> Limits {
    let l = codecs::Limits::default();
    Limits { max_width: l.max_width, max_height: l.max_height, max_pixels: l.max_pixels, max_alloc: l.max_alloc }
}

/// A raw file's embedded JPEG preview, turned upright. Its own EXIF orientation wins when it
/// has one; otherwise the raw's IFD0 orientation applies (TIFF-based raws record it there, and
/// their previews are usually stored as the sensor reads out). Developed raws are oriented by
/// `photosuite-raw` and carry no EXIF, so nothing is turned twice.
fn upright_preview(raw: &[u8], jpeg: &[u8]) -> Result<Image, IoError> {
    let img = codecs::decode_as_with(Format::Jpeg, jpeg, &codecs::DecodeOptions { keep_orientation: true, ..Default::default() })?;
    let own = img.meta.exif.as_deref().map_or(1, codecs::exif_orientation);
    let o = if own != 1 { own } else { codecs::exif_orientation(raw) };
    Ok(img.oriented(o)?)
}

/// Develops a raw file with the default settings.
pub fn import_raw(name: &str, bytes: &[u8]) -> Result<ImportResult, IoError> {
    import_raw_with(name, bytes, &DevelopOptions { limits: limits(), ..Default::default() })
}

/// A raw file's camera, lens and exposure as an EXIF block for its document, the way an opened
/// JPEG or PSD keeps its own (Lens Correction's Auto tab and Camera Raw read it; saving keeps it).
/// From the file's TIFF structure where it has one (CR2, NEF, ARW, DNG, PEF, RW2, ORF), else the
/// embedded preview's (CR3, RAF), with the decoder's make and model filling any gap.
pub(crate) fn camera_exif(bytes: &[u8], info: &photosuite_raw::RawInfo) -> Option<Vec<u8>> {
    use photosuite_algo::exif;
    let mut ci = exif::read(bytes);
    if (ci.make.is_none() || ci.lens.is_none() || ci.focal_length.is_none())
        && let Some(e) = photosuite_raw::embedded_preview(bytes).and_then(|p| codecs::jpeg_exif(p.jpeg))
    {
        let p = exif::read(&e);
        ci.make = ci.make.or(p.make);
        ci.model = ci.model.or(p.model);
        ci.lens = ci.lens.or(p.lens);
        ci.exposure_time = ci.exposure_time.or(p.exposure_time);
        ci.f_number = ci.f_number.or(p.f_number);
        ci.iso = ci.iso.or(p.iso);
        ci.focal_length = ci.focal_length.or(p.focal_length);
        ci.focal_length_35mm = ci.focal_length_35mm.or(p.focal_length_35mm);
    }
    ci.make = ci.make.or_else(|| info.make.clone());
    ci.model = ci.model.or_else(|| info.model.clone());
    (ci != exif::CameraInfo::default()).then(|| exif::build(&ci))
}

/// Develops a raw file with explicit settings.
pub fn import_raw_with(name: &str, bytes: &[u8], opts: &DevelopOptions) -> Result<ImportResult, IoError> {
    let format = photosuite_raw::identify(bytes).map(|f| f.name()).unwrap_or("camera raw");
    match photosuite_raw::develop(bytes, opts) {
        Ok(dev) => {
            let img = Image::from_u16(dev.width, dev.height, ChannelLayout::Rgb, &dev.rgb)?;
            let mut r = image_to_document(name, &img)?;
            r.document.icc_profile = Some(Arc::new(photosuite_cms::Builtin::ProPhotoCompat.profile().to_bytes().to_vec()));
            r.document.metadata.exif = camera_exif(bytes, &dev.info).map(Arc::new);
            // "Canon" + "Canon EOS 80D" reads as "Canon EOS 80D".
            let camera = match (dev.info.make.as_deref(), dev.info.model.as_deref()) {
                (Some(make), Some(model)) if model.to_ascii_lowercase().starts_with(&make.to_ascii_lowercase()) => model.to_string(),
                (make, model) => [make, model].into_iter().flatten().collect::<Vec<_>>().join(" "),
            };
            r.warnings.push(format!(
                "{format}{} developed with default settings ({} demosaic, as-shot white balance) into 16-bit {}",
                if camera.is_empty() { String::new() } else { format!(" from {camera}") },
                opts.demosaic.id(),
                photosuite_raw::OUTPUT_SPACE
            ));
            r.warnings.extend(dev.warnings);
            Ok(r)
        }
        Err(RawError::Unsupported(reason)) => match photosuite_raw::embedded_preview(bytes) {
            Some(p) => {
                let img = upright_preview(bytes, p.jpeg)?;
                let mut r = image_to_document(name, &img)?;
                r.warnings.insert(
                    0,
                    format!(
                        "{format}: {reason} is not supported yet; opened the camera's embedded {}x{} JPEG preview instead (8-bit, not the raw sensor data)",
                        p.width, p.height
                    ),
                );
                Ok(r)
            }
            None => Err(IoError::Raw(RawError::Unsupported(reason))),
        },
        Err(e) => Err(IoError::Raw(e)),
    }
}
