/**
 * GIMP XCF property type IDs (PropType) and related constants.
 * @see https://github.com/GNOME/gimp/blob/master/app/xcf/xcf-private.h
 */
const XcfPropType = {
  PROP_END: 0,
  PROP_COLORMAP: 1,
  PROP_ACTIVE_LAYER: 2,
  PROP_ACTIVE_CHANNEL: 3,
  PROP_SELECTION: 4,
  PROP_FLOATING_SELECTION: 5,
  PROP_OPACITY: 6,
  PROP_MODE: 7,
  PROP_VISIBLE: 8,
  PROP_LINKED: 9,
  PROP_LOCK_ALPHA: 10,
  PROP_APPLY_MASK: 11,
  PROP_EDIT_MASK: 12,
  PROP_SHOW_MASK: 13,
  PROP_SHOW_MASKED: 14,
  PROP_OFFSETS: 15,
  PROP_COLOR: 16,
  PROP_COMPRESSION: 17,
  PROP_GUIDES: 18,
  PROP_RESOLUTION: 19,
  PROP_TATTOO: 20,
  PROP_PARASITES: 21,
  PROP_UNIT: 22,
  PROP_PATHS: 23,
  PROP_USER_UNIT: 24,
  PROP_VECTORS: 25,
  PROP_TEXT_LAYER_FLAGS: 26,
  PROP_OLD_SAMPLE_POINTS: 27,
  PROP_LOCK_CONTENT: 28,
  PROP_GROUP_ITEM: 29,
  PROP_ITEM_PATH: 30,
  PROP_GROUP_ITEM_FLAGS: 31,
  PROP_LOCK_POSITION: 32,
  PROP_FLOAT_OPACITY: 33,
  PROP_COLOR_TAG: 34,
  PROP_COMPOSITE_MODE: 35,
  PROP_COMPOSITE_SPACE: 36,
  PROP_BLEND_SPACE: 37,
  PROP_FLOAT_COLOR: 38,

  /** XcfCompressionType */
  COMPRESS_NONE: 0,
  COMPRESS_RLE: 1,
  COMPRESS_ZLIB: 2,
  COMPRESS_FRACTAL: 3,

  ORIENTATION_HORIZONTAL: 1,
  ORIENTATION_VERTICAL: 2,
  STROKETYPE_STROKE: 0,
  STROKETYPE_BEZIER_STROKE: 1,
  GROUP_ITEM_EXPANDED: 1,

  /** GIMP layer mode index → 4-char PSD blend mode code. */
  psdBlendModeCodes: "norm,diss,norm,mul ,scrn,over,diff,lddg,fsub,dark,lite,hue ,sat ,colr,lum ,fdiv,lddg,idiv,hLit,sLit,fdiv,pLit,norm,over,hue ,hue ,colr,lite,norm,norm,mul ,scrn,diff,lddg,fsub,dark,lite,hue ,sat ,colr,lum ,fdiv,lddg,idiv,hLit,sLit,fdiv,pLit,vLit,pLit,lLit,hMix,smud,lbrn,lum ,lum ,lum ,lum ,norm,norm,norm,pass".split(","),
};

export { XcfPropType };
