/**
 * Page placement for printing: how a document's physical size, the sheet, the
 * margins and the scale mode decide where the image lands on paper.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

let computePagePlacement;
let orientPaper;
let mmToPoints;
let pointsToMm;
let labelAndSortPapers;
let defaultPaperIndex;
let STANDARD_PAPERS;

before(async () => {
  ({
    computePagePlacement,
    orientPaper,
    mmToPoints,
    pointsToMm,
    labelAndSortPapers,
    defaultPaperIndex,
    STANDARD_PAPERS,
  } = await import("../../../src/features/print/print-page.js"));
});

/** Paper rows shaped the way a CUPS queue reports them. */
function cupsPaper(id, widthPt, heightPt) {
  // A CUPS queue with nothing localised answers with the keyword itself.
  return { id, name: id, widthPt, heightPt };
}

/** A4 with a 5 mm unprintable border on every side. */
const A4_WITH_BORDER = {
  id: "iso_a4",
  name: "A4",
  widthPt: 595.28,
  heightPt: 841.89,
  printableWidthPt: 595.28 - 2 * 14.17,
  printableHeightPt: 841.89 - 2 * 14.17,
  marginLeftPt: 14.17,
  marginTopPt: 14.17,
};

/** A 300 dpi document measuring 4 × 6 inches. */
const PHOTO_4X6 = { docWidthPx: 1200, docHeightPx: 1800, docDpi: 300 };

function placement(overrides) {
  return computePagePlacement({
    paper: STANDARD_PAPERS.find((paper) => paper.id === "iso_a4_210x297mm"),
    landscape: false,
    marginsPt: { left: 0, top: 0, right: 0, bottom: 0 },
    scaleMode: "fit",
    centered: true,
    ...PHOTO_4X6,
    ...overrides,
  });
}

describe("features/print/print-page.js", () => {
  it("converts between millimetres and points", () => {
    assert.equal(Math.round(mmToPoints(25.4)), 72);
    assert.equal(Math.round(pointsToMm(72)), 25);
  });

  it("swaps the sheet's sides in landscape and carries its borders round", () => {
    const portrait = orientPaper(A4_WITH_BORDER, false);
    const landscape = orientPaper(A4_WITH_BORDER, true);
    assert.equal(landscape.widthPt, portrait.heightPt);
    assert.equal(landscape.heightPt, portrait.widthPt);
    // A quarter turn clockwise makes the sheet's bottom edge the page's left.
    assert.equal(landscape.hardMargins.left, portrait.hardMargins.bottom);
    assert.equal(landscape.hardMargins.top, portrait.hardMargins.left);
  });

  it("prints at the document's own size at actual scale", () => {
    const result = placement({ scaleMode: "actual" });
    // 1200 px at 300 dpi is 4 inches, which is 288 points.
    assert.equal(Math.round(result.widthPt), 288);
    assert.equal(Math.round(result.heightPt), 432);
    assert.equal(Math.round(result.effectiveDpi), 300);
    assert.equal(result.overflows, false);
  });

  it("fits inside the margins and keeps the document's aspect ratio", () => {
    const margin = mmToPoints(10);
    const result = placement({
      marginsPt: { left: margin, top: margin, right: margin, bottom: margin },
    });
    assert.ok(result.widthPt <= result.contentWidthPt + 0.01);
    assert.ok(result.heightPt <= result.contentHeightPt + 0.01);
    // One dimension of a fitted page touches its content box exactly.
    const touchesWidth = Math.abs(result.widthPt - result.contentWidthPt) < 0.01;
    const touchesHeight = Math.abs(result.heightPt - result.contentHeightPt) < 0.01;
    assert.ok(touchesWidth || touchesHeight);
    assert.ok(Math.abs(result.widthPt / result.heightPt - 1200 / 1800) < 1e-9);
    assert.equal(result.overflows, false);
  });

  it("fills the page and reports that it runs past the printable area", () => {
    const result = placement({ scaleMode: "fill" });
    assert.ok(result.widthPt >= result.contentWidthPt - 0.01);
    assert.ok(result.heightPt >= result.contentHeightPt - 0.01);
    assert.equal(result.overflows, true);
  });

  it("centres the image in the content box", () => {
    const margin = mmToPoints(10);
    const result = placement({
      scaleMode: "actual",
      marginsPt: { left: margin, top: margin, right: margin, bottom: margin },
    });
    const leftGap = result.leftPt - result.contentLeftPt;
    const rightGap = result.contentLeftPt + result.contentWidthPt - (result.leftPt + result.widthPt);
    assert.ok(Math.abs(leftGap - rightGap) < 0.01);
  });

  it("offsets from the content box when centring is off", () => {
    const margin = mmToPoints(10);
    const result = placement({
      scaleMode: "actual",
      centered: false,
      offsetXPt: mmToPoints(5),
      offsetYPt: mmToPoints(7),
      marginsPt: { left: margin, top: margin, right: margin, bottom: margin },
    });
    assert.ok(Math.abs(result.leftPt - (result.contentLeftPt + mmToPoints(5))) < 0.01);
    assert.ok(Math.abs(result.topPt - (result.contentTopPt + mmToPoints(7))) < 0.01);
  });

  it("takes the tighter of the user margin and the printer's own border", () => {
    // A 2 mm margin is inside the sheet's 5 mm unprintable border, so the
    // hardware's border is what bounds the content.
    const result = computePagePlacement({
      paper: A4_WITH_BORDER,
      landscape: false,
      marginsPt: { left: mmToPoints(2), top: mmToPoints(2), right: mmToPoints(2), bottom: mmToPoints(2) },
      scaleMode: "fit",
      centered: true,
      ...PHOTO_4X6,
    });
    assert.ok(Math.abs(result.contentLeftPt - A4_WITH_BORDER.marginLeftPt) < 0.01);
    assert.ok(result.contentWidthPt <= A4_WITH_BORDER.printableWidthPt + 0.01);
  });

  it("halves the printed resolution when the image is scaled to twice its size", () => {
    const result = placement({ scaleMode: "custom", scalePercent: 200 });
    assert.equal(Math.round(result.effectiveDpi), 150);
    assert.equal(Math.round(result.scalePercent), 200);
  });

  it("treats a document with no stated resolution as 72 dpi", () => {
    const result = placement({ scaleMode: "actual", docDpi: 0 });
    assert.equal(Math.round(result.widthPt), 1200);
  });
});

describe("features/print/print-page.js paper names", () => {
  it("reads PWG media keywords as the sizes people know", () => {
    const named = labelAndSortPapers([
      cupsPaper("iso_a4_210x297mm", 595.28, 841.89),
      cupsPaper("na_letter_8.5x11in", 612, 792),
      cupsPaper("na_number-10_4.125x9.5in", 297, 684),
      cupsPaper("jis_b5_182x257mm", 516, 729),
      cupsPaper("iso_c6_114x162mm", 323, 459),
      cupsPaper("jpn_hagaki_100x148mm", 283.5, 419.5),
      cupsPaper("na_5x7_5x7in", 360, 504),
      cupsPaper("oe_photo-l_3.5x5in", 252, 360),
    ]);
    const byId = Object.fromEntries(named.map((paper) => [paper.id, paper.name]));
    assert.equal(byId["iso_a4_210x297mm"], "A4");
    assert.equal(byId["na_letter_8.5x11in"], "Letter");
    assert.equal(byId["na_number-10_4.125x9.5in"], "No. 10 envelope");
    // A JIS B5 is a different sheet from an ISO B5, so the region stays.
    assert.equal(byId["jis_b5_182x257mm"], "JIS B5");
    assert.equal(byId["iso_c6_114x162mm"], "C6 envelope");
    assert.equal(byId["jpn_hagaki_100x148mm"], "Hagaki");
    assert.equal(byId["na_5x7_5x7in"], "5 × 7 in");
    assert.equal(byId["oe_photo-l_3.5x5in"], "Photo L");
  });

  it("states each size in millimetres and marks borderless variants", () => {
    const [a4, borderless] = labelAndSortPapers([
      cupsPaper("iso_a4_210x297mm", 595.28, 841.89),
      cupsPaper("iso_a4_210x297mm_borderless", 595.28, 841.89),
    ]);
    assert.equal(a4.label, "A4 — 210 × 297 mm");
    assert.equal(borderless.label, "A4 — 210 × 297 mm (borderless)");
  });

  it("orders the menu alphabetically, whatever order the printer gave", () => {
    const labels = labelAndSortPapers([
      cupsPaper("na_letter_8.5x11in", 612, 792),
      cupsPaper("iso_a5_148x210mm", 419.53, 595.28),
      cupsPaper("jpn_hagaki_100x148mm", 283.5, 419.5),
      cupsPaper("iso_a4_210x297mm", 595.28, 841.89),
    ]).map((paper) => paper.name);
    assert.deepEqual(labels, ["A4", "A5", "Hagaki", "Letter"]);
  });

  it("keeps a name the platform supplies rather than parsing the keyword", () => {
    // A Windows print ticket names its sizes; the keyword is not shown.
    const [paper] = labelAndSortPapers([
      { id: "ISOA4", name: "A4", widthPt: 595.28, heightPt: 841.89 },
    ]);
    assert.equal(paper.name, "A4");
  });

  it("splits a Windows media id when the driver supplies no name", () => {
    const [paper] = labelAndSortPapers([
      { id: "NorthAmericaLetter", name: "", widthPt: 612, heightPt: 792 },
    ]);
    assert.equal(paper.name, "North America Letter");
  });

  it("starts on A4 even when the printer's own default is Letter", () => {
    const papers = labelAndSortPapers([
      cupsPaper("na_letter_8.5x11in", 612, 792),
      cupsPaper("iso_a4_210x297mm", 595.28, 841.89),
      cupsPaper("iso_a4_210x297mm_borderless", 595.28, 841.89),
    ]);
    const index = defaultPaperIndex(papers, "na_letter_8.5x11in");
    assert.equal(papers[index].id, "iso_a4_210x297mm");
  });

  it("falls back to the printer's default when it offers no A4", () => {
    const papers = labelAndSortPapers([
      cupsPaper("na_letter_8.5x11in", 612, 792),
      cupsPaper("na_legal_8.5x14in", 612, 1008),
    ]);
    const index = defaultPaperIndex(papers, "na_legal_8.5x14in");
    assert.equal(papers[index].id, "na_legal_8.5x14in");
  });

  it("offers A4 first among the standard sizes used without a printer", () => {
    const papers = labelAndSortPapers(STANDARD_PAPERS);
    assert.equal(papers[defaultPaperIndex(papers, null)].name, "A4");
  });
});
