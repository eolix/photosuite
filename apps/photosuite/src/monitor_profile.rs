//! The displays and their ICC profiles, for the colour-managed canvas (Edit › Color Settings ›
//! Monitor Profile = `auto`; #569).
//!
//! macOS: every `NSScreen` with its `CGDirectDisplayID`, name, frame and
//! `colorSpace.ICCProfileData`, documented AppKit APIs read through `osascript` (AppKit via
//! AppleScriptObjC) so the app needs no `unsafe` FFI. A read takes about 0.4 s on a background
//! thread; the shell starts one at launch and again when the displays may have changed
//! (`photosuite_ui_egui::monitor_status`), and each window then uses the profile of the display
//! it is on. Other platforms report no displays (sRGB, or the profile chosen in Color Settings).

use std::sync::mpsc::Receiver;

use photosuite_engine::display_color::Display;

/// What the platform reader returns: the displays, or why there are none.
pub type Detection = Result<Vec<Display>, String>;

/// Starts reading the displays in the background; `None` when the platform has no reader.
pub fn detect_async() -> Option<Receiver<Detection>> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(detect());
    });
    Some(rx)
}

/// One line per screen, primary (menu-bar) screen first: id, frame (x, y, width, height in
/// points, Cocoa's bottom-left origin), the profile as base64, the profile's name in System
/// Settings and the display's name, tab-separated. Numbers as integers (text conversion of
/// reals follows the user's locale, e.g. "0,0").
#[cfg(target_os = "macos")]
const SCRIPT: &str = r#"use framework "AppKit"
set out to ""
repeat with s in (current application's NSScreen's screens() as list)
  set f to s's frame()
  set n to ((s's deviceDescription()'s objectForKey:"NSScreenNumber") as integer)
  set icc to ""
  set cs to s's colorSpace()
  set csName to ""
  if cs is not missing value then
    set csName to ((cs's localizedName()) as text)
    set d to cs's ICCProfileData()
    if d is not missing value then set icc to ((d's base64EncodedStringWithOptions:0) as text)
  end if
  set out to out & n & tab & ((item 1 of item 1 of f) as integer) & tab & ((item 2 of item 1 of f) as integer) & tab & ((item 1 of item 2 of f) as integer) & tab & ((item 2 of item 2 of f) as integer) & tab & icc & tab & csName & tab & ((s's localizedName()) as text) & linefeed
end repeat
return out"#;

#[cfg(target_os = "macos")]
fn detect() -> Detection {
    let mut cmd = std::process::Command::new("/usr/bin/osascript");
    cmd.args(["-e", SCRIPT]);
    parse_reply(&run_helper(&mut cmd, HELPER_TIMEOUT)?)
}

/// How long a reading may take before the helper is stopped (it normally takes about 0.4 s).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const HELPER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Run the helper and return its standard output; a helper that fails, or runs longer than
/// `timeout`, is an error (and is killed and reaped), so a hung reading can't block later ones.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn run_helper(cmd: &mut std::process::Command, timeout: std::time::Duration) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child =
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("couldn't run the display profile reader: {e}"))?;
    // Drain both pipes while waiting: a reply larger than the pipe buffer would otherwise block
    // the helper until the deadline.
    let drain = |p: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = p {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("reading the display profiles took longer than {} s and was stopped", timeout.as_secs()));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("waiting for the display profile reader failed: {e}"));
            }
        }
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    if !status.success() {
        let err = String::from_utf8_lossy(&err);
        let first = err.lines().next().unwrap_or("").trim();
        return Err(format!("reading the display profiles failed ({status}){}", if first.is_empty() { String::new() } else { format!(": {first}") }));
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn detect() -> Detection {
    Err("this platform doesn't report display profiles".into())
}

/// The helper's reply ([`SCRIPT`]) → displays, frames flipped to a top-left origin with y down
/// (the coordinates window positions use). Lines that don't parse are skipped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_reply(out: &str) -> Detection {
    let mut displays = Vec::new();
    let mut primary_height = None;
    for line in out.lines().filter(|l| !l.trim().is_empty()) {
        let f: Vec<&str> = line.splitn(8, '\t').collect();
        let [id, x, y, w, h, b64, profile_name, name] = f.as_slice() else { continue };
        let num = |s: &str| s.trim().parse::<f64>().ok().filter(|v| v.is_finite());
        let (Some(id), Some(x), Some(y), Some(w), Some(h)) = (id.trim().parse::<u32>().ok(), num(x), num(y), num(w), num(h)) else { continue };
        // Cocoa frames are relative to the primary screen's bottom-left corner, y up.
        let top = *primary_height.get_or_insert(h) - (y + h);
        let name = name.trim();
        let name = if name.is_empty() { format!("Display {id}") } else { name.to_string() };
        let b64 = b64.trim();
        // An ICC profile starts with its size and carries `acsp` at offset 36; anything else is
        // treated as no profile (the engine then says the display has none).
        let icc = (!b64.is_empty()).then(|| base64_decode(b64)).flatten().filter(|b| b.len() >= 132 && b.get(36..40) == Some(b"acsp"));
        let profile_name = Some(profile_name.trim().to_string()).filter(|n| !n.is_empty());
        displays.push(Display { id, name, frame: [x, top, w, h], profile_name, icc: icc.map(std::sync::Arc::new) });
    }
    if displays.is_empty() {
        let first = out.lines().next().unwrap_or("").trim();
        return Err(if first.is_empty() { "the display reader returned nothing".into() } else { format!("couldn't read the display list: {first}") });
    }
    Ok(displays)
}

/// Standard base64 (RFC 4648, with padding) → bytes; `None` on any invalid character.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            acc |= val(*c)? << (18 - 6 * i);
        }
        let n = match chunk.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        out.extend_from_slice(&acc.to_be_bytes()[1..1 + n]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        assert_eq!(base64_decode("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(base64_decode("aGVsbG8h").as_deref(), Some(&b"hello!"[..]));
        assert_eq!(base64_decode("aGk=").as_deref(), Some(&b"hi"[..]));
        assert_eq!(base64_decode("").as_deref(), Some(&b""[..]));
        assert!(base64_decode("a").is_none());
        assert!(base64_decode("a$==").is_none());
    }

    #[test]
    fn helper_replies() {
        // Only the ICC signature is checked here; parsing is the engine's job.
        let mut icc = vec![0u8; 132];
        icc[36..40].copy_from_slice(b"acsp");
        let b64 = base64_encode(&icc);
        // The #569 setup: built-in display primary, the external one right of it and higher up.
        let reply = format!(
            "1\t0\t0\t1728\t1117\t{b64}\tColor LCD\tBuilt-in Retina Display\n4\t1728\t92\t3008\t1692\t{b64}\tApple_Display_26-04-13.icc\tROG PG32UQX\n"
        );
        let d = parse_reply(&reply).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].id, d[0].name.as_str(), d[0].frame), (1, "Built-in Retina Display", [0.0, 0.0, 1728.0, 1117.0]));
        assert_eq!((d[1].id, d[1].frame), (4, [1728.0, -667.0, 3008.0, 1692.0]));
        assert_eq!(d[1].profile_name.as_deref(), Some("Apple_Display_26-04-13.icc"));
        assert_eq!(d[1].icc.as_deref(), Some(&icc));
        // No profile, a bad profile, no name: kept, without a profile or with a fallback name.
        let d = parse_reply("2\t0\t0\t800\t600\t\t\t\n3\t800\t0\t800\t600\taGVsbG8=\tX\tY\n").unwrap();
        assert_eq!((d[0].name.as_str(), d[0].icc.is_none(), d[0].profile_name.is_none()), ("Display 2", true, true));
        assert!(d[1].icc.is_none());
        // Garbage lines are skipped; nothing usable is an error.
        assert_eq!(parse_reply("junk\n5\t0\t0\t10\t10\t\t\tZ").unwrap().len(), 1);
        assert!(parse_reply("").is_err());
        assert!(parse_reply("execution error: -1728").unwrap_err().contains("-1728"));
    }

    #[test]
    fn a_hung_helper_is_stopped_and_big_replies_dont_block() {
        let t0 = std::time::Instant::now();
        let e = run_helper(std::process::Command::new("/bin/sleep").arg("30"), std::time::Duration::from_millis(300)).unwrap_err();
        assert!(e.contains("took longer than"), "{e}");
        assert!(t0.elapsed() < std::time::Duration::from_secs(5), "killed at the deadline");
        // 1 MB on stdout (far beyond a pipe buffer) arrives whole.
        let big = run_helper(std::process::Command::new("/bin/sh").args(["-c", "head -c 1048576 /dev/zero | tr '\\0' a"]), std::time::Duration::from_secs(20))
            .unwrap();
        assert_eq!(big.len(), 1 << 20);
        let e = run_helper(std::process::Command::new("/bin/sh").args(["-c", "echo boom >&2; exit 3"]), std::time::Duration::from_secs(5)).unwrap_err();
        assert!(e.contains("boom"), "{e}");
        assert!(run_helper(&mut std::process::Command::new("/nonexistent/helper"), std::time::Duration::from_secs(1)).is_err());
    }

    fn base64_encode(b: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for c in b.chunks(3) {
            let n = c.iter().enumerate().fold(0u32, |n, (i, v)| n | u32::from(*v) << (16 - 8 * i));
            for i in 0..=c.len() {
                s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
        }
        while !s.len().is_multiple_of(4) {
            s.push('=');
        }
        s
    }

    /// On a Mac, every display is read, and the profiles parse as RGB profiles.
    #[test]
    fn detected_displays_parse() {
        if let Ok(displays) = detect() {
            for d in displays {
                let Some(icc) = d.icc else { continue };
                let p = photosuite_engine::color_cmds::profile_from_bytes(&icc).expect("parses");
                assert_eq!(format!("{:?}", p.color_space), "Rgb", "{}: {}", d.name, p.description);
            }
        }
    }
}
