// RGBA → WebP encode for the document I/O codec. Used when the webview canvas
// cannot produce `image/webp` (WebKitGTK on Linux, some WebView2 builds).
// Canvas encode is tried first in JS; this module is the cross-platform fallback.
//
// Rebuild with build.sh (needs `rustup target add wasm32-unknown-unknown`).
use webp_rust::{encode_lossy, ImageBuffer};

static mut HEAP: usize = 0x10_0000;
static mut OUTPUT: Option<Vec<u8>> = None;

#[no_mangle]
pub extern "C" fn wasm_reset() {
    unsafe {
        HEAP = 0x10_0000;
    }
}

#[no_mangle]
pub extern "C" fn wasm_alloc(byte_count: u32) -> u32 {
    unsafe {
        let ptr = HEAP;
        HEAP += ((byte_count as usize) + 15) & !15;
        ptr as u32
    }
}

/// Encode RGBA8 at `src_ptr` (`width` × `height`).
/// `quality` is 0–100.
/// Returns 1 on success, 0 on failure.
///
/// PORT: the shipped `webp-encode.wasm` rejects any image containing a pixel with
/// alpha < 255 — `encode_lossy` returns Err and this returns 0. A single
/// non-opaque pixel is enough. Opaque images of every size encode correctly. The
/// JS side refuses transparent input before calling in, so the user gets a real
/// message instead of a bare failure code; remove that guard once a rebuilt
/// module encodes alpha. Verify a rebuild against a 64x64 image with one
/// alpha=254 pixel before trusting it.
#[no_mangle]
pub extern "C" fn encode_rgba(src_ptr: u32, width: u32, height: u32, quality: f32) -> i32 {
    if width == 0 || height == 0 {
        return 0;
    }
    let byte_count = (width as u64)
        .saturating_mul(height as u64)
        .saturating_mul(4);
    if byte_count > u32::MAX as u64 {
        return 0;
    }
    let src = unsafe {
        core::slice::from_raw_parts(src_ptr as *const u8, byte_count as usize)
    };
    let image = ImageBuffer {
        width: width as usize,
        height: height as usize,
        rgba: src.to_vec(),
    };
    let quality = quality.clamp(0.0, 100.0).round() as usize;
    let encoded = match encode_lossy(&image, 4, quality, None) {
        Ok(bytes) => bytes,
        Err(_) => return 0,
    };
    unsafe {
        OUTPUT = Some(encoded);
    }
    1
}

#[no_mangle]
pub extern "C" fn get_result_pointer() -> u32 {
    unsafe {
        OUTPUT
            .as_ref()
            .map(|bytes| bytes.as_ptr() as u32)
            .unwrap_or(0)
    }
}

#[no_mangle]
pub extern "C" fn get_result_size() -> u32 {
    unsafe {
        OUTPUT
            .as_ref()
            .map(|bytes| bytes.len() as u32)
            .unwrap_or(0)
    }
}

#[no_mangle]
pub extern "C" fn free_result() {
    unsafe {
        OUTPUT = None;
    }
}
