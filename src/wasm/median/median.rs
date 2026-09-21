// Sliding-window histogram median blur, compiled to wasm32. These are the
// dominant cost in the artistic filter gallery, and JavaScriptCore (the macOS
// WKWebView engine) runs the JS form far slower than V8 — WASM closes that gap.
//
// The output is byte-identical to a straightforward JS histogram median; the
// Node harness in verify.mjs asserts equality across sizes and window shapes.
// Rebuild with build.sh (needs `rustup target add wasm32-unknown-unknown`).
#![no_std]

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// Bump allocator. JS calls wasm_reset() then wasm_alloc() to lay out the source
// and destination single-channel planes. The base sits well above the module's
// static data and shadow stack (both far below 1 MiB for this tiny module).
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

/// Find the smallest histogram bin whose cumulative count reaches `target`.
/// A two-level histogram makes this O(1)-ish: skip 16 bins at a time using the
/// coarse buckets (each covers 16 fine bins), then scan the fine bins inside the
/// bucket that contains the target rank.
#[inline(always)]
fn median_bin(fine: &[i32; 256], coarse: &[i32; 16], target: i32) -> usize {
    let mut cumulative = 0i32;
    let mut bin = 0usize;
    while cumulative + coarse[bin >> 4] < target {
        cumulative += coarse[bin >> 4];
        bin += 16;
    }
    while bin < 256 {
        cumulative += fine[bin];
        if cumulative >= target { break; }
        bin += 1;
    }
    bin
}

/// Axis-aligned sliding-window median over a single-channel u8 plane.
/// The window is `window_width` x `window_height`; `rank` selects the rank-th
/// smallest value in the window (rank = window_area / 2 gives the true median).
#[no_mangle]
pub extern "C" fn median_h(
    src_ptr: u32,
    dst_ptr: u32,
    width: u32,
    height: u32,
    window_width: u32,
    window_height: u32,
    rank: u32,
) {
    let width = width as i32;
    let height = height as i32;
    let win_w = window_width as i32;
    let win_h = window_height as i32;
    let mut target = rank as i32;
    if target > win_h * win_w { target = win_h * win_w; }
    let half_w = win_w >> 1;
    let half_h = win_h >> 1;

    let count = (width * height) as usize;
    let src = unsafe { core::slice::from_raw_parts(src_ptr as *const u8, count) };
    let dst = unsafe { core::slice::from_raw_parts_mut(dst_ptr as *mut u8, count) };

    let mut col_x = [0i32; 256];   // leading sample x for each window row
    let mut fine = [0i32; 256];    // 256-bin histogram of the current window
    let mut coarse = [0i32; 16];   // coarse buckets (16 fine bins each)
    let mut out = 0usize;

    for row in 0..height {
        for v in fine.iter_mut() { *v = 0; }
        for v in coarse.iter_mut() { *v = 0; }

        // Seed the histogram with the full window over the first column.
        for win_row in 0..win_h {
            for win_col in 0..win_w {
                let mut sx = -half_w + win_col;
                let mut sy = row - half_h + win_row;
                if win_col == 0 { col_x[win_row as usize] = sx; }
                sx = clamp_index(sx, width);
                sy = clamp_index(sy, height);
                let sample = src[(sy * width + sx) as usize] as usize;
                fine[sample] += 1;
                coarse[sample >> 4] += 1;
            }
        }
        dst[out] = median_bin(&fine, &coarse, target) as u8;
        out += 1;

        // Slide one column at a time: drop the leftmost sample of each window row
        // and add the new rightmost one, then re-read the median.
        for _col in 1..width {
            for win_row in 0..win_h {
                let mut sy = row - half_h + win_row;
                let lead_x = col_x[win_row as usize] + 1;
                col_x[win_row as usize] = lead_x;
                let mut remove_x = lead_x - 1;
                let mut add_x = lead_x + win_w - 1;
                sy = clamp_index(sy, height);
                remove_x = clamp_index(remove_x, width);
                add_x = clamp_index(add_x, width);
                let removed = src[(sy * width + remove_x) as usize] as usize;
                let added = src[(sy * width + add_x) as usize] as usize;
                fine[removed] -= 1;
                fine[added] += 1;
                coarse[removed >> 4] -= 1;
                coarse[added >> 4] += 1;
            }
            dst[out] = median_bin(&fine, &coarse, target) as u8;
            out += 1;
        }
    }
}

/// Sheared (parallelogram) sliding-window median — the window is slanted, which
/// gives the directional stroke look used by several gallery filters.
/// `window_len` rows, each a `window_span`-wide horizontal run that steps
/// diagonally; `reverse != 0` flips the shear direction.
#[no_mangle]
pub extern "C" fn median_dir(
    src_ptr: u32,
    dst_ptr: u32,
    width: u32,
    height: u32,
    window_len: u32,
    window_span: u32,
    reverse: u32,
    rank: u32,
) {
    let width = width as i32;
    let height = height as i32;
    let win_len = window_len as i32;
    let win_span = window_span as i32;
    let target = rank as i32;
    let diagonal = win_len + win_span - 1;
    let half_len = win_len >> 1;
    let half_diagonal = diagonal >> 1;
    let flip = reverse != 0;

    let count = (width * height) as usize;
    let src = unsafe { core::slice::from_raw_parts(src_ptr as *const u8, count) };
    let dst = unsafe { core::slice::from_raw_parts_mut(dst_ptr as *mut u8, count) };

    let mut col_x = [0i32; 256];   // leading sample x for each of win_len rows
    let mut fine = [0i32; 256];
    let mut coarse = [0i32; 16];
    let mut out = 0usize;

    for row in 0..height {
        for v in fine.iter_mut() { *v = 0; }
        for v in coarse.iter_mut() { *v = 0; }

        for step in 0..win_len {
            let run_start = if flip { diagonal - step - win_span } else { step };
            for offset in run_start..(win_span + run_start) {
                let mut sx = -half_diagonal + offset;
                let mut sy = row - half_len + step;
                if offset == run_start { col_x[step as usize] = sx; }
                sx = clamp_index(sx, width);
                sy = clamp_index(sy, height);
                let sample = src[(sy * width + sx) as usize] as usize;
                fine[sample] += 1;
                coarse[sample >> 4] += 1;
            }
        }
        dst[out] = median_bin(&fine, &coarse, target) as u8;
        out += 1;

        for _col in 1..width {
            for step in 0..win_len {
                let mut sy = row - half_len + step;
                let lead_x = col_x[step as usize] + 1;
                col_x[step as usize] = lead_x;
                let mut remove_x = lead_x - 1;
                let mut add_x = lead_x + win_span - 1;
                sy = clamp_index(sy, height);
                remove_x = clamp_index(remove_x, width);
                add_x = clamp_index(add_x, width);
                let removed = src[(sy * width + remove_x) as usize] as usize;
                let added = src[(sy * width + add_x) as usize] as usize;
                fine[removed] -= 1;
                fine[added] += 1;
                coarse[removed >> 4] -= 1;
                coarse[added >> 4] += 1;
            }
            dst[out] = median_bin(&fine, &coarse, target) as u8;
            out += 1;
        }
    }
}
