// Separable box blur, compiled to wasm32. Used heavily by the artistic filter
// gallery (most filters call it, often several times). Two wins over the original
// JS: (1) it is *separable* — a vertical running-sum pass then a horizontal one,
// so cost is O(width*height) regardless of window size, where the original was
// O(width*height*windowHeight); (2) WASM avoids the JavaScriptCore slowdown on
// these tight integer loops. Output is byte-identical to a clamped-edge 2D box
// blur (the per-axis telescoping sums are exact, even at the borders); a dev
// harness asserted equality against the JS version before this shipped.
//
// Rebuild with build.sh (needs `rustup target add wasm32-unknown-unknown`).
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// Bump allocator. JS calls wasm_reset() then wasm_alloc() to lay out the source
// plane, destination plane, and the i32 vertical-sum scratch buffer.
static mut HEAP: usize = 0x10_0000;

#[no_mangle]
pub extern "C" fn wasm_reset() {
    unsafe { HEAP = 0x10_0000; }
}

#[no_mangle]
pub extern "C" fn wasm_alloc(byte_count: u32) -> u32 {
    unsafe {
        let ptr = HEAP;
        HEAP += ((byte_count as usize) + 15) & !15; // 16-byte aligned
        ptr as u32
    }
}

/// Clamp a coordinate into `[0, limit)`.
#[inline(always)]
fn clamp_index(value: i32, limit: i32) -> i32 {
    if value < 0 { 0 } else if value >= limit { limit - 1 } else { value }
}

/// Separable box blur of a single-channel u8 plane.
/// Window is `window_width` x `window_height`, edges clamp to the nearest pixel.
/// `tmp_ptr` is an `i32` scratch buffer of `width*height` entries holding the
/// vertical-pass column sums; the horizontal pass reads it and writes the mean.
#[no_mangle]
pub extern "C" fn box_blur(
    src_ptr: u32,
    dst_ptr: u32,
    tmp_ptr: u32,
    width: u32,
    height: u32,
    window_width: u32,
    window_height: u32,
) {
    let width = width as i32;
    let height = height as i32;
    let win_w = window_width as i32;
    let win_h = window_height as i32;
    let half_w = win_w >> 1;
    let half_h = win_h >> 1;
    let area = win_w * win_h;

    let count = (width * height) as usize;
    let src = unsafe { core::slice::from_raw_parts(src_ptr as *const u8, count) };
    let dst = unsafe { core::slice::from_raw_parts_mut(dst_ptr as *mut u8, count) };
    // Vertical-window sum per pixel; i32 since a window can total far past 255.
    let col_sum = unsafe { core::slice::from_raw_parts_mut(tmp_ptr as *mut i32, count) };

    // Vertical pass: col_sum[row*w + x] = sum of src over the window's rows,
    // built as a running sum down each column.
    for x in 0..width {
        let mut sum = 0i32;
        for k in 0..win_h {
            let sy = clamp_index(-half_h + k, height);
            sum += src[(sy * width + x) as usize] as i32;
        }
        col_sum[x as usize] = sum;
        for row in 1..height {
            let drop = clamp_index(row - 1 - half_h, height);
            let take = clamp_index(row - 1 - half_h + win_h, height);
            sum += src[(take * width + x) as usize] as i32 - src[(drop * width + x) as usize] as i32;
            col_sum[(row * width + x) as usize] = sum;
        }
    }

    // Horizontal pass: running sum across the window's columns of col_sum, then
    // divide by the window area. col_sum is non-negative so truncating division
    // matches the reference's `~~(sum / area)`.
    for row in 0..height {
        let base = (row * width) as usize;
        let mut sum = 0i32;
        for k in 0..win_w {
            let sx = clamp_index(-half_w + k, width);
            sum += col_sum[base + sx as usize];
        }
        dst[base] = (sum / area) as u8;
        for x in 1..width {
            let drop = clamp_index(x - 1 - half_w, width);
            let take = clamp_index(x - 1 - half_w + win_w, width);
            sum += col_sum[base + take as usize] - col_sum[base + drop as usize];
            dst[base + x as usize] = (sum / area) as u8;
        }
    }
}
