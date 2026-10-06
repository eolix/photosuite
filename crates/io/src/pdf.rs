//! PDF: open a page as pixels and save a flattened page.
//!
//! Opening renders the page with `hayro` (pure Rust, Apache-2.0 OR MIT; its standard fonts are
//! PDFium's Foxit fonts, BSD-3-Clause) at a resolution, like Photoshop's Import PDF with
//! "Pages" selected; text and vectors become pixels. Saving writes one page holding the
//! flattened image as JPEG, sized so it prints at the document's resolution (ISO 32000-1:
//! a catalog, a page tree, and per page a content stream and a DCTDecode image XObject).

use photosuite_codecs::{self as codecs, ChannelLayout, Format, SampleType};

use crate::{ExportResult, ImportResult, IoError};

/// Photoshop's Import PDF default resolution.
pub const DEFAULT_DPI: f32 = 300.0;

/// Whether `bytes` start like a PDF.
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes.len() >= 5 && bytes.get(..1024.min(bytes.len())).is_some_and(|h| h.windows(5).any(|w| w == b"%PDF-"))
}

fn load(bytes: &[u8]) -> Result<hayro::hayro_syntax::Pdf, IoError> {
    hayro::hayro_syntax::Pdf::new(bytes.to_vec()).map_err(|e| IoError::Unsupported(format!("PDF: can't read this file ({e:?})")))
}

/// Number of pages.
pub fn page_count(bytes: &[u8]) -> Result<usize, IoError> {
    Ok(load(bytes)?.pages().len())
}

/// Opens page `page` (0-based) at `dpi` as a one-layer document named `name`.
pub fn import_page(name: &str, bytes: &[u8], page: usize, dpi: f32) -> Result<ImportResult, IoError> {
    let pdf = load(bytes)?;
    let pages = pdf.pages();
    let n = pages.len();
    let p = pages.get(page).ok_or_else(|| IoError::Unsupported(format!("PDF has {n} pages; there is no page {}", page + 1)))?;
    let (wpt, hpt) = p.render_dimensions();
    if !(wpt > 0.0 && hpt > 0.0 && wpt.is_finite() && hpt.is_finite()) {
        return Err(IoError::Unsupported("PDF page has no size".into()));
    }
    // Scale to `dpi`, then down so the page fits the decode limits and hayro's 16-bit sizes.
    let limits = codecs::Limits::default();
    let mut scale = dpi.clamp(1.0, 2400.0) / 72.0;
    let max_side = (limits.max_width.min(limits.max_height) as f32).min(65_535.0);
    scale = scale.min(max_side / wpt.max(hpt));
    let px = f64::from(wpt * scale) * f64::from(hpt * scale);
    if px > limits.max_pixels as f64 {
        scale *= (limits.max_pixels as f64 / px).sqrt() as f32;
    }
    let mut warnings = Vec::new();
    if (scale * 72.0 - dpi).abs() > 0.5 {
        warnings.push(format!("PDF page opened at {:.0} ppi (the most that fits), not {dpi:.0}", scale * 72.0));
    }
    if n > 1 {
        warnings.push(format!("PDF has {n} pages; opened page {}", page + 1));
    }
    let cache = hayro::RenderCache::new();
    let settings = hayro::hayro_interpret::InterpreterSettings::default();
    let pix = hayro::render(
        p,
        &cache,
        &settings,
        &hayro::RenderSettings::default(),
        &hayro::PixmapSettings { x_scale: scale, y_scale: scale, bg_color: hayro::vello_cpu::color::palette::css::TRANSPARENT },
    );
    let (w, h) = (u32::from(pix.width()), u32::from(pix.height()));
    // Premultiplied → straight.
    let mut rgba = pix.data_as_u8_slice().to_vec();
    for q in rgba.chunks_exact_mut(4) {
        let a = u32::from(q[3]);
        if a > 0 && a < 255 {
            for c in &mut q[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    let img = codecs::Image::from_u8(w.max(1), h.max(1), ChannelLayout::Rgba, rgba).map_err(|e| IoError::Unsupported(e.to_string()))?;
    let mut r = crate::flat::image_to_document(name, &img)?;
    r.document.resolution_dpi = scale * 72.0;
    r.warnings.extend(warnings);
    Ok(r)
}

/// Saves the document flattened over white as a one-page PDF (JPEG at `quality`).
pub fn export(doc: &photosuite_doc::Document, quality: u8) -> Result<ExportResult, IoError> {
    let mut warnings = Vec::new();
    let mut img = crate::flat::document_to_image(doc, &mut warnings)?;
    if img.layout().is_cmyk() {
        img = crate::flat::cmyk_image_to_srgb(&img)?;
    }
    let rgba = img.converted(ChannelLayout::Rgba, SampleType::U8);
    let (w, h) = rgba.dimensions();
    let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
    for q in rgba.data().chunks_exact(4) {
        let a = u32::from(q[3]);
        for c in &q[..3] {
            rgb.push(((u32::from(*c) * a + 255 * (255 - a) + 127) / 255) as u8);
        }
    }
    let flat = codecs::Image::from_u8(w, h, ChannelLayout::Rgb, rgb).map_err(|e| IoError::Unsupported(e.to_string()))?;
    let opts = codecs::EncodeOptions { jpeg_quality: quality.clamp(1, 100), embed_icc: false, embed_metadata: false, ..Default::default() };
    let jpeg = codecs::encode(&flat, Format::Jpeg, &opts)?;
    if doc.layers.len() > 1 || rgba.data().chunks_exact(4).any(|q| q[3] < 255) {
        warnings.push("PDF: layers flattened over white".into());
    }
    Ok(ExportResult { bytes: raster_pdf(&[(w, h, doc.resolution_dpi, jpeg)]), warnings })
}

/// A minimal PDF with one page per JPEG image: (width px, height px, dpi, JPEG bytes). Pages are
/// sized so the image prints at its resolution.
pub fn raster_pdf(pages: &[(u32, u32, f32, Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets: Vec<usize> = Vec::new();
    let mut obj = |out: &mut Vec<u8>, body: &[u8]| {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", offsets.len()).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    // Objects: 1 catalog, 2 page tree, then per page: page, contents, image.
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 3 + i * 3)).collect();
    obj(&mut out, b"<< /Type /Catalog /Pages 2 0 R >>");
    obj(&mut out, format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()).as_bytes());
    for (i, (w, h, dpi, jpeg)) in pages.iter().enumerate() {
        let k = 72.0 / f64::from(dpi.max(1.0));
        let (pw, ph) = (f64::from(*w) * k, f64::from(*h) * k);
        let (contents, image) = (4 + i * 3, 5 + i * 3);
        obj(
            &mut out,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.3} {ph:.3}] /Resources << /XObject << /Im0 {image} 0 R >> >> /Contents {contents} 0 R >>"
            )
            .as_bytes(),
        );
        let stream = format!("q {pw:.3} 0 0 {ph:.3} 0 0 cm /Im0 Do Q");
        obj(&mut out, format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()).as_bytes());
        let mut img = format!(
            "<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            jpeg.len()
        )
        .into_bytes();
        img.extend_from_slice(jpeg);
        img.extend_from_slice(b"\nendstream");
        obj(&mut out, &img);
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1).as_bytes());
    for o in &offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1).as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> photosuite_doc::Document {
        let mut d = photosuite_doc::Document::with_background(
            "card",
            photosuite_geom::Size::new(144, 72),
            photosuite_color::ColorMode::Rgb,
            photosuite_color::SampleType::U8,
            photosuite_doc::Color::WHITE,
        );
        d.resolution_dpi = 72.0;
        if let Some(s) = d.layers.first_mut().and_then(|l| l.surface_mut()) {
            s.fill_rect(photosuite_geom::Rect::new(0, 0, 72, 72), &[1.0, 0.0, 0.0, 1.0]);
        }
        d
    }

    #[test]
    fn saved_pdfs_open_again_with_their_pixels() {
        let r = export(&doc(), 95).unwrap();
        assert!(is_pdf(&r.bytes));
        assert_eq!(page_count(&r.bytes).unwrap(), 1);
        // 2 in × 1 in page; at 72 ppi it comes back 144 × 72 with red on the left.
        let back = import_page("card.pdf", &r.bytes, 0, 72.0).unwrap().document;
        assert_eq!((back.size.width, back.size.height), (144, 72));
        let s = back.layers.first().and_then(|l| l.surface()).unwrap();
        let (l, rt) = (s.rgba(20, 36), s.rgba(120, 36));
        assert!(l[0] > 0.9 && l[1] < 0.15, "{l:?}");
        assert!(rt[0] > 0.9 && rt[1] > 0.9, "{rt:?}");
        // At 300 ppi the same page is 600 × 300.
        let big = import_page("card.pdf", &r.bytes, 0, 300.0).unwrap();
        assert_eq!((big.document.size.width, big.document.size.height), (600, 300));
        assert!((big.document.resolution_dpi - 300.0).abs() < 0.5);
    }

    #[test]
    fn bad_input_is_an_error() {
        assert!(!is_pdf(b"hello"));
        assert!(import_page("x.pdf", b"%PDF-1.4 garbage", 0, 72.0).is_err());
        let r = export(&doc(), 90).unwrap();
        assert!(import_page("x.pdf", &r.bytes, 3, 72.0).is_err(), "no such page");
    }
}
