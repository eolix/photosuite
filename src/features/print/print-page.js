/**
 * Turning a document into a page a printer can take: where the image sits on
 * the sheet, and the single-page PDF that carries it.
 *
 * The image goes into the PDF at its own pixel dimensions and is placed by the
 * page transform, so the printer's raster engine scales from the document's
 * full resolution at device resolution. Nothing is resampled on the way out,
 * and a page stays the size of its image rather than the size of the sheet.
 */

/* global ToPDF, UDOC */

/** PDF user-space units per inch. */
export const POINTS_PER_INCH = 72;
/** Millimetres per inch. */
export const MM_PER_INCH = 25.4;

/**
 * Sheet sizes offered when a printer advertises none of its own — a queue that
 * is offline, or a driver that does not answer a capability query.
 * Dimensions are in points, portrait.
 */
export const STANDARD_PAPERS = [
  { id: "iso_a3_297x420mm", widthPt: 841.89, heightPt: 1190.55 },
  { id: "iso_a4_210x297mm", widthPt: 595.28, heightPt: 841.89 },
  { id: "iso_a5_148x210mm", widthPt: 419.53, heightPt: 595.28 },
  { id: "na_letter_8.5x11in", widthPt: 612, heightPt: 792 },
  { id: "na_legal_8.5x14in", widthPt: 612, heightPt: 1008 },
  { id: "na_ledger_11x17in", widthPt: 792, heightPt: 1224 },
  { id: "na_index-4x6_4x6in", widthPt: 288, heightPt: 432 },
  { id: "na_5x7_5x7in", widthPt: 360, heightPt: 504 },
  { id: "na_govt-letter_8x10in", widthPt: 576, heightPt: 720 },
];

/** The size chosen when a printer offers it, whatever the printer's own default. */
const PREFERRED_DEFAULT_PAPER = "A4";

/**
 * Names for the PWG media keywords that do not read as themselves. Keyed by
 * the keyword's middle field, so `na_number-10_4.125x9.5in` is looked up as
 * `number-10`. Sizes not listed here are derived from the keyword.
 */
const PAPER_NAMES = {
  letter: "Letter",
  legal: "Legal",
  ledger: "Tabloid",
  tabloid: "Tabloid",
  executive: "Executive",
  foolscap: "Foolscap",
  monarch: "Monarch envelope",
  "number-9": "No. 9 envelope",
  "number-10": "No. 10 envelope",
  "number-11": "No. 11 envelope",
  "govt-letter": "Government letter",
  "govt-legal": "Government legal",
  dl: "DL envelope",
  hagaki: "Hagaki",
  oufuku: "Oufuku hagaki",
  "photo-l": "Photo L",
  "photo-2l": "Photo 2L",
  "small-photo": "Small photo",
  "wide-photo": "Wide photo",
  custom: "Custom",
};

/** Title-case a keyword that has no entry of its own ("super-b" → "Super B"). */
function titleCaseKeyword(keyword) {
  return keyword
    .split(/[-\s]/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The readable name behind a PWG media keyword (`iso_a4_210x297mm` → "A4").
 *
 * PWG 5101.1 keywords are `region_name_WxH`, self-describing but not meant to
 * be read by people. The region tells an ISO B size from a JIS one, which are
 * different sheets under the same letter.
 */
function nameFromMediaKeyword(mediaId) {
  const fields = mediaId.replace(/_borderless$/, "").split("_");
  const region = fields.length > 1 ? fields[0].toLowerCase() : "";
  const keyword = (fields.length > 1 ? fields[1] : fields[0]).toLowerCase();

  // A size a printer defines itself has its measurements where the keyword
  // would be; the label carries those already.
  if (region === "custom") return PAPER_NAMES.custom;
  if (PAPER_NAMES[keyword]) return PAPER_NAMES[keyword];

  const seriesMatch = /^([abc])(\d{1,2})$/.exec(keyword);
  if (seriesMatch) {
    const series = seriesMatch[1].toUpperCase();
    const size = series + seriesMatch[2];
    if (series === "C") return size + " envelope";
    if (series === "B") return (region === "jis" || region === "jpn" ? "JIS " : "") + size;
    return size;
  }

  // Keywords that are themselves a measurement ("5x7", "index-4x6").
  const inchMatch = /^(?:([a-z-]+)-)?(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(keyword);
  if (inchMatch) {
    const prefix = inchMatch[1] ? titleCaseKeyword(inchMatch[1]) + " " : "";
    return prefix + inchMatch[2] + " × " + inchMatch[3] + " in";
  }

  // A Windows print ticket names sizes as one run of words ("NorthAmericaLetter").
  if (fields.length === 1 && /[a-z][A-Z]/.test(mediaId)) {
    return mediaId
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^(ISO|JIS|JPN|PRC|ROC) ?/, "")
      .trim();
  }
  return titleCaseKeyword(keyword);
}

/**
 * Turn a printer's paper list into rows for the paper menu: each with a name a
 * person can read and its size, ordered alphabetically.
 *
 * A printer names its sizes for machines — `na_letter_8.5x11in` — and lists
 * them in whatever order its driver holds them, which is neither alphabetical
 * nor by size. The label a platform supplies is preferred when it gives one.
 *
 * @param {Array<object>} papers paper sizes as a printer reported them
 * @returns {Array<object>} the same sizes, each with a `label`, sorted by it
 */
export function labelAndSortPapers(papers) {
  const labelled = papers.map((paper) => {
    const supplied = typeof paper.name === "string" ? paper.name.trim() : "";
    // A platform that has no name of its own answers with the keyword.
    const usesSuppliedName = supplied !== "" && supplied !== paper.id && !supplied.includes("_");
    const name = usesSuppliedName ? supplied : nameFromMediaKeyword(paper.id);
    const widthMm = Math.round(pointsToMm(paper.widthPt));
    const heightMm = Math.round(pointsToMm(paper.heightPt));
    const borderless = /borderless/i.test(paper.id) || /borderless/i.test(supplied);
    return {
      ...paper,
      name,
      label:
        name +
        " — " +
        widthMm +
        " × " +
        heightMm +
        " mm" +
        (borderless ? " (borderless)" : ""),
    };
  });
  labelled.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return labelled;
}

/**
 * Which paper to start on: A4 where the printer has it, else the printer's own
 * default, else the first size it offers.
 *
 * @param {Array<object>} papers rows from {@link labelAndSortPapers}
 * @param {string|null} printerDefaultId the printer's default paper id
 */
export function defaultPaperIndex(papers, printerDefaultId) {
  const preferred = papers.findIndex(
    (paper) => paper.name === PREFERRED_DEFAULT_PAPER && !/borderless/i.test(paper.id),
  );
  if (preferred >= 0) return preferred;
  if (printerDefaultId) {
    const printerDefault = papers.findIndex((paper) => paper.id === printerDefaultId);
    if (printerDefault >= 0) return printerDefault;
  }
  return 0;
}

/**
 * A raw RGB page stream larger than this is sent as JPEG instead. An
 * uncompressed stream is exact, but a spool file of several hundred megabytes
 * stalls the queue long enough to look like a failure.
 */
const MAX_UNCOMPRESSED_STREAM_BYTES = 64 * 1024 * 1024;

/** Quality for the pages that cross that threshold. */
export const LARGE_PAGE_JPEG_QUALITY = 92;

/**
 * Whether a document of this pixel size should go into the page as JPEG rather
 * than as its own pixels. The PDF writer stores raw samples uncompressed, so
 * the stream is three bytes a pixel.
 *
 * @param {number} widthPx
 * @param {number} heightPx
 */
export function shouldCompressPage(widthPx, heightPx) {
  return widthPx * heightPx * 3 > MAX_UNCOMPRESSED_STREAM_BYTES;
}

/** @param {number} mm */
export function mmToPoints(mm) {
  return (mm / MM_PER_INCH) * POINTS_PER_INCH;
}

/** @param {number} points */
export function pointsToMm(points) {
  return (points / POINTS_PER_INCH) * MM_PER_INCH;
}

/** @param {number} inches */
export function inchesToPoints(inches) {
  return inches * POINTS_PER_INCH;
}

/** @param {number} points */
export function pointsToInches(points) {
  return points / POINTS_PER_INCH;
}

/**
 * A paper's dimensions in the chosen orientation, with its unprintable edges
 * rotated to match.
 *
 * @param {object} paper entry from a printer's `papers`, or {@link STANDARD_PAPERS}
 * @param {boolean} landscape
 */
export function orientPaper(paper, landscape) {
  const widthPt = paper.widthPt;
  const heightPt = paper.heightPt;
  const printableWidthPt = paper.printableWidthPt != null ? paper.printableWidthPt : widthPt;
  const printableHeightPt = paper.printableHeightPt != null ? paper.printableHeightPt : heightPt;
  const marginLeftPt = paper.marginLeftPt != null ? paper.marginLeftPt : 0;
  const marginTopPt = paper.marginTopPt != null ? paper.marginTopPt : 0;
  const marginRightPt = Math.max(0, widthPt - marginLeftPt - printableWidthPt);
  const marginBottomPt = Math.max(0, heightPt - marginTopPt - printableHeightPt);
  if (!landscape) {
    return {
      widthPt,
      heightPt,
      hardMargins: { left: marginLeftPt, top: marginTopPt, right: marginRightPt, bottom: marginBottomPt },
    };
  }
  // Rotating the sheet a quarter turn clockwise carries each unprintable edge
  // with it: the sheet's top edge becomes the page's right edge.
  return {
    widthPt: heightPt,
    heightPt: widthPt,
    hardMargins: { left: marginBottomPt, top: marginLeftPt, right: marginTopPt, bottom: marginRightPt },
  };
}

/**
 * Work out where the document sits on the sheet.
 *
 * User margins and the printer's own unprintable border are both honoured: the
 * content box is the tighter of the two, so a layout that fits here is a layout
 * the hardware can actually put on paper.
 *
 * @param {object} input
 * @param {object} input.paper sheet, as passed to {@link orientPaper}
 * @param {boolean} input.landscape
 * @param {{left:number,top:number,right:number,bottom:number}} input.marginsPt user margins
 * @param {number} input.docWidthPx
 * @param {number} input.docHeightPx
 * @param {number} input.docDpi document resolution, used for its physical size
 * @param {"fit"|"fill"|"actual"|"custom"} input.scaleMode
 * @param {number} [input.scalePercent] used when `scaleMode` is "custom"
 * @param {boolean} input.centered
 * @param {number} [input.offsetXPt] left inset from the content box when not centred
 * @param {number} [input.offsetYPt] top inset from the content box when not centred
 * @returns {object} placement in points, measured from the sheet's top-left
 */
export function computePagePlacement(input) {
  const page = orientPaper(input.paper, input.landscape);
  const hard = page.hardMargins;
  const margins = input.marginsPt;

  const contentLeftPt = Math.max(margins.left, hard.left);
  const contentTopPt = Math.max(margins.top, hard.top);
  const contentWidthPt = Math.max(0, page.widthPt - contentLeftPt - Math.max(margins.right, hard.right));
  const contentHeightPt = Math.max(0, page.heightPt - contentTopPt - Math.max(margins.bottom, hard.bottom));

  const docDpi = input.docDpi > 0 ? input.docDpi : 72;
  const docWidthPt = (input.docWidthPx / docDpi) * POINTS_PER_INCH;
  const docHeightPt = (input.docHeightPx / docDpi) * POINTS_PER_INCH;

  let scale;
  if (input.scaleMode === "actual") {
    scale = 1;
  } else if (input.scaleMode === "custom") {
    scale = Math.max(0.01, (input.scalePercent != null ? input.scalePercent : 100) / 100);
  } else if (input.scaleMode === "fill") {
    scale = Math.max(contentWidthPt / docWidthPt, contentHeightPt / docHeightPt);
  } else {
    scale = Math.min(contentWidthPt / docWidthPt, contentHeightPt / docHeightPt);
  }
  if (!isFinite(scale) || scale <= 0) scale = 1;

  const widthPt = docWidthPt * scale;
  const heightPt = docHeightPt * scale;

  let leftPt;
  let topPt;
  if (input.centered) {
    leftPt = contentLeftPt + (contentWidthPt - widthPt) / 2;
    topPt = contentTopPt + (contentHeightPt - heightPt) / 2;
  } else {
    leftPt = contentLeftPt + (input.offsetXPt || 0);
    topPt = contentTopPt + (input.offsetYPt || 0);
  }

  return {
    pageWidthPt: page.widthPt,
    pageHeightPt: page.heightPt,
    contentLeftPt,
    contentTopPt,
    contentWidthPt,
    contentHeightPt,
    leftPt,
    topPt,
    widthPt,
    heightPt,
    scalePercent: scale * 100,
    /** Resolution the image is actually printed at, once scaled onto the sheet. */
    effectiveDpi: widthPt > 0 ? input.docWidthPx / (widthPt / POINTS_PER_INCH) : 0,
    /** True when the placed image runs past the printable area on any side. */
    overflows:
      widthPt - contentWidthPt > 0.5 ||
      heightPt - contentHeightPt > 0.5 ||
      leftPt < contentLeftPt - 0.5 ||
      topPt < contentTopPt - 0.5,
  };
}

/**
 * Build the one-page PDF for a placement.
 *
 * The page's media box is the sheet, and the image goes in at the placement
 * rectangle. Both this and the print backends speak PDF, so this is the only
 * page format the app produces for printing.
 *
 * `imageBytes` is either the document's own RGBA composite — in which case the
 * writer derives a soft mask from its alpha — or JPEG bytes for a document
 * {@link shouldCompressPage} rules too large to send uncompressed.
 *
 * @param {object} placement result of {@link computePagePlacement}
 * @param {Uint8Array} imageBytes RGBA composite, or encoded JPEG
 * @param {number} imageWidthPx
 * @param {number} imageHeightPx
 * @returns {Uint8Array} PDF bytes
 */
export function buildPagePdf(placement, imageBytes, imageWidthPx, imageHeightPx) {
  const pageWidthPt = placement.pageWidthPt;
  const pageHeightPt = placement.pageHeightPt;

  const writer = new ToPDF();
  writer.StartPage(0, 0, pageWidthPt, pageHeightPt);
  const state = UDOC.getState([[0, 0, pageWidthPt, pageHeightPt]]);

  // PDF places an image by mapping it onto the unit square, with the first
  // sample row along the square's top edge. Scaling by the placement size and
  // translating to its bottom-left corner therefore lands the image upright;
  // PDF measures y upward from the foot of the sheet, so the top inset is
  // taken off the sheet height.
  state.ctm = [
    placement.widthPt,
    0,
    0,
    placement.heightPt,
    placement.leftPt,
    pageHeightPt - placement.topPt - placement.heightPt,
  ];
  writer.PutImage(state, imageBytes, imageWidthPx, imageHeightPx);

  writer.ShowPage();
  writer.Done();
  return new Uint8Array(writer.buffer);
}
