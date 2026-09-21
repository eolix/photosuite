// Photoshop EngineData editing: run arrays, style bags, and TySh extras
// (text descriptor, warp, bounds). Layout lives in text-layout.js; raster
// in text-renderer.js; text-on-path sampling in text-path-geometry.js.
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { computeTextPathData } from "./text-path-geometry.js";
import { boundsFromCoordPairs, buildCanvasPathRecords, flattenPathRecordsToPath, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { createForSubpaths } from "../../engine/compositing/key-origins.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";
import { defaultWarpDescriptor } from "../../engine/compositing/warp.js";

function TextEngineData() {}
function rgbFromType1Fill(values) {
  return {
    h: values[1] * 255,
    l: values[2] * 255,
    O: values[3] * 255,
  };
}

function cmykDescriptorFromFill(values) {
  return {
    classID: "CMYC",
    Cyn: { t: "doub", v: values[1] * 100 },
    Mgnt: { t: "doub", v: values[2] * 100 },
    Ylw: { t: "doub", v: values[3] * 100 },
    Blck: { t: "doub", v: values[4] * 100 },
  };
}

/**
 * Deep-clone JSON-compatible EngineData / style bags.
 * @param {*} value
 * @returns {*}
 */
TextEngineData.deepClone = function (value) {
  return JSON.parse(JSON.stringify(value))
};
TextEngineData.mergeProps = function(target, source) {
  for (let key in source) target[key] = source[key]
};
TextEngineData.createTextLayerData = function(x, y, initialStyle) {
  const engineData = TextEngineData.cloneEngineData();
  if (initialStyle) TextEngineData.applyStyle(engineData, 0, 0, initialStyle);
  const textShape = {
    transform: new Matrix2D(1, 0, 0, 1, Math.round(x), Math.round(y)),
    engineData: engineData
  };
  textShape.textDescriptor = TextEngineData.createTxLrDescriptor();
  textShape.warpDescriptor = defaultWarpDescriptor();
  textShape.boundsRect = new Rect;
  return textShape
};
TextEngineData.assertNoCharDir = function(node) {
  if (node.CharacterDirection != null && node.CharacterDirection != 0) {
    throw new Error("Unexpected CharacterDirection: " + node.CharacterDirection);
  }
  if (node instanceof Array)
    for (let idx = 0; idx < node.length; idx++) TextEngineData.assertNoCharDir(node[idx]);
  else if (node instanceof Object)
    for (let key in node) TextEngineData.assertNoCharDir(node[key])
};
TextEngineData.getJustification = function(paraProps, justification) {
  if (justification == null) justification = paraProps.Justification;
  const direction = paraProps._Direction ? paraProps._Direction : 0;
  if (direction == 1) {
    if (justification == 0 || justification == 3) justification++;
    else if (justification == 1 || justification == 4) justification--
  }
  return justification
};
TextEngineData.syncCurveToVmsk = function(textShape) {
  if (textShape.add == null) return;
  const engineData = textShape.engineData;
  var curve = engineData.Curve;
  const vmsk = textShape.add.vmsk;
  const pathRecords = vmsk.pathRecords;
  const flatCoords = flattenPathRecordsToPath(pathRecords, true).coords;
  const inverseMatrix = textShape.transform.clone();
  inverseMatrix.invert();
  transformCoordPairs(flatCoords, inverseMatrix, flatCoords);
  const curvePoints = flatCoords.slice(0, 8);
  for (let pathIdx = 8; pathIdx < flatCoords.length; pathIdx += 6) curvePoints.push(flatCoords[pathIdx - 2], flatCoords[pathIdx - 1], flatCoords[pathIdx], flatCoords[pathIdx + 1], flatCoords[pathIdx + 2], flatCoords[pathIdx + 3], flatCoords[pathIdx + 4], flatCoords[pathIdx + 5]);
  curve.Points = curvePoints;
  curve.TextOnPathTRange = vmsk.textOnPathParams.slice(0);
  curve.Reversed = vmsk.reversed;
  if (TextEngineData.getTextType(engineData) == 1) {
    const pathData = computeTextPathData(engineData.Curve);
    const pathBounds = boundsFromCoordPairs(pathData[0]);
    TextEngineData.setBoxBounds(engineData, [0, 0, pathBounds.width, pathBounds.height].map(Math.round));
    for (let coordIdx = 0; coordIdx < curvePoints.length; coordIdx += 2) {
      curvePoints[coordIdx] -= pathBounds.x;
      curvePoints[coordIdx + 1] -= pathBounds.y
    }
    const offsetMatrix = new Matrix2D(1, 0, 0, 1, pathBounds.x, pathBounds.y);
    offsetMatrix.concat(textShape.transform);
    textShape.transform = offsetMatrix
  }
};
TextEngineData.syncVmskToCurve = function(textShape) {
  if (textShape.add == null) return;
  const vmsk = textShape.add.vmsk;
  const curve = textShape.engineData.Curve;
  const points = curve.Points;

  const pathSpec = {
    commands: ["M"],
    coords: [points[0], points[1]]
  };

  for (let idx = 0; idx < points.length; idx += 8) {
    pathSpec.commands.push("C");
    pathSpec.coords.push(points[idx + 2], points[idx + 3], points[idx + 4], points[idx + 5], points[idx + 6], points[idx + 7])
  }
  transformCoordPairs(pathSpec.coords, textShape.transform, pathSpec.coords);
  const pathRecords = buildCanvasPathRecords(pathSpec, true);
  vmsk.pathRecords = pathRecords;
  vmsk.reversed = curve.Reversed;
  vmsk.textOnPathParams = curve.TextOnPathTRange.slice(0);
  textShape.add.vogk = createForSubpaths(pathRecords)
};
TextEngineData.fillColorToRgb = function (styleData) {
  let rgb = { h: 0, l: 0, O: 0 };
  if (styleData.FillColor) {
    const fillColor = styleData.FillColor;
    const values = fillColor.Values;
    if (fillColor.Type == 1) rgb = rgbFromType1Fill(values);
    else if (fillColor.Type == 2) {
      rgb = psdColorToRgb(cmykDescriptorFromFill(values));
    } else console.log("Unknown color type");
  }
  return rgb;
};
TextEngineData.normalizeFillColors = function(styleRuns) {
  for (let idx = 0; idx < styleRuns.length; idx++) {
    const styleData = styleRuns[idx].StyleSheet.StyleSheetData;
    const fillColor = styleData.FillColor;
    if (fillColor && fillColor.Type == 2) {
      let rgb = TextEngineData.fillColorToRgb(styleData);
      fillColor.Type = 1;
      fillColor.Values = [1, rgb.h / 255, rgb.l / 255, rgb.O / 255]
    }
  }
};
TextEngineData.getSelectionRect = function(textShape, curveData) {
  let boundsRect;
  if (TextEngineData.getTextType(textShape.engineData) == 1) {
    const boxBounds = TextEngineData.getBoxBounds(textShape.engineData);
    boundsRect = new Rect(0, 0, boxBounds[2] - boxBounds[0], boxBounds[3] - boxBounds[1])
  } else boundsRect = curveData.getBounds();
  return boundsRect
};
TextEngineData.intersectStyles = function(styles) {
  let result = styles[0];
  for (let idx = 0; idx < styles.length; idx++) result = TextEngineData.intersectTwoStyles(result, styles[idx]);
  return result
};
TextEngineData.intersectTwoStyles = function(styleA, styleB) {
  let result = {};
  for (let key in styleA)
    if (JSON.stringify(styleA[key]) == JSON.stringify(styleB[key])) result[key] = styleA[key];
  return result
};
TextEngineData.setTextFont = function(styleBundle, fontName) {
  const fontSet = styleBundle.fontSet;
  let fontIdx = -1;
  for (let idx = 0; idx < fontSet.length; idx++)
    if (fontSet[idx].Name == fontName) fontIdx = idx;
  if (fontIdx == -1) {
    fontIdx = fontSet.length;
    fontSet.push({
      FontType: 1,
      Name: fontName,
      Script: 0,
      Synthetic: 0
    })
  }
  styleBundle.textStyle.Font = fontIdx
};
TextEngineData.getLayerText = function(engineData) {
  return engineData.EngineDict.Editor.Text.replace(/\r/g, "\n").replace(/\u0003/g, "\n");
};
TextEngineData.setLayerText = function(engineData, text) {
  engineData.EngineDict.Editor.Text = text.replace(/\n/g, "\r")
};
TextEngineData.getTextType = function(engineData) {
  return engineData.Curve && engineData.Curve.TextOnPathTRange[0] >= 0 ? 2 : engineData.EngineDict.Rendered.Shapes.Children[0].ShapeType
};
TextEngineData.setTextType = function(engineData, shapeType) {
  const shapeChild = engineData.EngineDict.Rendered.Shapes.Children[0];
  shapeChild.ShapeType = shapeType;
  const photoshopCookie = shapeChild.Cookie.Photoshop;
  photoshopCookie.ShapeType = shapeType;
  photoshopCookie.Base.ShapeType = shapeType;
  if (shapeType == 0) {
    delete photoshopCookie.BoxBounds;
    photoshopCookie.PointBase = [0, 0]
  }
  if (shapeType == 1) {
    delete photoshopCookie.PointBase;
    photoshopCookie.BoxBounds = [0, 0, 1, 1]
  }
};
TextEngineData.getBoxBounds = function(engineData) {
  return engineData.EngineDict.Rendered.Shapes.Children[0].Cookie.Photoshop.BoxBounds
};
TextEngineData.setBoxBounds = function(engineData, bounds) {
  engineData.EngineDict.Rendered.Shapes.Children[0].Cookie.Photoshop.BoxBounds = bounds
};
TextEngineData.getStyleAtChar = function(engineData, charIndex) {
  return TextEngineData.mergeStyleRun(engineData, TextEngineData.getRunIdxAtChar(engineData, charIndex));
};
TextEngineData.getRunIdxAtChar = function(engineData, charIndex) {
  const runLengths = engineData.EngineDict.StyleRun.RunLengthArray;
  return TextEngineData.findRunAtChar(runLengths, charIndex).runIdx;
};
TextEngineData.mergeStyleRun = function(engineData, runIdx) {
  const baseStyle = engineData.ResourceDict.StyleSheetSet[0].StyleSheetData;
  const merged = {};
  for (let key in baseStyle) merged[key] = baseStyle[key];
  const runStyle = engineData.EngineDict.StyleRun.RunArray[runIdx].StyleSheet.StyleSheetData;
  TextEngineData.mergeProps(merged, runStyle);
  return merged
};
TextEngineData.mergeParagraphRun = function(engineData, runIdx) {
  const baseProps = engineData.ResourceDict.ParagraphSheetSet[0].Properties;
  const merged = {};
  for (let key in baseProps) merged[key] = baseProps[key];
  const runProps = engineData.EngineDict.ParagraphRun.RunArray[runIdx].ParagraphSheet.Properties;
  TextEngineData.mergeProps(merged, runProps);
  const indentKeys = ["StartIndent", "EndIndent", "FirstLineIndent"];
  for (let idx = 0; idx < 3; idx++)
    if (merged[indentKeys[idx]] == null) merged[indentKeys[idx]] = 0;
  return merged
};
TextEngineData.insertText = function(engineData, charIndex, insertText) {
  if (insertText == "") return;
  const layerText = TextEngineData.getLayerText(engineData);
  TextEngineData.setLayerText(engineData, layerText.substring(0, charIndex) + insertText + layerText.substring(charIndex, layerText.length));
  const styleRun = engineData.EngineDict.StyleRun;
  const styleLengths = styleRun.RunLengthArray;
  const styleRunAtPrev = TextEngineData.findRunAtChar(styleLengths, charIndex - 1);
  styleLengths[styleRunAtPrev.runIdx] += insertText.length;
  const alternateGlyphRun = engineData.EngineDict.AlternateGlyphRun;
  if (alternateGlyphRun) {
    const alternateLengths = alternateGlyphRun.RunLengthArray;
    alternateLengths[TextEngineData.findRunAtChar(alternateLengths, charIndex - 1).runIdx] += insertText.length
  }
  const paraRun = engineData.EngineDict.ParagraphRun;
  const paraLengths = paraRun.RunLengthArray;
  const paraRunAtChar = TextEngineData.findRunAtChar(paraLengths, charIndex);
  const lineParts = insertText.split("\n");
  if (lineParts.length == 1) {
    paraLengths[paraRunAtChar.runIdx] += insertText.length;
    return
  }
  paraLengths.splice(paraRunAtChar.runIdx + 1, 0, paraLengths[paraRunAtChar.runIdx] - (charIndex - paraRunAtChar.runStart));
  paraRun.RunArray.splice(paraRunAtChar.runIdx + 1, 0, TextEngineData.deepClone(paraRun.RunArray[paraRunAtChar.runIdx]));
  paraLengths[paraRunAtChar.runIdx] -= paraLengths[paraRunAtChar.runIdx + 1];
  paraLengths[paraRunAtChar.runIdx] += lineParts[0].length + 1;
  for (let idx = 1; idx < lineParts.length - 1; idx++) {
    paraRun.RunArray.splice(paraRunAtChar.runIdx + idx, 0, TextEngineData.deepClone(paraRun.RunArray[paraRunAtChar.runIdx + idx - 1]));
    paraRun.RunLengthArray.splice(paraRunAtChar.runIdx + idx, 0, lineParts[idx].length + 1)
  }
  paraLengths[paraRunAtChar.runIdx + lineParts.length - 1] += lineParts[lineParts.length - 1].length
};
TextEngineData.deleteText = function(engineData, startIndex, endIndex) {
  const layerText = TextEngineData.getLayerText(engineData);
  TextEngineData.setLayerText(engineData, layerText.substring(0, startIndex) + layerText.substring(endIndex, layerText.length));
  TextEngineData.adjustRunsAfterDelete(engineData.EngineDict.ParagraphRun, startIndex, endIndex, true);
  TextEngineData.adjustRunsAfterDelete(engineData.EngineDict.StyleRun, startIndex, endIndex, false);
  const alternateGlyphRun = engineData.EngineDict.AlternateGlyphRun;
  if (alternateGlyphRun) TextEngineData.adjustRunsAfterDelete(alternateGlyphRun, startIndex, endIndex, false)
};

/**
 * Empty run group, shaped like the style run: parallel RunArray and
 * RunLengthArray, joinable so neighbouring runs with equal data may merge.
 */
TextEngineData.createRunGroup = function() {
  return {
    RunArray: [],
    RunLengthArray: [],
    IsJoinable: 2
  }
};

/**
 * Glyph id forced at a character by the Glyphs panel, bypassing the cmap.
 * @returns {number} Glyph id, or -1 when the character shapes normally.
 */
TextEngineData.getAlternateGlyph = function(engineData, charIndex) {
  const alternateGlyphRun = engineData.EngineDict.AlternateGlyphRun;
  if (alternateGlyphRun == null) return -1;
  const runIdx = TextEngineData.findRunAtChar(alternateGlyphRun.RunLengthArray, charIndex).runIdx,
    run = alternateGlyphRun.RunArray[runIdx];
  if (run == null || run.Glyph == null) return -1;
  return run.Glyph
};

/**
 * Force one character to render as a specific glyph id. Splits the run it
 * lands in so the override covers exactly that character.
 */
TextEngineData.setAlternateGlyph = function(engineData, charIndex, glyphId) {
  let alternateGlyphRun = engineData.EngineDict.AlternateGlyphRun;
  if (alternateGlyphRun == null) {
    alternateGlyphRun = engineData.EngineDict.AlternateGlyphRun = TextEngineData.createRunGroup();
    alternateGlyphRun.RunArray.push({});
    alternateGlyphRun.RunLengthArray.push(TextEngineData.getLayerText(engineData).length)
  }
  const runLengths = alternateGlyphRun.RunLengthArray,
    runAtChar = TextEngineData.findRunAtChar(runLengths, charIndex);
  const offsetInRun = charIndex - runAtChar.runStart;
  let runIdx = runAtChar.runIdx,
    runLength = runLengths[runIdx];
  const runDataJson = JSON.stringify(alternateGlyphRun.RunArray[runIdx]);
  if (offsetInRun != 0) {
    // Split off the characters before charIndex, which keep the old override.
    alternateGlyphRun.RunArray.splice(runIdx, 0, JSON.parse(runDataJson));
    runLengths.splice(runIdx, 0, offsetInRun);
    runLengths[runIdx + 1] -= offsetInRun;
    runIdx++;
    runLength -= offsetInRun
  }
  if (runLength != 1) {
    // Split off the characters after charIndex, likewise.
    alternateGlyphRun.RunArray.splice(runIdx + 1, 0, JSON.parse(runDataJson));
    runLengths.splice(runIdx + 1, 0, runLength - 1);
    runLengths[runIdx] = 1
  }
  alternateGlyphRun.RunArray[runIdx].Glyph = glyphId
};
TextEngineData.adjustRunsAfterDelete = function(runGroup, startIndex, endIndex, mergeParagraphRuns) {
  const runLengths = runGroup.RunLengthArray;
  const runAtStart = TextEngineData.findRunAtChar(runLengths, startIndex);
  const runAtEnd = TextEngineData.findRunAtChar(runLengths, endIndex);
  const charToRunMap = [];
  for (let runIdx = 0; runIdx < runLengths.length; runIdx++)
    for (let charIdx = 0; charIdx < runLengths[runIdx]; charIdx++) charToRunMap.push(runIdx);
  charToRunMap.splice(startIndex, endIndex - startIndex);
  const runCounts = [];
  for (let runIdx = 0; runIdx < runLengths.length; runIdx++) runCounts.push(0);
  for (let idx = 0; idx < charToRunMap.length; idx++) runCounts[charToRunMap[idx]]++;
  for (let runIdx = 0; runIdx < runLengths.length; runIdx++) {
    if (runCounts[runIdx] == 0) {
      runCounts.splice(runIdx, 1);
      runLengths.splice(runIdx, 1);
      runGroup.RunArray.splice(runIdx, 1);
      runIdx--
    } else if (runCounts[runIdx] < runLengths[runIdx]) runLengths[runIdx] = runCounts[runIdx]
  }
  if (mergeParagraphRuns && runAtStart.runIdx != runAtEnd.runIdx && runAtStart.runStart != startIndex) {
    runLengths[runAtStart.runIdx] += runLengths[runAtStart.runIdx + 1];
    runLengths.splice(runAtStart.runIdx + 1, 1);
    runGroup.RunArray.splice(runAtStart.runIdx + 1, 1)
  }
};
TextEngineData.applyStyle = function(engineData, startIndex, endIndex, styleBundle) {
  const textLen = engineData.EngineDict.Editor.Text.length;
  if (endIndex == textLen - 2) endIndex++;
  if (styleBundle.textStyle.Font != null) engineData.ResourceDict.FontSet = styleBundle.fontSet.slice(0);
  if (startIndex <= endIndex) TextEngineData.applyStyleToRun(engineData.EngineDict.StyleRun, styleBundle.textStyle, startIndex, endIndex, true);
  TextEngineData.applyStyleToRun(engineData.EngineDict.ParagraphRun, styleBundle.paraStyle, startIndex, endIndex, false)
};
TextEngineData.applyStyleToRun = function(runGroup, styleProps, startIndex, endIndex, isStyleRun) {
  const runLengths = runGroup.RunLengthArray;
  if (isStyleRun) {
    var runAtStart = TextEngineData.findRunAtChar(runLengths, startIndex);
    if (runAtStart.runStart != startIndex) {
      var runLen = runLengths[runAtStart.runIdx];
      runLengths.splice(runAtStart.runIdx, 0, startIndex - runAtStart.runStart);
      runLengths[runAtStart.runIdx + 1] = runLen - runLengths[runAtStart.runIdx];
      runGroup.RunArray.splice(runAtStart.runIdx + 1, 0, TextEngineData.deepClone(runGroup.RunArray[runAtStart.runIdx]))
    }
    var runAtEnd = TextEngineData.findRunAtChar(runLengths, endIndex);
    if (runAtEnd.runStart + runLengths[runAtEnd.runIdx] - 1 != endIndex) {
      var runLen = runLengths[runAtEnd.runIdx];
      runLengths.splice(runAtEnd.runIdx, 0, endIndex - runAtEnd.runStart + 1);
      runLengths[runAtEnd.runIdx + 1] = runLen - runLengths[runAtEnd.runIdx];
      runGroup.RunArray.splice(runAtEnd.runIdx + 1, 0, TextEngineData.deepClone(runGroup.RunArray[runAtEnd.runIdx]))
    }
  }
  var runAtStart = TextEngineData.findRunAtChar(runLengths, startIndex);
  var runAtEnd = TextEngineData.findRunAtChar(runLengths, endIndex);
  if (isStyleRun)
    for (let idx = runAtStart.runIdx; idx <= runAtEnd.runIdx; idx++) TextEngineData.mergeProps(runGroup.RunArray[idx].StyleSheet.StyleSheetData, styleProps);
  else
    for (let idx = runAtStart.runIdx; idx <= runAtEnd.runIdx; idx++) TextEngineData.mergeProps(runGroup.RunArray[idx].ParagraphSheet.Properties, styleProps)
};
TextEngineData.getStyleRunCounts = function(engineData, startIndex, endIndex) {
  const runLengths = engineData.EngineDict.StyleRun.RunLengthArray;
  const counts = [];
  let charOffset = 0;
  for (let runIdx = 0; runIdx < runLengths.length; runIdx++) {
    const runLen = runLengths[runIdx];
    for (let charIdx = 0; charIdx < runLen; charIdx++)
      if (startIndex <= charOffset + charIdx && charOffset + charIdx < endIndex) counts.push(runIdx);
    charOffset += runLen
  }
  const baseRunIdx = counts[0];
  const histogram = [];
  for (let idx = 0; idx < counts.length; idx++) {
    const offset = counts[idx] - baseRunIdx;
    if (offset == histogram.length) histogram.push(0);
    histogram[offset]++
  }
  return histogram
};
TextEngineData.mergeAdjacentRuns = function(engineData) {
  const styleRun = engineData.EngineDict.StyleRun;
  const runArray = styleRun.RunArray;
  const runLengths = styleRun.RunLengthArray;
  for (let idx = 0; idx < runLengths.length - 1; idx++) {
    const styleA = runArray[idx].StyleSheet.StyleSheetData;
    const styleB = runArray[idx + 1].StyleSheet.StyleSheetData;
    if (JSON.stringify(styleA) == JSON.stringify(styleB)) {
      runArray.splice(idx + 1, 1);
      runLengths[idx] += runLengths[idx + 1];
      runLengths.splice(idx + 1, 1);
      idx--
    }
  }
};
TextEngineData.getAntiAliasMode = function(textShape) {
  let antiAliasTag = textShape.textDescriptor.AntA.v.Annt;
  antiAliasTag = ["Anno", "antiAliasSharp", "AnCr", "AnSt", "AnSm"].indexOf(antiAliasTag);
  if (antiAliasTag == -1) antiAliasTag = 1;
  return antiAliasTag
};
TextEngineData.setAntiAliasMode = function(textShape, modeIndex) {
  textShape.textDescriptor.AntA.v.Annt = ["Anno", "antiAliasSharp", "AnCr", "AnSt", "AnSm"][modeIndex]
};
TextEngineData.getTextStyle = function(engineData, startIndex, endIndex) {
  const styleBundle = {
      fontSet: engineData.ResourceDict.FontSet.slice(0),
      textStyle: [],
      paraStyle: []
    };

  const styleRunLengths = engineData.EngineDict.StyleRun.RunLengthArray;
  const styleStartRun = TextEngineData.findRunAtChar(styleRunLengths, startIndex).runIdx;
  const styleEndRun = TextEngineData.findRunAtChar(styleRunLengths, endIndex).runIdx;
  for (let idx = styleStartRun; idx <= styleEndRun; idx++) {
    const baseStyle = TextEngineData.deepClone(engineData.ResourceDict.StyleSheetSet[0].StyleSheetData);
    const styleRunArray = engineData.EngineDict.StyleRun.RunArray;
    if (styleRunArray.length == 0) continue;
    const runStyleData = styleRunArray[idx].StyleSheet.StyleSheetData;
    TextEngineData.mergeProps(baseStyle, runStyleData);
    styleBundle.textStyle.push(baseStyle)
  }
  const paraRunLengths = engineData.EngineDict.ParagraphRun.RunLengthArray;
  const paraStartRun = TextEngineData.findRunAtChar(paraRunLengths, startIndex).runIdx;
  const paraEndRun = TextEngineData.findRunAtChar(paraRunLengths, endIndex).runIdx;
  for (let idx = paraStartRun; idx <= paraEndRun; idx++) {
    const paraRunArray = engineData.EngineDict.ParagraphRun.RunArray;
    if (paraRunArray.length == 0) continue;
    styleBundle.paraStyle.push(TextEngineData.deepClone(paraRunArray[idx].ParagraphSheet.Properties))
  }
  styleBundle.textStyle = styleBundle.textStyle.length == 0 ? {} : TextEngineData.intersectStyles(styleBundle.textStyle);
  styleBundle.paraStyle = styleBundle.paraStyle.length == 0 ? {} : TextEngineData.intersectStyles(styleBundle.paraStyle);
  return styleBundle
};
TextEngineData.scaleTextStyle = function(styleBundle, scale) {
  let sizeKeys;
  let styleProps;
  sizeKeys = ["FontSize", "Leading", "BaselineShift"];
  styleProps = styleBundle.textStyle;
  for (let idx = 0; idx < sizeKeys.length; idx++)
    if (styleProps[sizeKeys[idx]] != null) styleProps[sizeKeys[idx]] *= scale;
  sizeKeys = ["StartIndent", "EndIndent", "FirstLineIndent", "SpaceBefore", "SpaceAfter"];
  styleProps = styleBundle.paraStyle;
  for (let idx = 0; idx < sizeKeys.length; idx++)
    if (styleProps[sizeKeys[idx]] != null) styleProps[sizeKeys[idx]] *= scale
};
TextEngineData.getDefaultTextStyle = function() {
  return TextEngineData.getTextStyle(TextEngineData.engineDataTemplate, 0, 0);
};
TextEngineData.createTxLrDescriptor = function() {
  return {
    classID: "TxLr",
    Txt: {
      t: "TEXT",
      v: "\0"
    },
    textGridding: {
      t: "enum",
      v: {
        textGridding: "None"
      }
    },
    Ornt: {
      t: "enum",
      v: {
        Ornt: "Hrzn"
      }
    },
    AntA: {
      t: "enum",
      v: {
        Annt: "antiAliasSharp"
      }
    },
    TextIndex: {
      t: "long",
      v: 0
    }
  }
};
TextEngineData.findRunAtChar = function(runLengths, charIndex) {
  let charOffset = 0;
  let runIdx = 0;
  while (charOffset + runLengths[runIdx] <= charIndex) {
    charOffset += runLengths[runIdx];
    runIdx++
  }
  return {
    runIdx: runIdx,
    runStart: charOffset
  };
};
TextEngineData.cloneEngineData = function() {
  const cloned = TextEngineData.deepClone(this.engineDataTemplate);
  return cloned
};
TextEngineData.defaultParagraphProps = {
  Justification: 0,
  FirstLineIndent: 0,
  StartIndent: 0,
  EndIndent: 0,
  SpaceBefore: 0,
  SpaceAfter: 0,
  AutoHyphenate: false,
  HyphenatedWordSize: 6,
  PreHyphen: 2,
  PostHyphen: 2,
  ConsecutiveHyphens: 8,
  Zone: 36,
  WordSpacing: [.8, 1, 1.33],
  LetterSpacing: [0, 0, 0],
  GlyphSpacing: [1, 1, 1],
  AutoLeading: 1.2,
  LeadingType: 0,
  Hanging: false,
  Burasagari: false,
  KinsokuOrder: 0,
  EveryLineComposer: false,
  _Direction: 0
};
TextEngineData.defaultTextStyleData = {
  Font: 0,
  FontSize: 12,
  FauxBold: false,
  FauxItalic: false,
  AutoLeading: true,
  Leading: 0,
  HorizontalScale: 1,
  VerticalScale: 1,
  Tracking: 0,
  AutoKerning: true,
  Kerning: 0,
  BaselineShift: 0,
  FontCaps: 0,
  FontBaseline: 0,
  Underline: false,
  Strikethrough: false,
  Ligatures: true,
  DLigatures: false,
  BaselineDirection: 2,
  Tsume: 0,
  StyleRunAlignment: 2,
  Language: 0,
  NoBreak: false,
  FillColor: {
    Type: 1,
    Values: [1, 0, 0, 0]
  },
  StrokeColor: {
    Type: 1,
    Values: [1, 0, 0, 0]
  },
  FillFlag: true,
  StrokeFlag: false,
  FillFirst: true,
  YUnderline: 1,
  OutlineWidth: 1,
  CharacterDirection: 0,
  HindiNumbers: false,
  Kashida: 1,
  DiacriticPos: 2
};
TextEngineData.engineDataTemplate = {
  EngineDict: {
    Editor: {
      Text: "\n"
    },
    ParagraphRun: {
      DefaultRunData: {
        ParagraphSheet: {
          DefaultStyleSheet: 0,
          Properties: {}
        },
        Adjustments: {
          Axis: [1, 0, 1],
          XY: [0, 0]
        }
      },
      RunArray: [{
        ParagraphSheet: {
          DefaultStyleSheet: 0,
          Properties: JSON.parse(JSON.stringify(TextEngineData.defaultParagraphProps))
        },
        Adjustments: {
          Axis: [1, 0, 1],
          XY: [0, 0]
        }
      }],
      RunLengthArray: [1],
      IsJoinable: 1
    },
    StyleRun: {
      DefaultRunData: {
        StyleSheet: {
          StyleSheetData: {}
        }
      },
      RunArray: [{
        StyleSheet: {
          StyleSheetData: {
            Font: 0,
            FontSize: 24,
            AutoKerning: true,
            Kerning: 0
          }
        }
      }],
      RunLengthArray: [1],
      IsJoinable: 2
    },
    GridInfo: {
      GridIsOn: false,
      ShowGrid: false,
      GridSize: 18,
      GridLeading: 22,
      GridColor: {
        Type: 1,
        Values: [0, 0, 0, 1]
      },
      GridLeadingFillColor: {
        Type: 1,
        Values: [0, 0, 0, 1]
      },
      AlignLineHeightToGridFlags: false
    },
    AntiAlias: 4,
    UseFractionalGlyphWidths: true,
    Rendered: {
      Version: 1,
      Shapes: {
        WritingDirection: 0,
        Children: [{
          ShapeType: 0,
          Procession: 0,
          Lines: {
            WritingDirection: 0,
            Children: []
          },
          Cookie: {
            Photoshop: {
              ShapeType: 0,
              PointBase: [0, 0],
              Base: {
                ShapeType: 0,
                TransformPoint0: [1, 0],
                TransformPoint1: [0, 1],
                TransformPoint2: [0, 0]
              }
            }
          }
        }]
      }
    }
  },
  ResourceDict: {
    KinsokuSet: [{
      Name: "PhotoshopKinsokuHard",
      NoStart: "\u3001\u3002\uFF0C\uFF0E\u30FB\uFF1A\uFF1B\uFF1F\uFF01\u30FC\u2015\u2019\u201D\uFF09\u3015\uFF3D\uFF5D\u3009\u300B\u300D\u300F\u3011\u30FD\u30FE\u309D\u309E\u3005\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6\u309B\u309C?!)]},.:;\u2103\u2109\xA2\uFF05\u2030",
      NoEnd: "\u2018\u201C\uFF08\u3014\uFF3B\uFF5B\u3008\u300A\u300C\u300E\u3010([{\uFFE5\uFF04\xA3\uFF20\xA7\u3012\uFF03",
      Keep: "\u2015\u2025",
      Hanging: "\u3001\u3002.,"
    }, {
      Name: "PhotoshopKinsokuSoft",
      NoStart: "\u3001\u3002\uFF0C\uFF0E\u30FB\uFF1A\uFF1B\uFF1F\uFF01\u2019\u201D\uFF09\u3015\uFF3D\uFF5D\u3009\u300B\u300D\u300F\u3011\u30FD\u30FE\u309D\u309E\u3005",
      NoEnd: "\u2018\u201C\uFF08\u3014\uFF3B\uFF5B\u3008\u300A\u300C\u300E\u3010",
      Keep: "\u2015\u2025",
      Hanging: "\u3001\u3002.,"
    }],
    MojiKumiSet: [{
      InternalName: "Photoshop6MojiKumiSet1"
    }, {
      InternalName: "Photoshop6MojiKumiSet2"
    }, {
      InternalName: "Photoshop6MojiKumiSet3"
    }, {
      InternalName: "Photoshop6MojiKumiSet4"
    }],
    TheNormalStyleSheet: 0,
    TheNormalParagraphSheet: 0,
    ParagraphSheetSet: [{
      Name: "Normal RGB",
      DefaultStyleSheet: 0,
      Properties: JSON.parse(JSON.stringify(TextEngineData.defaultParagraphProps))
    }],
    StyleSheetSet: [{
      Name: "Normal RGB",
      StyleSheetData: JSON.parse(JSON.stringify(TextEngineData.defaultTextStyleData))
    }],
    FontSet: [{
      Name: "DejaVuSans",
      Script: 0,
      FontType: 1,
      Synthetic: 0
    }, {
      Name: "AdobeInvisFont",
      Script: 0,
      FontType: 0,
      Synthetic: 0
    }, {
      Name: "MyriadHebrew-Regular",
      Script: 6,
      FontType: 0,
      Synthetic: 0
    }],
    SuperscriptSize: .583,
    SuperscriptPosition: .333,
    SubscriptSize: .583,
    SubscriptPosition: .333,
    SmallCapSize: .7
  }
};

export { TextEngineData };
