/**
 * Glyphs panel: browse every glyph in a font and insert it into a text layer.
 *
 * The panel carries its own font picker (a FontComboBox reduced to its family
 * input) so switching fonts here also switches the active text style. Glyphs
 * are painted into paginated canvas sheets — `rowsPerPage` rows of `columns`
 * cells — handed to a MenuList as grid cells. UNICODE_BLOCKS drives the
 * category dropdown; each block after "All Glyphs" lists inclusive paired
 * codepoint ranges.
 *
 * Clicking a cell inserts the glyph's lowest mapped codepoint as text. Glyphs
 * with no codepoint (OpenType alternates and ligatures reachable only through
 * feature substitution) are inserted as an AlternateGlyphRun override instead.
 */

import { ToolId } from "../../document/model/tool-base.js";
import { BaseTool } from "../widgets/base-tool.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { FontComboBox } from "../widgets/controls/font-controls.js";
import { Button, MenuList } from "../widgets/form-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { AppEvent, EventType } from "../../core/event-bus.js";
import { getDevicePixelRatio, getEventPos, isInDOM, makeElement } from "../../core/dom.js";
import { boundsFromCoordPairs } from "../../engine/compositing/anti-alias.js";

/** Highest codepoint Unicode defines; caps cmap coverage scans. */
const MAX_CODE_POINT = 0x10ffff;
/** Target cell edge in CSS pixels, and the range the zoom buttons walk. */
const DEFAULT_CELL_CSS = 45;
const MIN_CELL_CSS = 20;
const MAX_CELL_CSS = 100;
const CELL_ZOOM_STEP = 1.2;
/** Sheet rows kept in one MenuList cell. */
const ROWS_PER_PAGE = 4;
/** Panel width minus the grid's own margins, and header height above the grid. */
const PANEL_SIDE_PADDING_CSS = 13;
const GRID_CHROME_HEIGHT_CSS = 73;
const MIN_ATLAS_WIDTH_CSS = 120;
const DEFAULT_ATLAS_WIDTH_CSS = 290;
/** Fraction of the cell a glyph's em-box occupies, and its baseline offset. */
const GLYPH_FILL_RATIO = 0.8;
/** Half-height of the bar drawn across a glyph that has no outline, in font units. */
const BLANK_GLYPH_BAR_UNITS = 170;
/** How far outside the scroll viewport a sheet is painted ahead of time. */
const SHEET_PREPAINT_MARGIN = "400px";

function GlyphsPanel() {
  BaseTool.call(this, "panels.glyphs", false, getIconUrl("panels/glyphs"), BaseTool.PanelId.GLYPHS, true);
  this.doc = null;
  this.fontBox = null;
  this.currentFontFace = null;
  this.glyphsByBlock = null;
  this.glyphMeta = null;
  this.atlasWidthCss = DEFAULT_ATLAS_WIDTH_CSS;
  this.panelWidthCss = -1;
  this.cellTargetCss = DEFAULT_CELL_CSS;
  this.rowsPerPage = ROWS_PER_PAGE;
  this.sheetObserver = null;
  this.onFontLoaded = null;
}
GlyphsPanel.prototype = Object.create(BaseTool.prototype);

/**
 * Unicode block filters for the dropdown. The first entry (no ranges) is
 * "All Glyphs". Later entries use inclusive paired codepoint ranges.
 */
GlyphsPanel.UNICODE_BLOCKS = [{
  label: "All Glyphs"
}, {
  label: "Basic Latin, Latin 1",
  codePointRanges: [0, 127, 128, 143]
}, {
  label: "Latin Extended-A",
  codePointRanges: [256, 383]
}, {
  label: "Latin Extended-B",
  codePointRanges: [384, 591]
}, {
  label: "Punctuations",
  codePointRanges: [33, 35, 37, 39, 42, 42, 44, 44, 46, 47, 58, 59, 63, 63, 64, 64, 92, 92, 161, 161, 167, 167, 182, 183, 191, 191, 894, 894, 903, 903, 1370, 1375, 1417, 1417, 8192, 8303, 11776, 11903]
}, {
  label: "Greek",
  codePointRanges: [880, 1023]
}, {
  label: "Cyrillic",
  codePointRanges: [1024, 1279]
}, {
  label: "Hebrew",
  codePointRanges: [1424, 1535]
}, {
  label: "Arabic",
  codePointRanges: [1536, 1791]
}, {
  label: "Emoji",
  codePointRanges: [9728, 10095, 127744, 129535]
}];

/** Cells across one sheet at the current zoom. */
GlyphsPanel.prototype.getColumnCount = function() {
  return Math.max(1, Math.floor(this.atlasWidthCss / this.cellTargetCss))
};

/** Cell edge in device pixels, so the sheet fills the panel width exactly. */
GlyphsPanel.prototype.getCellSizePx = function() {
  return Math.max(1, Math.floor(this.atlasWidthCss * getDevicePixelRatio() / this.getColumnCount()))
};

GlyphsPanel.prototype.buildFormLayout = function() {
  this.fontBox = new FontComboBox();
  this.fontBox.parent = this;
  this.blockDropdown = new Dropdown(null, blockDropdownLabels(null));
  this.blockDropdown.on(EventType.widgetSelect, this.redraw, this);
  this.zoomOutBtn = new Button("-", null, null, true);
  this.zoomOutBtn.on("click", this.onZoomClick, this);
  this.zoomInBtn = new Button("+", null, null, true);
  this.zoomInBtn.on("click", this.onZoomClick, this);
  this.menuList = new MenuList(false);
  this.menuList.on(EventType.widgetSelect, this.onGlyphSelect, this);
  this.gridWrapper = makeElement("div", "form padded");
  this.gridWrapper.setAttribute("style", "width:" + this.atlasWidthCss + "px;");
  this.panelBody.appendChild(this.gridWrapper);
  this.gridWrapper.appendChild(this.fontBox.fontNameInput.el);
  this.gridWrapper.appendChild(makeElement("hr"));
  this.gridWrapper.appendChild(this.blockDropdown.el);
  this.gridWrapper.appendChild(this.zoomOutBtn.el);
  this.gridWrapper.appendChild(this.zoomInBtn.el);
  this.panelBody.appendChild(this.menuList.el);
  this.menuList.el.style.height = "20em"
};

GlyphsPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  if (this.fontBox) this.fontBox.buildUI();
  if (this.onFontLoaded == null) {
    // System fonts are read from disk asynchronously, so the face backing the
    // active text style is usually still parsing on the first onUpdate.
    this.onFontLoaded = this.syncFontFace.bind(this);
    window.addEventListener("photosuite:font-loaded", this.onFontLoaded)
  }
};

GlyphsPanel.prototype.refresh = function() {
  this.onUpdate(this.doc)
};

GlyphsPanel.prototype.onUpdate = function(doc, _popupType) {
  if (doc) this.doc = doc;
  if (this.doc == null || !isInDOM(this.panelBody)) return;
  if (this.fontBox == null) {
    this.buildFormLayout();
    this.fontBox.buildUI()
  }
  this.fontBox.setValue(this.doc.currentTextStyle, this.doc.fontRegistry, this.doc.favoriteFontFamilies);
  this.syncFontFace()
};

/**
 * Re-read the active text style's font and rebuild the glyph tables when the
 * face behind it changes.
 */
GlyphsPanel.prototype.syncFontFace = function() {
  const doc = this.doc;
  if (doc == null || this.fontBox == null || !isInDOM(this.panelBody)) return;
  const textStyleSnapshot = doc.currentTextStyle,
    fontIdx = textStyleSnapshot.textStyle.Font;
  if (fontIdx == null) return;
  const fontFace = doc.fontRegistry.loadFontFace(textStyleSnapshot.fontSet[fontIdx].Name);
  // While a face is still loading the registry answers with null, or with
  // whichever face is already resident. Keying on the face we were actually
  // handed — rather than on the name we asked for — lets the panel settle onto
  // the real font once photosuite:font-loaded fires.
  if (fontFace == null || fontFace == this.currentFontFace) return;
  this.currentFontFace = fontFace;
  this.glyphMeta = buildGlyphMeta(fontFace);
  this.glyphsByBlock = assignGlyphsToUnicodeBlocks(this.glyphMeta, fontFace.maxp.numGlyphs);
  const selectedBlock = this.blockDropdown.getValue();
  this.blockDropdown.setItems(blockDropdownLabels(this.glyphsByBlock));
  this.blockDropdown.setValue(selectedBlock);
  this.redraw()
};

GlyphsPanel.prototype.resize = function(width, height) {
  if (this.fontBox == null) return;
  this.menuList.el.style.height = Math.max(0, height - GRID_CHROME_HEIGHT_CSS) + "px";
  if (this.panelWidthCss == width) return;
  this.panelWidthCss = width;
  this.atlasWidthCss = Math.max(MIN_ATLAS_WIDTH_CSS, width - PANEL_SIDE_PADDING_CSS);
  this.gridWrapper.setAttribute("style", "width:" + this.atlasWidthCss + "px;");
  this.redraw()
};

GlyphsPanel.prototype.onZoomClick = function(clickEvent) {
  const zoomIn = clickEvent.target == this.zoomInBtn;
  this.cellTargetCss = clampCellSize(this.cellTargetCss * (zoomIn ? CELL_ZOOM_STEP : 1 / CELL_ZOOM_STEP));
  this.redraw()
};

GlyphsPanel.prototype.redraw = function(_changeEvent) {
  if (this.fontBox == null || this.glyphsByBlock == null) return;
  const glyphsInBlock = this.glyphsByBlock[this.blockDropdown.getValue()],
    columns = this.getColumnCount(),
    cellSizePx = this.getCellSizePx(),
    sheets = buildGlyphSheets(this, glyphsInBlock, columns, cellSizePx);
  this.menuList.setThumbnailGrid(sheets, null, cellSizePx * columns, cellSizePx * this.rowsPerPage);
  this.watchSheetVisibility(sheets)
};

/**
 * Paint sheets only while they are near the viewport, and drop their backing
 * store once they scroll away. A CJK face has tens of thousands of glyphs, so
 * "All Glyphs" runs to hundreds of sheets — painting them all up front would
 * hold gigabytes of canvas.
 */
GlyphsPanel.prototype.watchSheetVisibility = function(sheets) {
  if (this.sheetObserver) this.sheetObserver.disconnect();
  if (typeof IntersectionObserver != "function") {
    for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) paintSheet(sheets[sheetIdx]);
    return
  }
  if (this.sheetObserver == null) {
    this.sheetObserver = new IntersectionObserver(function(entries) {
      for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
        const entry = entries[entryIdx];
        if (entry.isIntersecting) paintSheet(entry.target);
        else discardSheet(entry.target)
      }
    }, { root: this.menuList.el, rootMargin: SHEET_PREPAINT_MARGIN });
  }
  // The first sheet is always on screen; painting it here fills the grid even
  // before the observer's first callback.
  if (sheets.length) paintSheet(sheets[0]);
  for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) this.sheetObserver.observe(sheets[sheetIdx])
};

/** Insert the glyph under the last click into the text layer being edited. */
GlyphsPanel.prototype.onGlyphSelect = function(_selectEvent) {
  if (this.glyphsByBlock == null) return;
  const glyphsInBlock = this.glyphsByBlock[this.blockDropdown.getValue()],
    gridIndex = this.resolveGridIndex(this.menuList.getValue(), this.menuList.getLastMousePosition());
  if (gridIndex < 0 || gridIndex >= glyphsInBlock.length) return;
  const glyphId = glyphsInBlock[gridIndex],
    codePoints = this.glyphMeta[glyphId].codePoints,
    insertEvent = new AppEvent(EventType.documentAction, true);
  insertEvent.routingChannel = ToolId.TOOL_TYPE;
  insertEvent.data = codePoints.length == 0
    ? { actionKind: "insertGlyph", insertGlyphId: glyphId }
    : { actionKind: "insertText", insertText: String.fromCodePoint(codePoints[0]) };
  this.dispatch(insertEvent)
};

/**
 * Flat index into the active block's glyph list for a point on one sheet.
 * @param {number} sheetIndex MenuList cell the point landed in.
 * @param {{x: number, y: number}} pointCss Position within that sheet.
 * @returns {number} Glyph list index, or -1 outside the grid.
 */
GlyphsPanel.prototype.resolveGridIndex = function(sheetIndex, pointCss) {
  if (sheetIndex < 0) return -1;
  const columns = this.getColumnCount(),
    cellCss = this.getCellSizePx() / getDevicePixelRatio(),
    column = Math.floor(pointCss.x / cellCss),
    row = Math.floor(pointCss.y / cellCss);
  if (column < 0 || column >= columns || row < 0 || row >= this.rowsPerPage) return -1;
  return (sheetIndex * this.rowsPerPage + row) * columns + column
};

export { GlyphsPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Keep the zoom target whole, so stepping in and out returns to where it was. */
function clampCellSize(cellCss) {
  return Math.max(MIN_CELL_CSS, Math.min(MAX_CELL_CSS, Math.round(cellCss)))
}

function blockDropdownLabels(glyphsByBlock) {
  const blocks = GlyphsPanel.UNICODE_BLOCKS,
    labels = [];
  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    labels.push(glyphsByBlock == null
      ? blocks[blockIdx].label
      : blocks[blockIdx].label + " (" + glyphsByBlock[blockIdx].length + ")")
  }
  return labels
}

/**
 * Codepoint ranges the font's active cmap subtable actually covers, as
 * inclusive pairs. Walking these instead of every codepoint in Unicode keeps
 * the reverse map cheap enough to rebuild on each font change.
 * @returns {number[]|null} Paired ranges, or null when the subtable shape is unknown.
 */
function cmapCoverageRanges(fontFace) {
  try {
    // Selects and caches the subtable Typr will use for this face.
    Typr.U.codeToGlyph(fontFace, 65)
  } catch (_) {
    return null
  }
  const table = fontFace._ctab;
  if (table == null) return null;
  const ranges = [];
  if (table.format == 0) ranges.push(0, table.map.length - 1);
  else if (table.format == 4) {
    for (let rangeIdx = 0; rangeIdx < table.endCount.length; rangeIdx++) {
      ranges.push(table.startCount[rangeIdx], table.endCount[rangeIdx])
    }
  } else if (table.format == 6) ranges.push(table.firstCode, table.firstCode + table.glyphIdArray.length - 1);
  else if (table.format == 12) {
    for (let groupIdx = 0; groupIdx + 2 < table.groups.length; groupIdx += 3) {
      ranges.push(table.groups[groupIdx], table.groups[groupIdx + 1])
    }
  } else return null;
  return ranges
}

/**
 * Glyph id -> codepoints that map to it, by inverting the font's cmap.
 * @returns {{codePoints: number[]}[]} One entry per glyph id, ascending codepoints.
 */
function buildGlyphMeta(fontFace) {
  const numGlyphs = fontFace.maxp.numGlyphs,
    meta = new Array(numGlyphs);
  for (let glyphId = 0; glyphId < numGlyphs; glyphId++) meta[glyphId] = { codePoints: [] };
  // Fall back to the Basic Multilingual Plane when the subtable shape is one
  // Typr reads but this file does not enumerate.
  const ranges = cmapCoverageRanges(fontFace) || [0, 0xffff];
  for (let rangeIdx = 0; rangeIdx < ranges.length; rangeIdx += 2) {
    const lastCode = Math.min(ranges[rangeIdx + 1], MAX_CODE_POINT);
    for (let code = Math.max(0, ranges[rangeIdx]); code <= lastCode; code++) {
      const glyphId = Typr.U.codeToGlyph(fontFace, code);
      if (glyphId != 0 && glyphId < numGlyphs) meta[glyphId].codePoints.push(code)
    }
  }
  return meta
}

/**
 * Bucket every glyph into the dropdown's blocks by its lowest codepoint.
 * Block 0 ("All Glyphs") holds every glyph except .notdef.
 */
function assignGlyphsToUnicodeBlocks(meta, numGlyphs) {
  const blocks = GlyphsPanel.UNICODE_BLOCKS,
    glyphsByBlock = [];
  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) glyphsByBlock.push([]);
  for (let glyphId = 1; glyphId < numGlyphs; glyphId++) {
    glyphsByBlock[0].push(glyphId);
    const firstCode = meta[glyphId].codePoints[0];
    if (firstCode == null) continue;
    for (let blockIdx = 1; blockIdx < blocks.length; blockIdx++) {
      const ranges = blocks[blockIdx].codePointRanges;
      for (let rangeIdx = 0; rangeIdx < ranges.length; rangeIdx += 2)
        if (ranges[rangeIdx] <= firstCode && firstCode <= ranges[rangeIdx + 1]) {
          glyphsByBlock[blockIdx].push(glyphId);
          break
        }
    }
  }
  return glyphsByBlock
}

/**
 * One canvas per MenuList cell, sized in CSS by the MenuList but left with an
 * empty backing store until {@link paintSheet} is asked for it.
 * @returns {HTMLCanvasElement[]} Sheets in reading order.
 */
function buildGlyphSheets(panel, glyphsInBlock, columns, cellSizePx) {
  const fontFace = panel.currentFontFace,
    rowsPerPage = panel.rowsPerPage,
    rowCount = Math.ceil(glyphsInBlock.length / columns),
    sheets = [];
  for (let firstRow = 0; firstRow < rowCount; firstRow += rowsPerPage) {
    const canvas = makeElement("canvas");
    canvas.width = 0;
    canvas.height = 0;
    sheetPaintJobs.set(canvas, {
      fontFace: fontFace,
      glyphMeta: panel.glyphMeta,
      glyphsInBlock: glyphsInBlock,
      firstRow: firstRow,
      columns: columns,
      rowsPerPage: rowsPerPage,
      cellSizePx: cellSizePx,
      unitScale: cellSizePx * GLYPH_FILL_RATIO / fontFace.head.unitsPerEm
    });
    installGlyphCellTooltip(canvas);
    sheets.push(canvas)
  }
  return sheets
}

/** What each sheet needs in order to paint itself when it comes into view. */
const sheetPaintJobs = new WeakMap();

function paintSheet(canvas) {
  const job = sheetPaintJobs.get(canvas);
  if (job == null || canvas.width != 0) return;
  const columns = job.columns,
    rowsPerPage = job.rowsPerPage,
    cellSizePx = job.cellSizePx;
  canvas.width = cellSizePx * columns;
  canvas.height = cellSizePx * rowsPerPage;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, columns * cellSizePx, rowsPerPage * cellSizePx);
  for (let row = 0; row < rowsPerPage; row++) {
    for (let column = 0; column < columns; column++) {
      const glyphId = job.glyphsInBlock[(job.firstRow + row) * columns + column];
      if (glyphId == null) break;
      paintGlyphCell(ctx, job.fontFace, glyphId, column, row, cellSizePx, job.unitScale)
    }
  }
  strokeGlyphGrid(ctx, columns, rowsPerPage, cellSizePx)
}

/** Release a scrolled-away sheet's pixels; its CSS size keeps the layout put. */
function discardSheet(canvas) {
  if (sheetPaintJobs.has(canvas)) {
    canvas.width = 0;
    canvas.height = 0
  }
}

/**
 * Draw one glyph centred in its cell, sitting on a baseline at
 * GLYPH_FILL_RATIO of the cell height. Glyphs with no outline — spaces and
 * the control characters a cmap still maps — are shown as an outlined bar
 * spanning their advance width so the cell stays visible and clickable.
 */
function paintGlyphCell(ctx, fontFace, glyphId, column, row, cellSizePx, unitScale) {
  let glyphPath = Typr.U.glyphToPath(fontFace, glyphId);
  const bounds = boundsFromCoordPairs(glyphPath.crds),
    isBlank = bounds.isEmpty();
  if (isBlank) {
    const advanceWidth = glyphAdvanceWidth(fontFace, glyphId);
    glyphPath = {
      cmds: ["M", "L", "M", "L", "M", "L"],
      crds: [
        0, 0, advanceWidth, 0,
        0, -BLANK_GLYPH_BAR_UNITS, 0, BLANK_GLYPH_BAR_UNITS,
        advanceWidth, -BLANK_GLYPH_BAR_UNITS, advanceWidth, BLANK_GLYPH_BAR_UNITS
      ]
    };
    bounds.x = 0;
    bounds.width = advanceWidth;
    ctx.strokeStyle = "rgba(0,192,0,1)"
  } else ctx.fillStyle = "#252525";
  ctx.beginPath();
  const translateX = column * cellSizePx + (cellSizePx - bounds.width * unitScale) * .5 - bounds.x * unitScale,
    translateY = row * cellSizePx + cellSizePx * GLYPH_FILL_RATIO;
  ctx.translate(translateX, translateY);
  ctx.scale(unitScale, -unitScale);
  Typr.U.pathToContext(glyphPath, ctx);
  ctx.scale(1 / unitScale, -1 / unitScale);
  ctx.translate(-translateX, -translateY);
  if (isBlank) ctx.stroke();
  else ctx.fill()
}

/** Advance width in font units. */
function glyphAdvanceWidth(fontFace, glyphId) {
  const hmtx = fontFace.hmtx;
  if (hmtx == null || hmtx.aWidth[glyphId] == null) return 0;
  return hmtx.aWidth[glyphId]
}

function strokeGlyphGrid(ctx, columns, rowsPerPage, cellSizePx) {
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  for (let column = 0; column < columns; column++) {
    const x = column * cellSizePx + cellSizePx + .5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cellSizePx * rowsPerPage)
  }
  for (let row = 0; row < rowsPerPage; row++) {
    const y = row * cellSizePx + cellSizePx + .5;
    ctx.moveTo(0, y);
    ctx.lineTo(columns * cellSizePx, y)
  }
  ctx.stroke()
}

/** Report the glyph id, character, and codepoint under the pointer. */
function installGlyphCellTooltip(canvas) {
  canvas.addEventListener("mousemove", function(moveEvent) {
    const job = sheetPaintJobs.get(canvas);
    if (job == null) return;
    const cellCss = job.cellSizePx / getDevicePixelRatio(),
      point = getEventPos(moveEvent, canvas),
      column = Math.floor(point.x / cellCss),
      row = Math.floor(point.y / cellCss);
    let title = "";
    if (column >= 0 && column < job.columns && row >= 0 && row < job.rowsPerPage) {
      const glyphId = job.glyphsInBlock[(job.firstRow + row) * job.columns + column];
      if (glyphId != null) title = describeGlyph(job.glyphMeta, glyphId)
    }
    if (canvas.title != title) canvas.title = title
  }, false)
}

function describeGlyph(glyphMeta, glyphId) {
  const codePoints = glyphMeta[glyphId].codePoints;
  if (codePoints.length == 0) return "Glyph: " + glyphId + "\nCharacter: ----\nUnicode: ----";
  return "Glyph: " + glyphId
    + "\nCharacter: " + String.fromCodePoint(codePoints[0])
    + "\nUnicode: #" + codePoints[0].toString(16).toUpperCase().padStart(4, "0")
}
