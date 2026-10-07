//! # photosuite-io
//!
//! Import and export between [`photosuite_doc::Document`] and files:
//!
//! * PSD / PSB (detected by the `8BPS` signature) via `photosuite-psd`, with
//!   fidelity levels 1–3 (raster layers, masks, blend/opacity/fill,
//!   visibility, names, groups, clipping, adjustment and fill layers).
//!   Every layer keeps its unmodelled tagged blocks in `Layer::psd_blocks`
//!   (vector masks, blending options, original adjustment/fill blocks, text
//!   and smart-object data) and re-export writes them back; text, shape and
//!   smart-object layers also keep their pixels as the cached raster, and fill
//!   layers keep Photoshop's rendering in `Layer::fill_cache`.
//! * Camera raws (DNG, CR2, uncompressed / lossless TIFF-EP raws) via
//!   `photosuite-raw`, developed into a 16-bit ProPhoto RGB "Background"
//!   layer; unsupported raw variants fall back to the embedded JPEG preview.
//! * Layered TIFFs (Photoshop layer data in tags 37724 and 34377) open with their
//!   layers through the PSD path and are written back the same way; see `tiff_layers`.
//! * Every other format goes through `photosuite-codecs` as a single
//!   "Background" layer (depth and Gray/RGB/CMYK model preserved).
//!
//! Exports to PSD render the merged composite with
//! `photosuite_compose::flatten`; flat exports report what is lost.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

pub mod abr_map;
mod adjust_map;
pub mod annotations_map;
pub mod blocks;
mod channel_map;
pub mod comps_map;
pub mod effects_map;
mod flat;
mod gradient_bake;
pub mod linked;
mod multichannel_map;
pub mod pattern_map;
pub mod pdf;
mod pixels;
mod psd_export;
mod psd_import;
pub mod raw;
pub mod slices_map;
pub mod smart_map;
pub mod text_styles_map;
pub mod tiff_layers;
pub mod vector_map;

use photosuite_codecs::{CodecError, EncodeOptions};
use photosuite_doc::Document;
use photosuite_psd::{PsdError, PsdFile};

pub use adjust_map::ADJUSTMENT_KEYS;
pub use flat::document_to_image;
pub use psd_export::{PsdExportOptions, document_to_psd, document_to_psd_with};
pub use psd_import::{psd_to_document, psd_to_document_with};

/// Errors from import/export.
#[derive(Debug, thiserror::Error)]
pub enum IoError {
    /// PSD parse/write failure.
    #[error("PSD: {0}")]
    Psd(#[from] PsdError),
    /// Codec failure.
    #[error("codec: {0}")]
    Codec(#[from] CodecError),
    /// The file type could not be determined.
    #[error("unknown file format: {0}")]
    UnknownFormat(String),
    /// The requested conversion is not possible.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// Native `.pcraft` bundle failure.
    #[error("pcraft: {0}")]
    Pcraft(#[from] photosuite_format::FormatError),
    /// Camera raw decode failure.
    #[error("{0}")]
    Raw(#[from] photosuite_raw::RawError),
    /// A background import was cancelled ([`import_with`]).
    #[error("cancelled")]
    Cancelled,
}

/// Result of [`import`].
#[derive(Debug, Clone)]
pub struct ImportResult {
    /// The imported document.
    pub document: Document,
    /// Human-readable notes about anything approximated or dropped.
    pub warnings: Vec<String>,
}

/// Result of [`export`].
#[derive(Debug, Clone)]
pub struct ExportResult {
    /// Encoded file.
    pub bytes: Vec<u8>,
    /// Human-readable notes about anything approximated or dropped.
    pub warnings: Vec<String>,
}

/// Export options. The default writes a flat TIFF: callers that keep layers ask for them.
#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    /// Codec options for flat formats.
    pub encode: EncodeOptions,
    /// Write PSB even for `.psd` names when the document is small.
    pub force_psb: bool,
    /// TIFF: keep the layers (Photoshop layer data in tag 37724). Off by default, so scripted
    /// and agent saves (CLI, batch, MCP) write a flat TIFF unless they ask for layers; the app's
    /// Save As sets it from its Layers option, which keeps them as Photoshop does. `false` is
    /// Photoshop's "Discard Layers and Save a Copy".
    pub tiff_layers: bool,
}

/// `true` if `bytes` start with the PSD/PSB signature.
pub fn is_psd(bytes: &[u8]) -> bool {
    bytes.starts_with(b"8BPS")
}

/// Imports a file. PSD/PSB and camera raws are detected by magic; everything
/// else is decoded with `photosuite-codecs`.
pub fn import(name: &str, bytes: &[u8]) -> Result<ImportResult, IoError> {
    import_with(name, bytes, &photosuite_raster::Interrupt::NONE)
}

/// [`import`] for a background open: checks `ctl` between stages (and per layer for PSD/PSB) and
/// reports progress. A cancelled import fails with [`IoError::Cancelled`].
pub fn import_with(name: &str, bytes: &[u8], ctl: &photosuite_raster::Interrupt) -> Result<ImportResult, IoError> {
    ctl.check().map_err(|_| IoError::Cancelled)?;
    let r = import_stages(name, bytes, ctl)?;
    ctl.check().map_err(|_| IoError::Cancelled)?;
    ctl.progress(1.0);
    Ok(r)
}

fn import_stages(name: &str, bytes: &[u8], ctl: &photosuite_raster::Interrupt) -> Result<ImportResult, IoError> {
    // A declared native extension must reach its loader so malformed bundles retain format errors.
    if has_extension(name, photosuite_format::EXTENSION) || photosuite_format::is_pcraft(bytes) {
        return Ok(ImportResult { document: photosuite_format::load_from_bytes(bytes)?, warnings: Vec::new() });
    }
    if is_psd(bytes) {
        let file = PsdFile::from_bytes(bytes)?;
        ctl.check().map_err(|_| IoError::Cancelled)?;
        ctl.progress(0.05);
        let (mut document, warnings) = psd_import::psd_to_document_with(&file, ctl).ok_or(IoError::Cancelled)?;
        document.name = name.to_string();
        return Ok(ImportResult { document, warnings });
    }
    if raw::is_raw(bytes) {
        return raw::import_raw(name, bytes);
    }
    if has_extension(name, "pdf") || pdf::is_pdf(bytes) {
        return pdf::import_page(name, bytes, 0, pdf::DEFAULT_DPI);
    }
    flat::import_flat(name, bytes)
}

fn extension(name_or_ext: &str) -> String {
    name_or_ext.rsplit(['.', '/', '\\']).next().unwrap_or(name_or_ext).to_ascii_lowercase()
}

fn has_extension(name: &str, expected: &str) -> bool {
    name.rsplit(['/', '\\']).next().and_then(|name| name.rsplit_once('.')).is_some_and(|(base, ext)| !base.is_empty() && ext.eq_ignore_ascii_case(expected))
}

/// Exports `doc` to the format named by `name_or_ext` (a file name, path or
/// bare extension).
pub fn export(doc: &Document, name_or_ext: &str, opts: &ExportOptions) -> Result<ExportResult, IoError> {
    let ext = extension(name_or_ext);
    if ext == photosuite_format::EXTENSION {
        let previews = photosuite_format::SaveOptions {
            thumbnail: Some(photosuite_compose::thumbnail(doc, 256)),
            composite: Some(photosuite_compose::thumbnail(doc, 1024)),
        };
        return Ok(ExportResult { bytes: photosuite_format::save_to_bytes(doc, &previews)?, warnings: Vec::new() });
    }
    if ext == "psd" || ext == "psb" {
        let o = PsdExportOptions { force_psb: opts.force_psb || ext == "psb", ..Default::default() };
        let (file, warnings) = document_to_psd_with(doc, &o);
        // Never write a header the reader would refuse (e.g. a zero-sized canvas).
        file.header.validate()?;
        let bytes = file.to_bytes()?;
        return Ok(ExportResult { bytes, warnings });
    }
    if ext == "pdf" {
        return pdf::export(doc, opts.encode.jpeg_quality);
    }
    let format = photosuite_codecs::from_extension(&ext).ok_or_else(|| IoError::UnknownFormat(name_or_ext.to_string()))?;
    if format == photosuite_codecs::Format::Tiff && opts.tiff_layers && tiff_layers::would_write_layers(doc) {
        return tiff_layers::export_layered(doc, opts);
    }
    flat::export_flat(doc, format, opts)
}

/// The PSD's merged composite as straight RGBA floats (row-major), converted
/// with the document pixel model and un-matted from white (Photoshop mattes
/// the merged image of transparent documents). Used as the compositing oracle.
pub fn merged_composite(file: &PsdFile) -> Result<Vec<[f32; 4]>, IoError> {
    let img = file.composite_rgba8().ok();
    let h = &file.header;
    // CMYK goes through the colour-managed model conversion (the PSD crate's RGBA preview is a
    // naive, profile-free conversion).
    if let (Some(img), false) = (img, matches!(h.color_mode, photosuite_psd::ColorMode::Lab | photosuite_psd::ColorMode::Cmyk)) {
        let unmatte = file.merged_has_alpha();
        return Ok(img
            .data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|p| {
                let mut v: [f32; 4] = std::array::from_fn(|i| f32::from(p[i]) / 255.0);
                if unmatte {
                    for c in 0..3 {
                        v[c] = pixels::unmatte(v[c], v[3], 1.0).clamp(0.0, 1.0);
                    }
                }
                v
            })
            .collect());
    }
    // Generic path (Lab, CMYK and others) via the raster model conversion.
    let (doc, _) = psd_to_document(&PsdFile { layer_info: None, ..file.clone() });
    // Multichannel documents keep their channels apart (no layer): composite them.
    if doc.layers.is_empty() && doc.mode == photosuite_color::ColorMode::Multichannel {
        return Ok(photosuite_compose::flatten(&doc).px);
    }
    let l = doc.layers.first().ok_or_else(|| IoError::Unsupported("no merged image".into()))?;
    let s = l.surface().ok_or_else(|| IoError::Unsupported("no merged image".into()))?;
    Ok(photosuite_compose::surface_to_buffer(s, doc.bounds()).px)
}
