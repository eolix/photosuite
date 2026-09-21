/**
 * Camera Raw filter wire shape, defaults, and panel layout.
 *
 * FilterDefs and panel registration use the short app id {@link CAMERA_RAW_APP_ID};
 * persisted smart-filter descriptors carry Adobe's stringID class
 * {@link CAMERA_RAW_WIRE_CLASS_ID} with Camera Raw property keys (`Ex12`, `Temp`,
 * `HA_R`, …) as typed `{ t, v }` nodes.
 *
 * {@link CAMERA_RAW_SECTIONS} is the single description of the develop panels:
 * the dialog builds its controls from it, and the raster applicator reads the
 * same slider keys and the same {@link CAMERA_RAW_SECTIONS}`[].enableKey`
 * switches, so a panel switched off in the dialog is switched off when the
 * filter is committed.
 */

/** App / FilterDefs / panel constructor key. */
export const CAMERA_RAW_APP_ID = "cameraRaw";

/** Adobe Action Manager stringID written on `Fltr.classID`. */
export const CAMERA_RAW_WIRE_CLASS_ID = "Adobe Camera Raw Filter";

/**
 * What the descriptor is developing, written to `CMod`.
 *
 * `Filter` is a rendered layer: Temperature and Tint are relative offsets and
 * the raster stage performs white balance and exposure itself. `Raw` is a
 * camera file the RAW decoder has already white-balanced and exposed in linear
 * light against the camera's own primaries, so Temperature is an absolute
 * colour temperature in kelvin and the raster stage leaves both alone.
 */
export const CAMERA_RAW_MODE_FILTER = "Filter";
export const CAMERA_RAW_MODE_RAW = "Raw";

/**
 * Temperature / Tint / Exposure ranges when developing a camera file, replacing
 * the relative ranges the sliders carry in {@link CAMERA_RAW_SECTIONS}.
 */
export const RAW_SLIDER_RANGES = {
  Temp: { min: 2000, max: 13000, decimals: 0 },
  Tint: { min: -150, max: 150, decimals: 0 },
  Ex12: { min: -5, max: 5, decimals: 2 },
};

/** Absolute Temperature / Tint for each named preset when developing a camera file. */
export const RAW_WHITE_BALANCE_PRESETS = {
  Dayl: [5500, 10],
  Cldy: [6500, 10],
  Shd: [7500, 10],
  Tung: [2850, 0],
  Flur: [3800, 21],
  Flsh: [5500, 0],
};

export const WHITE_BALANCE_ENUM = "WBal";
export const WHITE_BALANCE_AS_SHOT = "AsSh";
/** Custom white-balance enum, set whenever Temperature or Tint is moved by hand. */
export const WHITE_BALANCE_CUSTOM = "Cst";

/** Dropdown labels paired with their WBal enum value. */
export const WHITE_BALANCE_OPTIONS = [
  ["As Shot", "AsSh"],
  ["Auto", "Auto"],
  ["Daylight", "Dayl"],
  ["Cloudy", "Cldy"],
  ["Shade", "Shd"],
  ["Tungsten", "Tung"],
  ["Fluorescent", "Flur"],
  ["Flash", "Flsh"],
  ["Custom", "Cst"],
];

/**
 * Temperature / Tint pairs applied when a named white-balance mode is chosen.
 * The filter develops an already-rendered layer, so the values are relative to
 * the layer's own white: As Shot is the untouched plate, and Auto is resolved
 * from the image by the dialog rather than from this table.
 */
export const WHITE_BALANCE_PRESETS = {
  AsSh: [0, 0],
  Dayl: [8, 4],
  Cldy: [22, 6],
  Shd: [38, 10],
  Tung: [-48, 6],
  Flur: [-30, 28],
  Flsh: [16, 2],
};

/** Upright modes written to `PerU`. */
export const UPRIGHT_MODES = [
  ["Off", 0],
  ["Auto", 1],
  ["Level", 2],
  ["Vertical", 3],
  ["Full", 4],
  ["Guided", 5],
];

/** Camera Raw process versions, indexed by the `PrVN` value they write. */
export const PROCESS_VERSIONS = [
  ["Version 5 (Current)", 5],
  ["Version 4", 4],
  ["Version 3", 3],
  ["Version 2 (2012)", 2],
  ["Version 1 (2010)", 1],
];

/**
 * Colour Mixer bands: label, the suffix shared by the `HA_` / `SA_` / `LA_`
 * keys, the hue the band is centred on, and the half-width in degrees over
 * which its weight falls to zero. The dialog tints each row's track from the
 * centre hue; the applicator weights each pixel with the same numbers.
 */
export const COLOR_MIXER_BANDS = [
  { label: "Reds", suffix: "R", centreHue: 0, halfWidth: 30 },
  { label: "Oranges", suffix: "O", centreHue: 30, halfWidth: 30 },
  { label: "Yellows", suffix: "Y", centreHue: 60, halfWidth: 30 },
  { label: "Greens", suffix: "G", centreHue: 120, halfWidth: 40 },
  { label: "Aquas", suffix: "A", centreHue: 180, halfWidth: 30 },
  { label: "Blues", suffix: "B", centreHue: 240, halfWidth: 40 },
  { label: "Purples", suffix: "P", centreHue: 280, halfWidth: 30 },
  { label: "Magentas", suffix: "M", centreHue: 320, halfWidth: 30 },
];

/** Colour Mixer channels: tab label, key prefix, and the track style per row. */
export const COLOR_MIXER_CHANNELS = [
  { label: "Hue", prefix: "HA_", track: "bandHue" },
  { label: "Saturation", prefix: "SA_", track: "bandSaturation" },
  { label: "Luminance", prefix: "LA_", track: "bandLuminance" },
];

function longNode(value) {
  return { t: "long", v: value | 0 };
}

function doubNode(value) {
  return { t: "doub", v: +value };
}

function boolNode(value) {
  return { t: "bool", v: !!value };
}

function textNode(value) {
  return { t: "TEXT", v: String(value) };
}

/** Enum nodes in this codebase nest the type id as the value key. */
function enumNode(typeId, valueId) {
  return { t: "enum", v: { [typeId]: valueId } };
}

function intListNode(values) {
  const entries = [];
  for (let i = 0; i < values.length; i++) entries.push(longNode(values[i]));
  return { t: "VlLs", v: entries };
}

/** Read a scalar out of a typed descriptor node, falling back when absent. */
export function readScalar(descriptor, key, fallback) {
  const node = descriptor && descriptor[key];
  if (node == null) return fallback;
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (typeof node.v === "number" || typeof node.v === "boolean") return node.v;
  if (node.t === "TEXT") return node.v;
  return fallback;
}

/** Read an enum node's value id. */
export function readEnumValue(descriptor, key, fallback) {
  const node = descriptor && descriptor[key];
  if (node == null) return fallback;
  if (typeof node === "string") return node;
  if (node.t === "enum" && node.v) {
    if (node.v[key] != null) return node.v[key];
    for (const nestedKey in node.v) return node.v[nestedKey];
  }
  return fallback;
}

export function isCameraRawFilterClassId(classId) {
  return classId === CAMERA_RAW_APP_ID || classId === CAMERA_RAW_WIRE_CLASS_ID;
}

/** Map a PSD / Action Manager classID onto the app FilterDefs id. */
export function normalizeCameraRawClassId(classId) {
  return isCameraRawFilterClassId(classId) ? CAMERA_RAW_APP_ID : classId;
}

/** @typedef {{ key: string, label: string, min: number, max: number, decimals?: number, track?: string, trackHue?: number }} CameraRawSliderSpec */
/** @typedef {{ heading?: string, sliders: CameraRawSliderSpec[] }} CameraRawSliderGroup */

/**
 * Develop panels in dialog order.
 *
 * `enableKey` is the descriptor boolean the panel's visibility switch writes;
 * `kind` marks the three panels that carry controls beyond plain sliders
 * (white balance, the mixer's band tabs, the Upright buttons).
 */
export const CAMERA_RAW_SECTIONS = [
  {
    id: "basic",
    label: "Basic",
    kind: "basic",
    enableKey: "EnableBasic",
    groups: [
      {
        sliders: [
          { key: "Temp", label: "Temperature", min: -100, max: 100, track: "temperature" },
          { key: "Tint", label: "Tint", min: -100, max: 100, track: "tint" },
        ],
      },
      {
        sliders: [
          { key: "Ex12", label: "Exposure", min: -5, max: 5, decimals: 2, track: "tone" },
          { key: "Cr12", label: "Contrast", min: -100, max: 100, track: "tone" },
          { key: "Hi12", label: "Highlights", min: -100, max: 100, track: "tone" },
          { key: "Sh12", label: "Shadows", min: -100, max: 100, track: "tone" },
          { key: "Wh12", label: "Whites", min: -100, max: 100, track: "tone" },
          { key: "Bk12", label: "Blacks", min: -100, max: 100, track: "tone" },
        ],
      },
      {
        sliders: [
          { key: "CrTx", label: "Texture", min: -100, max: 100, track: "tone" },
          { key: "Cl12", label: "Clarity", min: -100, max: 100, track: "tone" },
          { key: "Dhze", label: "Dehaze", min: -100, max: 100, track: "tone" },
        ],
      },
      {
        sliders: [
          { key: "Vibr", label: "Vibrance", min: -100, max: 100, track: "saturation" },
          { key: "Strt", label: "Saturation", min: -100, max: 100, track: "saturation" },
        ],
      },
    ],
  },
  {
    id: "curve",
    label: "Curve",
    enableKey: "EnableToneCurve",
    groups: [
      {
        sliders: [
          { key: "PC_H", label: "Highlights", min: -100, max: 100, track: "tone" },
          { key: "PC_L", label: "Lights", min: -100, max: 100, track: "tone" },
          { key: "PC_D", label: "Darks", min: -100, max: 100, track: "tone" },
          { key: "PC_S", label: "Shadows", min: -100, max: 100, track: "tone" },
        ],
      },
    ],
  },
  {
    id: "detail",
    label: "Detail",
    enableKey: "EnableDetail",
    groups: [
      {
        sliders: [
          { key: "Shrp", label: "Sharpening", min: 0, max: 150, track: "tone" },
        ],
      },
      {
        heading: "Noise Reduction",
        sliders: [
          { key: "LNR", label: "Luminance", min: 0, max: 100, track: "tone" },
          { key: "CNR", label: "Colour", min: 0, max: 100, track: "tone" },
        ],
      },
    ],
  },
  {
    id: "mixer",
    label: "Color Mixer",
    kind: "colorMixer",
    enableKey: "EnableColorAdjustments",
  },
  {
    id: "split",
    label: "Split Toning",
    enableKey: "EnableSplitToning",
    groups: [
      {
        heading: "Highlights",
        sliders: [
          { key: "STHH", label: "Hue", min: 0, max: 360, track: "hueWheel" },
          { key: "STHS", label: "Saturation", min: 0, max: 100, track: "tone" },
        ],
      },
      {
        heading: "Shadows",
        sliders: [
          { key: "STSH", label: "Hue", min: 0, max: 360, track: "hueWheel" },
          { key: "STSS", label: "Saturation", min: 0, max: 100, track: "tone" },
        ],
      },
      {
        sliders: [
          { key: "STB", label: "Balance", min: -100, max: 100, track: "tone" },
        ],
      },
    ],
  },
  {
    id: "optics",
    label: "Optics",
    enableKey: "EnableLensCorrections",
    groups: [
      {
        sliders: [
          { key: "MDis", label: "Distortion", min: -100, max: 100, track: "tone" },
          { key: "VigA", label: "Vignetting", min: -100, max: 100, track: "tone" },
        ],
      },
    ],
  },
  {
    id: "geometry",
    label: "Geometry",
    kind: "geometry",
    enableKey: "EnableGeometry",
  },
  {
    id: "effects",
    label: "Effects",
    enableKey: "EnableEffects",
    groups: [
      {
        heading: "Grain",
        sliders: [
          { key: "GRNA", label: "Amount", min: 0, max: 100, track: "tone" },
          { key: "GrainSize", label: "Size", min: 0, max: 100, track: "tone" },
          { key: "GrainFrequency", label: "Roughness", min: 0, max: 100, track: "tone" },
        ],
      },
      {
        heading: "Post Crop Vignetting",
        sliders: [
          { key: "PCVA", label: "Amount", min: -100, max: 100, track: "tone" },
        ],
      },
    ],
  },
  {
    id: "calibration",
    label: "Calibration",
    kind: "calibration",
    enableKey: "EnableCalibration",
    groups: [
      {
        heading: "Shadows",
        sliders: [
          { key: "ShdT", label: "Tint", min: -100, max: 100, track: "tint" },
        ],
      },
      {
        heading: "Red Primary",
        sliders: [
          { key: "RHue", label: "Hue", min: -100, max: 100, track: "primaryHue", trackHue: 0 },
          { key: "RSat", label: "Saturation", min: -100, max: 100, track: "primarySaturation", trackHue: 0 },
        ],
      },
      {
        heading: "Green Primary",
        sliders: [
          { key: "GHue", label: "Hue", min: -100, max: 100, track: "primaryHue", trackHue: 120 },
          { key: "GSat", label: "Saturation", min: -100, max: 100, track: "primarySaturation", trackHue: 120 },
        ],
      },
      {
        heading: "Blue Primary",
        sliders: [
          { key: "BHue", label: "Hue", min: -100, max: 100, track: "primaryHue", trackHue: 240 },
          { key: "BSat", label: "Saturation", min: -100, max: 100, track: "primarySaturation", trackHue: 240 },
        ],
      },
    ],
  },
];

/**
 * Flat Adobe-shaped default descriptor. Numeric ranges match the Camera Raw
 * filter's relative Temperature / Tint and its PV2012-era tone controls.
 */
export function createCameraRawDefaultDescriptor() {
  const descriptor = {
    __name: "Camera Raw Filter",
    classID: CAMERA_RAW_WIRE_CLASS_ID,
    CMod: textNode(CAMERA_RAW_MODE_FILTER),
    Sett: enumNode("Sett", "Cst"),
    WBal: enumNode(WHITE_BALANCE_ENUM, WHITE_BALANCE_AS_SHOT),
    Temp: longNode(0),
    Tint: longNode(0),
    Ex12: doubNode(0),
    Cr12: longNode(0),
    Hi12: longNode(0),
    Sh12: longNode(0),
    Wh12: longNode(0),
    Bk12: longNode(0),
    CrTx: longNode(0),
    Cl12: longNode(0),
    Dhze: longNode(0),
    Vibr: longNode(0),
    Strt: longNode(0),
    PC_S: longNode(0),
    PC_D: longNode(0),
    PC_L: longNode(0),
    PC_H: longNode(0),
    PC_1: longNode(25),
    PC_2: longNode(50),
    PC_3: longNode(75),
    Shrp: longNode(0),
    ShpR: doubNode(1),
    ShpD: longNode(25),
    ShpM: longNode(0),
    LNR: longNode(0),
    CNR: longNode(0),
    STHH: longNode(0),
    STHS: longNode(0),
    STB: longNode(0),
    STSH: longNode(0),
    STSS: longNode(0),
    MDis: longNode(0),
    VigA: longNode(0),
    PerV: longNode(0),
    PerH: longNode(0),
    PerR: doubNode(0),
    PerS: longNode(100),
    PerA: longNode(0),
    PerU: longNode(0),
    PerX: doubNode(0),
    PerY: doubNode(0),
    AuCA: longNode(0),
    PCVA: longNode(0),
    GRNA: longNode(0),
    GrainSize: longNode(25),
    GrainFrequency: longNode(50),
    ShdT: longNode(0),
    RHue: longNode(0),
    RSat: longNode(0),
    GHue: longNode(0),
    GSat: longNode(0),
    BHue: longNode(0),
    BSat: longNode(0),
    Crv: intListNode([0, 0, 255, 255]),
    CrvR: intListNode([0, 0, 255, 255]),
    CrvG: intListNode([0, 0, 255, 255]),
    CrvB: intListNode([0, 0, 255, 255]),
    CrVe: textNode("15.2"),
    PrVN: longNode(5),
  };
  for (let bandIdx = 0; bandIdx < COLOR_MIXER_BANDS.length; bandIdx++) {
    const suffix = COLOR_MIXER_BANDS[bandIdx].suffix;
    for (let channelIdx = 0; channelIdx < COLOR_MIXER_CHANNELS.length; channelIdx++) {
      descriptor[COLOR_MIXER_CHANNELS[channelIdx].prefix + suffix] = longNode(0);
    }
  }
  for (let sectionIdx = 0; sectionIdx < CAMERA_RAW_SECTIONS.length; sectionIdx++) {
    descriptor[CAMERA_RAW_SECTIONS[sectionIdx].enableKey] = boolNode(true);
  }
  return descriptor;
}

/**
 * Every slider the dialog puts on screen, in panel order. The Colour Mixer's
 * rows are generated from the band and channel tables rather than written out
 * in {@link CAMERA_RAW_SECTIONS}, so they are expanded here too — anything
 * reasoning about "all the sliders" has to see all twenty-four of them.
 */
export function listCameraRawSliderSpecs() {
  const specs = [];
  for (let sectionIdx = 0; sectionIdx < CAMERA_RAW_SECTIONS.length; sectionIdx++) {
    const section = CAMERA_RAW_SECTIONS[sectionIdx];
    if (section.kind === "colorMixer") {
      for (let channelIdx = 0; channelIdx < COLOR_MIXER_CHANNELS.length; channelIdx++) {
        const channel = COLOR_MIXER_CHANNELS[channelIdx];
        for (let bandIdx = 0; bandIdx < COLOR_MIXER_BANDS.length; bandIdx++) {
          const band = COLOR_MIXER_BANDS[bandIdx];
          specs.push({
            key: channel.prefix + band.suffix,
            label: band.label,
            min: -100,
            max: 100,
            track: channel.track,
            trackHue: band.centreHue,
          });
        }
      }
      continue;
    }
    const groups = section.groups;
    if (!groups) continue;
    for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
      const sliders = groups[groupIdx].sliders;
      for (let sliderIdx = 0; sliderIdx < sliders.length; sliderIdx++) specs.push(sliders[sliderIdx]);
    }
  }
  return specs;
}

/** True when the panel owning `enableKey` should contribute to the render. */
export function isSectionEnabled(scalars, enableKey) {
  return scalars[enableKey] !== false;
}

/** Write widget values onto a typed Adobe descriptor. */
export function writeCameraRawScalars(descriptor, scalars) {
  for (const key in scalars) {
    if (!Object.prototype.hasOwnProperty.call(scalars, key)) continue;
    const value = scalars[key];
    if (key === "WBal") descriptor.WBal = enumNode(WHITE_BALANCE_ENUM, value);
    else if (key === "CMod") descriptor.CMod = textNode(value);
    else if (key === "Ex12" || key === "ShpR" || key === "PerR") descriptor[key] = doubNode(value);
    else if (typeof value === "boolean") descriptor[key] = boolNode(value);
    else descriptor[key] = longNode(value);
  }
  return descriptor;
}

/** Collect the numeric, enum, and switch values the raster applicator reads. */
export function collectCameraRawScalars(descriptor) {
  const defaults = createCameraRawDefaultDescriptor();
  const scalars = Object.create(null);
  for (const key in defaults) {
    if (key === "__name" || key === "classID") continue;
    if (key === "WBal") {
      scalars.WBal = readEnumValue(descriptor, "WBal", WHITE_BALANCE_AS_SHOT);
      continue;
    }
    if (key === "CMod") {
      scalars.CMod = readScalar(descriptor, "CMod", CAMERA_RAW_MODE_FILTER);
      continue;
    }
    if (key === "Sett" || key === "CrVe" ||
        key === "Crv" || key === "CrvR" || key === "CrvG" || key === "CrvB") {
      continue;
    }
    scalars[key] = readScalar(descriptor, key, readScalar(defaults, key, 0));
  }
  return scalars;
}
