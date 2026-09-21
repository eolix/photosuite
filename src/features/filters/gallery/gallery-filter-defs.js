// Filter Gallery definitions and rendering.
//
// Two execution paths share one descriptor format:
//   • ~33 self-contained filters run a single FilterPixelOps kernel, dispatched
//     through the KERNELS table (also read by the worker offload in
//     FilterBandRunner, so the two never drift).
//   • The remaining filters need multi-pass image processing and are implemented
//     here on top of the engine modules (see the "Complex filters" section).

import { FilterPixelOps } from './filter-pixel-ops.js';
import { PixelEngine } from './pixel-engine.js';
import { Point } from '../../../core/math/point.js';
import { devToolsBinDb } from "../../../document/formats/registry/registry-helpers.js";
import { allocBuffer, copyBuffer, extractChannelByte, fillBuffer, rgbaToGrayChannel } from "../../../engine/compositing/buffer-utils.js";
import { round } from "../../../engine/compositing/pixel-ops.js";
import { sampleBilinearWrap } from "../../../engine/compositing/homography.js";
import { RngState, composite, overF } from "../../../engine/compositing/compositing-ops.js";
import { invert } from "../../../engine/compositing/color-math.js";
import { boxBlurByte, gaussianBlurByte, gaussianBlurFloat, gaussianBlurRgba } from "../../../engine/compositing/blur.js";
import { convolveChannel3x3Raw, convolveRGBA, findEdgesRGB, normalizeKernel, setPercentileFraction, selectMaximum, selectPercentile } from "../../../engine/compositing/spatial-filters.js";
import { quantizeDithered } from "../../../engine/compositing/quantizer.js";
import { applyWarp } from "../../../engine/compositing/warp.js";

// FilterDefs and LayerStyleRenderer live in `src/features/`; `core/startup-wiring.js`
// calls installLayerSymbols once those modules have loaded.
let FilterDefs = null;
let LayerStyleRenderer = null;
function installLayerSymbols(deps) {
    FilterDefs = deps.FilterDefs;
    LayerStyleRenderer = deps.LayerStyleRenderer;
}

export const GalleryFilterDefs = {};

// ---------------------------------------------------------------------------
// Enum wire-id tables — a parameter's enum value is stored as its index here.
// ---------------------------------------------------------------------------

GalleryFilterDefs.brushTypeWireIds      = "BrSm BrsL BrDR BrsW BrbW BrSp".split(" ");
GalleryFilterDefs.lightDirectionWireIds = "LDBt LDBL LDLf LDTL LDTp LDTR LDRg LDBR".split(" ");
GalleryFilterDefs.scratchTypeWireIds    = ["ScrC", "ScrD", "ScrL"];
GalleryFilterDefs.strokeDirectionWireIds = ["SDRD", "SDHz", "SDLD", "SDVt"];
GalleryFilterDefs.textureTypeWireIds    = "TxBl TxCa TxFr TxTL TxBr TxBu TxSt".split(" ");

// A texture serves one of two purposes, and a filter offers only the set that
// matches its own: Glass refracts the image *through* a texture, so its four
// read as glass surfaces; the relief filters light a texture as a material
// surface, so theirs read as woven and mineral ones. The order here is the
// order the menu lists them in.
GalleryFilterDefs.glassTextureWireIds  = ["TxBl", "TxCa", "TxFr", "TxTL"];
GalleryFilterDefs.reliefTextureWireIds = ["TxBr", "TxBu", "TxCa", "TxSt"];

/**
 * The texture ids `filterKey` offers, in menu order.
 * @param {string} filterKey Gallery filter wire id, e.g. `"Gls"`, `"Txtz"`.
 * @returns {string[]}
 */
GalleryFilterDefs.textureWireIdsFor = function (filterKey) {
  return filterKey === "Gls"
    ? GalleryFilterDefs.glassTextureWireIds
    : GalleryFilterDefs.reliefTextureWireIds;
};
GalleryFilterDefs.grainTypeWireIds      = "GrnR GrSf GrSr GrnC GrCn GrnE GrSt GrnH GrnV GrSp".split(" ");
GalleryFilterDefs.lightPositionWireIds  = "LPBt LPBL LPLf LPTL LPTp LPTR LPRg LPBR".split(" ");

// ---------------------------------------------------------------------------
// Filter catalog
// ---------------------------------------------------------------------------

// The filter groups, in UI display order: a short id (each filter names its
// group with this) and the localization key for the group heading.
const FILTER_GROUPS = [
    { id: "artistic",     loc: "filters.gallery.groups.artistic" },
    { id: "brushStrokes", loc: "filters.gallery.groups.brushStrokes" },
    { id: "distort",      loc: "filters.gallery.groups.distort" },
    { id: "sketch",       loc: "filters.gallery.groups.sketch" },
    { id: "stylize",      loc: "filters.gallery.groups.stylise" },
    { id: "texture",      loc: "filters.gallery.groups.texture" }
];
const GROUP_INDEX = {};
FILTER_GROUPS.forEach(function (group, index) { GROUP_INDEX[group.id] = index; });
GalleryFilterDefs.filterGroupLocaleKeys = FILTER_GROUPS.map(function (group) { return group.loc; });

GalleryFilterDefs.filterClassIdAliases = { PntD: "paintDaubs" };

// Single source of truth: one entry per filter holding everything about it.
//   group                 — which group it is listed under in the UI (a
//                           FILTER_GROUPS id)
//   loc / name            — this filter's own localization key and English name
//   defaults              — starting parameters, cloned by create()
//   kernel / out / params — FilterPixelOps dispatch; present only on the
//                           single-kernel filters (the rest are handled by the
//                           engine-based functions further down). `out` is
//                           "direct" (kernel writes final RGBA) or "gray" (kernel
//                           writes a gray plane, then colorizeGrayToRgba applies
//                           fg/bg). `params(descriptor, ctx)` reads the kernel's
//                           argument array, where ctx = { fg, bg, seed, texture }.
const FILTERS = {
  ClrP: { group: "artistic", loc: "filters.gallery.colourPencil", name: "Color Pencil",
    defaults: { Pncl: { t: "long", v: 4 }, StrP: { t: "long", v: 8 }, PprB: { t: "long", v: 25 } },
    kernel: "colorPencil", out: "direct", params: function (descriptor) { return [descriptor.Pncl.v, descriptor.StrP.v, descriptor.PprB.v]; } },
  Ct: { group: "artistic", loc: "filters.gallery.cutout", name: "Cutout",
    defaults: { NmbL: { t: "long", v: 4 }, EdgS: { t: "long", v: 3 }, EdgF: { t: "long", v: 1 } },
    kernel: "cutout", out: "direct", params: function (descriptor) {
      // Persist EdgF on older descriptors that only had NmbL/EdgS.
      if (!descriptor.EdgF) descriptor.EdgF = { t: "long", v: 1 };
      return [descriptor.NmbL.v, descriptor.EdgS.v, descriptor.EdgF.v];
    } },
  DryB: { group: "artistic", loc: "filters.gallery.dryBrush", name: "Dry Brush",
    defaults: { BrsS: { t: "long", v: 4 }, BrsD: { t: "long", v: 4 }, Txtr: { t: "long", v: 2 } },
    kernel: "dryBrush", out: "direct", params: function (descriptor) { return [descriptor.BrsS.v, descriptor.BrsD.v, descriptor.Txtr.v]; } },
  FlmG: { group: "artistic", loc: "filters.gallery.filmGrain", name: "Film Grain",
    defaults: { Grn: { t: "long", v: 4 }, HghA: { t: "long", v: 0 }, Intn: { t: "long", v: 10 }, FlRs: { t: "long", v: 23068185 } },
    kernel: "filmGrain", out: "direct", params: function (descriptor, context) { return [descriptor.Grn.v, descriptor.HghA.v, descriptor.Intn.v, context.seed]; } },
  Frsc: { group: "artistic", loc: "filters.gallery.fresco", name: "Fresco",
    defaults: { BrsS: { t: "long", v: 2 }, BrsD: { t: "long", v: 8 }, Txtr: { t: "long", v: 1 } },
    kernel: "fresco", out: "direct", params: function (descriptor) { return [descriptor.BrsS.v, descriptor.BrsD.v, descriptor.Txtr.v]; } },
  NGlw: { group: "artistic", loc: "filters.gallery.neonGlow", name: "Neon Glow",
    defaults: { Sz: { t: "long", v: 5 }, Brgh: { t: "long", v: 15 }, Clr: { t: "Objc", v: { classID: "RGBC", Rd: { t: "doub", v: 0 }, Grn: { t: "doub", v: 0 }, Bl: { t: "doub", v: 255 } } } },
    kernel: "neonGlow", out: "direct", params: function (descriptor, context) {
      var glowColor = descriptor.Clr ? descriptor.Clr.v : { Rd: { v: 0 }, Grn: { v: 0 }, Bl: { v: 255 } };
      var glowColorInt = ~~glowColor.Rd.v << 24 | ~~glowColor.Grn.v << 16 | ~~glowColor.Bl.v << 8 | 255;
      return [descriptor.Sz.v, descriptor.Brgh.v, glowColorInt, context.fg, context.bg]; } },
  PntD: { group: "artistic", loc: "filters.gallery.paintDaubs", name: "Paint Daubs",
    defaults: { Sz: { t: "long", v: 10 }, Shrp: { t: "long", v: 10 }, BrsT: { t: "enum", v: { BrsT: "BrSm" } } } },
  PltK: { group: "artistic", loc: "filters.gallery.paletteKnife", name: "Palette Knife",
    defaults: { StrS: { t: "long", v: 25 }, StDt: { t: "long", v: 3 }, Sftn: { t: "long", v: 2 } },
    kernel: "paletteKnife", out: "direct", params: function (descriptor) { return [descriptor.StrS.v, descriptor.StDt.v, descriptor.Sftn.v]; } },
  PlsW: { group: "artistic", loc: "filters.gallery.plasticWrap", name: "Plastic Wrap",
    defaults: { HghS: { t: "long", v: 20 }, Dtl: { t: "long", v: 4 }, Smth: { t: "long", v: 5 } } },
  PstE: { group: "artistic", loc: "filters.gallery.posterEdges", name: "Poster Edges",
    defaults: { EdgT: { t: "long", v: 2 }, EdgI: { t: "long", v: 1 }, Pstr: { t: "long", v: 2 } },
    kernel: "posterEdges", out: "direct", params: function (descriptor) { return [descriptor.EdgT.v, descriptor.EdgI.v, descriptor.Pstr.v]; } },
  RghP: { group: "artistic", loc: "filters.gallery.roughPastels", name: "Rough Pastels",
    defaults: { StrL: { t: "long", v: 6 }, StDt: { t: "long", v: 4 }, TxtT: { t: "enum", v: { TxtT: "TxCa" } }, Scln: { t: "long", v: 100 }, Rlf: { t: "long", v: 20 }, LghD: { t: "enum", v: { LghD: "LDBt" } }, InvT: { t: "bool", v: false } },
    kernel: "roughPastels", out: "direct", params: function (descriptor, context) { return [descriptor.StrL.v, descriptor.StDt.v, context.texture, descriptor.Scln.v, descriptor.Rlf.v, GalleryFilterDefs.lightDirectionWireIds.indexOf(descriptor.LghD.v.LghD), descriptor.InvT.v]; } },
  SmdS: { group: "artistic", loc: "filters.gallery.smudgeStick", name: "Smudge Stick",
    defaults: { StrL: { t: "long", v: 2 }, HghA: { t: "long", v: 0 }, Intn: { t: "long", v: 10 }, FlRs: { t: "long", v: 6399750 } },
    kernel: "smudgeStick", out: "direct", params: function (descriptor, context) { return [descriptor.StrL.v, descriptor.HghA.v, descriptor.Intn.v, descriptor.FlRs ? descriptor.FlRs.v : 0, context.seed]; } },
  Spng: { group: "artistic", loc: "filters.gallery.sponge", name: "Sponge",
    defaults: { BrsS: { t: "long", v: 2 }, Dfnt: { t: "long", v: 12 }, Smth: { t: "long", v: 5 }, FlRs: { t: "long", v: 218877241 } },
    kernel: "sponge", out: "direct", params: function (descriptor, context) { return [descriptor.BrsS.v, descriptor.Dfnt.v, descriptor.Smth.v, descriptor.FlRs ? descriptor.FlRs.v : 0, context.seed]; } },
  Undr: { group: "artistic", loc: "filters.gallery.underpainting", name: "Underpainting",
    defaults: { BrsS: { t: "long", v: 6 }, TxtC: { t: "long", v: 16 }, TxtT: { t: "enum", v: { TxtT: "TxCa" } }, Scln: { t: "long", v: 100 }, Rlf: { t: "long", v: 4 }, LghD: { t: "enum", v: { LghD: "LDTp" } }, InvT: { t: "bool", v: false } },
    kernel: "underpainting", out: "direct", params: function (descriptor, context) { return [descriptor.BrsS.v, descriptor.TxtC.v, context.texture, descriptor.Scln.v, descriptor.Rlf.v, GalleryFilterDefs.lightDirectionWireIds.indexOf(descriptor.LghD.v.LghD), descriptor.InvT.v]; } },
  Wtrc: { group: "artistic", loc: "filters.gallery.watercolor", name: "Watercolor",
    defaults: { BrsD: { t: "long", v: 9 }, ShdI: { t: "long", v: 1 }, Txtr: { t: "long", v: 3 } },
    kernel: "watercolor", out: "direct", params: function (descriptor) { return [descriptor.BrsD.v, descriptor.ShdI.v, descriptor.Txtr.v]; } },
  AccE: { group: "brushStrokes", loc: "filters.gallery.accentedEdges", name: "Accented Edges",
    defaults: { EdgW: { t: "long", v: 2 }, EdgB: { t: "long", v: 38 }, Smth: { t: "long", v: 5 } },
    kernel: "accentedEdges", out: "direct", params: function (descriptor) { return [descriptor.EdgW.v, descriptor.EdgB.v, descriptor.Smth.v]; } },
  AngS: { group: "brushStrokes", loc: "filters.gallery.angledStrokes", name: "Angled Strokes",
    defaults: { DrcB: { t: "long", v: 50 }, StrL: { t: "long", v: 15 }, Shrp: { t: "long", v: 3 } },
    kernel: "angledStrokes", out: "direct", params: function (descriptor) { return [descriptor.DrcB.v, descriptor.StrL.v, descriptor.Shrp.v]; } },
  Crsh: { group: "brushStrokes", loc: "filters.gallery.crosshatch", name: "Crosshatch",
    defaults: { StrL: { t: "long", v: 9 }, Shrp: { t: "long", v: 6 }, Strg: { t: "long", v: 1 } },
    kernel: "crosshatch", out: "direct", params: function (descriptor) { return [descriptor.StrL.v, descriptor.Shrp.v, descriptor.Strg.v]; } },
  DrkS: { group: "brushStrokes", loc: "filters.gallery.darkStrokes", name: "Dark Strokes",
    defaults: { Blnc: { t: "long", v: 5 }, BlcI: { t: "long", v: 6 }, WhtI: { t: "long", v: 2 } },
    kernel: "darkStrokes", out: "direct", params: function (descriptor) { return [descriptor.Blnc.v, descriptor.BlcI.v, descriptor.WhtI.v]; } },
  InkO: { group: "brushStrokes", loc: "filters.gallery.inkOutlines", name: "Ink Outlines",
    defaults: { StrL: { t: "long", v: 4 }, DrkI: { t: "long", v: 20 }, LghI: { t: "long", v: 10 } },
    kernel: "inkOutlines", out: "direct", params: function (descriptor) { return [descriptor.StrL.v, descriptor.DrkI.v, descriptor.LghI.v]; } },
  Spt: { group: "brushStrokes", loc: "filters.gallery.spatter", name: "Spatter",
    defaults: { SprR: { t: "long", v: 10 }, Smth: { t: "long", v: 5 }, FlRs: { t: "long", v: 10738420 } } },
  SprS: { group: "brushStrokes", loc: "filters.gallery.sprayedStrokes", name: "Sprayed Strokes",
    defaults: { StrL: { t: "long", v: 12 }, SprR: { t: "long", v: 7 }, SDir: { t: "enum", v: { StrD: "SDRD" } }, FlRs: { t: "long", v: 893120664 } } },
  Smie: { group: "brushStrokes", loc: "filters.gallery.sumi", name: "Sumié",
    defaults: { StrW: { t: "long", v: 10 }, StrP: { t: "long", v: 5 }, Cntr: { t: "long", v: 16 } },
    kernel: "sumie", out: "direct", params: function (descriptor) { return [descriptor.StrW.v, descriptor.StrP.v, descriptor.Cntr.v]; } },
  DfsG: { group: "distort", loc: "filters.gallery.diffuseGlow", name: "Diffuse Glow",
    defaults: { Grns: { t: "long", v: 6 }, GlwA: { t: "long", v: 10 }, ClrA: { t: "long", v: 15 }, FlRs: { t: "long", v: 325892160 } },
    kernel: "diffuseGlow", out: "direct", params: function (descriptor, context) { return [descriptor.Grns.v, descriptor.GlwA.v, descriptor.ClrA.v, context.bg, context.seed]; } },
  Gls: { group: "distort", loc: "filters.gallery.glass", name: "Glass",
    defaults: { Dstr: { t: "long", v: 3 }, Smth: { t: "long", v: 1 }, TxtT: { t: "enum", v: { TxtT: "TxTL" } }, Scln: { t: "long", v: 100 }, InvT: { t: "bool", v: false } } },
  OcnR: { group: "distort", loc: "filters.gallery.oceanRipple", name: "Ocean Ripple",
    defaults: { RplS: { t: "long", v: 5 }, RplM: { t: "long", v: 15 }, FlRs: { t: "long", v: 64008840 } } },
  BsRl: { group: "sketch", loc: "filters.gallery.basRelief", name: "Bas Relief",
    defaults: { Dtl: { t: "long", v: 11 }, Smth: { t: "long", v: 7 }, LghD: { t: "enum", v: { LghD: "LDBt" } } } },
  ChlC: { group: "sketch", loc: "filters.gallery.chalkCharcoal", name: "Chalk & Charcoal",
    defaults: { ChrA: { t: "long", v: 6 }, ChlA: { t: "long", v: 6 }, StrP: { t: "long", v: 1 }, FlRs: { t: "long", v: 314004633 } },
    kernel: "chalkCharcoal", out: "direct", params: function (descriptor, context) { return [descriptor.ChrA.v, descriptor.ChlA.v, descriptor.StrP.v, context.seed, context.bg, context.fg]; } },
  Chrc: { group: "sketch", loc: "filters.gallery.charcoal", name: "Charcoal",
    defaults: { ChAm: { t: "long", v: 1 }, Dtl: { t: "long", v: 5 }, LgDr: { t: "long", v: 50 }, GELv: { t: "bool", v: true } },
    kernel: "charcoal", out: "gray", params: function (descriptor) { return [descriptor.ChAm.v, descriptor.Dtl.v, descriptor.LgDr.v]; } },
  Chrm: { group: "sketch", loc: "filters.gallery.chrome", name: "Chrome",
    defaults: { Dtl: { t: "long", v: 4 }, Smth: { t: "long", v: 4 } } },
  CntC: { group: "sketch", loc: "filters.gallery.contCrayon", name: "Conté Crayon",
    defaults: { FrgL: { t: "long", v: 11 }, BckL: { t: "long", v: 7 }, TxtT: { t: "enum", v: { TxtT: "TxCa" } }, Scln: { t: "long", v: 100 }, Rlf: { t: "long", v: 4 }, LghD: { t: "enum", v: { LghD: "LDTp" } }, InvT: { t: "bool", v: false } },
    kernel: "conteCreyon", out: "direct", params: function (descriptor, context) { return [descriptor.FrgL.v, descriptor.BckL.v, context.texture, descriptor.Scln.v, descriptor.Rlf.v, GalleryFilterDefs.lightDirectionWireIds.indexOf(descriptor.LghD.v.LghD), descriptor.InvT.v, context.bg, context.fg]; } },
  GraP: { group: "sketch", loc: "filters.gallery.graphicPen", name: "Graphic Pen",
    defaults: { StrL: { t: "long", v: 7 }, LgDr: { t: "long", v: 50 }, SDir: { t: "enum", v: { StrD: "SDRD" } }, FlRs: { t: "long", v: 55993248 } },
    kernel: "graphicPen", out: "gray", params: function (descriptor, context) { return [descriptor.StrL.v, descriptor.LgDr.v, GalleryFilterDefs.strokeDirectionWireIds.indexOf(descriptor.SDir.v.StrD), context.seed]; } },
  HlfS: { group: "sketch", loc: "filters.gallery.halftonePattern", name: "Halftone Pattern",
    defaults: { HlSz: { t: "long", v: 1 }, Cntr: { t: "long", v: 5 }, ScrT: { t: "enum", v: { ScrT: "ScrD" } } } },
  NtPr: { group: "sketch", loc: "filters.gallery.notePaper", name: "Note Paper",
    defaults: { ImgB: { t: "long", v: 25 }, Grns: { t: "long", v: 10 }, Rlf: { t: "long", v: 11 }, FlRs: { t: "long", v: 52642770 } },
    kernel: "notePaper", out: "direct", params: function (descriptor, context) { return [descriptor.ImgB.v, descriptor.Grns.v, descriptor.Rlf.v, context.fg, context.bg, context.seed]; } },
  Phtc: { group: "sketch", loc: "filters.gallery.photocopy", name: "Photocopy",
    defaults: { Dtl: { t: "long", v: 10 }, Drkn: { t: "long", v: 4 } } },
  Plst: { group: "sketch", loc: "filters.gallery.plaster", name: "Plaster",
    defaults: { ImgB: { t: "long", v: 20 }, Smth: { t: "long", v: 2 }, LghP: { t: "enum", v: { LghP: "LPTp" } } },
    kernel: "plaster", out: "gray", params: function (descriptor) { return [descriptor.ImgB.v, GalleryFilterDefs.lightPositionWireIds.indexOf(descriptor.LghP.v.LghP), descriptor.Smth.v]; } },
  Rtcl: { group: "sketch", loc: "filters.gallery.reticulation", name: "Reticulation",
    defaults: { Dnst: { t: "long", v: 12 }, BlcL: { t: "long", v: 40 }, WhtL: { t: "long", v: 5 }, FlRs: { t: "long", v: 301835400 } },
    kernel: "reticulation", out: "gray", params: function (descriptor, context) { return [descriptor.Dnst.v, descriptor.BlcL.v, descriptor.WhtL.v, context.seed]; } },
  Stmp: { group: "sketch", loc: "filters.gallery.stamp", name: "Stamp",
    defaults: { LgDr: { t: "long", v: 25 }, Smth: { t: "long", v: 4 } },
    kernel: "stamp", out: "gray", params: function (descriptor) { return [descriptor.LgDr.v, descriptor.Smth.v]; } },
  TrnE: { group: "sketch", loc: "filters.gallery.tornEdges", name: "Torn Edges",
    defaults: { ImgB: { t: "long", v: 25 }, Smth: { t: "long", v: 11 }, Cntr: { t: "long", v: 17 }, FlRs: { t: "long", v: 461109340 } },
    kernel: "tornEdges", out: "gray", params: function (descriptor, context) { return [descriptor.ImgB.v, descriptor.Smth.v, descriptor.Cntr.v, context.seed]; } },
  WtrP: { group: "sketch", loc: "filters.gallery.waterPaper", name: "Water Paper",
    defaults: { FbrL: { t: "long", v: 15 }, Brgh: { t: "long", v: 60 }, Cntr: { t: "long", v: 80 }, FlRs: { t: "long", v: 83852682 } },
    kernel: "waterPaper", out: "direct", params: function (descriptor, context) { return [descriptor.FbrL.v, descriptor.Brgh.v, descriptor.Cntr.v, context.seed >>> 1]; } },
  GlwE: { group: "stylize", loc: "filters.gallery.glowingEdges", name: "Glowing Edges",
    defaults: { EdgW: { t: "long", v: 1 }, EdgB: { t: "long", v: 10 }, Smth: { t: "long", v: 1 } } },
  Crql: { group: "texture", loc: "filters.gallery.craquelure", name: "Craquelure",
    defaults: { CrcS: { t: "long", v: 15 }, CrcD: { t: "long", v: 6 }, CrcB: { t: "long", v: 9 }, FlRs: { t: "long", v: 495615720 } },
    kernel: "craquelure", out: "direct", params: function (descriptor, context) { return [descriptor.CrcS.v, descriptor.CrcD.v, descriptor.CrcB.v, context.seed]; } },
  Grn: { group: "texture", loc: "filters.gallery.grain", name: "Grain",
    defaults: { Intn: { t: "long", v: 40 }, Cntr: { t: "long", v: 50 }, Grnt: { t: "enum", v: { Grnt: "GrnR" } }, FlRs: { t: "long", v: 217582197 } },
    kernel: "grain", out: "direct", params: function (descriptor, context) { return [descriptor.Intn.v, GalleryFilterDefs.grainTypeWireIds.indexOf(descriptor.Grnt.v.Grnt), descriptor.Cntr.v, context.fg, context.bg, context.seed]; } },
  MscT: { group: "texture", loc: "filters.gallery.mosaicTiles", name: "Mosaic Tiles",
    defaults: { TlSz: { t: "long", v: 12 }, GrtW: { t: "long", v: 3 }, LghG: { t: "long", v: 9 }, FlRs: { t: "long", v: 25445584 } },
    kernel: "mosaicTiles", out: "direct", params: function (descriptor, context) { return [descriptor.TlSz.v, descriptor.GrtW.v, descriptor.LghG.v, context.seed]; } },
  Ptch: { group: "texture", loc: "filters.gallery.patchwork", name: "Patchwork",
    defaults: { SqrS: { t: "long", v: 4 }, Rlf: { t: "long", v: 8 }, FlRs: { t: "long", v: 383529723 } },
    kernel: "patchwork", out: "direct", params: function (descriptor, context) { return [descriptor.SqrS.v, descriptor.Rlf.v, context.seed]; } },
  StnG: { group: "texture", loc: "filters.gallery.stainedGlass", name: "Stained Glass",
    defaults: { ClSz: { t: "long", v: 10 }, BrdT: { t: "long", v: 4 }, LghI: { t: "long", v: 0 }, FlRs: { t: "long", v: 319935998 } } },
  Txtz: { group: "texture", loc: "filters.gallery.texturizer", name: "Texturizer",
    defaults: { TxtT: { t: "enum", v: { TxtT: "TxBr" } }, Scln: { t: "long", v: 100 }, Rlf: { t: "long", v: 10 }, LghD: { t: "enum", v: { LghD: "LDBL" } }, InvT: { t: "bool", v: false } } }
};

// Views derived from FILTERS, in the shapes external consumers already expect:
//   names   — read by the UI panels
//   KERNELS — read here and by the worker offload path (FilterBandRunner)
GalleryFilterDefs.names = {};
GalleryFilterDefs.KERNELS = {};
for (var catalogKey in FILTERS) {
    var catalogEntry = FILTERS[catalogKey];
    GalleryFilterDefs.names[catalogKey] = [GROUP_INDEX[catalogEntry.group], catalogEntry.loc, catalogEntry.name];
    if (catalogEntry.kernel)
        GalleryFilterDefs.KERNELS[catalogKey] = { kernel: catalogEntry.kernel, out: catalogEntry.out, params: catalogEntry.params };
}

// Builds a fresh default descriptor for a named filter (undefined if unknown).
GalleryFilterDefs.create = function (filterKey) {
    var entry = FILTERS[filterKey];
    if (!entry) return undefined;
    var descriptor = JSON.parse(JSON.stringify(entry.defaults));
    descriptor.__name = "Filter Gallery";
    descriptor.classID = "GEfc";
    descriptor.GEfk = { t: "enum", v: { GEft: filterKey } };
    descriptor.GELv = { t: "bool", v: true };
    return descriptor;
};

// ---------------------------------------------------------------------------
// Shared pixel helpers
// ---------------------------------------------------------------------------

// Blends a grayscale plane into RGBA between fg and bg colours, where the gray
// value picks the mix (0 → fg, 255 → bg). Colours are {h:R, l:G, O:B}.
GalleryFilterDefs.colorizeGrayToRgba = function (grayPlane, destRgba, fgRgb, bgRgb) {
    var pixelCount = grayPlane.length,
        fgR = fgRgb.h, fgG = fgRgb.l, fgB = fgRgb.O,
        bgR = bgRgb.h, bgG = bgRgb.l, bgB = bgRgb.O;
    for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        var blend = grayPlane[pixelIndex] * (1 / 255),
            invBlend = 1 - blend,
            rgbaOffset = pixelIndex << 2;
        destRgba[rgbaOffset]     = ~~(fgR * invBlend + bgR * blend);
        destRgba[rgbaOffset + 1] = ~~(fgG * invBlend + bgG * blend);
        destRgba[rgbaOffset + 2] = ~~(fgB * invBlend + bgB * blend);
    }
};

// Expansion padding a descriptor needs: 0 for local ops, 1e4 when the filter
// needs the whole layer as context.
GalleryFilterDefs.galleryFilterPadding = function (filterDescriptor) {
    if (filterDescriptor == null) return new Point(0, 0);
    var maxPadding = 0,
        effectList = filterDescriptor.GEfs ? filterDescriptor.GEfs.v : [{ v: filterDescriptor }];
    for (var effectIndex = 0; effectIndex < effectList.length; effectIndex++) {
        var effectDesc = effectList[effectIndex].v, padding = 1e4;
        if (effectDesc.GELv && !effectDesc.GELv.v) continue;
        var filterType = effectDesc.GEfk.v.GEft;
        if (filterType == "GlwE" || filterType == "Phtc" || filterType == "BsRl" || filterType == "PlsW" || filterType == "Chrm" ||
            filterType == "Gls"  || filterType == "OcnR" || filterType == "InkO") padding = 0;
        maxPadding = Math.max(maxPadding, padding);
    }
    return new Point(maxPadding, maxPadding);
};

// ---------------------------------------------------------------------------
// Displacement-field smoothing (used by Spatter/Sprayed Strokes and the
// gradient-based filters below)
// ---------------------------------------------------------------------------

// 13-tap Gaussian kernel for a sigma chosen by index.
function gaussianKernel13(sigmaIndex) {
    var kernel = [0,0,0,0,0,0,0,0,0,0,0,0,0],
        sigma = [0,.6,.7,.8,1,1.2,1.4,1.6,1.8,2,2.2,2.6,3,4,5][sigmaIndex];
    for (var tap = 0; tap < 13; tap++) {
        var offset = tap - 6;
        kernel[tap] = 1 / (sigma * Math.sqrt(2 * Math.PI)) * Math.exp(-.5 * (offset / sigma) * (offset / sigma));
    }
    return kernel;
}

// Horizontal Gaussian pass on an interleaved (x,y) displacement field.
function blurFieldHorizontal(srcMap, destMap, width, height, sigmaIndex) {
    var kernel = gaussianKernel13(sigmaIndex), radius = 6, tapCount = 13;
    for (var row = 0; row < height; row++)
        for (var col = 0; col < width; col++) {
            var destIdx = row * width + col << 1, sumX = 0, sumY = 0;
            for (var tap = 0; tap < tapCount; tap++) {
                var sampleCol = col + tap - radius, clampedCol = sampleCol < 0 ? 0 : sampleCol >= width ? width - 1 : sampleCol,
                    srcIdx = (row * width + clampedCol) * 2, weight = kernel[tap];
                sumX += weight * srcMap[srcIdx]; sumY += weight * srcMap[srcIdx + 1];
            }
            destMap[destIdx] = sumX; destMap[destIdx + 1] = sumY;
        }
}

// Vertical Gaussian pass on an interleaved (x,y) displacement field.
function blurFieldVertical(srcMap, destMap, width, height, sigmaIndex) {
    var kernel = gaussianKernel13(sigmaIndex), radius = 6, tapCount = 13;
    for (var row = 0; row < height; row++)
        for (var col = 0; col < width; col++) {
            var destIdx = row * width + col << 1, sumX = 0, sumY = 0;
            for (var tap = 0; tap < tapCount; tap++) {
                var sampleRow = row + tap - radius, clampedRow = sampleRow < 0 ? 0 : sampleRow >= height ? height - 1 : sampleRow,
                    srcIdx = (clampedRow * width + col) * 2, weight = kernel[tap];
                sumX += weight * srcMap[srcIdx]; sumY += weight * srcMap[srcIdx + 1];
            }
            destMap[destIdx] = sumX; destMap[destIdx + 1] = sumY;
        }
}

// Smooths two float planes in place: a 3×3 convolution for small amounts,
// a Gaussian blur otherwise.
function smoothFloatField(mapX, mapY, scratch, rect, smoothAmount) {
    if (smoothAmount <= 1) {
        smoothAmount = Math.round(smoothAmount);
        convolveFloatField3x3(mapX, mapY, scratch, rect, [1, 16, 4][smoothAmount]);
        return;
    }
    var blurSigma = smoothAmount * .42;
    if (mapX) { gaussianBlurFloat(mapX, scratch, rect, blurSigma, 3); mapX.set(scratch); }
    if (mapY) { gaussianBlurFloat(mapY, scratch, rect, blurSigma, 3); mapY.set(scratch); }
}

// In-place 3×3 convolution of two float planes (sharpen or soften via the
// centre weight).
function convolveFloatField3x3(mapX, mapY, scratch, rect, centerWeight) {
    var kernel = normalizeKernel([1, 2, 1, 2, centerWeight, 2, 1, 2, 1]);
    if (mapX) { scratch.set(mapX); convolveChannel3x3Raw(mapX, scratch, rect.width, rect.height, kernel); mapX.set(scratch); }
    if (mapY) { scratch.set(mapY); convolveChannel3x3Raw(mapY, scratch, rect.width, rect.height, kernel); mapY.set(scratch); }
}

// ---------------------------------------------------------------------------
// Texture loading (built-in textures indexed 0-6; index 2 = procedural noise)
// ---------------------------------------------------------------------------

let builtinTextureCache = null;

// Returns [{s: width, T: height}, grayData] for a texture parameter pair
// [textureEnum, userLayers]. Custom layer textures resolve by path; built-in
// textures are generated/loaded once and cached.
function loadGalleryTexture(textureParams) {
    var textureEnum = textureParams[0],
        textureLayers = textureParams[1],
        builtinIndex = GalleryFilterDefs.textureTypeWireIds.indexOf(textureEnum.v.TxtT);

    if (builtinIndex == -1 && (!textureLayers || !textureLayers[0] || textureLayers[0].length == 0)) builtinIndex = 0;
    else if (builtinIndex == -1) {
        // Custom layer texture: find the layer whose path matches.
        var layerPath = textureEnum.v.pth, layerList = textureLayers[0], matchedLayer = null;
        for (var layerIndex = 0; layerIndex < layerList.length; layerIndex++)
            if (layerList[layerIndex].Cv == layerPath) matchedLayer = layerList[layerIndex];
        if (matchedLayer == null) matchedLayer = layerList[0];
        if (matchedLayer) {
            if (matchedLayer.l7) matchedLayer.l7();
            if (matchedLayer.NF) {
                var layerPixels = matchedLayer.NF,
                    layerRect = layerPixels[1],
                    layerWidth = layerRect.s || layerRect.width,
                    layerHeight = layerRect.T || layerRect.height,
                    grayPlane = new Uint8Array(layerWidth * layerHeight);
                rgbaToGrayChannel(layerPixels[0], grayPlane);
                invert(grayPlane);
                return [{ s: layerWidth, T: layerHeight }, grayPlane];
            }
        }
        builtinIndex = 0;
    }

    if (builtinTextureCache == null) builtinTextureCache = [];
    if (builtinTextureCache[builtinIndex] == null) {
        var texNames = "blocks canvas frosted tinylens brick burlap sandstone".split(" ");
        var texName = texNames[builtinIndex];
        var rgbaBuffer, texRect;
        if (builtinIndex == 2) {
            // Frosted: a 128×128 monochrome Gaussian-noise texture.
            texRect = { width: 128, height: 128, area: function() { return 128 * 128; }, s: 128, T: 128 };
            var noiseDesc = FilterDefs ? FilterDefs.create("AdNs") : null;
            if (noiseDesc) {
                noiseDesc.Mnch.v = true;
                noiseDesc.Dstr.v.Dstr = "Gsn";
                noiseDesc.Nose.v.val = 50;
                rgbaBuffer = allocBuffer(128 * 128 * 4);
                var noiseSrc = rgbaBuffer.slice(0);
                new Uint32Array(noiseSrc.buffer).fill(4286611584);
                FilterDefs.applyFilterToPixels("AdNs", { buffer: noiseSrc, rect: texRect }, noiseDesc, 0, 0, { buffer: rgbaBuffer, rect: texRect });
            } else {
                rgbaBuffer = allocBuffer(128 * 128 * 4);
                for (var byteIndex = 0; byteIndex < rgbaBuffer.length; byteIndex++)
                    rgbaBuffer[byteIndex] = Math.random() * 255;
            }
        } else {
            if (devToolsBinDb) {
              var packedTex = devToolsBinDb.get("tex/" + texName, true)[0];
                if (packedTex) { texRect = packedTex.rect; rgbaBuffer = new Uint8Array(packedTex.data); }
            }
            if (!texRect) {
                texRect = { width: 128, height: 128, s: 128, T: 128 };
                rgbaBuffer = allocBuffer(128 * 128 * 4);
            }
        }
        var texWidth = texRect.width || texRect.s || 128, texHeight = texRect.height || texRect.T || 128;
        var grayOut = new Uint8Array(texWidth * texHeight);
        extractChannelByte(rgbaBuffer, grayOut, 0);
        builtinTextureCache[builtinIndex] = [{ s: texWidth, T: texHeight }, grayOut];
    }
    return builtinTextureCache[builtinIndex];
}

// ---------------------------------------------------------------------------
// Complex filters (engine-based, one function each)
// ---------------------------------------------------------------------------

// Photocopy: a high-pass of the gray image, twice, differenced and darkened.
function renderPhotocopy(sourceRgba, destRgba, pixelCount, sourceRect, descriptor, fgRgb, bgRgb) {
    function unsharpHighpass(srcGray, outGray, rect, blurRadius) {
        gaussianBlurRgba(srcGray, outGray, rect, blurRadius);
        for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++)
            outGray[pixelIndex] = Math.max(0, Math.min(255, 128 + srcGray[pixelIndex] - outGray[pixelIndex]));
    }
    var detail = descriptor.Dtl.v, darkness = descriptor.Drkn.v, grayPlane = allocBuffer(pixelCount);
    rgbaToGrayChannel(sourceRgba, grayPlane);
    var lowPass = allocBuffer(pixelCount);
    unsharpHighpass(grayPlane, lowPass, sourceRect, 1);
    if (detail == 1) { detail = 2; darkness = Math.round(darkness / 4); }
    var highPass = allocBuffer(pixelCount);
    unsharpHighpass(grayPlane, highPass, sourceRect, detail);
    for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++)
        grayPlane[pixelIndex] = Math.max(0, Math.min(255, 255 - (lowPass[pixelIndex] - highPass[pixelIndex]) * darkness));
    GalleryFilterDefs.colorizeGrayToRgba(grayPlane, destRgba, fgRgb, bgRgb);
}

// Spatter / Sprayed Strokes: a random displacement field warps the image.
function renderSpatterSprayed(filterType, sourceRgba, destRgba, width, height, descriptor) {
    var field = { mapWidth: Math.floor(width), mapHeight: Math.floor(height) };
    field.map = new Float32Array(field.mapWidth * field.mapHeight * 2);
    var rng = new RngState(descriptor.FlRs ? descriptor.FlRs.v : 0),
        noiseTable = new Float32Array(8192),
        sprayRadius = descriptor.SprR.v,
        sprayStrength = sprayRadius < 20 ? .018 * sprayRadius : .36 + (sprayRadius - 20) * .128;
    if (filterType == "SprS") sprayStrength = .07 + [0,.02,.04,.06,.08,.1,.12,.14,.16,.18,.2,.22,.24,.26,.28,.3,.34,.38,.5,.65,.75,.85,1,1.5,2.2,3][sprayRadius];
    for (var noiseIndex = 0; noiseIndex < 8192; noiseIndex++)
        noiseTable[noiseIndex] = (-1 + 2 * rng.get()) * sprayStrength * 70;
    for (var row = 0; row < height; row++)
        for (var col = 0; col < width; col++) {
            var fieldOffset = row * width + col << 1;
            field.map[fieldOffset] = noiseTable[fieldOffset % 7919];
            field.map[fieldOffset + 1] = noiseTable[(fieldOffset + 1) % 7919];
        }
    var tempMap = field.map.slice(0),
        spatterSmooth = filterType == "Spt" ? descriptor.Smth.v - 1 : 1;
    if (filterType == "Spt" && spatterSmooth != 0) {
        blurFieldHorizontal(field.map, tempMap, width, height, spatterSmooth);
        blurFieldVertical(tempMap, field.map, width, height, spatterSmooth);
    }
    if (filterType == "SprS") {
        var strokeHalf = descriptor.StrL.v >>> 1, blurSigmaIndex = strokeHalf == 0 ? 2 : 1;
        blurFieldHorizontal(field.map, tempMap, width, height, blurSigmaIndex);
        blurFieldVertical(tempMap, field.map, width, height, blurSigmaIndex);
        if (strokeHalf != 0) {
            var dirIndex = GalleryFilterDefs.strokeDirectionWireIds.indexOf(descriptor.SDir.v.StrD),
                dirX = [1,1,1,0][dirIndex], dirY = [-1,0,1,1][dirIndex],
                spanLen = 2 * strokeHalf + 1, spanInv = 1 / spanLen;
            for (var row = 0; row < height; row++)
                for (var col = 0; col < width; col++) {
                    var fieldOffset = row * width + col << 1, accumX = 0, accumY = 0;
                    for (var spanStep = 0; spanStep < spanLen; spanStep++) {
                        var sampleX = Math.max(0, Math.min(width-1, col-(strokeHalf+spanStep)*dirX)),
                            sampleY = Math.max(0, Math.min(height-1, row-(strokeHalf+spanStep)*dirY)),
                            sampleIdx = sampleY * width + sampleX << 1;
                        accumX += field.map[sampleIdx]; accumY += field.map[sampleIdx + 1];
                    }
                    tempMap[fieldOffset] = accumX * spanInv; tempMap[fieldOffset + 1] = accumY * spanInv;
                }
            field.map = tempMap;
        }
    }
    applyWarp(sourceRgba, destRgba, width, height, null, field.map, field.mapWidth, field.mapHeight, 1);
}

// Bas Relief / Plastic Wrap / Chrome: build a surface gradient, then light it
// (Bas Relief), accentuate highlights (Plastic Wrap), or reflect it (Chrome).
function renderReliefMap(filterType, sourceRgba, destRgba, width, height, pixelCount, sourceRect, descriptor, fgRgb, bgRgb) {
    var grayPlane = allocBuffer(pixelCount), scratchPlane = grayPlane.slice(0);
    rgbaToGrayChannel(sourceRgba, grayPlane);
    var detail = descriptor.Dtl ? descriptor.Dtl.v : 15, smoothness = descriptor.Smth.v;
    if (detail != 15) {
        gaussianBlurByte(grayPlane, scratchPlane, sourceRect, Math.round((15 - detail) * .5));
        copyBuffer(scratchPlane, grayPlane);
    }
    var invWidth = 1.4 / width, invHeight = 1.4 / height,
        gradX = new Float32Array(pixelCount), gradY = new Float32Array(pixelCount),
        floatScratch = new Float32Array(destRgba.buffer);
    for (var row = 0; row < height; row++)
        for (var col = 0; col < width; col++) {
            var pixelIndex = row * width + col,
                slopeX = col == width-1 ? grayPlane[pixelIndex] - grayPlane[pixelIndex-1] : grayPlane[pixelIndex+1] - grayPlane[pixelIndex],
                slopeY = row == height-1 ? grayPlane[pixelIndex] - grayPlane[pixelIndex-width] : grayPlane[pixelIndex+width] - grayPlane[pixelIndex],
                fallbackX = col * invWidth - .7, fallbackY = row * invHeight - .7;
            gradX[pixelIndex] = slopeX == 0 ? fallbackX : slopeX * .4;
            gradY[pixelIndex] = slopeY == 0 ? fallbackY : slopeY * .4;
        }
    if (filterType == "BsRl") {
        var lightAngle = (2 + GalleryFilterDefs.lightDirectionWireIds.indexOf(descriptor.LghD.v.LghD)) * Math.PI * .25,
            cosLight = Math.cos(lightAngle), sinLight = Math.sin(lightAngle);
        if (Math.abs(cosLight) < .1) cosLight = 0; cosLight = Math.sign(cosLight);
        if (Math.abs(sinLight) < .1) sinLight = 0; sinLight = Math.sign(sinLight);
        var lightNorm = 1 / (cosLight * cosLight + sinLight * sinLight);
        for (var row = 0; row < height; row++)
            for (var col = 0; col < width; col++) {
                var pixelIndex = row * width + col,
                    litX = Math.max(-1, Math.min(1, cosLight * gradX[pixelIndex])),
                    litY = Math.max(-1, Math.min(1, sinLight * gradY[pixelIndex]));
                scratchPlane[pixelIndex] = 128 + 127 * (litX + litY) * lightNorm;
            }
        if (smoothness != 1) {
            gaussianBlurByte(scratchPlane, grayPlane, sourceRect, Math.round((smoothness - 1) * .5));
            copyBuffer(grayPlane, scratchPlane);
        }
        GalleryFilterDefs.colorizeGrayToRgba(scratchPlane, destRgba, fgRgb, bgRgb);
    } else {
        if (filterType == "Chrm") smoothness = 5 + smoothness;
        if (smoothness > 1) smoothFloatField(gradX, gradY, floatScratch, sourceRect, smoothness - 1);
        if (filterType == "PlsW") {
            var coverageBytes = new Uint8Array(gradX.buffer);
            for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
                var rgbaOffset = pixelIndex << 2, gradXVal = gradX[pixelIndex], gradYVal = gradY[pixelIndex],
                    cosNorm = 1 / (Math.sqrt(1 + gradXVal * gradXVal) * Math.sqrt(1 + gradYVal * gradYVal)),
                    cos2 = cosNorm * cosNorm, cos4 = cos2 * cos2, highlight = ~~(255 * (cos4 * cos4 * cos2));
                coverageBytes[rgbaOffset] = coverageBytes[rgbaOffset+1] = coverageBytes[rgbaOffset+2] = coverageBytes[rgbaOffset+3] = highlight;
            }
            destRgba.set(sourceRgba);
            composite("norm", coverageBytes, sourceRect, destRgba, sourceRect, sourceRect, descriptor.HghS.v / 20);
        } else if (filterType == "Chrm") {
            var halfW = width >>> 1, halfH = height >>> 1;
            for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
                var rgbaOffset = pixelIndex << 2, gradXVal = gradX[pixelIndex], gradYVal = gradY[pixelIndex],
                    tangentX = { x: 1, y: 0, z: gradXVal }, tangentY = { x: 0, y: 1, z: gradYVal };
                LayerStyleRenderer.normalizeVec3(tangentX); LayerStyleRenderer.normalizeVec3(tangentY);
                var normal = LayerStyleRenderer.crossVec3(tangentX, tangentY),
                    invZ = 1 / normal.z,
                    reflectX = ~~Math.max(0, Math.min(width-1, halfW - normal.x * invZ * halfW)),
                    reflectY = ~~Math.max(0, Math.min(height-1, halfH - normal.y * invZ * halfH)),
                    reflected = grayPlane[reflectY * width + reflectX];
                destRgba[rgbaOffset] = destRgba[rgbaOffset+1] = destRgba[rgbaOffset+2] = reflected;
            }
        }
    }
}

// Glass / Ocean Ripple / Texturizer: build a displacement gradient from a
// texture, then either resample the image through it (Glass/Ocean Ripple) or
// light it as a relief (Texturizer).
function renderDistortion(filterType, sourceRgba, destRgba, width, height, pixelCount, sourceRect, descriptor, textureLayers) {
    var textureEnum = filterType == "OcnR"
        ? { t: "enum", v: { TxtT: "TxFr" } }
        : (descriptor.TxtT || { t: "enum", v: { TxtT: "TxTL" } });
    var textureBuiltinIndex = filterType == "OcnR" ? 2 : GalleryFilterDefs.textureTypeWireIds.indexOf(textureEnum.v.TxtT);
    var texPair = loadGalleryTexture([textureEnum, textureLayers]),
        texRect = texPair[0], texData = texPair[1],
        texW = texRect.s, texH = texRect.T;
    var clampMax = 24,
        gradX = new Float32Array(pixelCount), gradY = new Float32Array(pixelCount),
        floatScratch = new Float32Array(destRgba.buffer),
        scale = filterType == "OcnR" ? 1 / (1 + (descriptor.RplS.v - 1) * .1) : 100 / descriptor.Scln.v;
    if (textureBuiltinIndex == 3) scale *= 32 / 22.2;
    var gradScale = scale;
    if (filterType == "Txtz") { gradScale *= 1 / 255; clampMax = 256; }
    for (var row = 0; row < height; row++) {
        var texY0 = ~~(scale * (row + sourceRect.y) + 8192) & 127;
        var texY1 = texY0 + 1 & 127;
        if (texH != 128) { texY0 = Math.round(row * scale) % texH; texY1 = (Math.round(row * scale) + 1) % texH; }
        for (var col = 0; col < width; col++) {
            var pixelIndex = row * width + col,
                texX0 = ~~(scale * (col + sourceRect.x) + 8192) & 127,
                texX1 = texX0 + 1 & 127,
                sampleCenter = 0, sampleDown = 0, sampleRight = 0;
            if (texW != 128) { texX0 = Math.round(col * scale) % texW; texX1 = (Math.round(col * scale) + 1) % texW; }
            if (filterType == "Txtz") {
                sampleCenter = sampleBilinearWrap(scale * col, scale * row, texData, 128, 128);
                sampleDown = sampleBilinearWrap(scale * col, scale * row + 1, texData, 128, 128);
                sampleRight = sampleBilinearWrap(scale * col + 1, scale * row, texData, 128, 128);
            } else {
                sampleCenter = texData[texY0 * texW + texX0];
                sampleDown = texData[texY1 * texW + texX0];
                sampleRight = texData[texY0 * texW + texX1];
            }
            gradX[pixelIndex] = Math.max(-clampMax, Math.min((sampleRight - sampleCenter) * gradScale, clampMax));
            gradY[pixelIndex] = Math.max(-clampMax, Math.min((sampleDown - sampleCenter) * gradScale, clampMax));
        }
    }
    var smoothness = filterType == "Txtz" ? 1 : (filterType == "OcnR" ? 3.5 / scale : descriptor.Smth.v);
    if (filterType == "Txtz") convolveFloatField3x3(gradX, gradY, floatScratch, sourceRect, 6);
    else smoothFloatField(gradX, gradY, floatScratch, sourceRect, smoothness);
    if (filterType == "Txtz") {
        var lightSign = descriptor.InvT.v ? -1 : 1,
            lightAngle = (2 + GalleryFilterDefs.lightDirectionWireIds.indexOf(descriptor.LghD.v.LghD)) * Math.PI * .25,
            lightDir = { x: Math.cos(lightAngle), y: Math.sin(lightAngle), z: 0 };
        LayerStyleRenderer.normalizeVec3(lightDir);
        var relief = descriptor.Rlf.v;
        relief = relief / 4 + Math.max(0, (relief - 35) * 2);
        for (var row = 0; row < height; row++)
            for (var col = 0; col < width; col++) {
                var pixelIndex = row * width + col, rgbaOffset = pixelIndex << 2,
                    gradXVal = gradX[pixelIndex], gradYVal = gradY[pixelIndex],
                    tangentX = { x: 1, y: 0, z: gradXVal }, tangentY = { x: 0, y: 1, z: gradYVal };
                LayerStyleRenderer.normalizeVec3(tangentX); LayerStyleRenderer.normalizeVec3(tangentY);
                var normal = LayerStyleRenderer.crossVec3(tangentX, tangentY),
                    lightDot = LayerStyleRenderer.dotVec3(normal, lightDir) * lightSign,
                    shade = 1, shadeColor = 1;
                if (lightDot < 0) { shadeColor = 0; lightDot = -lightDot; }
                shade = Math.min(1, lightDot * relief);
                function blendChannel(base, lit, mix) {
                    var over = overF(lit, base, 1);
                    return ((1 - mix) * base + mix * (mix * lit + (1 - mix) * over)) * 255;
                }
                destRgba[rgbaOffset]   = ~~blendChannel(sourceRgba[rgbaOffset]   * (1/255), shadeColor, shade);
                destRgba[rgbaOffset+1] = ~~blendChannel(sourceRgba[rgbaOffset+1] * (1/255), shadeColor, shade);
                destRgba[rgbaOffset+2] = ~~blendChannel(sourceRgba[rgbaOffset+2] * (1/255), shadeColor, shade);
            }
    } else {
        var distortStrength;
        if (filterType == "Gls") {
            distortStrength = [1,.4,.5,.5,.5,.5,.5,1][textureBuiltinIndex] * (Math.exp(descriptor.Dstr.v * .155) - 1);
            if (descriptor.InvT.v) distortStrength = -distortStrength;
        } else {
            distortStrength = .5 * (Math.exp(descriptor.RplM.v * .155) - 1);
        }
        for (var row = 0; row < height; row++)
            for (var col = 0; col < width; col++) {
                var pixelIndex = row * width + col, rgbaOffset = pixelIndex << 2,
                    gradXVal = gradX[pixelIndex], gradYVal = gradY[pixelIndex],
                    tangentX = { x: 1, y: 0, z: gradXVal }, tangentY = { x: 0, y: 1, z: gradYVal };
                LayerStyleRenderer.normalizeVec3(tangentX); LayerStyleRenderer.normalizeVec3(tangentY);
                var normal = LayerStyleRenderer.crossVec3(tangentX, tangentY),
                    displace = distortStrength / normal.z,
                    sampleX = ~~Math.max(0, Math.min(width-1, col - normal.x * displace)),
                    sampleY = ~~Math.max(0, Math.min(height-1, row - normal.y * displace)),
                    sampleOff = sampleY * width + sampleX << 2;
                destRgba[rgbaOffset]   = sourceRgba[sampleOff];
                destRgba[rgbaOffset+1] = sourceRgba[sampleOff+1];
                destRgba[rgbaOffset+2] = sourceRgba[sampleOff+2];
            }
    }
}

// Paint Daubs: a percentile morphological fill, then an unsharp-style pass.
function renderPaintDaubs(sourceRgba, destRgba, width, height, descriptor) {
    var sharpen = descriptor.Shrp.v * .4, brushType = descriptor.BrsT.v.BrsT,
        brushPercentile = { BrSm:[.75], BrsL:[.85], BrDR:[.68], BrsW:[.75], BrbW:[.78], BrSp:[.62] }[brushType],
        radius = Math.round(descriptor.Sz.v * .5);
    setPercentileFraction(brushPercentile[0]);
    var selectFn = selectPercentile;
    FilterDefs.applyMorphologicalGradientFill(sourceRgba, destRgba, width, height, radius, selectFn, [], 0);
    var sharpenKernel = [-.7,-1,-.7,-1,10,-1,-.7,-1,-.7];
    sharpenKernel = normalizeKernel(sharpenKernel);
    var blurred = destRgba.slice(0);
    convolveRGBA(blurred, destRgba, width, height, sharpenKernel, 0);
    for (var byteIndex = 0; byteIndex < sourceRgba.length; byteIndex++) {
        var diff = destRgba[byteIndex] - blurred[byteIndex];
        destRgba[byteIndex] = Math.max(0, Math.min(255, blurred[byteIndex] + sharpen * diff));
    }
}

// Glowing Edges: detect edges, invert to white, dilate, and scale brightness.
function renderGlowingEdges(sourceRgba, destRgba, width, height, descriptor) {
    var scratch = destRgba.slice(0);
    setPercentileFraction(.5);
    var selectFn = selectPercentile;
    FilterDefs.applyMorphologicalGradientFill(sourceRgba, scratch, width, height, descriptor.Smth.v >>> 1, selectFn, [], 0);
    findEdgesRGB(scratch, destRgba, width, height);
    copyBuffer(destRgba, scratch);
    invert(scratch);
    fillBuffer(scratch, 4278190080, 16777215);
    FilterDefs.applyMorphologicalGradientFill(scratch, destRgba, width, height, descriptor.EdgW.v >>> 1, selectMaximum, [], 0);
    var brightness = descriptor.EdgB.v / 10;
    for (var byteIndex = 0; byteIndex < scratch.length; byteIndex++) {
        if ((byteIndex & 3) == 3) continue;
        var value = destRgba[byteIndex];
        destRgba[byteIndex] = Math.max(0, Math.min(255, value * brightness));
    }
}

// Halftone Pattern: a screen function modulates a blurred gray image, with a
// contrast adjustment around the (alpha-weighted) mean.
function renderHalftonePattern(sourceRgba, destRgba, width, height, pixelCount, sourceRect, descriptor, fgRgb, bgRgb) {
    var cellRadius = descriptor.HlSz.v, cellSize = cellRadius * 2 + 1, contrast = descriptor.Cntr.v,
        screenType = GalleryFilterDefs.scratchTypeWireIds.indexOf(descriptor.ScrT.v.ScrT),
        grayPlane = allocBuffer(pixelCount), blurScratch = grayPlane.slice(0);
    for (var rgbaIndex = 0; rgbaIndex < pixelCount * 4; rgbaIndex += 4)
        grayPlane[rgbaIndex >>> 2] = ~~(.5 + (sourceRgba[rgbaIndex] + sourceRgba[rgbaIndex+1] + sourceRgba[rgbaIndex+2]) * (1/3));
    boxBlurByte(grayPlane, blurScratch, sourceRect, cellRadius);
    grayPlane = blurScratch;
    var cellFreq = Math.PI / cellSize, distSqByCol = new Float64Array(width), cosByCol = new Float64Array(width), sinTable = new Float64Array(2 * width);
    for (var col = 0; col < width; col++) {
        var colAngle = (col - (width >>> 1)) * cellFreq;
        distSqByCol[col] = colAngle * colAngle; cosByCol[col] = Math.cos(colAngle);
        var sinIdx = col << 1;
        sinTable[sinIdx] = Math.sin(sinIdx * (1/4.5)); sinTable[sinIdx+1] = Math.sin((sinIdx+1) * (1/4.5));
    }
    var weightedSum = 0, weightTotal = 0;
    for (var row = 0; row < height; row++) {
        var rowAngle = (row - (height >>> 1)) * cellFreq, rowCos = Math.cos(rowAngle), rowAngleSq = rowAngle * rowAngle;
        for (var col = 0; col < width; col++) {
            var screen = rowCos;
            if (screenType == 0) { var ringIdx = .5 + Math.sqrt(distSqByCol[col] + rowAngleSq) * 4.5; screen = sinTable[~~ringIdx]; }
            else if (screenType == 1) screen = cosByCol[col] * rowCos;
            var pixelIndex = row * width + col,
                luminance = grayPlane[pixelIndex] * (.75 + .25 * screen),
                alpha = sourceRgba[(pixelIndex << 2) + 3] * (1/255),
                clamped = Math.max(0, Math.min(255, ~~luminance));
            weightedSum += clamped * alpha; weightTotal += alpha; grayPlane[pixelIndex] = clamped;
        }
    }
    var mean = weightTotal > 0 ? weightedSum / weightTotal : 128,
        contrastBase = 128 + 1.26 * (mean - 128), contrastSpread = .08 + .25 * Math.abs((128 - mean) / 128), contrastScale = 1 + contrastSpread * contrast;
    for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
        var adjusted = contrastBase + (grayPlane[pixelIndex] - contrastBase) * contrastScale;
        grayPlane[pixelIndex] = Math.max(0, Math.min(255, ~~adjusted));
    }
    if (contrast > 46) round(grayPlane);
    GalleryFilterDefs.colorizeGrayToRgba(grayPlane, destRgba, fgRgb, bgRgb);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Applies one gallery filter to a source pixel buffer, writing destPixels.
//   galleryFilterType — ignored; the real type comes from filterDescriptor.GEfk
//   sourcePixels / destPixels — { buffer, rect: { width, height, x, y } }
//   fgRgb / bgRgb — foreground/background colours as { h:R, l:G, O:B }
//   textureLayers — PSD user texture layer list (for texture-driven filters)
GalleryFilterDefs.applyGalleryFilterToPixels = function (galleryFilterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, textureLayers) {
    galleryFilterType = filterDescriptor.GEfk.v.GEft;
    var sourceRect = sourcePixels.rect,
        width = sourceRect.width, height = sourceRect.height,
        pixelCount = width * height;
    var sourceRgba = sourcePixels.buffer, destRgba = destPixels.buffer;

    // Pack {h:R, l:G, O:B} colours as int (R<<24 | G<<16 | B<<8 | 255).
    var fgInt = fgRgb.h << 24 | fgRgb.l << 16 | fgRgb.O << 8 | 255;
    var bgInt = bgRgb.h << 24 | bgRgb.l << 16 | bgRgb.O << 8 | 255;
    var seed = filterDescriptor.FlRs ? filterDescriptor.FlRs.v >>> 1 : 0;
    var textureLoadArgs = filterDescriptor.TxtT ? [filterDescriptor.TxtT, textureLayers] : [{ t: "enum", v: { TxtT: "TxCa" } }, textureLayers];

    // Self-contained filters: one FilterPixelOps kernel via the KERNELS table.
    var kernelSpec = GalleryFilterDefs.KERNELS[galleryFilterType];
    if (kernelSpec) {
        var ctx = { fg: fgInt, bg: bgInt, seed: seed, texture: textureLoadArgs };
        FilterPixelOps[kernelSpec.kernel](sourceRgba, width, height, destRgba, kernelSpec.params(filterDescriptor, ctx));
        if (kernelSpec.out == "gray") {
            // Kernel left a gray plane in the R channel; colourise with fg/bg.
            var grayPlane = allocBuffer(pixelCount);
            for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++)
                grayPlane[pixelIndex] = destRgba[pixelIndex * 4];
            GalleryFilterDefs.colorizeGrayToRgba(grayPlane, destRgba, fgRgb, bgRgb);
        }
    }

    // Complex filters.
    if (galleryFilterType == "Phtc")
        renderPhotocopy(sourceRgba, destRgba, pixelCount, sourceRect, filterDescriptor, fgRgb, bgRgb);
    if (galleryFilterType == "Spt" || galleryFilterType == "SprS")
        renderSpatterSprayed(galleryFilterType, sourceRgba, destRgba, width, height, filterDescriptor);
    if (galleryFilterType == "BsRl" || galleryFilterType == "PlsW" || galleryFilterType == "Chrm")
        renderReliefMap(galleryFilterType, sourceRgba, destRgba, width, height, pixelCount, sourceRect, filterDescriptor, fgRgb, bgRgb);
    if (galleryFilterType == "Gls" || galleryFilterType == "OcnR" || galleryFilterType == "Txtz")
        renderDistortion(galleryFilterType, sourceRgba, destRgba, width, height, pixelCount, sourceRect, filterDescriptor, textureLayers);
    if (galleryFilterType == "PntD")
        renderPaintDaubs(sourceRgba, destRgba, width, height, filterDescriptor);
    if (galleryFilterType == "GlwE")
        renderGlowingEdges(sourceRgba, destRgba, width, height, filterDescriptor);
    if (galleryFilterType == "StnG")
        quantizeDithered(sourceRgba, width, height, destRgba, filterDescriptor.ClSz.v, [Math.round(fgRgb.h), Math.round(fgRgb.l), Math.round(fgRgb.O)], filterDescriptor.BrdT.v);
    if (galleryFilterType == "HlfS")
        renderHalftonePattern(sourceRgba, destRgba, width, height, pixelCount, sourceRect, filterDescriptor, fgRgb, bgRgb);

    // Preserve source alpha in all cases.
    for (var rgbaIndex = 0; rgbaIndex < sourceRgba.length; rgbaIndex += 4)
        destRgba[rgbaIndex + 3] = sourceRgba[rgbaIndex + 3];
};

// Wire FilterPixelOps hooks now that the texture loader and sampler exist.
PixelEngine.textureLoader = loadGalleryTexture;
PixelEngine.bilinearSample = function (x, y, data, w, h) {
    return sampleBilinearWrap(x, y, data, w, h);
};

export { installLayerSymbols };
