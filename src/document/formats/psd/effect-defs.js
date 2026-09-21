// Layer effect defaults, registry metadata, and descriptor helpers for parsers, renderer, and UI.

import {
  DESCRIPTOR_TEMPLATES,
  EFFECT_DEFAULT_DESCRIPTORS,
  FILL_LAYER_DEFAULTS,
  LMFX_ROOT_DEFAULT,
  STROKE_STYLE_DEFAULT,
} from "./effect-default-data.js";

export const EFFECT_ORDER = [
  "ebbl",
  "FrFX",
  "IrSh",
  "IrGl",
  "ChFX",
  "SoFi",
  "GrFl",
  "patternFill",
  "OrGl",
  "DrSh",
];

export const EFFECT_LIST_KEYS = [
  "ebblMulti",
  "frameFXMulti",
  "innerShadowMulti",
  "IrGlMulti",
  "ChFXMulti",
  "solidFillMulti",
  "gradientFillMulti",
  "patternFillMulti",
  "OrGlMulti",
  "dropShadowMulti",
];

export const EFFECT_DISPLAY_NAMES = [
  "layerEffects.bevelAndEmboss",
  "layerEffects.stroke",
  "layerEffects.innerShadow",
  "layerEffects.innerGlow",
  "layerEffects.satin",
  "layerEffects.colourOverlay",
  "layerEffects.gradientOverlay",
  "layerEffects.patternOverlay",
  "layerEffects.outerGlow",
  "layerEffects.dropShadow",
];

/** Effects that use a single descriptor slot instead of an empty variant list. */
export const SINGLE_SLOT_EFFECT_KINDS = ["DrSh", "IrSh", "SoFi", "GrFl", "FrFX"];

export const SOLID_FILL_PROPERTY_KEYS = ["Clr"];

export const GRADIENT_OVERLAY_PROPERTY_KEYS = [
  "Grad",
  "Rvrs",
  "Type",
  "Algn",
  "Angl",
  "Dthr",
  "Scl",
  "Ofst",
];

export const PATTERN_OVERLAY_PROPERTY_KEYS = ["Ptrn", "Scl", "Algn", "phase"];

export const FILL_PROPERTY_KEY_GROUPS = [
  SOLID_FILL_PROPERTY_KEYS,
  GRADIENT_OVERLAY_PROPERTY_KEYS,
  PATTERN_OVERLAY_PROPERTY_KEYS,
];

export const GRADIENT_TYPE_OPTIONS = {
  types: ["Lnr", "Rdl", "Angl", "Rflc", "Dmnd", "shapeburst"],
  names: [
    "styleOptions.gradientType.linear",
    "styleOptions.gradientType.radial",
    "styleOptions.gradientType.angle",
    "styleOptions.gradientType.reflected",
    "styleOptions.gradientType.diamond",
    "styleOptions.gradientType.shapeBurst",
  ],
};

export const STROKE_POSITION_OPTIONS = {
  types: ["InsF", "CtrF", "OutF"],
  names: [
    "styleOptions.strokePosition.inside",
    "styleOptions.strokePosition.centre",
    "styleOptions.strokePosition.outside",
  ],
  fillKinds: ["SClr", "GrFl", "Ptrn"],
  fillKindLabels: [
    "colour.title",
    "properties.gradient",
    "properties.pattern",
  ],
};

export const GLOW_TECHNIQUE_OPTIONS = {
  types: ["SfBL", "PrBL"],
  names: [
    "styleOptions.softer",
    "styleOptions.precise",
  ],
  sourceTypes: ["SrcC", "SrcE"],
  sourceLabels: [
    "styleOptions.strokePosition.centre",
    "properties.edge",
  ],
};

export const BEVEL_STYLE_OPTIONS = {
  types: ["OtrB", "InrB", "Embs", "PlEb", "strokeEmboss"],
  style: [
    "styleOptions.bevelStyle.outerBevel",
    "styleOptions.bevelStyle.innerBevel",
    "styleOptions.bevelStyle.emboss",
    "styleOptions.bevelStyle.pillowEmboss",
    "styleOptions.bevelStyle.strokeEmboss",
  ],
  techniqueTypes: ["SfBL", "PrBL", "Slmt"],
  techniqueLabels: [
    "styleOptions.bevelTechnique.smooth",
    "styleOptions.bevelTechnique.chiselHard",
    "styleOptions.bevelTechnique.chiselSoft",
  ],
  dir: [
    "styleOptions.up",
    "styleOptions.down",
  ],
};

export const STROKE_STYLE_REGISTRY = {
  lineCapTypes: [
    "strokeStyleButtCap",
    "strokeStyleRoundCap",
    "strokeStyleSquareCap",
  ],
  alignTypes: [
    "strokeStyleAlignInside",
    "strokeStyleAlignCenter",
    "strokeStyleAlignOutside",
  ],
  join: [
    "strokeStyleMiterJoin",
    "strokeStyleRoundJoin",
    "strokeStyleBevelJoin",
  ],
  fillLayerTypes: ["solidColorLayer", "gradientLayer", "patternLayer"],
};

export function effectOrderIndex(effectClassId) {
  const index = EFFECT_ORDER.indexOf(effectClassId);
  if (index === -1) {
    throw new Error(`Unknown layer effect classID: ${effectClassId}`);
  }
  return index;
}

export function effectListKeyForClass(effectClassId) {
  return EFFECT_LIST_KEYS[effectOrderIndex(effectClassId)];
}

function cloneDescriptorTree(descriptor) {
  return JSON.parse(JSON.stringify(descriptor));
}

/** Deep-cloned lmfx root descriptor before per-effect lists are attached. */
export function createLmfxRootTemplate() {
  return cloneDescriptorTree(LMFX_ROOT_DEFAULT);
}

/** Deep-cloned default descriptor for a layer-effect classID (ebbl, DrSh, …). */
export function getEffectDefault(effectClassId) {
  return cloneDescriptorTree(EFFECT_DEFAULT_DESCRIPTORS[effectOrderIndex(effectClassId)]);
}

/** Deep-cloned default descriptor by index into effect order. */
export function getEffectDefaultByOrderIndex(orderIndex) {
  return cloneDescriptorTree(EFFECT_DEFAULT_DESCRIPTORS[orderIndex]);
}

/** JSON-serialized default descriptor for a layer-effect classID. */
export function getEffectDefaultJson(effectClassId) {
  return JSON.stringify(getEffectDefault(effectClassId));
}

export function getEffectDefaultJsonByOrderIndex(orderIndex) {
  return JSON.stringify(getEffectDefaultByOrderIndex(orderIndex));
}

/** Deep-cloned default vector stroke style (vstk descriptor). */
export function getStrokeStyleDefault() {
  return cloneDescriptorTree(STROKE_STYLE_DEFAULT);
}

/** Deep-cloned fill-layer default by kind index (0 solid, 1 gradient, 2 pattern). */
export function getFillLayerDefault(fillKindIndex) {
  return cloneDescriptorTree(FILL_LAYER_DEFAULTS[fillKindIndex]);
}

const LayerEffectDefs = {
  order: EFFECT_ORDER,
  effectKeys: EFFECT_LIST_KEYS,
  names: EFFECT_DISPLAY_NAMES,
  singleSlotEffectKinds: SINGLE_SLOT_EFFECT_KINDS,
  solidFillPropertyKeys: SOLID_FILL_PROPERTY_KEYS,
  gradientOverlayPropertyKeys: GRADIENT_OVERLAY_PROPERTY_KEYS,
  patternOverlayPropertyKeys: PATTERN_OVERLAY_PROPERTY_KEYS,
  fillPropertyKeyGroups: FILL_PROPERTY_KEY_GROUPS,
  gradientTypeOptions: GRADIENT_TYPE_OPTIONS,
  strokePositionOptions: STROKE_POSITION_OPTIONS,
  glowTechniqueOptions: GLOW_TECHNIQUE_OPTIONS,
  bevelStyleOptions: BEVEL_STYLE_OPTIONS,
  descriptorTemplates: DESCRIPTOR_TEMPLATES,
  fillLayerDefaults: FILL_LAYER_DEFAULTS.map((entry) => cloneDescriptorTree(entry)),
  StrokeStyleDefs: {
    lineCapTypes: STROKE_STYLE_REGISTRY.lineCapTypes,
    alignTypes: STROKE_STYLE_REGISTRY.alignTypes,
    join: STROKE_STYLE_REGISTRY.join,
    fillLayerTypes: STROKE_STYLE_REGISTRY.fillLayerTypes,
    default: cloneDescriptorTree(STROKE_STYLE_DEFAULT),
  },
  createLmfxRootTemplate,
  getEffectDefault,
  getEffectDefaultByOrderIndex,
  getEffectDefaultJson,
  getEffectDefaultJsonByOrderIndex,
  getStrokeStyleDefault,
  getFillLayerDefault,
};


export { LayerEffectDefs };
