//! Windows print backend.
//!
//! Capabilities come from the printer's PrintCapabilities document, and the
//! chosen settings go back as a PrintTicket. The composed page PDF is rendered
//! by `Windows.Data.Pdf` into a Direct2D print control, which is part of
//! Windows itself — nothing is bundled and no PDF interpreter is installed
//! alongside the app.
//!
//! `WinPdfPrinter` prints from a path, so the page is written to a temporary
//! file for the length of the call and removed afterwards.

use std::io::Write;
use windows::Win32::Graphics::Printing::GetDefaultPrinterW;
use winprint::printer::{FilePrinter, PrinterDevice, WinPdfPrinter};
use winprint::ticket::{
    Copies, FeatureOptionPack, FeatureOptionPackWithPredefined, PredefinedDuplexType,
    PredefinedPageOrientation, PredefinedPageOutputColor, PrintCapabilities, PrintTicketBuilder,
};

use super::{microns_to_points, PaperSize, PrintJobOptions, PrinterInfo, PrinterList};

pub fn list_printers() -> PrinterList {
    let devices = match PrinterDevice::all() {
        Ok(devices) => devices,
        Err(e) => {
            return PrinterList {
                printers: Vec::new(),
                warning: Some(format!("could not reach the print spooler: {e}")),
            };
        }
    };

    let default_name = default_printer_name();
    let mut printers = Vec::with_capacity(devices.len());
    for device in devices {
        let is_default = default_name.as_deref() == Some(device.name());
        printers.push(describe(device, is_default));
    }

    let warning = if printers.is_empty() {
        Some("no printers are set up on this system".to_string())
    } else {
        None
    };
    PrinterList { printers, warning }
}

/// The spooler's default printer, as a display name matching `PrinterDevice::name`.
fn default_printer_name() -> Option<String> {
    let mut length: u32 = 0;
    // The first call is expected to fail, and reports the buffer size it needs
    // — in characters, including the terminating null.
    let _ = unsafe { GetDefaultPrinterW(None, &mut length) };
    if length == 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    let filled = unsafe {
        GetDefaultPrinterW(
            Some(windows::core::PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
    };
    if !filled.as_bool() {
        return None;
    }
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// Build the dialog's view of one device.
///
/// A device whose capabilities cannot be fetched — offline, or a driver that
/// declines — is still listed, with empty capability lists, so the user can see
/// it is there and read its state rather than wonder where it went.
fn describe(device: PrinterDevice, is_default: bool) -> PrinterInfo {
    let name = device.name().to_string();
    let Ok(capabilities) = PrintCapabilities::fetch(&device) else {
        return PrinterInfo {
            id: name.clone(),
            name,
            is_default,
            location: None,
            model: None,
            state: "unknown".to_string(),
            accepting_jobs: false,
            papers: Vec::new(),
            default_paper_id: None,
            duplex_modes: vec!["none".to_string()],
            color_modes: vec!["color".to_string()],
            qualities: vec!["normal".to_string()],
            resolutions_dpi: Vec::new(),
            max_copies: 1,
        };
    };

    let mut papers = Vec::new();
    for (index, media) in capabilities.page_media_sizes().enumerate() {
        let size = media.size();
        let width_pt = microns_to_points(size.width_in_micron());
        let height_pt = microns_to_points(size.height_in_micron());
        if width_pt <= 0.0 || height_pt <= 0.0 {
            continue;
        }
        papers.push(PaperSize {
            id: media_id(&media, index),
            name: media
                .display_name()
                .map(str::to_string)
                .or_else(|| media.as_predefined_name().map(|n| format!("{n:?}")))
                .unwrap_or_else(|| format!("Paper {}", index + 1)),
            width_pt,
            height_pt,
            // The print ticket carries the imageable area for the job as a
            // whole rather than per paper size, so the sheet is reported as
            // fully printable and the dialog's own margins decide the inset.
            printable_width_pt: width_pt,
            printable_height_pt: height_pt,
            margin_left_pt: 0.0,
            margin_top_pt: 0.0,
        });
    }

    let mut duplex_modes = vec!["none".to_string()];
    for duplex in capabilities.duplexes() {
        match duplex.as_predefined_name() {
            Some(PredefinedDuplexType::TwoSidedLongEdge) => duplex_modes.push("long".to_string()),
            Some(PredefinedDuplexType::TwoSidedShortEdge) => duplex_modes.push("short".to_string()),
            _ => {}
        }
    }

    let mut color_modes = Vec::new();
    for color in capabilities.page_output_colors() {
        match color.as_predefined_name() {
            Some(PredefinedPageOutputColor::Color) => color_modes.push("color".to_string()),
            Some(PredefinedPageOutputColor::Grayscale)
            | Some(PredefinedPageOutputColor::Monochrome) => color_modes.push("mono".to_string()),
            _ => {}
        }
    }
    color_modes.dedup();
    if color_modes.is_empty() {
        color_modes.push("color".to_string());
    }

    let mut resolutions_dpi: Vec<u32> = capabilities
        .page_resolutions()
        .map(|resolution| resolution.dpi().0)
        .filter(|dpi| *dpi > 0)
        .collect();
    resolutions_dpi.sort_unstable();
    resolutions_dpi.dedup();

    let default_paper_id = papers.first().map(|paper| paper.id.clone());
    PrinterInfo {
        id: name.clone(),
        name,
        is_default,
        location: None,
        model: None,
        state: "idle".to_string(),
        accepting_jobs: true,
        papers,
        default_paper_id,
        duplex_modes,
        color_modes,
        // The print ticket expresses quality as resolution rather than as a
        // named grade, so the dialog offers the DPI list instead.
        qualities: vec!["normal".to_string()],
        resolutions_dpi,
        max_copies: capabilities
            .max_copies()
            .map(|copies| u32::from(copies.0))
            .filter(|copies| *copies > 0)
            .unwrap_or(1),
    }
}

/// A paper's identity, preferring its standard name so a selection survives a
/// re-listing; an unnamed size falls back to its position in the list.
fn media_id(media: &winprint::ticket::PageMediaSize, index: usize) -> String {
    media
        .as_predefined_name()
        .map(|name| format!("{name:?}"))
        .unwrap_or_else(|| format!("idx:{index}"))
}

pub fn submit(options: &PrintJobOptions, document: &[u8]) -> Result<i32, String> {
    let devices =
        PrinterDevice::all().map_err(|e| format!("could not reach the print spooler: {e}"))?;
    let device = devices
        .into_iter()
        .find(|device| device.name() == options.printer_id)
        .ok_or_else(|| format!("printer \"{}\" is not available", options.printer_id))?;

    let ticket = build_ticket(&device, options)?;

    // Windows opens the document through the storage APIs, which need a real
    // file. It lives only for the duration of the print call.
    // Named per job rather than per process, so a second page sent while the
    // first is still spooling does not overwrite the file being read.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!("photosuite-print-{}-{stamp}.pdf", std::process::id()));
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("could not stage the page for printing: {e}"))?;
    file.write_all(document)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("could not stage the page for printing: {e}"))?;
    drop(file);

    let result = WinPdfPrinter::new(device)
        .print(&path, ticket)
        .map_err(|e| format!("the page could not be sent to the printer: {e}"));
    let _ = std::fs::remove_file(&path);
    result?;

    // The Direct2D print control does not hand back a spooler job id; the job
    // is queued by the time print() returns.
    Ok(0)
}

/// Translate the dialog's choices into a print ticket, keeping only the
/// options this printer advertises.
fn build_ticket(
    device: &PrinterDevice,
    options: &PrintJobOptions,
) -> Result<winprint::ticket::PrintTicket, String> {
    let capabilities = PrintCapabilities::fetch(device)
        .map_err(|e| format!("could not read what this printer supports: {e}"))?;
    let mut builder = PrintTicketBuilder::new(device)
        .map_err(|e| format!("could not prepare the print job: {e}"))?;

    if let Some(paper_id) = options.paper_id.as_ref().filter(|id| !id.is_empty()) {
        if let Some(media) = capabilities
            .page_media_sizes()
            .enumerate()
            .find(|(index, media)| &media_id(media, *index) == paper_id)
            .map(|(_, media)| media)
        {
            builder
                .merge(media)
                .map_err(|e| format!("this printer would not take that paper size: {e}"))?;
        }
    }

    let wanted_duplex = match options.duplex.as_str() {
        "long" => Some(PredefinedDuplexType::TwoSidedLongEdge),
        "short" => Some(PredefinedDuplexType::TwoSidedShortEdge),
        _ => Some(PredefinedDuplexType::OneSided),
    };
    if let Some(duplex) = capabilities
        .duplexes()
        .find(|duplex| duplex.as_predefined_name() == wanted_duplex)
    {
        let _ = builder.merge(duplex);
    }

    let wanted_color = if options.color_mode == "mono" {
        PredefinedPageOutputColor::Grayscale
    } else {
        PredefinedPageOutputColor::Color
    };
    if let Some(color) = capabilities
        .page_output_colors()
        .find(|color| color.as_predefined_name() == Some(wanted_color))
    {
        let _ = builder.merge(color);
    }

    let wanted_orientation = if options.landscape {
        PredefinedPageOrientation::Landscape
    } else {
        PredefinedPageOrientation::Portrait
    };
    if let Some(orientation) = capabilities
        .page_orientations()
        .find(|orientation| orientation.as_predefined_name() == Some(wanted_orientation))
    {
        let _ = builder.merge(orientation);
    }

    let copies = options.copies.clamp(1, u32::from(u16::MAX)) as u16;
    let _ = builder.merge(Copies(copies));

    builder
        .build()
        .map_err(|e| format!("could not prepare the print job: {e}"))
}
