import { getIconUrl, isIconTinted } from "../../assets/icon-registry.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { rgbToHex } from "../../engine/compositing/color-math.js";

// Theme palettes and CSS custom-property application for the shell UI.
//
// A theme declares a small set of base colours; every other token the
// stylesheet consumes (hover fills, hairlines, muted text, menu surfaces,
// accent contrast) is derived here so a new palette needs only the base set
// and stays internally consistent.

function mixChannel(from, to, amount) {
  return Math.round(from + (to - from) * amount);
}

function mixRgb(fromRgb, toRgb, amount) {
  return (
    (mixChannel((fromRgb >> 16) & 255, (toRgb >> 16) & 255, amount) << 16) |
    (mixChannel((fromRgb >> 8) & 255, (toRgb >> 8) & 255, amount) << 8) |
    mixChannel(fromRgb & 255, toRgb & 255, amount)
  );
}

function lightenRgb(rgb, amount) {
  return mixRgb(rgb, 0xffffff, amount);
}

function hex(rgb) {
  return "#" + rgbToHex(rgb);
}

function rgba(rgb, alpha) {
  return "rgba(" + ((rgb >> 16) & 255) + "," + ((rgb >> 8) & 255) + "," + (rgb & 255) + "," + alpha + ")";
}

/** Perceived brightness on 0..1, used to pick readable text over a fill. */
function relativeLuminance(rgb) {
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) / 255;
}

const THEME_ICON_PATHS =
  "lrs/eye lrs/arrow_down lrs/arrow_right lrs/chain lrs/link lrs/clipping lrs/lock lrs/fx lrs/folder cross tools/cshape checkmark".split(
    " "
  );

function applyThemeBaseVariables(styleEl, themeData) {
  const panel = themeData["--bg-panel"];
  const chrome = themeData["--bg-color"];
  const text = themeData["--text-color"];
  const input = themeData["--bg-input"];
  const accent = themeData["--accent"];

  styleEl.setProperty("--bg-color", hex(chrome));
  styleEl.setProperty("--bg-panel", hex(panel));
  styleEl.setProperty("--bg-canvas", hex(themeData["--bg-canvas"]));
  styleEl.setProperty("--bg-input", hex(input));
  styleEl.setProperty("--bg-bbtn", hex(themeData["--bg-bbtn"]));
  styleEl.setProperty("--bg-bbtnOver", hex(themeData["--bg-bbtnOver"]));
  styleEl.setProperty("--brdr", hex(themeData["--brdr"]));
  styleEl.setProperty("--text-color", hex(text));
  styleEl.setProperty("--brdrLgt", "rgba(255,255,255," + themeData["--brdrLgt"] + ")");
  styleEl.setProperty("--brdrDrk", "rgba(  0,  0,  0," + themeData["--brdrDrk"] + ")");
  styleEl.setProperty("--alphaDark", "" + themeData["--alphaDark"]);
  styleEl.setProperty("--gs-invert", "" + themeData["--gs-invert"]);

  // Layered surfaces. Hover and active fills are translucent so they read
  // correctly over any surface beneath them; mixing toward the text colour
  // lifts a fill on dark palettes and deepens it on light ones.
  styleEl.setProperty("--surface-raised", hex(mixRgb(panel, text, 0.06)));
  styleEl.setProperty("--surface-subtle", rgba(text, 0.05));
  styleEl.setProperty("--surface-hover", rgba(text, 0.09));
  styleEl.setProperty("--surface-active", rgba(text, 0.16));
  styleEl.setProperty("--surface-sunken", hex(mixRgb(panel, 0x000000, 0.18)));
  styleEl.setProperty("--menu-bg", hex(mixRgb(panel, text, 0.05)));

  // Separators. `--hairline` draws every 1px rule in the chrome; the strong
  // variant marks structural edges (bar boundaries, docked column gutters).
  styleEl.setProperty("--hairline", rgba(text, 0.13));
  styleEl.setProperty("--hairline-strong", rgba(text, 0.22));
  // Groove closing the top chrome. Cut from the canvas, the darkest plane in
  // the palette, so it stays the darkest line on the screen and the workspace
  // below reads as a separate plane rather than a continuation of the bars.
  styleEl.setProperty("--chrome-groove", hex(mixRgb(themeData["--bg-canvas"], 0x000000, 0.25)));

  styleEl.setProperty("--text-muted", hex(mixRgb(text, panel, 0.4)));
  styleEl.setProperty("--text-faint", hex(mixRgb(text, panel, 0.62)));

  styleEl.setProperty("--modal-border", hex(lightenRgb(panel, 0.26)));
  styleEl.setProperty("--input-border", hex(mixRgb(input, text, 0.24)));

  styleEl.setProperty("--accent", hex(accent));
  styleEl.setProperty("--accent-subtle", rgba(accent, 0.18));
  styleEl.setProperty("--accent-muted", rgba(accent, 0.34));
  styleEl.setProperty("--accent-focus-ring", rgba(accent, 0.42));
  styleEl.setProperty("--accent-contrast", relativeLuminance(accent) > 0.62 ? "#101216" : "#ffffff");

  // Tells the engine which way to render the controls it paints itself —
  // checkbox glyphs, native select popups, default scrollbars.
  styleEl.setProperty("color-scheme", relativeLuminance(chrome) > 0.5 ? "light" : "dark");
}

/**
 * Colours for widgets that paint into a `<canvas>` (curve editors, histogram
 * plates, level ramps). CSS custom properties are invisible to canvas 2D, so
 * the active theme is resolved into concrete strings here and refreshed by
 * {@link ThemeConfig.applyTheme}.
 */
function buildCanvasPalette(themeData) {
  const panel = themeData["--bg-panel"];
  const text = themeData["--text-color"];
  const input = themeData["--bg-input"];
  const accent = themeData["--accent"];
  return {
    /** Chart plate behind a histogram or curve grid. */
    plate: hex(input),
    /** Interior grid lines. */
    grid: rgba(text, 0.16),
    /** Plate outline. */
    frame: rgba(text, 0.28),
    /** Curve / trace stroke. */
    trace: hex(text),
    /** Histogram fill for the composite channel. */
    histogram: rgba(text, 0.34),
    /** Per-channel histogram fills: composite, red, green, blue. */
    histogramChannels: [rgba(text, 0.34), "#e0605f", "#57bf6d", "#5c92e8"],
    /** Draggable point / level handle. */
    handleFill: hex(mixRgb(input, text, 0.1)),
    handleStroke: rgba(text, 0.75),
    handleActiveFill: hex(accent),
    /** Label text drawn onto a canvas. */
    text: hex(text),
    muted: hex(mixRgb(text, panel, 0.4)),
  };
}

let activeCanvasPalette = null;

function resolveThemeIconSizePx() {
  let iconSize = 20;
  if (1 < getDevicePixelRatio() && getDevicePixelRatio() < 1.5) {
    iconSize /= getDevicePixelRatio();
  }
  return iconSize;
}

function applyThemeIconVariables(styleEl, themeData) {
  styleEl.setProperty("--img20", resolveThemeIconSizePx() + "px");
  for (let iconIdx = 0; iconIdx < THEME_ICON_PATHS.length; iconIdx++) {
    const iconPath = THEME_ICON_PATHS[iconIdx];
    const iconName = iconPath.split("/").pop();
    const invertValue = isIconTinted(iconPath) ? themeData["--gs-invert"] : "0";
    styleEl.setProperty("--icon_" + iconName, "url(" + getIconUrl(iconPath) + ")");
    styleEl.setProperty("--icon_" + iconName + "_invrt", invertValue);
  }
}

function applyThemeColorMetaTag(themeData) {
  const metaColorTag = document.querySelector("meta[name=theme-color]");
  if (metaColorTag) metaColorTag.setAttribute("content", "#" + rgbToHex(themeData["--bg-color"]));
}

export const ThemeConfig = {};

ThemeConfig.applyTheme = function (themeIndex) {
  const themeData = ThemeConfig.themes[themeIndex];
  const styleEl = document.documentElement.style;
  applyThemeBaseVariables(styleEl, themeData);
  applyThemeIconVariables(styleEl, themeData);
  applyThemeColorMetaTag(themeData);
  activeCanvasPalette = buildCanvasPalette(themeData);
};

/**
 * Canvas-drawing colours for the theme in effect. Falls back to the first
 * palette when called before the first {@link ThemeConfig.applyTheme}.
 * @returns {object}
 */
ThemeConfig.getCanvasPalette = function () {
  if (activeCanvasPalette == null) activeCanvasPalette = buildCanvasPalette(ThemeConfig.themes[0]);
  return activeCanvasPalette;
};

ThemeConfig.themes = [
  {
    name: "Midnight",
    "--bg-color": 1974567, // #1E2127
    "--bg-panel": 1645602, // #191C22
    "--bg-canvas": 1316637, // #14171D
    "--bg-input": 2435376, // #252930
    "--bg-bbtn": 2764602, // #2A2F3A
    "--bg-bbtnOver": 3422791, // #343A47
    "--brdrLgt": 0.07,
    "--brdrDrk": 0.55,
    "--alphaDark": 0.3,
    "--text-color": 13949669, // #D4DAE5
    "--gs-invert": 0.86,
    "--brdr": 2238000, // #222630
    "--accent": 3642623, // #3794FF
  },
  {
    name: "Anthracite",
    "--bg-color": 3684408, // #383838
    "--bg-panel": 3026478, // #2E2E2E
    "--bg-canvas": 2105376, // #202020
    "--bg-input": 2500134, // #262626
    "--bg-bbtn": 4539717, // #454545
    "--bg-bbtnOver": 5395026, // #525252
    "--brdrLgt": 0.09,
    "--brdrDrk": 0.45,
    "--alphaDark": 0.22,
    "--text-color": 14474460, // #DCDCDC
    "--gs-invert": 0.8,
    "--brdr": 2368548, // #242424
    "--accent": 4886754, // #4A90E2
  },
  {
    name: "Slate",
    "--bg-color": 3554637, // #363D4D
    "--bg-panel": 2830914, // #2B3242
    "--bg-canvas": 1975604, // #1E2534
    "--bg-input": 2304568, // #232A38
    "--bg-bbtn": 4081497, // #3E4759
    "--bg-bbtnOver": 4937064, // #4B5568
    "--brdrLgt": 0.09,
    "--brdrDrk": 0.48,
    "--alphaDark": 0.25,
    "--text-color": 15002098, // #E4E9F2
    "--gs-invert": 0.88,
    "--brdr": 2238777, // #222939
    "--accent": 6000111, // #5B8DEF
  },
  {
    name: "Pearl",
    "--bg-color": 15921911, // #F2F2F7
    "--bg-panel": 15329774, // #E9E9EE
    "--bg-canvas": 13355986, // #CBCBD2
    "--bg-input": 16777215, // #FFFFFF
    "--bg-bbtn": 16448252, // #FAFAFC
    "--bg-bbtnOver": 15527153, // #ECECF1
    "--brdrLgt": 0.6,
    "--brdrDrk": 0.08,
    "--alphaDark": 0.07,
    "--text-color": 1842206, // #1C1C1E
    "--gs-invert": 0.12,
    "--brdr": 13816536, // #D2D2D8
    "--accent": 31487, // #007AFF
  },
  {
    name: "Aubergine",
    "--bg-color": 4207434, // #40334A
    "--bg-panel": 3286329, // #322539
    "--bg-canvas": 2497584, // #261C30
    "--bg-input": 3089208, // #2F2338
    "--bg-bbtn": 5127513, // #4E3D59
    "--bg-bbtnOver": 6179435, // #5E4A6B
    "--brdrLgt": 0.09,
    "--brdrDrk": 0.52,
    "--alphaDark": 0.26,
    "--text-color": 15591155, // #EDE6F3
    "--gs-invert": 0.88,
    "--brdr": 2365996, // #241A2C
    "--accent": 11560422, // #B065E6
  },
  {
    name: "Ocean",
    "--bg-color": 1451327, // #16253F
    "--bg-panel": 1056308, // #101E34
    "--bg-canvas": 791845, // #0C1525
    "--bg-input": 1451327, // #16253F
    "--bg-bbtn": 2242652, // #22385C
    "--bg-bbtnOver": 2901871, // #2C476F
    "--brdrLgt": 0.08,
    "--brdrDrk": 0.5,
    "--alphaDark": 0.25,
    "--text-color": 14017525, // #D5E3F5
    "--gs-invert": 0.88,
    "--brdr": 989998, // #0F1B2E
    "--accent": 959977, // #0EA5E9
  },
];
