#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

use std::path::PathBuf;

fn main() {
    register_lens_profiles();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = photosuite_cli::run(&args, &mut std::io::stdout(), &mut std::io::stderr());
    std::process::exit(code);
}

/// The measured lens profiles for Lens Correction's `auto` / `measured` profiles, read on first
/// use from the bundled resources (`PHOTOSUITE_RESOURCES`, beside the binary, or the source tree).
fn register_lens_profiles() {
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from));
    let mut dirs: Vec<PathBuf> = std::env::var_os("PHOTOSUITE_RESOURCES").map(PathBuf::from).into_iter().collect();
    if let Some(d) = exe_dir {
        dirs.extend([d.join("../Resources/resources"), d.join("resources"), d.join("../share/photosuite/resources")]);
    }
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources"));
    let Some(path) = dirs.into_iter().map(|d| d.join("lensfun/lens-database.json")).find(|p| p.is_file()) else { return };
    photosuite_engine::lens_cmds::set_lens_database_loader(Box::new(move || std::fs::read(&path).ok()));
}
