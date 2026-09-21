// Glyph path collection and canvas raster of a laid-out TextLayout.
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { TextEngineData } from "./text-engine.js";
import { TextLayout } from "./text-layout.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { appendPath, boundsFromCoordPairs, normalizePathToCubics, pathHasDrawCommands, pixelAlignBoundsFromCoords, subdividePathByFlatness, toTyprPath, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { getScratch2dContext, rgbToHex } from "../../engine/compositing/color-math.js";
import { warpCoordsThroughMesh } from "../../engine/compositing/image-renderer.js";
import { getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";

function TextRenderer() {}

function emptyTextRenderResult() {
  return {
    buffer: allocBuffer(0),
    rect: new Rect(),
    layoutBounds: new Rect(),
  };
}

function applyAntiAliasToAlpha(pixelBuffer, antiAliasMode) {
  if (antiAliasMode == 0) {
    for (let pixelIdx = 0; pixelIdx < pixelBuffer.length; pixelIdx += 4) {
      pixelBuffer[pixelIdx + 3] = pixelBuffer[pixelIdx + 3] > 80 ? 255 : 0;
    }
  }
  if (antiAliasMode == 3) {
    for (let pixelIdx = 0; pixelIdx < pixelBuffer.length; pixelIdx += 4) {
      pixelBuffer[pixelIdx + 3] = Math.min(255, pixelBuffer[pixelIdx + 3] * 1.5);
    }
  }
}

function appendDecorationRect(pathAccumulator, localMatrix, rectLeft, rectTop, rectWidth, rectHeight) {
  appendPath(
    pathAccumulator,
    {
      commands: ["M", "L", "L", "L", "Z"],
      coords: [
        rectLeft,
        rectTop,
        rectLeft + rectWidth,
        rectTop,
        rectLeft + rectWidth,
        rectTop + rectHeight,
        rectLeft,
        rectTop + rectHeight,
      ],
    },
    localMatrix,
  );
}

TextRenderer.offscreenCanvas = document.createElement("canvas");
TextRenderer.renderCtx = TextRenderer.offscreenCanvas.getContext("2d");
TextRenderer.renderText = function(curveData, textShape) {
  const layoutBounds = curveData.getBounds();
  let pixelBuffer;
  if (layoutBounds.x == Infinity || layoutBounds.isEmpty()) return emptyTextRenderResult();
  const fullBounds = curveData.getBounds();
  const textPaths = TextRenderer.buildTextPaths(curveData, textShape);
  const pixelBounds = pixelAlignBoundsFromCoords(textPaths.coords);
  if (pixelBounds.isEmpty()) return emptyTextRenderResult();
  const scratchCtx = getScratch2dContext(pixelBounds.width, pixelBounds.height);
  scratchCtx.translate(-pixelBounds.x, -pixelBounds.y);
  TextRenderer.drawPaths(textPaths, scratchCtx);
  if (curveData.textStyle.length != 0) {
    const antiAliasMode = TextEngineData.getAntiAliasMode(textShape);
    const imageData = scratchCtx.getImageData(0, 0, pixelBounds.width, pixelBounds.height);
    pixelBuffer = new Uint8Array(imageData.data.buffer);
    applyAntiAliasToAlpha(pixelBuffer, antiAliasMode);
  } else pixelBuffer = allocBuffer(pixelBounds.area() * 4);
  scratchCtx.resetTransform();
  scratchCtx.beginPath();
  return {
    buffer: pixelBuffer,
    rect: pixelBounds,
    layoutBounds: fullBounds
  }
};
TextRenderer.buildTextPaths = function(curveData, textShape) {
  let pathAccumulator = {
      commands: [],
      coords: []
    };

  const textMatrix = textShape.transform;
  const antiAliasMode = TextEngineData.getAntiAliasMode(textShape);
  let snapMatrix = Math.max(textMatrix.b * textMatrix.b, textMatrix.c * textMatrix.c) < 1e-9 ? textMatrix : null;
  if (antiAliasMode == 3 || antiAliasMode == 4) snapMatrix = null;
  TextRenderer.collectPaths(curveData, pathAccumulator, snapMatrix);
  if (!isIdentityWarp(textShape.warpDescriptor)) {
    const pathBounds = boundsFromCoordPairs(pathAccumulator.coords);
    pathAccumulator = normalizePathToCubics(pathAccumulator);
    pathAccumulator = subdividePathByFlatness(pathAccumulator, Math.min(pathBounds.width, pathBounds.height) / 8);
    const selectionRect = TextEngineData.getSelectionRect(textShape, curveData);
    const warpControlPoints = getWarpControlPoints(textShape.warpDescriptor, selectionRect);
    warpCoordsThroughMesh(warpControlPoints, pathAccumulator.coords, selectionRect)
  }
  transformCoordPairs(pathAccumulator.coords, textMatrix, pathAccumulator.coords);
  return pathAccumulator
};
TextRenderer.drawPaths = function(pathData, canvasContext) {
  Typr.U.pathToContext(toTyprPath(pathData), canvasContext)
};
TextRenderer.checkFonts = function(textShape, fontRegistry) {
  if (!TextLayout.ensureWasm()) return;
  const engineData = textShape.engineData;
  const fontSet = engineData.ResourceDict.FontSet;
  const defaultStyleSheet = engineData.ResourceDict.StyleSheetSet[0].StyleSheetData;
  const runLengths = engineData.EngineDict.StyleRun.RunLengthArray;
  const styleRuns = engineData.EngineDict.StyleRun.RunArray;
  const layerText = TextEngineData.getLayerText(engineData);
  let allFontsReady = true;
  const fontLoadCache = {};
  let charOffset = 0;
  for (let runIdx = 0; runIdx < styleRuns.length; runIdx++) {
    let fontIdx = styleRuns[runIdx].StyleSheet.StyleSheetData.Font;
    if (fontIdx == null) fontIdx = defaultStyleSheet.Font;
    for (let charInRunIdx = 0; charInRunIdx < runLengths[runIdx]; charInRunIdx++) {
      const charCode = layerText.charCodeAt(charOffset + charInRunIdx);
      const cacheKey = fontIdx + "," + (charCode > 128 ? charCode : -1);
      if (fontLoadCache[cacheKey] == null) {
        fontLoadCache[cacheKey] = 1;
        if (fontRegistry.loadFontFace(fontSet[fontIdx].Name, charCode) == null) allFontsReady = false
      }
    }
    charOffset += runLengths[runIdx]
  }
  return allFontsReady
};
TextRenderer.collectPaths = function(curveData, pathAccumulator, snapMatrix) {
  const cumulativeMatrix = new Matrix2D;
  for (let paraIdx = 0; paraIdx < curveData.paraStyle.length; paraIdx++) TextRenderer.collectParaPaths(curveData.textStyle, curveData.paraStyle[paraIdx], pathAccumulator, cumulativeMatrix, snapMatrix)
};
TextRenderer.collectParaPaths = function(textStyle, paraStyle, pathAccumulator, cumulativeMatrix, snapMatrix) {
  cumulativeMatrix.translate(paraStyle.offset.x, paraStyle.offset.y);
  for (let lineIdx = 0; lineIdx < paraStyle.nodes.length; lineIdx++) {
    const decorationState = {};
    const lineNode = paraStyle.nodes[lineIdx];
    if (!lineNode.isVisible) break;
    const lineMatrix = cumulativeMatrix.clone();
    lineMatrix.translate(lineNode.offset.x, lineNode.offset.y);
    if (snapMatrix) {
      const snappedTy = snapMatrix.ty + lineMatrix.ty * snapMatrix.d;
      lineMatrix.ty = (Math.round(snappedTy) - snapMatrix.ty) / snapMatrix.d
    }
    for (let wordRunIdx = lineNode.start; wordRunIdx < lineNode.end; wordRunIdx++) TextRenderer.collectGlyphPath(textStyle, paraStyle.wordRuns[wordRunIdx], paraStyle, decorationState, pathAccumulator, lineMatrix)
  }
  cumulativeMatrix.translate(-paraStyle.offset.x, -paraStyle.offset.y)
};
TextRenderer.mirroredChars = "()<>[]{}\xAB\xBB\u0F3A\u0F3B\u0F3C\u0F3D\u169B\u169C\u2039\u203A\u2045\u2046\u207D\u207E\u208D\u208E\u2208\u2209\u220A\u220B\u220C\u220D\u2215\u223C\u223D\u2243\u2252\u2253\u2254\u2255\u2264\u2265\u2266\u2267\u2268\u2269\u226A\u226B\u226E\u226F\u2270\u2271\u2272\u2273\u2274\u2275\u2276\u2277\u2278\u2279\u227A\u227B\u227C\u227D\u227E\u227F\u2280\u2281\u2282\u2283\u2284\u2285\u2286\u2287\u2288\u2289\u228A\u228B\u228F\u2290\u2291\u2292\u2298\u22A2\u22A3\u22A6\u22A8\u22A9\u22AB\u22B0\u22B1\u22B2\u22B3\u22B4\u22B5\u22B6\u22B7\u22C9\u22CA\u22CB\u22CC\u22CD\u22D0\u22D1\u22D6\u22D7\u22D8\u22D9\u22DA\u22DB\u22DC\u22DD\u22DE\u22DF\u22E0\u22E1\u22E2\u22E3\u22E4\u22E5\u22E6\u22E7\u22E8\u22E9\u22EA\u22EB\u22EC\u22ED\u22F0\u22F1\u22F2\u22F3\u22F4\u22F6\u22F7\u22FA\u22FB\u22FC\u22FD\u22FE\u2308\u2309\u230A\u230B\u2329\u232A\u2768\u2769\u276A\u276B\u276C\u276D\u276E\u276F\u2770\u2771\u2772\u2773\u2774\u2775\u27C3\u27C4\u27C5\u27C6\u27C8\u27C9\u27CB\u27CD\u27D5\u27D6\u27DD\u27DE\u27E2\u27E3\u27E4\u27E5\u27E6\u27E7\u27E8\u27E9\u27EA\u27EB\u27EC\u27ED\u27EE\u27EF\u2983\u2984\u2985\u2986\u2987\u2988\u2989\u298A\u298B\u298C\u298D\u298E\u298F\u2990\u2991\u2992\u2993\u2994\u2995\u2996\u2997\u2998\u29B8\u29C0\u29C1\u29C4\u29C5\u29CF\u29D0\u29D1\u29D2\u29D4\u29D5\u29D8\u29D9\u29DA\u29DB\u29F5\u29F8\u29F9\u29FC\u29FD\u2A2B\u2A2C\u2A2D\u2A2E\u2A34\u2A35\u2A3C\u2A3D\u2A64\u2A65\u2A79\u2A7A\u2A7D\u2A7E\u2A7F\u2A80\u2A81\u2A82\u2A83\u2A84\u2A8B\u2A8C\u2A91\u2A92\u2A93\u2A94\u2A95\u2A96\u2A97\u2A98\u2A99\u2A9A\u2A9B\u2A9C\u2AA1\u2AA2\u2AA6\u2AA7\u2AA8\u2AA9\u2AAA\u2AAB\u2AAC\u2AAD\u2AAF\u2AB0\u2AB3\u2AB4\u2ABB\u2ABC\u2ABD\u2ABE\u2ABF\u2AC0\u2AC1\u2AC2\u2AC3\u2AC4\u2AC5\u2AC6\u2ACD\u2ACE\u2ACF\u2AD0\u2AD1\u2AD2\u2AD3\u2AD4\u2AD5\u2AD6\u2ADE\u2AE3\u2AE4\u2AE5\u2AEC\u2AED\u2AF7\u2AF8\u2AF9\u2AFA\u2E02\u2E03\u2E04\u2E05\u2E09\u2E0A\u2E0C\u2E0D\u2E1C\u2E1D\u2E20\u2E21\u2E22\u2E23\u2E24\u2E25\u2E26\u2E27\u2E28\u2E29\u3008\u3009\u300A\u300B\u300C\u300D\u300E\u300F\u3010\u3011\u3014\u3015\u3016\u3017\u3018\u3019\u301A\u301B\uFE59\uFE5A\uFE5B\uFE5C\uFE5D\uFE5E\uFE64\uFE65\uFF08\uFF09\uFF1C\uFF1E\uFF3B\uFF3D\uFF5B\uFF5D\uFF5F\uFF60\uFF62\uFF63";
TextRenderer.collectGlyphPath = function(textStyle, wordRun, paraStyle, decorationState, pathAccumulator, wordMatrix) {
  wordMatrix.translate(wordRun.offset.x, wordRun.offset.y);
  for (let glyphIdx = wordRun.firstGlyph; glyphIdx <= wordRun.lastGlyph; glyphIdx++) {
    const glyph = paraStyle.glyphs[glyphIdx];
    const glyphAdvance = glyph.bounds.width;
    const charStyle = textStyle[paraStyle.textStart + glyph.charIdx];
    if (charStyle.char == "\n") continue;
    const fontScale = charStyle.styleSheet.FontSize / charStyle.font.head.unitsPerEm;
    const fillRgb = TextEngineData.fillColorToRgb(charStyle.styleSheet);
    const rgbPacked = (Math.round(fillRgb.h) << 16) + (Math.round(fillRgb.l) << 8) + Math.round(fillRgb.O);
    pathAccumulator.commands.push("#" + rgbToHex(rgbPacked));
    const glyphMatrix = wordMatrix.clone();
    glyphMatrix.translate(glyph.offset.x + glyph.offsetX * fontScale, glyph.offset.y - glyph.offsetY * fontScale);
    const localMatrix = new Matrix2D;
    localMatrix.scale(fontScale, -fontScale);
    if (charStyle.bidiLevel == 1 && TextRenderer.mirroredChars.indexOf(charStyle.char) != -1) localMatrix.concat(new Matrix2D(-1, 0, 0, 1, glyphAdvance, 0));
    if (charStyle.styleSheet.FauxItalic) localMatrix.concat(new Matrix2D(1, 0, -Math.tan(.18), 1, 0, 0));
    localMatrix.translate(0, charStyle.baselineOffset);
    localMatrix.scale(charStyle.scale.x, charStyle.scale.y);
    if (charStyle.styleSheet.BaselineShift != null) localMatrix.translate(0, -charStyle.styleSheet.BaselineShift);
    if (glyph.pathTangent != 0) {
      localMatrix.rotate(-glyph.pathTangent)
    }
    localMatrix.concat(glyphMatrix);
    if (pathHasDrawCommands(glyph.path) && charStyle.char != "\t") {
      if (charStyle.styleSheet.FauxBold) {
        const boldOffset = charStyle.styleSheet.FontSize / 2048 * 27 * charStyle.scale.x;
        localMatrix.tx += boldOffset;
        appendPath(pathAccumulator, glyph.path, localMatrix);
        localMatrix.tx -= boldOffset + boldOffset;
        appendPath(pathAccumulator, glyph.path, localMatrix)
      } else appendPath(pathAccumulator, glyph.path, localMatrix)
    }
    if (charStyle.char != "\n") {
      if (charStyle.styleSheet.Underline) {
        if (decorationState.underlineThickness == null) decorationState.underlineThickness = charStyle.font.post.underlineThickness;
        if (decorationState.underlinePosition == null) decorationState.underlinePosition = charStyle.font.post.underlinePosition;
        const rectLeft = 0;
        const rectTop = decorationState.underlinePosition - decorationState.underlineThickness / 2;
        const rectWidth = glyph.advanceWidth * 1.05;
        const rectHeight = -decorationState.underlineThickness;
        appendDecorationRect(pathAccumulator, localMatrix, rectLeft, rectTop, rectWidth, rectHeight);
      }
      if (charStyle.styleSheet.Strikethrough) {
        const strikeSize = charStyle.font["OS/2"].yStrikeoutSize;
        const strikePosition = charStyle.font["OS/2"].yStrikeoutPosition;
        const rectLeft = 0;
        const rectTop = strikePosition + strikeSize / 2;
        const rectWidth = glyph.advanceWidth * 1.05;
        const rectHeight = -strikeSize;
        appendDecorationRect(pathAccumulator, localMatrix, rectLeft, rectTop, rectWidth, rectHeight);
      }
    }
    pathAccumulator.commands.push("X")
  }
  wordMatrix.translate(-wordRun.offset.x, -wordRun.offset.y)
};

export { TextRenderer };
