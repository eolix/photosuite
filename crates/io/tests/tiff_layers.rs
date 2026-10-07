//! Layered TIFF (Photoshop layer data in tags 37724 / 34377): Document → TIFF → Document round
//! trips in every mode and depth, equivalence with the PSD path, the flat fall-backs, files
//! written by an independent implementation (psdtags, both byte orders), and malformed input.

mod common;

use common::*;
use photosuite_color::{ColorMode, SampleType};
use photosuite_doc::{Document, LayerContent};
use photosuite_io::*;
use photosuite_psd::tiff::{ByteOrder, ImageSourceData};

fn tiff(doc: &Document, layers: bool) -> ExportResult {
    export(doc, "x.tif", &ExportOptions { tiff_layers: layers, ..Default::default() }).expect("export")
}

/// The two Photoshop tags of a TIFF: (resources, layers).
fn tags(bytes: &[u8]) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let (r, l) = photosuite_codecs::tiff_photoshop_tags(bytes);
    (r.map(<[u8]>::to_vec), l.map(<[u8]>::to_vec))
}

fn roundtrip(doc: &Document) -> Document {
    let r = tiff(doc, true);
    let (resources, layers) = tags(&r.bytes);
    let layers = layers.expect("layer data");
    assert!(resources.is_some_and(|r| !r.is_empty()), "image resources");
    // The layer data matches the container's byte order and is byte-stable through the psd crate.
    let order = if photosuite_codecs::tiff_writes_little_endian() { ByteOrder::Little } else { ByteOrder::Big };
    let (isd, w) = ImageSourceData::from_bytes(&layers).expect("parse layer data");
    assert!(w.is_empty(), "{w:?}");
    assert_eq!(isd.byte_order, order);
    assert_eq!(isd.to_bytes(order).unwrap().0, layers);
    // The TIFF is a plain image to any other reader: the composite at the document's size.
    let flat = photosuite_codecs::decode(&r.bytes).expect("flat decode");
    assert_eq!(flat.dimensions(), (doc.size.width, doc.size.height));
    // A TIFF holds one transparency channel: extra alpha channels (and a Quick Mask) are not
    // kept, and the export says so.
    let extra = doc.channels.len() + usize::from(doc.quick_mask.is_some());
    assert_eq!(r.warnings.iter().any(|w| w.contains("alpha channel(s) are not written")), extra > 0, "{:?}", r.warnings);
    import("x.tif", &r.bytes).expect("import").document
}

/// `doc` as a layered TIFF round trip returns it: without extra alpha channels or a Quick Mask.
fn expected(doc: &Document) -> Document {
    let mut d = doc.clone();
    d.channels.clear();
    d.quick_mask = None;
    d
}

macro_rules! rt_case {
    ($name:ident, $mode:expr, $depth:expr, $f:expr) => {
        #[test]
        fn $name() {
            let d = gen_doc($mode, $depth, $f);
            let back = roundtrip(&d);
            assert_docs_eq(&expected(&d), &back);
        }
    };
}

rt_case!(rt_rgb8_all, ColorMode::Rgb, SampleType::U8, Features::ALL);
rt_case!(rt_rgb16_all, ColorMode::Rgb, SampleType::U16, Features::ALL);
rt_case!(rt_rgb32_all, ColorMode::Rgb, SampleType::F32, Features::ALL);
rt_case!(rt_gray8_all, ColorMode::Grayscale, SampleType::U8, Features::ALL);
rt_case!(rt_gray16_all, ColorMode::Grayscale, SampleType::U16, Features::ALL);
rt_case!(rt_gray32_all, ColorMode::Grayscale, SampleType::F32, Features::ALL);
rt_case!(rt_cmyk8_all, ColorMode::Cmyk, SampleType::U8, Features::ALL);
rt_case!(rt_cmyk16_all, ColorMode::Cmyk, SampleType::U16, Features::ALL);
rt_case!(rt_rgb8_pixels, ColorMode::Rgb, SampleType::U8, Features::PIXELS);
rt_case!(rt_gray16_pixels, ColorMode::Grayscale, SampleType::U16, Features::PIXELS);
rt_case!(rt_cmyk8_pixels, ColorMode::Cmyk, SampleType::U8, Features::PIXELS);

#[test]
fn tiff_and_psd_open_as_the_same_document() {
    for (mode, depth) in [(ColorMode::Rgb, SampleType::U8), (ColorMode::Cmyk, SampleType::U16), (ColorMode::Grayscale, SampleType::F32)] {
        let d = gen_doc(mode, depth, Features::ALL);
        let psd = export(&d, "x.psd", &ExportOptions::default()).unwrap();
        let from_psd = import("x.psd", &psd.bytes).unwrap().document;
        let from_tif = roundtrip(&d);
        assert_docs_eq(&expected(&from_psd), &from_tif);
        // The composite the TIFF carries is what the document looks like.
        let tif = tiff(&d, true);
        let flat = import(
            "flat.tif",
            &photosuite_codecs::encode(&photosuite_codecs::decode(&tif.bytes).unwrap(), photosuite_codecs::Format::Tiff, &Default::default()).unwrap(),
        )
        .unwrap()
        .document;
        let a = photosuite_compose::flatten(&d).px;
        let b = photosuite_compose::flatten(&flat).px;
        assert!(max_diff(&a, &b) <= 2.0 / 255.0, "{mode:?} {depth:?}: composite differs by {}", max_diff(&a, &b));
    }
}

#[test]
fn every_compression_keeps_the_layers() {
    use photosuite_codecs::TiffCompression;
    let d = gen_doc(ColorMode::Rgb, SampleType::U16, Features::PIXELS);
    for c in [TiffCompression::None, TiffCompression::Lzw, TiffCompression::Deflate, TiffCompression::PackBits] {
        let mut opts = ExportOptions::default();
        opts.encode.tiff_compression = c;
        let r = export(&d, "x.tiff", &opts).unwrap();
        let back = import("x.tiff", &r.bytes).unwrap().document;
        assert_docs_eq(&d, &back);
    }
}

#[test]
fn discard_layers_writes_a_flat_file() {
    let d = gen_doc(ColorMode::Rgb, SampleType::U8, Features::PIXELS);
    let r = tiff(&d, false);
    assert_eq!(tags(&r.bytes), (None, None));
    assert!(r.warnings.iter().any(|w| w.contains("flattened")), "{:?}", r.warnings);
    let back = import("x.tif", &r.bytes).unwrap().document;
    assert_eq!(back.layers.len(), 1);
    assert!(!tiff_layers::would_write_layers(&back));
}

#[test]
fn a_plain_background_needs_no_layer_data() {
    let d = import("x.png", &export(&gen_doc(ColorMode::Rgb, SampleType::U8, Features::PIXELS), "x.png", &Default::default()).unwrap().bytes).unwrap().document;
    assert_eq!(d.layers.len(), 1);
    assert!(!tiff_layers::would_write_layers(&d));
    let r = tiff(&d, true);
    assert_eq!(tags(&r.bytes), (None, None));
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let back = import("x.tif", &r.bytes).unwrap().document;
    assert_docs_eq(&d, &back);
}

#[test]
fn lab_documents_are_saved_flat_with_a_warning() {
    let d = gen_doc(ColorMode::Lab, SampleType::U8, Features::PIXELS);
    let r = tiff(&d, true);
    assert_eq!(tags(&r.bytes), (None, None));
    assert!(r.warnings.iter().any(|w| w.contains("Lab") && w.contains("layers are not kept")), "{:?}", r.warnings);
    assert!(import("x.tif", &r.bytes).is_ok());
}

#[test]
fn transparency_is_straight_in_the_composite() {
    // A translucent layer over nothing: the TIFF's composite keeps its colour under the alpha
    // instead of being matted against white like a PSD's merged image.
    let mut d = Document::new("t", photosuite_geom::Size::new(4, 4), ColorMode::Rgb, SampleType::U8);
    let fmt = d.pixel_format();
    let mut l = raster("Red", fmt, photosuite_geom::Rect::new(0, 0, 4, 4), 0, false);
    if let LayerContent::Raster(s) = &mut l.content {
        let px: Vec<f32> = (0..16).flat_map(|_| [1.0, 0.0, 0.0, 0.5]).collect();
        s.write_region(photosuite_geom::Rect::new(0, 0, 4, 4), &px);
    }
    d.layers.push(l);
    let r = tiff(&d, true);
    let flat = photosuite_codecs::decode(&r.bytes).unwrap();
    assert!(flat.layout().has_alpha());
    let px = flat.data();
    assert_eq!(&px[..4], &[255, 0, 0, 128]);
    let back = import("x.tif", &r.bytes).unwrap().document;
    assert_docs_eq(&d, &back);
}

#[test]
fn big_documents_use_the_psb_signature() {
    // Forcing PSB stands in for a > 30000 px document.
    let d = gen_doc(ColorMode::Rgb, SampleType::U8, Features::PIXELS);
    let r = export(&d, "x.tif", &ExportOptions { force_psb: true, ..Default::default() }).unwrap();
    let (_, layers) = tags(&r.bytes);
    assert!(layers.unwrap().starts_with(photosuite_psd::tiff::SIGNATURE_PSB));
    let back = import("x.tif", &r.bytes).unwrap().document;
    assert_docs_eq(&d, &back);
}

/// Files written by psdtags (`scripts/layered_tiff_fixtures.py`): two RGB layers, "Background"
/// (RLE) and an offset, translucent "Upper é" (ZIP, Multiply, opacity 200), in both byte orders
/// at 8 and 16 bits. Binary files stay out of this repository: run the script to write them
/// to `corpus/layered-tiff/` (gitignored); without them these checks are skipped.
fn fixture(name: &str) -> Option<Vec<u8>> {
    let bytes = std::fs::read(format!("{}/../../corpus/layered-tiff/{name}", env!("CARGO_MANIFEST_DIR"))).ok();
    if bytes.is_none() {
        eprintln!("skipped {name}: run `python scripts/layered_tiff_fixtures.py` to write corpus/layered-tiff/");
    }
    bytes
}

#[test]
fn psdtags_fixtures_open_with_their_layers() {
    for (name, depth) in [
        ("layered-le-8bit.tif", SampleType::U8),
        ("layered-be-8bit.tif", SampleType::U8),
        ("layered-le-16bit.tif", SampleType::U16),
        ("layered-be-16bit.tif", SampleType::U16),
    ] {
        let Some(bytes) = fixture(name) else { continue };
        let r = import(name, &bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        let d = &r.document;
        assert_eq!(d.size, photosuite_geom::Size::new(6, 4), "{name}");
        assert_eq!(d.mode, ColorMode::Rgb);
        assert_eq!(d.depth, depth, "{name}");
        let names: Vec<&str> = d.layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Background", "Upper \u{e9}"], "{name}");
        let upper = &d.layers[1];
        assert_eq!(upper.blend, photosuite_color::BlendMode::Multiply);
        assert!((upper.opacity - 200.0 / 255.0).abs() < 1e-6);
        let LayerContent::Raster(s) = &upper.content else { panic!("raster") };
        let bounds = s.content_bounds();
        assert_eq!((bounds.x0, bounds.y0, bounds.width(), bounds.height()), (1, 1, 4, 3), "{name}");
        // Pixel (x=2, y=0) of the upper layer: the generator's ramp, alpha 160/255.
        let px = s.pixel(3, 1);
        let expect = |v: u32| (v % 256) as f32 / 255.0;
        assert!((px[0] - expect(2 * 40 + 7)).abs() < 1e-3, "{name}: {px:?}");
        assert!((px[1] - expect(7 * 3)).abs() < 1e-3, "{name}: {px:?}");
        assert!((px[3] - 160.0 / 255.0).abs() < 1e-3, "{name}: {px:?}");
        let LayerContent::Raster(bg) = &d.layers[0].content else { panic!("raster") };
        let b = bg.pixel(5, 3);
        assert!((b[0] - expect(5 * 40 + 1)).abs() < 1e-3, "{name}: {b:?}");
        assert!((b[3] - 1.0).abs() < 1e-6);
        assert_eq!(d.resolution_dpi, 300.0);
        // tifffile writes a Software tag; nothing else is worth a warning.
        assert!(r.warnings.iter().all(|w| w.contains("text metadata")), "{name}: {:?}", r.warnings);
        // psdtags wrote the composite's alpha sample without the transparency flag, so by the
        // PSD rules it is an alpha channel (which a re-save cannot keep). Re-saving keeps
        // everything else; the file is then in the encoder's byte order.
        assert_eq!(d.channels.len(), 1, "{name}");
        let out = tiff(d, true);
        let back = import(name, &out.bytes).unwrap().document;
        assert_docs_eq(&expected(d), &back);
    }
}

#[test]
fn damaged_layer_data_opens_flattened() {
    let d = gen_doc(ColorMode::Rgb, SampleType::U8, Features::PIXELS);
    let r = tiff(&d, true);
    let (_, layers) = tags(&r.bytes);
    let layers = layers.unwrap();
    let at = r.bytes.windows(layers.len()).position(|w| w == &layers[..]).unwrap();
    // Garbage after the signature: no layers, a warning, the composite as one layer.
    let mut bad = r.bytes.clone();
    for b in &mut bad[at + 36..at + 36 + 24] {
        *b ^= 0xa5;
    }
    let r2 = import("x.tif", &bad).unwrap();
    assert_eq!(r2.document.layers.len(), 1);
    assert!(r2.warnings.iter().any(|w| w.contains("could not be read")), "{:?}", r2.warnings);
    // Every truncation and a sweep of bit flips through the whole file: never a panic.
    for cut in (0..r.bytes.len()).step_by(11) {
        let _ = import("x.tif", &r.bytes[..cut]);
    }
    for i in (0..r.bytes.len()).step_by(29) {
        let mut b = r.bytes.clone();
        b[i] ^= 0x5a;
        let _ = import("x.tif", &b);
    }
    for name in ["layered-le-8bit.tif", "layered-be-16bit.tif"] {
        let Some(bytes) = fixture(name) else { continue };
        for cut in (0..bytes.len()).step_by(7) {
            let _ = import(name, &bytes[..cut]);
        }
        for i in (0..bytes.len()).step_by(5) {
            let mut b = bytes.clone();
            b[i] ^= 0xff;
            let _ = import(name, &b);
        }
    }
}
