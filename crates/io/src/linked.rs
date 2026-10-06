//! Embedded smart-object files from the PSD global `lnk2`/`lnk3`/`lnkD` blocks.
//!
//! PSD import keeps a placed layer's source as `SmartSource::Linked { path: <Idnt uuid> }` and the
//! file bytes stay inside the preserved global block (so PSD export stays byte-stable). This module
//! finds the bytes for a uuid when the engine needs to re-render the smart object from its source.
//!
//! Layout (Adobe PSD spec, "Linked Layer"): a sequence of items, each `u64 length` + item data,
//! padded to 4 bytes. Item: type (`liFD` data / `liFE` external / `liFA` alias), version (1–7),
//! Pascal uuid, Unicode file name, file type, creator, `u64` data length, open-descriptor flag (+
//! versioned descriptor), then for `liFD` the raw file bytes.

use photosuite_doc::Metadata;
use photosuite_psd::descriptor::VersionedDescriptor;

/// An embedded file found in a linked-layer block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedFile {
    pub uuid: String,
    pub file_name: String,
    pub bytes: Vec<u8>,
}

struct Rd<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.d.get(self.p..self.p.checked_add(n)?)?;
        self.p += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        self.take(8).map(|b| u64::from_be_bytes(b.try_into().unwrap_or([0; 8])))
    }
    fn unicode(&mut self) -> Option<String> {
        let n = self.u32()? as usize;
        let raw = self.take(n.checked_mul(2)?)?;
        let units: Vec<u16> = raw.as_chunks::<2>().0.iter().map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        Some(String::from_utf16_lossy(&units).trim_end_matches('\0').to_string())
    }
}

/// Parses one item; `None` for malformed data or non-`liFD` items.
fn parse_item(item: &[u8]) -> Option<LinkedFile> {
    let mut r = Rd { d: item, p: 0 };
    let kind = r.take(4)?;
    let _version = r.u32()?;
    let n = r.u8()? as usize;
    let uuid = String::from_utf8_lossy(r.take(n)?).to_string();
    let file_name = r.unicode()?;
    r.take(8)?; // file type + creator
    let len = usize::try_from(r.u64()?).ok()?;
    if r.u8()? != 0 {
        let (_, used) = VersionedDescriptor::parse_prefix(item.get(r.p..)?).ok()?;
        r.p += used;
    }
    if kind != b"liFD" {
        return None;
    }
    let bytes = r.take(len)?.to_vec();
    Some(LinkedFile { uuid, file_name, bytes })
}

/// Every embedded (`liFD`) file in one linked-layer block's data.
pub fn parse_linked_files(data: &[u8]) -> Vec<LinkedFile> {
    let mut out = Vec::new();
    let mut r = Rd { d: data, p: 0 };
    while let Some(len) = r.u64() {
        let Ok(len) = usize::try_from(len) else { break };
        let Some(item) = r.take(len) else { break };
        out.extend(parse_item(item));
        r.p = r.p.next_multiple_of(4);
    }
    out
}

/// The embedded file for smart-object `uuid` among the document's preserved PSD global blocks.
pub fn find_linked_file(meta: &Metadata, uuid: &str) -> Option<LinkedFile> {
    if uuid.is_empty() {
        return None;
    }
    meta.psd_global_blocks
        .iter()
        .filter(|(_, k, _)| matches!(k, b"lnk2" | b"lnk3" | b"lnkD"))
        .flat_map(|(_, _, d)| parse_linked_files(d))
        .find(|f| f.uuid == uuid)
}

/// Encodes one `liFD` item (version 2, no open descriptor). Used by tests and writers that
/// need a minimal linked-layer block.
pub fn encode_linked_file(f: &LinkedFile) -> Vec<u8> {
    let mut item = Vec::new();
    item.extend_from_slice(b"liFD");
    item.extend_from_slice(&2u32.to_be_bytes());
    item.push(f.uuid.len().min(255) as u8);
    item.extend_from_slice(&f.uuid.as_bytes()[..f.uuid.len().min(255)]);
    let units: Vec<u16> = f.file_name.encode_utf16().collect();
    item.extend_from_slice(&(units.len() as u32).to_be_bytes());
    for u in units {
        item.extend_from_slice(&u.to_be_bytes());
    }
    item.extend_from_slice(b"    8BIM");
    item.extend_from_slice(&(f.bytes.len() as u64).to_be_bytes());
    item.push(0);
    item.extend_from_slice(&f.bytes);
    let mut out = (item.len() as u64).to_be_bytes().to_vec();
    out.extend_from_slice(&item);
    while !out.len().is_multiple_of(4) {
        out.push(0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn round_trips_and_finds_by_uuid() {
        let a = LinkedFile { uuid: "abc-1".into(), file_name: "a.png".into(), bytes: vec![1, 2, 3] };
        let b = LinkedFile { uuid: "def-2".into(), file_name: "b.psd".into(), bytes: vec![9; 10] };
        let mut data = encode_linked_file(&a);
        data.extend(encode_linked_file(&b));
        assert_eq!(parse_linked_files(&data), vec![a.clone(), b.clone()]);
        let mut meta = Metadata::default();
        meta.psd_global_blocks.push((*b"8BIM", *b"lnk2", Arc::new(data)));
        assert_eq!(find_linked_file(&meta, "def-2"), Some(b));
        assert_eq!(find_linked_file(&meta, "zzz"), None);
        assert_eq!(find_linked_file(&meta, ""), None);
    }

    #[test]
    fn malformed_data_is_ignored() {
        assert!(parse_linked_files(&[0, 0, 0, 0, 0, 0, 0, 200, 1, 2]).is_empty());
        assert!(parse_linked_files(&[]).is_empty());
        let mut d = encode_linked_file(&LinkedFile { uuid: "x".into(), file_name: "f".into(), bytes: vec![5; 4] });
        d.truncate(d.len() - 6);
        assert!(parse_linked_files(&d).is_empty());
    }
}
