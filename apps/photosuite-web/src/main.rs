//! PhotoSuite in the browser.
//!
//! Runs the same [`photosuite_ui_egui::PhotosuiteApp`] as the desktop app through eframe's web
//! runner (wgpu: WebGPU where available, WebGL2 otherwise). Build with `trunk build --release`
//! from this directory; see `docs/development.md` ("Web build").
//!
//! Differences from the desktop app:
//! - no TCP control server (browsers can't listen on sockets);
//! - File → Open uses the browser file picker; bytes arrive asynchronously through
//!   `Services::inbox`;
//! - saving/exporting triggers a browser download;
//! - dropped files are read asynchronously by `web::WebShell` and delivered through the inbox.
//!
//! URL query flags: `?cpu` forces the CPU canvas path (same as `PHOTOSUITE_CPU_CANVAS=1`);
//! `?webgl` forces the WebGL2 backend instead of WebGPU.

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("photosuite-web only runs in the browser: build it with `trunk build --release` in apps/photosuite-web");
}
