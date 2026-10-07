use photosuite_codecs::{Image, decode, exif_orientation, upright_exif};

fn classic_white_is_zero() -> Vec<u8> {
    let width = 4u16;
    let height = 1u16;
    let pixels = [0u8, 64, 192, 255];
    let entries: [(u16, u16, u32); 9] = [
        (256, 3, u32::from(width)),
        (257, 3, u32::from(height)),
        (258, 3, 8),
        (259, 3, 1),
        (262, 3, 0),   // WhiteIsZero
        (273, 4, 122), // StripOffsets: immediately after IFD0.
        (277, 3, 1),
        (278, 3, u32::from(height)),
        (279, 4, pixels.len() as u32),
    ];
    let mut bytes = b"II*\0\x08\0\0\0".to_vec();
    bytes.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for (tag, field_type, value) in entries {
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&field_type.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        if field_type == 3 {
            bytes.extend_from_slice(&(value as u16).to_le_bytes());
            bytes.extend_from_slice(&[0; 2]);
        } else {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&pixels);
    bytes
}

fn big_tiff_gray(stored: &[u8], width: u16, height: u16, orientation: u16) -> Vec<u8> {
    let mut entries = vec![
        (256u16, 3u16, 1u64, u64::from(width)),
        (257, 3, 1, u64::from(height)),
        (258, 3, 1, 8),
        (259, 3, 1, 1),
        (262, 3, 1, 1), // BlackIsZero
        (273, 4, 1, 0), // StripOffsets, patched below.
        (274, 3, 1, u64::from(orientation)),
        (277, 3, 1, 1),
        (278, 3, 1, u64::from(height)),
        (279, 4, 1, stored.len() as u64),
    ];
    entries.sort_by_key(|entry| entry.0);
    let pixel_offset = 16u64 + 8 + entries.len() as u64 * 20 + 8;
    if let Some(strip_offset) = entries.iter_mut().find(|entry| entry.0 == 273) {
        strip_offset.3 = pixel_offset;
    }

    let mut bytes = b"II+\0\x08\0\0\0\x10\0\0\0\0\0\0\0".to_vec();
    bytes.extend_from_slice(&(entries.len() as u64).to_le_bytes());
    for (tag, field_type, count, value) in entries {
        bytes.extend_from_slice(&tag.to_le_bytes());
        bytes.extend_from_slice(&field_type.to_le_bytes());
        bytes.extend_from_slice(&count.to_le_bytes());
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes.extend_from_slice(stored);
    bytes
}

fn stored_for_orientation_6_or_8(orientation: u16) -> Vec<u8> {
    match orientation {
        6 => vec![3, 6, 2, 5, 1, 4],
        8 => vec![4, 1, 5, 2, 6, 3],
        _ => unreachable!(),
    }
}

#[test]
fn white_is_zero_is_normalized_once_by_the_tiff_decoder() {
    let image = decode(&classic_white_is_zero()).expect("synthetic WhiteIsZero TIFF should decode");

    assert_eq!(image.dimensions(), (4, 1));
    assert_eq!(image.data(), &[255, 191, 63, 0]);
}

#[test]
fn big_tiff_orientation_6_and_8_are_applied_to_decoded_pixels() {
    let upright = [1u8, 2, 3, 4, 5, 6];

    for orientation in [6, 8] {
        let bytes = big_tiff_gray(&stored_for_orientation_6_or_8(orientation), 2, 3, orientation);
        let image: Image = decode(&bytes).expect("synthetic BigTIFF should decode");

        assert_eq!(exif_orientation(&bytes), orientation);
        assert_eq!(exif_orientation(&upright_exif(&bytes)), 1);
        assert_eq!(image.dimensions(), (3, 2), "orientation {orientation}");
        assert_eq!(image.data(), &upright, "orientation {orientation}");
    }
}
