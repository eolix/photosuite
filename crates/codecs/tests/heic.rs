//! HEIC / HEIF decoding (heic-rs) on synthetic fixtures encoded by macOS `sips`; see
//! `tests/fixtures/heic/README.md`. HEVC is lossy and 4:2:0, so colours are checked with a
//! tolerance and away from the band edges.

use photosuite_codecs::*;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/heic/{name}.heic", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// Pixel `(x, y)` on the 0..=255 scale, whatever the sample type.
fn px(img: &Image, x: u32, y: u32) -> Vec<i32> {
    (0..img.layout().channels()).map(|c| (img.get(x, y, c) * 255.0).round() as i32).collect()
}

fn near(got: &[i32], want: &[i32]) {
    assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() <= 8), "got {got:?}, want {want:?}");
}

fn check_picture(img: &Image) {
    assert_eq!(img.dimensions(), (64, 48));
    near(&px(img, 0, 10)[..3], &[0, 0, 0]);
    near(&px(img, 15, 10)[..3], &[123, 123, 123]);
    near(&px(img, 48, 5)[..3], &[220, 30, 30]);
    near(&px(img, 48, 20)[..3], &[30, 200, 40]);
    near(&px(img, 48, 35)[..3], &[30, 60, 220]);
    near(&px(img, 40, 45)[..3], &[255, 255, 255]);
}

#[test]
fn decodes_an_8_bit_photo() {
    let b = fixture("rgb");
    assert_eq!(detect(&b), Some(Format::Heic));
    let img = decode(&b).unwrap();
    assert_eq!((img.layout(), img.sample_type()), (ChannelLayout::Rgb, SampleType::U8));
    check_picture(&img);
}

#[test]
fn keeps_alpha() {
    let img = decode(&fixture("rgba")).unwrap();
    assert_eq!((img.layout(), img.sample_type()), (ChannelLayout::Rgba, SampleType::U8));
    check_picture(&img);
    assert_eq!(px(&img, 3, 10)[3], 0, "transparent columns");
    assert_eq!(px(&img, 48, 20)[3], 255);
}

#[test]
fn deep_streams_decode_to_16_bit() {
    let img = decode(&fixture("rgb16")).unwrap();
    assert_eq!((img.layout(), img.sample_type()), (ChannelLayout::Rgb, SampleType::U16));
    check_picture(&img);
}

#[test]
fn keeps_the_icc_profile() {
    // `sips` converts the pixels when it embeds the profile, so only the profile is checked.
    let img = decode(&fixture("icc")).unwrap();
    assert_eq!(img.dimensions(), (64, 48));
    let icc = img.icc.as_deref().expect("the embedded profile");
    assert!(icc.len() > 128 && &icc[36..40] == b"acsp", "an ICC profile");
    assert!(decode(&fixture("rgb")).unwrap().icc.is_none());
}

#[test]
fn heic_is_read_only_with_its_extensions() {
    let c = caps(Format::Heic);
    assert!(c.read && !c.write);
    for e in ["heic", "HEIF", "hif"] {
        assert_eq!(from_extension(e), Some(Format::Heic), "{e}");
    }
    let img = decode(&fixture("rgb")).unwrap();
    assert!(matches!(encode(&img, Format::Heic, &EncodeOptions::default()), Err(CodecError::Unsupported { .. })));
}

#[test]
fn brands_are_told_apart() {
    assert_eq!(detect(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"), Some(Format::Heic));
    assert_eq!(detect(b"\0\0\0\x18ftypheix\0\0\0\0mif1heix"), Some(Format::Heic));
    assert_eq!(detect(b"\0\0\0\x14ftypmif1\0\0\0\0mif1"), Some(Format::Heic), "generic HEIF");
    assert_eq!(detect(b"\0\0\0\x18ftypmif1\0\0\0\0mif1avif"), Some(Format::Avif), "AVIF wins");
    assert_eq!(detect(b"\0\0\0\x18ftypcrx \0\0\0\0crx isom"), None, "a Canon CR3 is not HEIC");
    assert_eq!(detect(b"\0\0\0\x14ftypisom\0\0\0\0mp41"), None, "nor an MP4");
}

#[test]
fn limits_are_enforced_before_decoding() {
    let tight = DecodeOptions { limits: Limits { max_pixels: 1000, ..Limits::default() } };
    assert!(matches!(decode_with(&fixture("rgb"), &tight), Err(CodecError::LimitExceeded(_))));
}

#[test]
fn damaged_files_are_errors_not_panics() {
    for name in ["rgb", "rgba", "rgb16", "icc"] {
        let b = fixture(name);
        for n in (0..b.len()).step_by(7) {
            assert!(decode_as(Format::Heic, &b[..n]).is_err(), "{name} cut at {n}");
        }
        // Every byte flipped in turn: may decode (to something) or fail, but never panic.
        for i in 0..b.len() {
            let mut c = b.clone();
            c[i] ^= 0xA5;
            let _ = decode_as(Format::Heic, &c);
        }
    }
}
