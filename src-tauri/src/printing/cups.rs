//! CUPS print backend, used on macOS and Linux.
//!
//! CUPS takes PDF as a job document on both, so the page the webview composed
//! is handed to `submit_data` unchanged. `print-scaling=none` keeps the print
//! system from fitting the page a second time — the PDF's media box already
//! matches the paper, and the image inside it is already where the user put it.

use cups_rs::{
    create_job_with_options, get_all_destinations, ColorMode, Destination, DestinationInfo,
    DuplexMode, Orientation, PrintOptions, PrintQuality, PrinterState, MEDIA_FLAGS_DEFAULT,
};
use std::ptr;

use super::{hundredths_mm_to_points, PaperSize, PrintJobOptions, PrinterInfo, PrinterList};

/// PDF is what the composed page is, and what every CUPS queue accepts.
const PAGE_MIME_TYPE: &str = "application/pdf";

/// Job options asked about for capabilities the typed media API does not
/// cover. These are the IPP option names, not their `-supported` attributes:
/// CUPS answers "what may this option be set to" for the option itself, and
/// does so for PPD-driven queues as well as driverless ones.
const SIDES: &str = "sides";
const COLOR_MODE: &str = "print-color-mode";
const QUALITY: &str = "print-quality";
const RESOLUTION: &str = "printer-resolution";
const COPIES: &str = "copies";

pub fn list_printers() -> PrinterList {
    let destinations = match get_all_destinations() {
        Ok(destinations) => destinations,
        Err(e) => {
            return PrinterList {
                printers: Vec::new(),
                warning: Some(format!("could not reach the print service: {e}")),
            };
        }
    };

    let mut printers = Vec::with_capacity(destinations.len());
    for destination in &destinations {
        printers.push(describe(destination));
    }

    let warning = if printers.is_empty() {
        Some("no printers are set up on this system".to_string())
    } else {
        None
    };
    PrinterList { printers, warning }
}

/// Build the dialog's view of one destination.
///
/// Capabilities come from the destination's detailed info, which is one IPP
/// round trip to the queue and holds what the printer actually supports; the
/// options CUPS caches on the destination itself carry only a subset. Each
/// lookup falls back to the conservative answer rather than failing the
/// listing: a printer that under-reports still prints, it just offers fewer
/// choices.
fn describe(destination: &Destination) -> PrinterInfo {
    let info = destination.get_detailed_info(ptr::null_mut()).ok();
    let (papers, default_paper_id) = media_sizes(destination, info.as_ref());
    PrinterInfo {
        id: destination.name.clone(),
        name: destination
            .info()
            .cloned()
            .unwrap_or_else(|| destination.name.clone()),
        is_default: destination.is_default,
        location: destination.location().cloned(),
        model: destination.make_and_model().cloned(),
        state: match destination.state() {
            PrinterState::Idle => "idle",
            PrinterState::Processing => "printing",
            PrinterState::Stopped => "stopped",
            PrinterState::Unknown => "unknown",
        }
        .to_string(),
        accepting_jobs: destination.is_accepting_jobs(),
        papers,
        default_paper_id,
        duplex_modes: duplex_modes(&capability_values(destination, info.as_ref(), SIDES)),
        color_modes: color_modes(&capability_values(destination, info.as_ref(), COLOR_MODE)),
        qualities: qualities(&capability_values(destination, info.as_ref(), QUALITY)),
        resolutions_dpi: resolutions(&capability_values(destination, info.as_ref(), RESOLUTION)),
        max_copies: max_copies(&capability_values(destination, info.as_ref(), COPIES)),
    }
}

/// The paper sizes a destination accepts, plus the id of its default size.
///
/// Reading the media list needs the destination's detailed info, which is an
/// IPP round trip to the queue. A destination that will not answer contributes
/// an empty list, and the dialog falls back to its own standard sizes.
fn media_sizes(
    destination: &Destination,
    info: Option<&DestinationInfo>,
) -> (Vec<PaperSize>, Option<String>) {
    let Some(info) = info else {
        return (Vec::new(), None);
    };
    let dest_ptr = destination.as_ptr();
    if dest_ptr.is_null() {
        return (Vec::new(), None);
    }

    let Ok(media) = info.get_all_media(ptr::null_mut(), dest_ptr, MEDIA_FLAGS_DEFAULT) else {
        return (Vec::new(), None);
    };

    let mut papers = Vec::with_capacity(media.len());
    for size in &media {
        if size.width <= 0 || size.length <= 0 {
            continue;
        }
        let width_pt = hundredths_mm_to_points(size.width);
        let height_pt = hundredths_mm_to_points(size.length);
        let margin_left_pt = hundredths_mm_to_points(size.left);
        let margin_top_pt = hundredths_mm_to_points(size.top);
        papers.push(PaperSize {
            id: size.name.clone(),
            name: info
                .localize_media(ptr::null_mut(), dest_ptr, MEDIA_FLAGS_DEFAULT, size)
                .unwrap_or_else(|_| size.name.clone()),
            width_pt,
            height_pt,
            printable_width_pt: (width_pt
                - margin_left_pt
                - hundredths_mm_to_points(size.right))
            .max(0.0),
            printable_height_pt: (height_pt
                - margin_top_pt
                - hundredths_mm_to_points(size.bottom))
            .max(0.0),
            margin_left_pt,
            margin_top_pt,
        });
    }

    let default_paper_id = info
        .get_default_media(ptr::null_mut(), dest_ptr, MEDIA_FLAGS_DEFAULT)
        .ok()
        .map(|size| size.name)
        .filter(|name| !name.is_empty());
    (papers, default_paper_id)
}

/// What a printer says it supports for one IPP attribute.
///
/// The queue is asked first, since that is the complete answer. A destination
/// that will not answer may still have the attribute cached in its own options
/// as a comma-separated list, which is read as a fallback.
fn capability_values(
    destination: &Destination,
    info: Option<&DestinationInfo>,
    option: &str,
) -> Vec<String> {
    let dest_ptr = destination.as_ptr();
    if let (Some(info), false) = (info, dest_ptr.is_null()) {
        if let Ok(values) = info.get_supported_values(ptr::null_mut(), dest_ptr, option) {
            if !values.is_empty() {
                return values;
            }
        }
    }
    destination
        .get_option(option)
        .map(|value| {
            value
                .split(',')
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn duplex_modes(supported: &[String]) -> Vec<String> {
    let mut modes = vec!["none".to_string()];
    if supported.iter().any(|v| v == "two-sided-long-edge") {
        modes.push("long".to_string());
    }
    if supported.iter().any(|v| v == "two-sided-short-edge") {
        modes.push("short".to_string());
    }
    modes
}

fn color_modes(supported: &[String]) -> Vec<String> {
    if supported.is_empty() {
        return vec!["color".to_string(), "mono".to_string()];
    }
    let mut modes = Vec::new();
    if supported.iter().any(|v| v == "color" || v == "auto") {
        modes.push("color".to_string());
    }
    if supported.iter().any(|v| v == "monochrome") {
        modes.push("mono".to_string());
    }
    if modes.is_empty() {
        modes.push("color".to_string());
    }
    modes
}

/// IPP print-quality is 3 (draft), 4 (normal), 5 (high).
fn qualities(supported: &[String]) -> Vec<String> {
    if supported.is_empty() {
        return vec!["normal".to_string()];
    }
    let mut qualities = Vec::new();
    for (value, name) in [("3", "draft"), ("4", "normal"), ("5", "high")] {
        if supported.iter().any(|v| v == value) {
            qualities.push(name.to_string());
        }
    }
    if qualities.is_empty() {
        qualities.push("normal".to_string());
    }
    qualities
}

/// Resolutions arrive as "300dpi,600dpi" or "600x600dpi"; the cross-feed
/// figure is the one that bounds page detail, so a square reading is enough
/// for the dialog's DPI menu.
fn resolutions(supported: &[String]) -> Vec<u32> {
    let mut found: Vec<u32> = supported
        .iter()
        .filter_map(|entry| {
            let digits: String = entry.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        })
        .filter(|dpi| *dpi > 0)
        .collect();
    found.sort_unstable();
    found.dedup();
    found
}

/// "copies-supported" is an IPP range, which arrives either as the text "1-99"
/// or as its bounds; the largest number seen is the cap.
fn max_copies(supported: &[String]) -> u32 {
    let cap = supported
        .iter()
        .flat_map(|value| value.split('-'))
        .filter_map(|bound| bound.trim().parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    // A range that arrives as its type rather than its bounds reads as 0, and
    // a queue that answers with the option's current value reads as 1. Neither
    // is a ceiling, and treating either as one would hold the user to a single
    // copy on a printer that has no such limit.
    if cap > 1 {
        cap
    } else {
        99
    }
}

pub fn submit(options: &PrintJobOptions, document: &[u8]) -> Result<i32, String> {
    let destination = cups_rs::get_destination(&options.printer_id)
        .map_err(|e| format!("printer \"{}\" is not available: {e}", options.printer_id))?;

    let mut print_options = PrintOptions::new()
        .copies(options.copies.max(1))
        .color_mode(match options.color_mode.as_str() {
            "mono" => ColorMode::Monochrome,
            _ => ColorMode::Color,
        })
        .quality(match options.quality.as_str() {
            "draft" => PrintQuality::Draft,
            "high" => PrintQuality::High,
            _ => PrintQuality::Normal,
        })
        .duplex(match options.duplex.as_str() {
            "long" => DuplexMode::TwoSidedPortrait,
            "short" => DuplexMode::TwoSidedLandscape,
            _ => DuplexMode::OneSided,
        })
        .orientation(if options.landscape {
            Orientation::Landscape
        } else {
            Orientation::Portrait
        })
        // The page is already composed at the paper's size with the margins
        // the user chose, so any fitting the print system would apply on top
        // would move the image off the placement they saw in the preview.
        .custom_option("print-scaling", "none");

    if let Some(paper_id) = options.paper_id.as_ref().filter(|id| !id.is_empty()) {
        print_options = print_options.media(paper_id);
    }

    let job = create_job_with_options(&destination, &options.job_name, &print_options)
        .map_err(|e| format!("the printer would not start the job: {e}"))?;
    job.submit_data(document, PAGE_MIME_TYPE, &options.job_name)
        .map_err(|e| format!("the page could not be sent to the printer: {e}"))?;
    Ok(job.id)
}
