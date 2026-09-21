/**
 * Photoshop blend mode wire codes, PSD enum names, UI labels, and CSS mappings.
 *
 * `wireCode` values (e.g. `"mul "`, `"hue "`) are PSD on-disk FourCC strings — do not trim.
 */

const BLEND_MODE_GROUP_SIZES = [2, 5, 5, 7, 4, 4];

/** @type {ReadonlyArray<{ wireCode: string, psdName: string, uiLabelKey: string, cssBlendMode: string | null }>} */
const BLEND_MODE_CATALOG = [
  { wireCode: "norm", psdName: "Nrml", uiLabelKey: "brushAndMessages.blendModes.normal", cssBlendMode: "normal" },
  { wireCode: "diss", psdName: "Dslv", uiLabelKey: "brushAndMessages.blendModes.dissolve", cssBlendMode: null },
  { wireCode: "dark", psdName: "Drkn", uiLabelKey: "brushAndMessages.blendModes.darken", cssBlendMode: "darken" },
  { wireCode: "mul ", psdName: "Mltp", uiLabelKey: "brushAndMessages.blendModes.multiply", cssBlendMode: "multiply" },
  { wireCode: "idiv", psdName: "CBrn", uiLabelKey: "brushAndMessages.blendModes.colourBurn", cssBlendMode: "color-burn" },
  { wireCode: "lbrn", psdName: "linearBurn", uiLabelKey: "brushAndMessages.blendModes.linearBurn", cssBlendMode: null },
  { wireCode: "dkCl", psdName: "darkerColor", uiLabelKey: "brushAndMessages.blendModes.darkerColour", cssBlendMode: null },
  { wireCode: "lite", psdName: "Lghn", uiLabelKey: "brushAndMessages.blendModes.lighten", cssBlendMode: "lighten" },
  { wireCode: "scrn", psdName: "Scrn", uiLabelKey: "brushAndMessages.blendModes.screen", cssBlendMode: "screen" },
  { wireCode: "div ", psdName: "CDdg", uiLabelKey: "brushAndMessages.blendModes.colourDodge", cssBlendMode: "color-dodge" },
  { wireCode: "lddg", psdName: "linearDodge", uiLabelKey: "brushAndMessages.blendModes.linearDodge", cssBlendMode: null },
  { wireCode: "lgCl", psdName: "lighterColor", uiLabelKey: "brushAndMessages.blendModes.lighterColour", cssBlendMode: null },
  { wireCode: "over", psdName: "Ovrl", uiLabelKey: "brushAndMessages.blendModes.overlay", cssBlendMode: "overlay" },
  { wireCode: "sLit", psdName: "SftL", uiLabelKey: "brushAndMessages.blendModes.softLight", cssBlendMode: "soft-light" },
  { wireCode: "hLit", psdName: "HrdL", uiLabelKey: "brushAndMessages.blendModes.hardLight", cssBlendMode: "hard-light" },
  { wireCode: "vLit", psdName: "vividLight", uiLabelKey: "brushAndMessages.blendModes.vividLight", cssBlendMode: null },
  { wireCode: "lLit", psdName: "linearLight", uiLabelKey: "brushAndMessages.blendModes.linearLight", cssBlendMode: null },
  { wireCode: "pLit", psdName: "pinLight", uiLabelKey: "brushAndMessages.blendModes.pinLight", cssBlendMode: null },
  { wireCode: "hMix", psdName: "hardMix", uiLabelKey: "brushAndMessages.blendModes.hardMix", cssBlendMode: null },
  { wireCode: "diff", psdName: "Dfrn", uiLabelKey: "brushAndMessages.blendModes.difference", cssBlendMode: "difference" },
  { wireCode: "smud", psdName: "Xclu", uiLabelKey: "brushAndMessages.blendModes.exclusion", cssBlendMode: "exclusion" },
  { wireCode: "fsub", psdName: "blendSubtraction", uiLabelKey: "brushAndMessages.blendModes.subtract", cssBlendMode: null },
  { wireCode: "fdiv", psdName: "blendDivide", uiLabelKey: "brushAndMessages.blendModes.divide", cssBlendMode: null },
  { wireCode: "hue ", psdName: "H", uiLabelKey: "brushAndMessages.blendModes.hue", cssBlendMode: "hue" },
  { wireCode: "sat ", psdName: "Strt", uiLabelKey: "brushAndMessages.blendModes.saturation", cssBlendMode: "saturation" },
  { wireCode: "colr", psdName: "Clr", uiLabelKey: "brushAndMessages.blendModes.colour", cssBlendMode: "color" },
  { wireCode: "lum ", psdName: "Lmns", uiLabelKey: "brushAndMessages.blendModes.luminosity", cssBlendMode: "luminosity" },
];

const psdCodes = BLEND_MODE_CATALOG.map((entry) => entry.wireCode);
const psdNames = BLEND_MODE_CATALOG.map((entry) => entry.psdName);
const uiLabels = BLEND_MODE_CATALOG.map((entry) => entry.uiLabelKey);
const cssNames = BLEND_MODE_CATALOG.map((entry) => entry.cssBlendMode);

function indexOfWireCode(wireCode) {
  return psdCodes.indexOf(wireCode);
}

/** Map a PSD layer-record blend mode name to the internal wire code. */
function fromPSD(psdName) {
  if (psdName == null || psdName === "") return "norm";
  if (psdName === "passThrough") return "pass";
  const index = psdNames.indexOf(psdName);
  if (index === -1) {
    console.warn("[BlendModes] Unknown PSD blend mode, using norm:", psdName);
    return "norm";
  }
  return psdCodes[index];
}

/** Map an internal wire code to the PSD layer-record blend mode name. */
function toPSD(wireCode) {
  if (wireCode === "pass") return "passThrough";
  return psdNames[indexOfWireCode(wireCode)];
}

/** i18n key for a blend mode wire code (for dropdown labels). */
function getName(wireCode) {
  return uiLabels[indexOfWireCode(wireCode)];
}

const BlendModes = {
  groupSizes: BLEND_MODE_GROUP_SIZES,
  psdCodes,
  psdNames,
  uiLabels,
  cssNames,
  fromPSD,
  toPSD,
  getName,
};

export { BlendModes };
