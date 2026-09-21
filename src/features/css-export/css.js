/**
 * CSS and SVG style generation from layer effects, fills, strokes, and text.
 * Output feeds the CSS panel and vector format converters.
 */


import { FontRegistry } from "../../fonts/font-registry.js";
import { TextEngineData } from "../text/text-engine.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { LayerStyleRenderer } from "../layer-styles/style-renderer.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { scaleIgnoringRotation } from "../../core/math/matrix2d.js";
import { boundsOfPathRecords, measureRightAngleLeg } from "../../engine/compositing/selection-utils.js";
import { rgbToHex } from "../../engine/compositing/color-math.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";

function CSS() {}

/**
 * Build CSS declaration strings for a layer (size, text, shadows, fill, stroke).
 */
CSS.generateLayerCSS = function(layer, doc) {
  const add = layer.add;
  const vectorMask = add.vmsk;
  let vectorStroke = add.vstk;
  const layerEffects = add.lmfx;
  const textShape = add.TySh;
  const cssRules = [];
  const fillBackground = CSS.resolveFillBackground(layerEffects, add);
  if (layer.hasFillContent() && vectorMask) appendVectorMaskSizeRules(cssRules, vectorMask);
  else if (textShape) appendTextLayerRules(cssRules, textShape, fillBackground[0]);
  appendDropShadowFilterRule(cssRules, layerEffects, doc);
  if (textShape == null) CSS.appendBackgroundRules(fillBackground, cssRules);
  if (vectorStroke == null || !vectorStroke.strokeEnabled.v) vectorStroke = LayerStyleRenderer.defaultVectorStroke(layerEffects);
  appendStrokeBorderRule(cssRules, vectorStroke);
  return cssRules
};

/** Resolve solid or gradient fill CSS colours from layer effects and add. */
CSS.resolveFillBackground = function(layerEffects, add) {
  const mergedFills = LayerStyleRenderer.mergeMultiFillWithLayerFills(layerEffects, add);
  const solidFill = mergedFills[0];
  const gradientFill = mergedFills[1];
  let solidColorCss;
  let gradientCss;
  if (solidFill) {
    solidColorCss = CSS.psdColorToCss(solidFill.Clr.v, add.iOpa != null ? add.iOpa / 255 : 1)
  } else if (gradientFill) {
    gradientCss = CSS.gradientToCss(gradientFill)
  }
  return [solidColorCss, gradientCss]
};

CSS.appendBackgroundRules = function(fillBackground, cssRules) {
  if (fillBackground[0]) cssRules.push("background-color: " + fillBackground[0]);
  if (fillBackground[1]) cssRules.push("background-image: " + fillBackground[1])
};

CSS.namedColors = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32"
};

/** Trim trailing zeros from a CSS length number. */
CSS.formatCssNumber = function(value) {
  return "" + parseFloat(value.toFixed(3))
};

/** Parse a CSS colour string into planar RGB channel values. */
CSS.parseCssColor = function(cssColor) {
  if (cssColor == null) return {
    h: 0,
    l: 0,
    O: 0
  };
  const parenIndex = cssColor.indexOf("(");
  if (parenIndex != -1) return parseFunctionalCssColor(cssColor, parenIndex);
  if (cssColor.charAt(0) != "#") {
    const namedColors = CSS.namedColors;
    if (namedColors[cssColor]) cssColor = namedColors[cssColor];
    else console.log("unknown color " + cssColor)
  }
  return parseHexCssColor(cssColor)
};

CSS.psdColorToCss = function(psdColor, opacity) {
  return CSS.rgbToCss(psdColorToRgb(psdColor), opacity);
};

CSS.rgbToCss = function(rgb, opacity) {
  if (opacity == null) opacity = 1;
  const red = Math.round(rgb.h);
  const green = Math.round(rgb.l);
  const blue = Math.round(rgb.O);
  const packedRgb = red << 16 | green << 8 | blue;
  return opacity == 1 ? "#" + rgbToHex(packedRgb) : "rgba(" + red + "," + green + "," + blue + "," + opacity + ")";
};

/** Convert a PSD gradient fill descriptor into a CSS gradient function. */
CSS.gradientToCss = function(gradientFill) {
  const gradientDesc = gradientFill.Grad.v;
  if (gradientDesc.Clrs == null) return "";
  const colorStops = gradientDesc.Clrs.v.slice(0);
  const transparencyStops = gradientDesc.Trns.v.slice(0);
  const offset = gradientFill.Ofst.v;
  const isRadial = gradientFill.Type.v.GrdT == "Rdl" ? 1 : 0;
  const gradientType = (isRadial == 1 ? "radial" : "linear") + "-gradient";
  let gradientStopsCss = isRadial == 0 ? Math.round(-gradientFill.Angl.v.val + 90) + "deg" : "circle at center";
  const reversed = gradientFill.Rvrs.v;
  if (reversed) {
    colorStops.reverse();
    transparencyStops.reverse()
  }
  for (let stopIdx = 0; stopIdx < colorStops.length; stopIdx++) {
    const colorStop = colorStops[stopIdx].v;
    const stopOpacity = stopIdx < transparencyStops.length ? transparencyStops[stopIdx].v.Opct.v.val / 100 : 1;
    let stopPosition = colorStop.Lctn.v / 4096;
    if (reversed) stopPosition = 1 - stopPosition;
    gradientStopsCss += ", " + CSS.psdColorToCss(colorStop.Clr.v, stopOpacity) + " " + Math.round(stopPosition * 100) + "%"
  }
  return gradientType + "(" + gradientStopsCss + ")"
};

/** Append font, colour, and alignment rules for a text style bundle. */
CSS.appendTextStyleRules = function(cssRules, textStyleBundle, transform, isSvg, includePostScriptName, overrideFillColor) {
  const textStyle = textStyleBundle.textStyle;
  const scale = isSvg ? 1 : scaleIgnoringRotation(transform);
  const fontSizePx = Math.round(textStyle.FontSize * scale);
  cssRules.push("font-size: " + fontSizePx + "px");
  const tracking = textStyle.Tracking;
  if (!isSvg && tracking != null && tracking != 0) cssRules.push("letter-spacing: " + Math.round(tracking * fontSizePx / 1e3) + "px");
  if (!textStyle.AutoLeading) cssRules.push("line-height: " + Math.round(textStyle.Leading * scale) + "px");
  if (textStyle.Strikethrough) cssRules.push("text-decoration: line-through");
  let fillRgb = TextEngineData.fillColorToRgb(textStyle);
  fillRgb = [fillRgb.h, fillRgb.l, fillRgb.O].map(Math.round);
  cssRules.push((isSvg ? "fill: " : "color: ") + (overrideFillColor ? overrideFillColor : "#" + rgbToHex(fillRgb[0] << 16 | fillRgb[1] << 8 | fillRgb[2])));
  appendFontFamilyRules(cssRules, textStyleBundle, textStyle, isSvg, includePostScriptName);
  const justification = textStyleBundle.paraStyle.Justification;
  if (justification != null && justification != 0)
    if (isSvg) cssRules.push("text-anchor: " + ["start", "end", "middle"][justification % 3]);
    else cssRules.push("text-align: " + ["left", "right", "center"][justification % 3])
};

/** Infer a CSS font-family label from a PostScript name. */
CSS.inferFontFamilyFromPostScriptName = function(postScriptName) {
  postScriptName = postScriptName.split("-")[0];
  while (postScriptName.endsWith("MT") || postScriptName.endsWith("PS")) postScriptName = postScriptName.slice(0, postScriptName.length - 2);
  return insertSpacesBeforeInternalCapitals(postScriptName)
};

export { CSS };

function appendVectorMaskSizeRules(cssRules, vectorMask) {
  const bounds = boundsOfPathRecords(vectorMask.pathRecords);
  if (!bounds.isEmpty()) {
    cssRules.push("width: " + Math.round(bounds.width) + "px");
    cssRules.push("height: " + Math.round(bounds.height) + "px")
  }
  const cornerRadius = measureRightAngleLeg(vectorMask.pathRecords);
  if (cornerRadius > 0) cssRules.push("border-radius: " + Math.round(cornerRadius) + "px")
}

function appendTextLayerRules(cssRules, textShape, overrideFillColor) {
  const engineData = textShape.engineData;
  if (TextEngineData.getTextType(engineData) == 1) {
    const bounds = TextEngineData.getBoxBounds(engineData);
    cssRules.push("width: " + Math.round(bounds[2]) + "px");
    cssRules.push("height: " + Math.round(bounds[3]) + "px")
  }
  CSS.appendTextStyleRules(cssRules, TextEngineData.getTextStyle(engineData, 0, 0), textShape.transform, false, false, overrideFillColor)
}

function appendDropShadowFilterRule(cssRules, layerEffects, doc) {
  const dropShadowFilters = [];
  const dropShadowList = layerEffects ? layerEffects.dropShadowMulti.v : 0;
  for (let shadowIdx = 0; shadowIdx < dropShadowList.length; shadowIdx++) {
    const shadowEntry = dropShadowList[shadowIdx].v;
    if (shadowEntry.enab.v) {
      const shadowDistance = shadowEntry.Dstn.v.val;
      let shadowAngleRad = shadowEntry.lagl.v.val * Math.PI / 180;
      if (shadowEntry.uglg && shadowEntry.uglg.v) shadowAngleRad = doc.getRotationAngle() * Math.PI / 180;
      const offsetX = shadowDistance * Math.cos(shadowAngleRad);
      const offsetY = shadowDistance * Math.sin(shadowAngleRad);
      dropShadowFilters.push("drop-shadow(" + (offsetX == 0 ? "0 " : CSS.formatCssNumber(-offsetX) + "px ") + (offsetY == 0 ? "0 " : CSS.formatCssNumber(offsetY) + "px ") + shadowEntry.blur.v.val / 2 + "px " + CSS.psdColorToCss(shadowEntry.Clr.v, shadowEntry.Opct.v.val / 100) + ")")
    }
  }
  if (dropShadowFilters.length != 0) cssRules.push("filter: " + dropShadowFilters.join(" "))
}

function appendStrokeBorderRule(cssRules, vectorStroke) {
  if (!(vectorStroke && vectorStroke.strokeEnabled.v)) return;
  const strokeContent = vectorStroke.strokeStyleContent.v;
  const strokeContentClassId = strokeContent.classID;
  const lineCapIndex = LayerEffectDefs.StrokeStyleDefs.lineCapTypes.indexOf(vectorStroke.strokeStyleLineCapType.v.strokeStyleLineCapType);
  const joinIndex = LayerEffectDefs.StrokeStyleDefs.join.indexOf(vectorStroke.strokeStyleLineJoinType.v.strokeStyleLineJoinType);
  const strokeOpacity = vectorStroke.strokeStyleOpacity.v.val / 100;
  const strokeWidth = vectorStroke.strokeStyleLineWidth.v.val;
  let borderColor = "";
  if (strokeContentClassId == "solidColorLayer") borderColor = CSS.psdColorToCss(strokeContent.Clr.v, strokeOpacity);
  cssRules.push("border: " + strokeWidth + "px solid " + borderColor)
}

function parseFunctionalCssColor(cssColor, parenIndex) {
  const components = cssColor.slice(parenIndex + 1, cssColor.length - 1).split(",");
  for (let compIdx = 0; compIdx < components.length; compIdx++) {
    const componentStr = components[compIdx].trim();
    components[compIdx] = parseFloat(componentStr) * (componentStr.endsWith("%") ? 255 / 100 : 1)
  }
  return {
    h: components[0],
    l: components[1],
    O: components[2]
  }
}

function parseHexCssColor(cssColor) {
  cssColor = cssColor.slice(1);
  if (cssColor.length == 3) cssColor = cssColor[0] + cssColor[0] + cssColor[1] + cssColor[1] + cssColor[2] + cssColor[2];
  cssColor = parseInt(cssColor, 16);
  return {
    h: cssColor >> 16 & 255,
    l: cssColor >> 8 & 255,
    O: cssColor & 255
  }
}

function appendFontFamilyRules(cssRules, textStyleBundle, textStyle, isSvg, includePostScriptName) {
  const fontPostScriptName = textStyleBundle.fontSet[textStyle.Font].Name;
  if (!fontPostScriptName) return;
  let fontFace = FontRegistry.instance.loadFontFace(fontPostScriptName);
  let fontFamilyCss = "";
  let fontFamily = null;
  let fontWeight = null;
  if (fontFace != null && fontPostScriptName != FontRegistry.getPostScriptName(fontFace)) fontFace = null;
  if (includePostScriptName && fontFace) fontFamilyCss += "\"" + fontPostScriptName + "\", ";
  const fontNameLower = fontPostScriptName.toLowerCase();
  if (fontFace) {
    fontFamily = FontRegistry.extractFamilyStyle(fontFace)[0];
    if (fontFace["OS/2"]) fontWeight = fontFace["OS/2"].usWeightClass
  } else {
    fontFamily = CSS.inferFontFamilyFromPostScriptName(fontPostScriptName);
    if (fontNameLower.indexOf("light") != -1) fontWeight = 300;
    else if (fontNameLower.indexOf("medium") != -1) fontWeight = 500;
    else if (fontNameLower.indexOf("black") != -1 || fontNameLower.indexOf("extrabold") != -1) fontWeight = 800;
    else if (fontNameLower.indexOf("bold") != -1) fontWeight = "bold"
  }
  if (fontFamily != null) fontFamilyCss += "\"" + fontFamily + "\"";
  if (fontWeight != null) cssRules.push("font-weight: " + fontWeight);
  if (fontNameLower.indexOf("italic") != -1 || fontNameLower.indexOf("oblique") != -1) cssRules.push("font-style: italic");
  if (fontFamilyCss) cssRules.push("font-family: " + fontFamilyCss)
}

function insertSpacesBeforeInternalCapitals(postScriptName) {
  let nextCharUppercase = true;
  for (let charIdx = 0; charIdx < postScriptName.length; charIdx++) {
    const ch = postScriptName.charAt(charIdx);
    if (!nextCharUppercase && ch.toLowerCase() != ch) {
      postScriptName = postScriptName.slice(0, charIdx) + " " + postScriptName.slice(charIdx);
      charIdx++;
      nextCharUppercase = true
    } else nextCharUppercase = false
  }
  return postScriptName
}
