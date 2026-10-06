//! Windows only: embed the app icon and version info (VERSIONINFO) into `photosuite.exe`.
//!
//! On every other target this does nothing. A missing resource compiler is a warning, so a
//! cross-compile from macOS or Linux still links, unless `PHOTOSUITE_REQUIRE_WINRES=1` (set by the
//! release workflow) turns it into an error.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../../assets/app-icon/photosuite.ico");
    println!("cargo:rerun-if-env-changed=PHOTOSUITE_REQUIRE_WINRES");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon("../../assets/app-icon/photosuite.ico")
        .set("ProductName", "PhotoSuite")
        .set("FileDescription", "PhotoSuite image editor")
        .set("CompanyName", "PhotoSuite")
        .set("LegalCopyright", "Copyright (c) the PhotoSuite authors; ArtCraft Team and the PhotoCraft contributors. MIT OR Apache-2.0.")
        .set("OriginalFilename", "photosuite.exe")
        .set("InternalName", "photosuite");
    if let Err(e) = res.compile() {
        if std::env::var_os("PHOTOSUITE_REQUIRE_WINRES").is_some() {
            panic!("embedding Windows resources failed: {e}");
        }
        println!("cargo:warning=photosuite.exe built without icon/version resources: {e}");
    }
}
