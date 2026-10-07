//! Minimal EXIF reader for the camera settings the photography commands use (exposure, aperture,
//! ISO, focal length, camera and lens names). Input is the raw TIFF-structured EXIF payload
//! (`II*\0` / `MM\0*`, as stored in `Document.metadata.exif`); malformed data yields `None`
//! fields, never a panic. Tag numbers are from the EXIF 2.32 specification (CIPA DC-008).

/// Camera settings read from EXIF.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CameraInfo {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    /// Seconds.
    pub exposure_time: Option<f64>,
    pub f_number: Option<f64>,
    pub iso: Option<f64>,
    /// Millimetres.
    pub focal_length: Option<f64>,
    /// 35 mm-equivalent focal length in millimetres.
    pub focal_length_35mm: Option<f64>,
}

impl CameraInfo {
    /// Linear exposure factor `t · ISO / N²` (relative brightness of the image for one scene).
    pub fn exposure_factor(&self) -> Option<f64> {
        let t = self.exposure_time?;
        let n = self.f_number.unwrap_or(1.0).max(0.1);
        Some(t * self.iso.unwrap_or(100.0) / 100.0 / (n * n))
    }
}

struct Tiff<'a> {
    b: &'a [u8],
    le: bool,
}

impl Tiff<'_> {
    fn u16(&self, o: usize) -> Option<u16> {
        let s = self.b.get(o..o + 2)?;
        Some(if self.le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) })
    }
    fn u32(&self, o: usize) -> Option<u32> {
        let s = self.b.get(o..o + 4)?;
        let a = [s[0], s[1], s[2], s[3]];
        Some(if self.le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    }
    /// Entries of the IFD at `off`: (tag, type, count, value offset field position).
    fn ifd(&self, off: usize) -> Vec<(u16, u16, u32, usize)> {
        let Some(n) = self.u16(off) else { return Vec::new() };
        (0..n as usize)
            .filter_map(|k| {
                let e = off + 2 + k * 12;
                Some((self.u16(e)?, self.u16(e + 2)?, self.u32(e + 4)?, e + 8))
            })
            .collect()
    }
    fn data_at(&self, typ: u16, count: u32, field: usize) -> Option<usize> {
        let size = match typ {
            1 | 2 | 6 | 7 => 1,
            3 | 8 => 2,
            4 | 9 | 11 => 4,
            5 | 10 | 12 => 8,
            _ => return None,
        } * count as usize;
        if size <= 4 { Some(field) } else { self.u32(field).map(|v| v as usize) }
    }
    fn number(&self, typ: u16, count: u32, field: usize) -> Option<f64> {
        let at = self.data_at(typ, count, field)?;
        match typ {
            3 => self.u16(at).map(f64::from),
            4 => self.u32(at).map(f64::from),
            5 => {
                let (n, d) = (self.u32(at)?, self.u32(at + 4)?);
                (d != 0).then(|| n as f64 / d as f64)
            }
            10 => {
                let (n, d) = (self.u32(at)? as i32, self.u32(at + 4)? as i32);
                (d != 0).then(|| n as f64 / d as f64)
            }
            _ => None,
        }
    }
    fn text(&self, typ: u16, count: u32, field: usize) -> Option<String> {
        if typ != 2 {
            return None;
        }
        let at = self.data_at(typ, count, field)?;
        let s = self.b.get(at..at + count as usize)?;
        let s = String::from_utf8_lossy(s).trim_end_matches('\0').trim().to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// Reads [`CameraInfo`] from a TIFF-structured EXIF payload (an `Exif\0\0` prefix is skipped).
pub fn read(exif: &[u8]) -> CameraInfo {
    let b = exif.strip_prefix(b"Exif\0\0").unwrap_or(exif);
    let mut info = CameraInfo::default();
    // TIFF's 42, and the variants raw files use for the same layout: Panasonic RW2 (0x55) and
    // Olympus ORF ("RO", "RS").
    let le = match b.get(..4) {
        Some([b'I', b'I', 42 | 0x55, 0] | [b'I', b'I', b'R', b'O' | b'S']) => true,
        Some([b'M', b'M', 0, 42] | [b'M', b'M', b'O', b'R']) => false,
        _ => return info,
    };
    let t = Tiff { b, le };
    let Some(ifd0) = t.u32(4) else { return info };
    let mut queue = vec![ifd0 as usize];
    let mut seen = Vec::new();
    while let Some(off) = queue.pop() {
        if seen.contains(&off) || seen.len() > 8 {
            continue;
        }
        seen.push(off);
        for (tag, typ, count, field) in t.ifd(off) {
            match tag {
                0x010F => info.make = t.text(typ, count, field),
                0x0110 => info.model = t.text(typ, count, field),
                0x829A => info.exposure_time = t.number(typ, count, field),
                0x829D => info.f_number = t.number(typ, count, field),
                0x8827 => info.iso = t.number(typ, count, field),
                0x920A => info.focal_length = t.number(typ, count, field),
                0xA405 => info.focal_length_35mm = t.number(typ, count, field).filter(|v| *v > 0.0),
                0xA434 => info.lens = t.text(typ, count, field),
                0x8769 => {
                    if let Some(p) = t.u32(field) {
                        queue.push(p as usize);
                    }
                }
                _ => {}
            }
        }
    }
    info
}

/// Builds a little-endian EXIF payload: what `read` returns, written back (a raw file's camera
/// and exposure kept on its document; tests and synthetic fixtures).
pub fn build(info: &CameraInfo) -> Vec<u8> {
    // IFD0: Make, Model, ExifIFD pointer; Exif IFD: the rest. Data area after the IFDs.
    let mut ifd0: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
    let mut exif: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
    let text = |s: &str| {
        let mut v = s.as_bytes().to_vec();
        v.push(0);
        v
    };
    // Fractions as cameras write them: 1/n below one (a 1/8000 s shutter), else n/10000.
    let rational = |v: f64| {
        let (n, d) = if v > 0.0 && v < 1.0 && (1.0 / v - (1.0 / v).round()).abs() < 1e-3 {
            (1u32, (1.0 / v).round() as u32)
        } else {
            ((v * 10000.0).round() as u32, 10000u32)
        };
        let mut b = n.to_le_bytes().to_vec();
        b.extend_from_slice(&d.to_le_bytes());
        b
    };
    if let Some(s) = &info.make {
        ifd0.push((0x010F, 2, s.len() as u32 + 1, text(s)));
    }
    if let Some(s) = &info.model {
        ifd0.push((0x0110, 2, s.len() as u32 + 1, text(s)));
    }
    if let Some(v) = info.exposure_time {
        exif.push((0x829A, 5, 1, rational(v)));
    }
    if let Some(v) = info.f_number {
        exif.push((0x829D, 5, 1, rational(v)));
    }
    if let Some(v) = info.iso {
        exif.push((0x8827, 3, 1, (v as u16).to_le_bytes().to_vec()));
    }
    if let Some(v) = info.focal_length {
        exif.push((0x920A, 5, 1, rational(v)));
    }
    if let Some(v) = info.focal_length_35mm {
        exif.push((0xA405, 3, 1, (v as u16).to_le_bytes().to_vec()));
    }
    if let Some(s) = &info.lens {
        exif.push((0xA434, 2, s.len() as u32 + 1, text(s)));
    }
    let ifd_len = |n: usize| 2 + 12 * n + 4;
    let ifd0_off = 8usize;
    let n0 = ifd0.len() + 1;
    let exif_off = ifd0_off + ifd_len(n0);
    let mut data_off = exif_off + ifd_len(exif.len());
    let mut out = b"II*\0".to_vec();
    out.extend_from_slice(&(ifd0_off as u32).to_le_bytes());
    let mut data = Vec::new();
    let mut write_ifd = |out: &mut Vec<u8>, entries: &[(u16, u16, u32, Vec<u8>)], extra: Option<u32>| {
        let n = entries.len() + usize::from(extra.is_some());
        out.extend_from_slice(&(n as u16).to_le_bytes());
        for (tag, typ, count, bytes) in entries {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&typ.to_le_bytes());
            out.extend_from_slice(&count.to_le_bytes());
            if bytes.len() <= 4 {
                let mut f = bytes.clone();
                f.resize(4, 0);
                out.extend_from_slice(&f);
            } else {
                out.extend_from_slice(&(data_off as u32).to_le_bytes());
                data.extend_from_slice(bytes);
                data_off += bytes.len();
            }
        }
        if let Some(p) = extra {
            out.extend_from_slice(&0x8769u16.to_le_bytes());
            out.extend_from_slice(&4u16.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
            out.extend_from_slice(&p.to_le_bytes());
        }
        out.extend_from_slice(&0u32.to_le_bytes());
    };
    write_ifd(&mut out, &ifd0, Some(exif_off as u32));
    write_ifd(&mut out, &exif, None);
    out.extend_from_slice(&data);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_info_reads_back_with_camera_fractions() {
        let info = CameraInfo {
            make: Some("Canon".into()),
            model: Some("Canon EOS R5".into()),
            lens: Some("RF24-70mm F2.8 L IS USM".into()),
            exposure_time: Some(1.0 / 8000.0),
            f_number: Some(2.8),
            iso: Some(400.0),
            focal_length: Some(35.0),
            focal_length_35mm: Some(35.0),
        };
        let back = read(&build(&info));
        assert_eq!(back.exposure_time, Some(1.0 / 8000.0), "1/8000 s stays exact");
        assert_eq!((back.make, back.model, back.lens), (info.make, info.model, info.lens));
        assert_eq!((back.f_number, back.focal_length), (Some(2.8), Some(35.0)));
    }

    /// Raw files with TIFF's layout under another header: Panasonic RW2 and Olympus ORF.
    #[test]
    fn raw_tiff_header_variants_are_read() {
        let b = build(&CameraInfo { make: Some("Panasonic".into()), model: Some("DC-G9".into()), ..Default::default() });
        for magic in [[b'I', b'I', 0x55, 0], [b'I', b'I', b'R', b'O'], [b'I', b'I', b'R', b'S']] {
            let mut v = b.clone();
            v[..4].copy_from_slice(&magic);
            assert_eq!(read(&v).model.as_deref(), Some("DC-G9"), "{magic:?}");
        }
        let mut junk = b.clone();
        junk[..4].copy_from_slice(b"IIxx");
        assert_eq!(read(&junk), CameraInfo::default());
    }

    #[test]
    fn round_trips_and_survives_garbage() {
        let info = CameraInfo {
            make: Some("Generic".into()),
            model: Some("Camera 1".into()),
            lens: Some("24-70mm".into()),
            exposure_time: Some(0.004),
            f_number: Some(8.0),
            iso: Some(200.0),
            focal_length: Some(35.0),
            focal_length_35mm: Some(52.0),
        };
        let b = build(&info);
        let r = read(&b);
        assert_eq!(r, info);
        assert!((r.exposure_factor().unwrap() - 0.004 * 2.0 / 64.0).abs() < 1e-9);
        let mut prefixed = b"Exif\0\0".to_vec();
        prefixed.extend_from_slice(&b);
        assert_eq!(read(&prefixed), info);
        assert_eq!(read(b"nonsense"), CameraInfo::default());
        for cut in [5, 12, 30, b.len() - 3] {
            let _ = read(&b[..cut]);
        }
    }
}
