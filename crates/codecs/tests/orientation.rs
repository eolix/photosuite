//! EXIF / TIFF orientation (#285): files are opened upright, and every export
//! writes Orientation = 1 so the upright pixels are never rotated twice.

mod common;
use common::*;
use photosuite_codecs::*;
use proptest::prelude::{any, prop_assert, prop_assert_eq, proptest};

/// A minimal EXIF (TIFF-structured) block: a filler tag, then Orientation.
fn exif(o: u32, big: bool, long: bool) -> Vec<u8> {
    let u16b = |v: u16| if big { v.to_be_bytes() } else { v.to_le_bytes() };
    let u32b = |v: u32| if big { v.to_be_bytes() } else { v.to_le_bytes() };
    let mut v = if big { b"MM\0*".to_vec() } else { b"II*\0".to_vec() };
    v.extend_from_slice(&u32b(8));
    v.extend_from_slice(&u16b(2));
    // ImageDescription-ish filler (ASCII, 4 bytes inline).
    v.extend_from_slice(&u16b(0x010E));
    v.extend_from_slice(&u16b(2));
    v.extend_from_slice(&u32b(4));
    v.extend_from_slice(b"abc\0");
    v.extend_from_slice(&u16b(0x0112));
    if long {
        v.extend_from_slice(&u16b(4));
        v.extend_from_slice(&u32b(1));
        v.extend_from_slice(&u32b(o));
    } else {
        v.extend_from_slice(&u16b(3));
        v.extend_from_slice(&u32b(1));
        v.extend_from_slice(&u16b(o as u16));
        v.extend_from_slice(&[0, 0]);
    }
    v.extend_from_slice(&u32b(0));
    v
}

/// The "upright" test picture: `w`×`h` gray values, distinct per pixel.
fn upright(w: usize, h: usize, value: impl Fn(usize, usize) -> u8) -> Vec<u8> {
    (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| value(x, y)).collect()
}

/// What a camera stores for orientation `o` when the scene is `up` (`w`×`h`): the inverse
/// of the turn a viewer applies. Returns the stored pixels and their size.
fn stored(up: &[u8], w: usize, h: usize, o: u16) -> (Vec<u8>, usize, usize) {
    let (sw, sh) = if o >= 5 { (h, w) } else { (w, h) };
    let mut s = vec![0u8; up.len()];
    for y in 0..h {
        for x in 0..w {
            // Where upright pixel (x, y) sits in the stored image.
            let (sx, sy) = match o {
                1 => (x, y),
                2 => (w - 1 - x, y),         // mirrored horizontally
                3 => (w - 1 - x, h - 1 - y), // rotated 180°
                4 => (x, h - 1 - y),         // mirrored vertically
                5 => (y, x),                 // transposed
                6 => (y, w - 1 - x),         // viewer turns it 90° clockwise
                7 => (h - 1 - y, w - 1 - x), // transverse
                8 => (h - 1 - y, x),         // viewer turns it 90° counter-clockwise
                _ => unreachable!(),
            };
            s[sy * sw + sx] = up[y * w + x];
        }
    }
    (s, sw, sh)
}

/// Inserts a JPEG APP1 EXIF segment right after SOI.
fn jpeg_with_exif(jpeg: &[u8], exif: &[u8]) -> Vec<u8> {
    let mut seg = b"Exif\0\0".to_vec();
    seg.extend_from_slice(exif);
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&seg);
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// Inserts a PNG eXIf chunk before the first IDAT.
fn png_with_exif(png: &[u8], exif: &[u8]) -> Vec<u8> {
    let at = png.windows(4).position(|w| w == b"IDAT").unwrap() - 4;
    let mut chunk = (exif.len() as u32).to_be_bytes().to_vec();
    let mut body = b"eXIf".to_vec();
    body.extend_from_slice(exif);
    let mut crc = flate2::Crc::new();
    crc.update(&body);
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc.sum().to_be_bytes());
    let mut out = png[..at].to_vec();
    out.extend_from_slice(&chunk);
    out.extend_from_slice(&png[at..]);
    out
}

fn tiff_with_orientation(data: &[u8], w: u32, h: u32, o: u16) -> Vec<u8> {
    use tiff::encoder::{TiffEncoder, colortype::Gray8};
    let mut cursor = std::io::Cursor::new(Vec::new());
    let mut enc = TiffEncoder::new(&mut cursor).unwrap();
    let mut im = enc.new_image::<Gray8>(w, h).unwrap();
    im.encoder().write_tag(tiff::tags::Tag::Orientation, o).unwrap();
    im.write_data(data).unwrap();
    cursor.into_inner()
}

fn gray(w: usize, h: usize, px: Vec<u8>) -> Image {
    Image::from_u8(w as u32, h as u32, ChannelLayout::Gray, px).unwrap()
}

/// Exact pixels: distinct values per pixel.
fn exact_scene(w: usize, h: usize) -> Vec<u8> {
    upright(w, h, |x, y| (y * w + x) as u8 * 3 + 1)
}

#[test]
fn reads_orientation_in_every_encoding() {
    for o in 1..=8 {
        for big in [false, true] {
            for long in [false, true] {
                let e = exif(o, big, long);
                assert_eq!(exif_orientation(&e), o as u16, "o={o} big={big} long={long}");
                let mut prefixed = b"Exif\0\0".to_vec();
                prefixed.extend_from_slice(&e);
                assert_eq!(exif_orientation(&prefixed), o as u16);
                let fixed = upright_exif(&prefixed);
                assert_eq!(exif_orientation(&fixed), 1);
                assert_eq!(fixed.len(), prefixed.len(), "rewritten in place");
                assert_eq!(&fixed[..6], b"Exif\0\0");
            }
        }
    }
    // Already upright, no tag, or garbage: borrowed unchanged.
    assert!(matches!(upright_exif(&exif(1, false, false)), std::borrow::Cow::Borrowed(_)));
    assert!(matches!(upright_exif(&sample_exif()), std::borrow::Cow::Borrowed(_)));
    assert!(matches!(upright_exif(b"nonsense"), std::borrow::Cow::Borrowed(_)));
}

#[test]
fn malformed_or_out_of_range_orientation_reads_as_1() {
    for bad in [0, 9, 255, 0xFFFF, 0x1_0006] {
        assert_eq!(exif_orientation(&exif(bad, false, true)), 1, "{bad}");
    }
    let good = exif(6, false, false);
    for n in 0..good.len() {
        let o = exif_orientation(&good[..n]);
        assert!(o == 1 || o == 6, "truncated at {n}: {o}");
        let _ = upright_exif(&good[..n]);
    }
    // IFD offset past the end, a huge entry count, a wrong field type.
    let mut far = good.clone();
    far[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(exif_orientation(&far), 1);
    let mut many = good.clone();
    many[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
    assert_eq!(exif_orientation(&many), 6, "entries past the end are ignored, the real one still found");
    let mut typed = good.clone();
    typed[24..26].copy_from_slice(&2u16.to_le_bytes()); // ASCII
    assert_eq!(exif_orientation(&typed), 1);
    assert_eq!(exif_orientation(&[]), 1);
    assert_eq!(exif_orientation(b"II*\0"), 1);
}

proptest! {
    #[test]
    fn random_exif_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..256), le in any::<bool>()) {
        let mut b = if le { b"II*\0\x08\0\0\0".to_vec() } else { b"MM\0*\0\0\0\x08".to_vec() };
        b.extend_from_slice(&bytes);
        let o = exif_orientation(&b);
        prop_assert!((1..=8).contains(&o));
        prop_assert_eq!(exif_orientation(&upright_exif(&b)), 1);
        let _ = exif_orientation(&bytes);
        let _ = upright_exif(&bytes);
    }

    #[test]
    fn random_xmp_never_panics(s in ".{0,64}", tail in ".{0,16}") {
        let x = format!("{s}tiff:Orientation{tail}");
        let _ = upright_xmp(&x);
    }
}

#[test]
fn xmp_orientation_is_rewritten() {
    let attr = r#"<rdf:Description tiff:Orientation="6" tiff:Make="X"/>"#;
    assert_eq!(upright_xmp(attr), r#"<rdf:Description tiff:Orientation="1" tiff:Make="X"/>"#);
    let elem = "<tiff:Orientation>8</tiff:Orientation><tiff:Orientation>3</tiff:Orientation>";
    assert_eq!(upright_xmp(elem), "<tiff:Orientation>1</tiff:Orientation><tiff:Orientation>1</tiff:Orientation>");
    assert_eq!(upright_xmp("tiff:Orientation='12'"), "tiff:Orientation='1'");
    for same in [r#"tiff:Orientation="1""#, "no orientation", "tiff:Orientation", "tiff:Orientation=\"\"", "tiff:Orientation: 6"] {
        assert!(matches!(upright_xmp(same), std::borrow::Cow::Borrowed(_)), "{same}");
    }
}

#[test]
fn png_opens_upright_for_every_orientation() {
    let (w, h) = (5, 3);
    let up = exact_scene(w, h);
    for o in 1..=8u16 {
        let (s, sw, sh) = stored(&up, w, h, o);
        let png = encode(&gray(sw, sh, s.clone()), Format::Png, &EncodeOptions::default()).unwrap();
        let file = png_with_exif(&png, &exif(u32::from(o), o % 2 == 0, false));
        let img = decode(&file).unwrap();
        assert_eq!(img.dimensions(), (w as u32, h as u32), "o={o}");
        assert_eq!(img.data(), &up[..], "o={o}");
        assert_eq!(exif_orientation(img.meta.exif.as_deref().unwrap()), 1, "o={o}: metadata says upright");
        // Opting out keeps the stored pixels and the tag.
        let raw = decode_with(&file, &DecodeOptions { keep_orientation: true, ..Default::default() }).unwrap();
        assert_eq!((raw.dimensions(), raw.data()), ((sw as u32, sh as u32), &s[..]), "o={o}");
        assert_eq!(exif_orientation(raw.meta.exif.as_deref().unwrap()), o);
    }
}

#[test]
fn tiff_opens_upright_for_every_orientation() {
    let (w, h) = (4, 7);
    let up = exact_scene(w, h);
    for o in 1..=8u16 {
        let (s, sw, sh) = stored(&up, w, h, o);
        let img = decode(&tiff_with_orientation(&s, sw as u32, sh as u32, o)).unwrap();
        assert_eq!(img.dimensions(), (w as u32, h as u32), "o={o}");
        assert_eq!(img.data(), &up[..], "o={o}");
    }
}

#[test]
fn webp_opens_upright() {
    let (w, h) = (6, 2);
    let up = exact_scene(w, h);
    for o in [3, 6, 8] {
        let (s, sw, sh) = stored(&up, w, h, o);
        let mut out = Vec::new();
        let mut enc = image_webp::WebPEncoder::new(&mut out);
        enc.set_exif_metadata(exif(u32::from(o), false, false));
        enc.encode(&s, sw as u32, sh as u32, image_webp::ColorType::L8).unwrap();
        // WebP has no gray mode: it comes back as RGB.
        let img = decode(&out).unwrap().convert(ChannelLayout::Gray, SampleType::U8);
        assert_eq!((img.dimensions(), img.data()), ((w as u32, h as u32), &up[..]), "o={o}");
    }
}

/// 8×8-block scene so JPEG keeps each block's value: block (bx, by) is distinct.
fn block_scene(w: usize, h: usize) -> Vec<u8> {
    upright(w, h, |x, y| (20 + 25 * (x / 8 + (w / 8) * (y / 8))) as u8)
}

fn assert_blocks(img: &Image, up: &[u8], w: usize, h: usize, what: &str) {
    assert_eq!(img.dimensions(), (w as u32, h as u32), "{what}");
    let d = img.data();
    for by in 0..h / 8 {
        for bx in 0..w / 8 {
            let i = (by * 8 + 4) * w + bx * 8 + 4;
            assert!((i32::from(d[i]) - i32::from(up[i])).abs() <= 4, "{what}: block ({bx},{by}) is {} not {}", d[i], up[i]);
        }
    }
}

#[test]
fn jpeg_opens_upright_for_every_orientation() {
    let (w, h) = (32, 16);
    let up = block_scene(w, h);
    for o in 1..=8u16 {
        let (s, sw, sh) = stored(&up, w, h, o);
        let jpeg = encode(&gray(sw, sh, s), Format::Jpeg, &EncodeOptions { jpeg_quality: 100, ..Default::default() }).unwrap();
        let file = jpeg_with_exif(&jpeg, &exif(u32::from(o), o > 4, o == 7));
        let img = decode(&file).unwrap();
        assert_blocks(&img, &up, w, h, &format!("o={o}"));
        assert_eq!(exif_orientation(img.meta.exif.as_deref().unwrap()), 1);
    }
}

#[test]
fn rgb_jpeg_with_dpi_swaps_resolution_on_a_quarter_turn() {
    let img = Image::from_u8(16, 8, ChannelLayout::Rgb, vec![128; 16 * 8 * 3]).unwrap().with_meta(Metadata { dpi: Some((300.0, 150.0)), ..Default::default() });
    let jpeg = encode(&img, Format::Jpeg, &EncodeOptions::default()).unwrap();
    let back = decode(&jpeg_with_exif(&jpeg, &exif(6, false, false))).unwrap();
    assert_eq!(back.dimensions(), (8, 16));
    assert_eq!(back.meta.dpi, Some((150.0, 300.0)));
}

#[test]
fn export_writes_orientation_1_and_keeps_pixels() {
    let (w, h) = (32, 16);
    let up = block_scene(w, h);
    let (s, sw, sh) = stored(&up, w, h, 6);
    let jpeg = encode(&gray(sw, sh, s), Format::Jpeg, &EncodeOptions { jpeg_quality: 100, ..Default::default() }).unwrap();
    let opened = decode(&jpeg_with_exif(&jpeg, &exif(6, false, false))).unwrap();
    assert_blocks(&opened, &up, w, h, "opened");

    // Even an image whose metadata still claims 6 (e.g. from a PSD) is written as 1.
    let mut stale = opened.clone();
    stale.meta.exif = Some(exif(6, true, false));
    stale.meta.xmp = Some(r#"<x tiff:Orientation="6"/>"#.into());
    for format in [Format::Png, Format::Jpeg, Format::WebP, Format::Tiff] {
        let bytes = encode(&stale, format, &EncodeOptions { jpeg_quality: 100, ..Default::default() }).unwrap();
        let raw = decode_with(&bytes, &DecodeOptions { keep_orientation: true, ..Default::default() }).unwrap();
        if let Some(e) = &raw.meta.exif {
            assert_eq!(exif_orientation(e), 1, "{format:?}");
        }
        if let Some(x) = &raw.meta.xmp {
            assert!(x.contains(r#"tiff:Orientation="1""#), "{format:?}: {x}");
        }
        assert_eq!(exif_orientation(&bytes), 1, "{format:?} file");
        // Pixels as shown, both with and without applying orientation on reopen.
        let back = decode(&bytes).unwrap();
        assert_eq!(back.dimensions(), raw.dimensions(), "{format:?}");
        if format == Format::Jpeg {
            assert_blocks(&back, &up, w, h, "jpeg reopen");
        } else {
            assert_eq!(back.convert(ChannelLayout::Gray, SampleType::U8).data(), opened.data(), "{format:?} lossless");
        }
    }
}

#[test]
fn round_trip_open_save_reopen_is_stable() {
    let (w, h) = (24, 16);
    let up = block_scene(w, h);
    for o in 1..=8u16 {
        let (s, sw, sh) = stored(&up, w, h, o);
        let jpeg = encode(&gray(sw, sh, s), Format::Jpeg, &EncodeOptions { jpeg_quality: 100, ..Default::default() }).unwrap();
        let first = decode(&jpeg_with_exif(&jpeg, &exif(u32::from(o), false, false))).unwrap();
        let saved = encode(&first, Format::Jpeg, &EncodeOptions { jpeg_quality: 100, ..Default::default() }).unwrap();
        let second = decode(&saved).unwrap();
        assert_blocks(&second, &up, w, h, &format!("reopened o={o}"));
        assert_eq!(exif_orientation(second.meta.exif.as_deref().unwrap()), 1);
    }
}

#[test]
fn malformed_exif_in_a_jpeg_opens_as_stored() {
    let img = gray(16, 8, vec![90; 128]);
    let jpeg = encode(&img, Format::Jpeg, &EncodeOptions::default()).unwrap();
    let mut rng = Rng::new(285);
    let mut cases = vec![Vec::new(), b"II*\0".to_vec(), b"MM\0*\xff\xff\xff\xff".to_vec(), exif(6, false, false)[..20].to_vec()];
    cases.extend((0..64).map(|i| {
        let mut b = if i % 2 == 0 { b"II*\0\x08\0\0\0".to_vec() } else { b"MM\0*\0\0\0\x08".to_vec() };
        b.extend(rng.bytes(i * 7));
        b
    }));
    for e in cases {
        let back = decode(&jpeg_with_exif(&jpeg, &e)).unwrap();
        let o = exif_orientation(&e);
        let want = if o >= 5 { (8, 16) } else { (16, 8) };
        assert_eq!(back.dimensions(), want, "{e:?}");
    }
}

#[test]
fn every_layout_and_depth_orients_and_inverts() {
    let inverse = |o: u16| match o {
        6 => 8,
        8 => 6,
        o => o,
    };
    for layout in ChannelLayout::ALL {
        for sample in SampleType::ALL {
            let img = test_image(layout, sample);
            for o in 0..=9u16 {
                let turned = img.clone().oriented(o).unwrap();
                if (2..=8).contains(&o) && o >= 5 {
                    assert_eq!(turned.dimensions(), (img.height(), img.width()));
                } else {
                    assert_eq!(turned.dimensions(), img.dimensions());
                }
                let back = turned.oriented(inverse(o)).unwrap();
                assert_eq!(back.data(), img.data(), "{layout:?} {sample:?} o={o}");
            }
        }
    }
}

/// #285 performance budget: turning a 24 MP photo upright on open adds ≤ 50 ms
/// (release build: `cargo test --release -p photosuite-codecs --test orientation -- --ignored`).
#[test]
#[ignore = "timing; run in release"]
fn rotating_24_mp_is_fast() {
    let (w, h) = (6000u32, 4000u32);
    let img = Image::from_u8(w, h, ChannelLayout::Rgb, (0..w as usize * h as usize * 3).map(|i| i as u8).collect()).unwrap();
    for o in [6u16, 3, 8] {
        let mut best = f64::MAX;
        for _ in 0..5 {
            let c = img.clone();
            let t = std::time::Instant::now();
            let r = c.oriented(o).unwrap();
            best = best.min(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(r);
        }
        eprintln!("orientation {o}: 24 MP RGB8 in {best:.1} ms");
        assert!(best <= 50.0, "orientation {o} took {best:.1} ms");
    }
}
