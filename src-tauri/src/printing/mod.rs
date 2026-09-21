//! Printing: enumerates the host's printers with their capabilities, and sends
//! a composed page document to one of them.
//!
//! The webview composes each page itself and hands this module a finished PDF,
//! so the placement, scaling and margins a user sets in the print dialog are
//! decided by the app's own compositor rather than by a print driver. Every
//! platform takes that same PDF: CUPS accepts it as a job document directly,
//! and Windows renders it through `Windows.Data.Pdf` into a Direct2D print
//! control.

use serde::{Deserialize, Serialize};

#[cfg(unix)]
mod cups;
#[cfg(windows)]
mod win_spool;

/// Points per inch in PDF user space.
const POINTS_PER_INCH: f64 = 72.0;
/// Millimetres per inch, for converting the units each print system reports.
const MM_PER_INCH: f64 = 25.4;

/// A paper size a printer accepts, in PDF points.
///
/// `printable_*` describes the area the hardware can actually put ink on;
/// where a platform does not report it, it equals the full sheet.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaperSize {
    /// Opaque to the webview: passed back verbatim as `paper_id` to select this size.
    pub id: String,
    pub name: String,
    pub width_pt: f64,
    pub height_pt: f64,
    pub printable_width_pt: f64,
    pub printable_height_pt: f64,
    pub margin_left_pt: f64,
    pub margin_top_pt: f64,
}

/// One printer and everything the print dialog offers for it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    /// Opaque to the webview: passed back verbatim as `printer_id` to submit a job.
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub location: Option<String>,
    pub model: Option<String>,
    /// "idle" | "printing" | "stopped" | "unknown".
    pub state: String,
    pub accepting_jobs: bool,
    pub papers: Vec<PaperSize>,
    pub default_paper_id: Option<String>,
    /// Any of "none", "long", "short".
    pub duplex_modes: Vec<String>,
    /// Any of "color", "mono".
    pub color_modes: Vec<String>,
    /// Any of "draft", "normal", "high".
    pub qualities: Vec<String>,
    /// Advertised rendering resolutions, highest last.
    pub resolutions_dpi: Vec<u32>,
    pub max_copies: u32,
}

/// What a printer listing came back with. `warning` carries a reason when the
/// list is short or empty — a stopped print service, a missing CUPS socket —
/// so the dialog can say why instead of showing an unexplained empty menu.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterList {
    pub printers: Vec<PrinterInfo>,
    pub warning: Option<String>,
}

/// The job settings chosen in the print dialog. Anything a printer does not
/// advertise is dropped by the platform backend rather than refused here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJobOptions {
    pub printer_id: String,
    pub job_name: String,
    pub copies: u32,
    pub paper_id: Option<String>,
    /// "none" | "long" | "short".
    pub duplex: String,
    /// "color" | "mono".
    pub color_mode: String,
    /// "draft" | "normal" | "high".
    pub quality: String,
    pub landscape: bool,
}

/// Hundredths of a millimetre (CUPS media units) to PDF points.
#[cfg(unix)]
fn hundredths_mm_to_points(value: i32) -> f64 {
    f64::from(value) / 100.0 / MM_PER_INCH * POINTS_PER_INCH
}

/// Microns (Windows print-ticket media units) to PDF points.
#[cfg(windows)]
fn microns_to_points(value: u32) -> f64 {
    f64::from(value) / 1000.0 / MM_PER_INCH * POINTS_PER_INCH
}

/// List the host's printers and their capabilities.
///
/// Never fails on an unreachable print service: an empty list with a `warning`
/// lets the dialog open and explain itself.
#[tauri::command]
pub fn list_printers() -> PrinterList {
    #[cfg(unix)]
    {
        cups::list_printers()
    }
    #[cfg(windows)]
    {
        win_spool::list_printers()
    }
    #[cfg(not(any(unix, windows)))]
    {
        PrinterList {
            printers: Vec::new(),
            warning: Some("printing is not supported on this platform".to_string()),
        }
    }
}

/// Send a composed page PDF to a printer.
///
/// The PDF arrives as the raw invoke body and the settings as percent-encoded
/// JSON in `X-PhotoSuite-Print`, keeping a multi-megabyte document off the JSON
/// path the way [`crate::save_file`] does.
///
/// Resolves to a job id the platform can be asked about later.
#[tauri::command]
pub fn submit_print_job(request: tauri::ipc::Request<'_>) -> Result<i32, String> {
    use tauri::ipc::InvokeBody;

    let encoded_options = request
        .headers()
        .get("x-photosuite-print")
        .ok_or_else(|| "missing X-PhotoSuite-Print header".to_string())?
        .to_str()
        .map_err(|e| e.to_string())?;
    let options_json = crate::percent_decode(encoded_options)?;
    let options: PrintJobOptions =
        serde_json::from_str(&options_json).map_err(|e| format!("bad print options: {e}"))?;

    let document = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => {
            return Err(
                "submit_print_job expects the page PDF as a binary invoke body (Uint8Array)"
                    .to_string(),
            );
        }
    };
    if document.is_empty() {
        return Err("nothing to print: the page document is empty".to_string());
    }

    #[cfg(unix)]
    {
        cups::submit(&options, document)
    }
    #[cfg(windows)]
    {
        win_spool::submit(&options, document)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (&options, document);
        Err("printing is not supported on this platform".to_string())
    }
}
