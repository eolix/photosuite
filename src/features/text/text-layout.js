// Paragraph / word-run layout for Photoshop EngineData text.

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { FontRegistry } from "../../fonts/font-registry.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { TextEngineData } from "./text-engine.js";
import { computeTextPathData, findPathIndex, getPathPosition } from "./text-path-geometry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { canonicalPath, polygonScanlineXsAtY } from "../../engine/compositing/anti-alias.js";

/**
 * Layout EngineData into paragraph nodes, word runs, and per-character styles.
 * @param {object} engineData Photoshop EngineData tree.
 * @param {object} fontRegistry FontRegistry used to load faces per character.
 */
function TextLayout(engineData, fontRegistry) {
  const textType = TextEngineData.getTextType(engineData);
  let boxRect;
  let pathData;
  const boxBounds = TextEngineData.getBoxBounds(engineData);
  let styleAtChar;
  if (engineData.Curve) pathData = computeTextPathData(engineData.Curve);
  if (textType != 0) {
    boxRect = new Rect(boxBounds[0], boxBounds[1], boxBounds[2], boxBounds[3]);
    if (textType == 2) {
      boxRect.width = pathData[5] - pathData[4];
      boxRect.height = 9999
    }
  }
  this.paraStyle = [];
  this.textStyle = [];
  this.textType = textType;
  const layerText = this.rawText = TextEngineData.getLayerText(engineData);
  let prevRunIdx = -1;
  for (let charIdx = 0; charIdx < layerText.length; charIdx++) {
    let charStyle = styleAtChar;
    let runIdx = TextEngineData.getRunIdxAtChar(engineData, charIdx);
    if (runIdx != prevRunIdx) {
      prevRunIdx = runIdx;
      charStyle = styleAtChar = TextEngineData.getStyleAtChar(engineData, charIdx)
    }

    const charEntry = {
        char: layerText.charAt(charIdx),
        styleSheet: charStyle,
        font: null,
        glyphIdx: -1,
        alternateGlyphId: TextEngineData.getAlternateGlyph(engineData, charIdx),
        baselineOffset: 0,
        scale: new Point(0, 0),
        ascenderHeight: 0,
        lineHeight: 0,
        bidiLevel: 0
      };

    const fontName = engineData.ResourceDict.FontSet[charStyle.Font].Name;
    const fontFace = charEntry.font = fontRegistry.loadFontFace(fontName, layerText.charCodeAt(charIdx));
    charEntry.scale.x = charStyle.HorizontalScale == null ? 1 : charStyle.HorizontalScale;
    charEntry.scale.y = charStyle.VerticalScale == null ? 1 : charStyle.VerticalScale;
    const os2Table = fontFace["OS/2"];
    const hheaTable = fontFace.hhea;
    if (charStyle.FontCaps == 1 && charEntry.char != charEntry.char.toUpperCase()) {
      const capScale = os2Table.sxHeight ? os2Table.sxHeight / os2Table.sTypoAscender : .76;
      charEntry.scale.x *= capScale;
      charEntry.scale.y *= capScale
    }
    const emScale = 1 / fontFace.head.unitsPerEm * charStyle.FontSize;
    if (charStyle.FontBaseline == 1) {
      const superScale = engineData.ResourceDict.SuperscriptSize;
      charEntry.scale.x *= superScale;
      charEntry.scale.y *= superScale;
      charEntry.baselineOffset -= engineData.ResourceDict.SuperscriptPosition * charStyle.FontSize
    }
    if (charStyle.FontBaseline == 2) {
      const subScale = engineData.ResourceDict.SubscriptSize;
      charEntry.scale.x *= subScale;
      charEntry.scale.y *= subScale;
      charEntry.baselineOffset += engineData.ResourceDict.SubscriptPosition * charStyle.FontSize
    }
    charEntry.ascenderHeight = TextLayout.computeAscenderHeight(fontFace, fontName, charStyle);
    charEntry.lineHeight = charStyle.FontSize * 1.2;
    if (charStyle.AutoLeading == false) charEntry.lineHeight = charStyle.Leading;
    if (charEntry.lineHeight == 0) charEntry.lineHeight = .01;
    this.textStyle.push(charEntry)
  }
  const paraLayouts = this.paraStyle;
  const yCursor = [0];
  for (let paraIdx = 0; paraIdx < engineData.EngineDict.ParagraphRun.RunLengthArray.length; paraIdx++) {
    const paraLayout = new TextLayout.ParagraphLayout(engineData, fontRegistry, this.textStyle, paraIdx, boxRect, yCursor, textType == 1 ? pathData : null);
    paraLayouts.push(paraLayout)
  }
  if (textType == 2) {
    const curvePoints = engineData.Curve.Points;
    const flatCoords = pathData[0];
    const segmentIndices = pathData[1];
    const arcLengths = pathData[2];
    const totalLength = pathData[3];
    const pathStart = pathData[4];
    const pathEnd = pathData[5];
    for (let paraIdx = 0; paraIdx < paraLayouts.length; paraIdx++)
      for (let nodeIdx = 0; nodeIdx < paraLayouts[paraIdx].nodes.length; nodeIdx++)
        if (!(paraIdx == 0 && nodeIdx == 0)) paraLayouts[paraIdx].nodes[nodeIdx].isVisible = false;
    const firstPara = paraLayouts[0];
    const firstNode = firstPara.nodes[0];
    firstPara.offset.setXY(0, 0);
    firstNode.offset.setXY(0, 0);
    for (let nodeIdx = firstNode.start; nodeIdx < firstNode.end; nodeIdx++) {
      const wordRun = firstPara.wordRuns[nodeIdx];
      const savedOffsetX = wordRun.offset.x;
      wordRun.offset.x = 0;
      for (let glyphIdx = wordRun.firstGlyph; glyphIdx <= wordRun.lastGlyph; glyphIdx++) {
        const glyph = firstPara.glyphs[glyphIdx];
        const halfAdvance = glyph.bounds.width / 2;
        glyph.offset.x += savedOffsetX;
        const pathPos = getPathPosition(flatCoords, (pathStart + glyph.offset.x + halfAdvance) % totalLength);
        glyph.offset.x = pathPos[0] - halfAdvance * pathPos[2];
        glyph.offset.y = pathPos[1] - halfAdvance * pathPos[3];
        glyph.pathTangent = Math.atan2(pathPos[3], pathPos[2])
      }
    }
  }
}
TextLayout.computeAscenderHeight = function(fontFace, fontName, styleSheet) {
  const os2Table = fontFace["OS/2"];
  const hheaTable = fontFace.hhea;
  var ascender = 0;
  var ascender = 0;
  const candidates = [];
  candidates.push(os2Table && os2Table.sxHeight && fontName.toLowerCase().indexOf("capitals") != -1 ? os2Table.sxHeight : 0);
  candidates.push(os2Table && os2Table.sCapHeight ? os2Table.sCapHeight : 0);
  candidates.push(os2Table && os2Table.sTypoAscender ? os2Table.sTypoAscender : 0);
  candidates.push(hheaTable.ascender ? hheaTable.ascender : 0);
  for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx++)
    if (candidates[candidateIdx] != 0) {
      ascender = candidates[candidateIdx];
      break
    }
  const fontScale = 1 / fontFace.head.unitsPerEm * styleSheet.FontSize;
  ascender = ascender * fontScale;
  if (ascender < styleSheet.FontSize * .6) ascender = styleSheet.FontSize * .75;
  return ascender
};
TextLayout.prototype.isBoxFull = function() {
  return !this.getLayoutInfo(0)
};
TextLayout.prototype.getLineCount = function() {
  return this.getLayoutInfo(1)
};
TextLayout.prototype.getLayoutInfo = function(modeIndex) {
  const paraLayouts = this.paraStyle;
  let allVisible = true;
  let lineCount = 0;
  for (let paraIdx = 0; paraIdx < paraLayouts.length; paraIdx++) {
    const lineNodes = paraLayouts[paraIdx].nodes;
    const nodeCount = lineNodes.length;
    lineCount += nodeCount;
    for (let nodeIdx = 0; nodeIdx < nodeCount; nodeIdx++) allVisible &= lineNodes[nodeIdx].isVisible
  }
  return [allVisible, lineCount][modeIndex]
};
TextLayout.prototype.getTextStyleAt = function(charIndex) {
  return this.textStyle[charIndex];
};
TextLayout.prototype.getWordBounds = function(charIndex) {
  for (let paraIdx = 0; paraIdx < this.paraStyle.length; paraIdx++) {
    const paraLayout = this.paraStyle[paraIdx];
    for (let nodeIdx = 0; nodeIdx < paraLayout.nodes.length; nodeIdx++) {
      const lineNode = paraLayout.nodes[nodeIdx];
      const wordStart = paraLayout.wordRuns[lineNode.start].start;
      const wordEnd = paraLayout.wordRuns[lineNode.end - 1].end;
      if (wordStart < charIndex && charIndex < wordEnd) return [wordStart, wordEnd - 1]
    }
  }
  return [0, 1]
};
TextLayout.prototype.hitTestChar = function(point, lineIndex) {
  let currentLine = -1;
  const paraLayouts = this.paraStyle;
  if (this.textType == 2) {
    let bestDistSq = 1e9;
    let bestCharIdx = 0;
    const firstPara = paraLayouts[0];
    const firstNode = firstPara.nodes[0];
    for (let wordRunIdx = firstNode.start; wordRunIdx < firstNode.end; wordRunIdx++) {
      var wordRun = firstPara.wordRuns[wordRunIdx];
      for (let glyphIdx = wordRun.firstGlyph; glyphIdx <= wordRun.lastGlyph; glyphIdx++) {
        var glyph = firstPara.glyphs[glyphIdx];
        var glyphWidth = glyph.bounds.width;
        const dx = point.x - glyph.offset.x;
        const dy = point.y - glyph.offset.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestCharIdx = glyph.charIdx
        }
      }
    }
    if (bestCharIdx != 0 && this.rawText.codePointAt(bestCharIdx - 1) > 65535) bestCharIdx--;
    return bestCharIdx
  }
  for (let paraIdx = 0; paraIdx < paraLayouts.length; paraIdx++) {
    const paraLayout = paraLayouts[paraIdx];
    for (let nodeIdx = 0; nodeIdx < paraLayout.nodes.length; nodeIdx++) {
      currentLine++;
      const lineNode = paraLayout.nodes[nodeIdx];
      let nextNode = paraLayout.nodes[nodeIdx + 1];
      if (nextNode == null && paraIdx < paraLayouts.length - 1) nextNode = paraLayouts[paraIdx + 1].nodes[0];
      if (lineIndex != null) {
        if (currentLine != lineIndex) continue
      } else {
        if (nextNode != null && paraLayout.offset.y + lineNode.offset.y < point.y) continue
      }
      for (let wordRunIdx = lineNode.start; wordRunIdx < lineNode.end; wordRunIdx++) {
        var wordRun = paraLayout.wordRuns[wordRunIdx];
        for (let glyphIdx = wordRun.firstGlyph; glyphIdx <= wordRun.lastGlyph; glyphIdx++) {
          var glyph = paraLayout.glyphs[glyphIdx];
          var glyphWidth = glyph.bounds.width;
          const runLeft = paraLayout.offset.x + lineNode.offset.x + wordRun.offset.x;
          const glyphLeft = runLeft + glyph.offset.x;
          const glyphRight = runLeft + (glyphIdx < wordRun.lastGlyph ? paraLayout.glyphs[glyphIdx + 1].offset.x : glyph.offset.x + glyphWidth);
          if (point.x <= glyphRight || wordRunIdx + 1 == lineNode.end && glyphIdx == wordRun.lastGlyph) {
            let charIndex = paraLayout.textStart + glyph.charIdx;
            let charStyle = this.textStyle[charIndex];
            const rtl = charStyle.bidiLevel & 1;
            if (charStyle.char != "\n" && (rtl == 0 && point.x > glyphLeft + glyphWidth / 2 || rtl == 1 && point.x < glyphLeft + glyphWidth / 2)) charIndex += this.rawText.codePointAt(charIndex) > 65535 ? 2 : 1;
            return charIndex
          }
        }
      }
    }
  }
};
TextLayout.prototype.getGlyphBounds = function(charIndex) {
  const glyphBounds = {
      bounds: new Rect,
      lineIndex: 0
    };

  let lineCounter = 0;
  for (let paraIdx = 0; paraIdx < this.paraStyle.length; paraIdx++) {
    const paraLayout = this.paraStyle[paraIdx];
    for (let nodeIdx = 0; nodeIdx < paraLayout.nodes.length; nodeIdx++) {
      const lineNode = paraLayout.nodes[nodeIdx];
      glyphBounds.lineIndex = lineCounter;
      lineCounter++;
      for (let wordRunIdx = lineNode.start; wordRunIdx < lineNode.end; wordRunIdx++) {
        const wordRun = paraLayout.wordRuns[wordRunIdx];
        for (let charOffset = wordRun.start; charOffset < wordRun.end; charOffset++) {
          if (charOffset == charIndex) {
            let charStyle = this.textStyle[charOffset];
            let glyphIdx = charStyle.glyphIdx;
            const firstGlyph = paraLayout.glyphs[glyphIdx];
            // A word run whose characters never reached shaping leaves its
            // glyphs unplaced; report the empty bounds rather than reading them.
            if (firstGlyph == null || firstGlyph.offset == null) return glyphBounds;
            const clusterCharIdx = firstGlyph.charIdx;
            const glyphStep = 1;
            while (paraLayout.glyphs[glyphIdx] != null
              && paraLayout.glyphs[glyphIdx].offset != null
              && paraLayout.glyphs[glyphIdx].charIdx == clusterCharIdx) {
              const glyph = paraLayout.glyphs[glyphIdx];
              const glyphLeft = paraLayout.offset.x + lineNode.offset.x + wordRun.offset.x + glyph.offset.x;
              const glyphTop = paraLayout.offset.y + lineNode.offset.y + wordRun.offset.y + glyph.offset.y;
              glyphBounds.bounds = glyphBounds.bounds.union(new Rect(glyphLeft, glyphTop - charStyle.lineHeight, glyph.bounds.width, charStyle.lineHeight));
              glyphBounds.pathTangent = glyph.pathTangent;
              glyphIdx += glyphStep
            }
            return glyphBounds
          }
        }
      }
    }
  }
};
TextLayout.prototype.getBounds = function() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let paraIdx = 0; paraIdx < this.paraStyle.length; paraIdx++) {
    const paraLayout = this.paraStyle[paraIdx];
    for (let nodeIdx = 0; nodeIdx < paraLayout.nodes.length; nodeIdx++) {
      const lineNode = paraLayout.nodes[nodeIdx];
      if (!lineNode.isVisible) break;
      for (let wordRunIdx = lineNode.start; wordRunIdx < lineNode.end; wordRunIdx++) {
        const wordRun = paraLayout.wordRuns[wordRunIdx];
        for (let glyphIdx = wordRun.firstGlyph; glyphIdx <= wordRun.lastGlyph; glyphIdx++) {
          const glyph = paraLayout.glyphs[glyphIdx];
          const glyphRect = glyph.bounds;
          const glyphLeft = paraLayout.offset.x + lineNode.offset.x + wordRun.offset.x + glyph.offset.x;
          const glyphTop = paraLayout.offset.y + lineNode.offset.y + wordRun.offset.y + glyph.offset.y;
          minX = Math.min(minX, glyphLeft + glyphRect.x);
          minY = Math.min(minY, glyphTop + glyphRect.y);
          maxX = Math.max(maxX, glyphLeft + glyphRect.x + glyphRect.width);
          maxY = Math.max(maxY, glyphTop + glyphRect.y + glyphRect.height)
        }
      }
    }
  }
  return new Rect(minX, minY, maxX - minX, maxY - minY);
};
const CJK_IDEOGRAPH_START = 19968;
const CJK_IDEOGRAPH_END = 40959;
const CJK_PUNCTUATION_START = 12288;
const CJK_PUNCTUATION_END = 12543;

TextLayout.isCJK = function (charCode) {
  return (
    (CJK_IDEOGRAPH_START <= charCode && charCode <= CJK_IDEOGRAPH_END) ||
    (CJK_PUNCTUATION_START <= charCode && charCode <= CJK_PUNCTUATION_END)
  );
};
TextLayout.buildWordRuns = function(engineData, fontRegistry, textStyle, textStart, glyphs, runStart, runEnd) {
  const segmentData = [runStart];
  let segmentLen = 0;
  for (let charOffset = runStart; charOffset < runEnd; charOffset++) {
    const charText = textStyle[charOffset].char;
    const charCode = charText.charCodeAt(0);
    if (charCode == 32 || charCode == 9) {
      segmentData.push(segmentLen, charOffset, 1, charOffset + 1);
      segmentLen = 0
    } else if (charCode == 3851) {
      segmentData.push(segmentLen + 1, charOffset + 1);
      segmentLen = 0
    } else if (TextLayout.isCJK(charCode)) {
      segmentData.push(segmentLen, charOffset);
      segmentLen = 1
    } else if (charOffset != runStart && textStyle[charOffset].bidiLevel != textStyle[charOffset - 1].bidiLevel) {
      segmentData.push(segmentLen, charOffset);
      segmentLen = 1
    } else segmentLen++
  }
  segmentData.push(segmentLen);
  const wordRuns = [];
  for (let segIdx = 0; segIdx < segmentData.length; segIdx += 2) {
    const wordStart = segmentData[segIdx];
    const wordLen = segmentData[segIdx + 1];
    if (wordLen == 0) continue;
    wordRuns.push(new TextLayout.WordRun(engineData, fontRegistry, textStyle, textStart, glyphs, wordStart, wordLen))
  }
  return wordRuns
};
TextLayout.layoutLine = function(wordRuns, boxRect, paraProps, pathPolygon, yCursor, wordRunStart, layoutOutput) {
  let lineSpans = [0, boxRect ? boxRect.width : 1e9];
  const wordCounts = [];
  if (pathPolygon) {
    const ascenderHeight = wordRuns[wordRunStart].ascenderHeight;
    const lineBottom = yCursor + (yCursor == 0 ? ascenderHeight : wordRuns[wordRunStart].lineHeight);
    const scanYTop = lineBottom - ascenderHeight * .9;
    const topIntersections = polygonScanlineXsAtY(pathPolygon[0], scanYTop);
    const topCount = topIntersections.length;
    const bottomIntersections = polygonScanlineXsAtY(pathPolygon[0], lineBottom);
    const bottomCount = bottomIntersections.length;
    if (topCount != 0 && bottomCount != 0) {
      let topIdx = 0;
      let bottomIdx = 0;
      lineSpans = [];
      while (topIdx < topCount && bottomIdx < bottomCount) {
        const spanLeft = Math.max(topIntersections[topIdx], bottomIntersections[bottomIdx]);
        const topRight = topIntersections[topIdx + 1];
        const bottomRight = bottomIntersections[bottomIdx + 1];
        const spanRight = Math.min(topRight, bottomRight);
        if (spanLeft < spanRight) lineSpans.push(spanLeft, spanRight);
        if (topRight < bottomRight) topIdx += 2;
        else bottomIdx += 2
      }
    }
  }
  for (let spanIdx = 0; spanIdx < lineSpans.length; spanIdx += 2) {
    const spanWidth = lineSpans[spanIdx + 1] - lineSpans[spanIdx];
    let lineWidth = 0;
    const lineStart = wordRunStart;
    const maxWidth = boxRect ? spanWidth - paraProps.StartIndent - paraProps.EndIndent - (wordRunStart == 0 ? paraProps.FirstLineIndent : 0) : Infinity;
    while (wordRunStart != wordRuns.length) {
      const wordRun = wordRuns[wordRunStart];
      const fits = lineWidth == 0 || (wordRun.isSpace || wordRun.isNewline) || lineWidth + wordRun.bounds.width < maxWidth;
      if (!fits) break;
      lineWidth += wordRun.bounds.width;
      wordRunStart++
    }
    wordCounts.push(wordRunStart - lineStart)
  }
  layoutOutput[0] = wordCounts;
  layoutOutput[1] = lineSpans;
  layoutOutput[2] = wordRunStart
};
TextLayout.getBidiLevels = function(text, direction) {
  const textLen = text.length;
  const codePoints = new Uint32Array(textLen);
  let bidiLevels = new Uint8Array(textLen);
  let maxCode = 0;
  for (let charIdx = 0; charIdx < textLen; charIdx++) {
    bidiLevels[charIdx] = 0;
    const charCode = text.charCodeAt(charIdx);
    codePoints[charIdx] = charCode;
    if (charCode > maxCode) maxCode = charCode
  }
  if (maxCode > 1424) bidiLevels = TextLayout.resolveBidiLevels(codePoints, direction);
  return bidiLevels
};
TextLayout.ParagraphLayout = function(engineData, fontRegistry, textStyle, paraRunIdx, boxRect, yCursor, pathData) {
  this.wordRuns = [];
  this.nodes = [];
  this.offset = new Point(0, 0);
  this.glyphs = null;
  this.wordRuns = null;
  this.paraProps = TextEngineData.mergeParagraphRun(engineData, paraRunIdx);
  const paraProps = this.paraProps;
  let charOffset = 0;
  let displayText = "";
  let runStart = 0;
  let runSegmentLen = 1;
  let wordRunIdx = 0;
  if (paraRunIdx != 0) {
    const spaceBefore = paraProps.SpaceBefore;
    if (spaceBefore != null) yCursor[0] += spaceBefore
  }
  const runLengths = engineData.EngineDict.ParagraphRun.RunLengthArray;
  const paraRunLen = runLengths[paraRunIdx];
  for (let prevRunIdx = 0; prevRunIdx < paraRunIdx; prevRunIdx++) charOffset += runLengths[prevRunIdx];
  const direction = paraProps._Direction ? paraProps._Direction : 0;
  this.textStart = charOffset;
  let paraText = TextEngineData.getLayerText(engineData).slice(charOffset, charOffset + paraRunLen);
  for (let charIdx = 0; charIdx < paraText.length; charIdx++) {
    const ch = paraText.charAt(charIdx);
    displayText += textStyle[charOffset + charIdx].styleSheet.FontCaps == 0 ? ch : ch.toUpperCase()
  }
  paraText = displayText;
  let bidiLevels = TextLayout.getBidiLevels(paraText, direction);
  const fontRuns = [];
  let rtlFlag = bidiLevels[charOffset] & 1;
  let runFont = textStyle[charOffset].font;
  textStyle[charOffset].bidiLevel = bidiLevels[0];
  for (let charIdx = 1; charIdx < paraText.length; charIdx++) {
    const charEntry = textStyle[charOffset + charIdx];
    var bidiLevel = bidiLevels[charIdx];
    charEntry.bidiLevel = bidiLevel;
    if (bidiLevel != rtlFlag || charEntry.font != runFont) {
      fontRuns.push(runStart, runSegmentLen);
      runStart = charIdx;
      runSegmentLen = 1;
      rtlFlag = bidiLevel;
      runFont = charEntry.font
    } else runSegmentLen++
  }
  fontRuns.push(runStart, runSegmentLen);
  const glyphs = this.glyphs = [];
  for (let runIdx = 0; runIdx < fontRuns.length; runIdx += 2) {
    const fontRunStart = fontRuns[runIdx];
    const fontRunLen = fontRuns[runIdx + 1];
    const ltr = (textStyle[charOffset + fontRunStart].bidiLevel & 1) == 0;
    const runText = paraText.slice(fontRunStart, fontRunStart + fontRunLen);
    let shapedGlyphs = Typr.U.shapeHB(textStyle[charOffset + fontRunStart].font, runText, { ltr: ltr });
    const glyphList = [];
    for (let glyphIdx = 0; glyphIdx < shapedGlyphs.length; glyphIdx++) {
      const shaped = shapedGlyphs[glyphIdx];
      glyphList.push({
        glyphId: shaped.g,
        charIdx: shaped.cl,
        advanceWidth: shaped.ax,
        advanceHeight: shaped.ay,
        offsetX: shaped.dx,
        offsetY: shaped.dy
      })
    }
    shapedGlyphs = glyphList;
    // Point each character at a glyph: the one whose cluster is the highest at
    // or before that character, and among equal clusters the first. Clusters
    // run in shaping order, which is visual order — descending for a
    // right-to-left run — so this scans rather than walking a cursor, and the
    // index it yields is already an index into the order glyphs are pushed in.
    for (let charIdx = 0; charIdx < runText.length; charIdx++) {
      let pickedGlyph = 0;
      let pickedCluster = -1;
      for (let glyphIdx = 0; glyphIdx < shapedGlyphs.length; glyphIdx++) {
        const cluster = shapedGlyphs[glyphIdx].charIdx;
        if (cluster <= charIdx && cluster > pickedCluster) {
          pickedCluster = cluster;
          pickedGlyph = glyphIdx
        }
      }
      textStyle[charOffset + fontRunStart + charIdx].glyphIdx = glyphs.length + pickedGlyph
    }
    for (let glyphIdx = 0; glyphIdx < shapedGlyphs.length; glyphIdx++) {
      glyphs.push(shapedGlyphs[glyphIdx]);
      shapedGlyphs[glyphIdx].charIdx += fontRunStart;
      const glyphChar = textStyle[charOffset + shapedGlyphs[glyphIdx].charIdx];
      // A glyph the Glyphs panel inserted directly has no cmap entry, so the
      // shaper produced a placeholder for it. Swap in the requested glyph and
      // take its advance from hmtx.
      if (glyphChar.alternateGlyphId != -1 && glyphChar.alternateGlyphId < glyphChar.font.maxp.numGlyphs) {
        shapedGlyphs[glyphIdx].glyphId = glyphChar.alternateGlyphId;
        const hmtx = glyphChar.font.hmtx;
        if (hmtx) shapedGlyphs[glyphIdx].advanceWidth = hmtx.aWidth[glyphChar.alternateGlyphId]
      }
      if (glyphChar.char == "\n") shapedGlyphs[glyphIdx].advanceWidth = 0;
      if (glyphChar.char == "\t") shapedGlyphs[glyphIdx].advanceWidth = glyphChar.font.head.unitsPerEm * 2
    }
  }
  const justification = TextEngineData.getJustification(paraProps);
  const wordRuns = this.wordRuns = TextLayout.buildWordRuns(engineData, fontRegistry, textStyle, charOffset, glyphs, charOffset, charOffset + paraRunLen);
  const lineNodes = this.nodes;
  let lineIdx = -1;
  const layoutScratch = [null, null, 0];
  while (wordRunIdx < wordRuns.length) {
    TextLayout.layoutLine(wordRuns, boxRect, paraProps, pathData, yCursor[0], wordRunIdx, layoutScratch);
    lineIdx++;

    const lineNode = {
        start: wordRunIdx,
        end: 0,
        bounds: new Rect,
        offset: new Point(0, 0),
        isVisible: true
      };

    let maxAscender = 0;
    let maxLineHeight = 0;
    lineNodes.push(lineNode);
    lineNode.end = layoutScratch[2];
    const isLastLine = lineNode.end == wordRuns.length;

    function reverseWordRunSlice(wordRuns, sliceStart, sliceEnd) {
      const halfLen = sliceEnd - sliceStart >>> 1;
      for (let swapIdx = 0; swapIdx < halfLen; swapIdx++) {
        const tmpRun = wordRuns[sliceStart + swapIdx];
        wordRuns[sliceStart + swapIdx] = wordRuns[sliceEnd - 1 - swapIdx];
        wordRuns[sliceEnd - 1 - swapIdx] = tmpRun
      }
    }
    for (let bidiPass = 1; bidiPass < 5; bidiPass++) {
      let sliceStart = -1;
      for (let wordIdx = lineNode.start; wordIdx < lineNode.end; wordIdx++) {
        var bidiLevel = textStyle[wordRuns[wordIdx].start].bidiLevel;
        if (sliceStart == -1 && bidiLevel >= bidiPass) sliceStart = wordIdx;
        else if (sliceStart != -1 && bidiLevel < bidiPass) {
          reverseWordRunSlice(wordRuns, sliceStart, wordIdx);
          sliceStart = -1
        }
      }
      let lineEnd = lineNode.end;
      if (direction == 0 && wordRuns[lineEnd - 1].isSpace) lineEnd--;
      if (sliceStart != -1) reverseWordRunSlice(wordRuns, sliceStart, lineEnd)
    }
    const spanWordCounts = layoutScratch[0];
    const spanBounds = layoutScratch[1];
    let spanStart = wordRunIdx;
    let spanEnd = wordRunIdx;
    for (let spanIdx = 0; spanIdx < spanWordCounts.length; spanIdx++) {
      const spanWidth = spanBounds[spanIdx * 2 + 1] - spanBounds[spanIdx * 2];
      let lineOffset = 0;
      spanStart = spanEnd;
      spanEnd += spanWordCounts[spanIdx];
      const lineMetrics = this.measureLine(spanStart, spanEnd, wordRuns, direction, boxRect != null);
      if (boxRect) {
        if (justification == 1 || isLastLine && justification == 4) lineOffset = lineMetrics[1] + (spanWidth - lineMetrics[0]);
        if (justification == 2 || isLastLine && justification == 5) lineOffset = lineMetrics[1] + (spanWidth - lineMetrics[0]) / 2;
        if (lineIdx == 0) lineOffset += paraProps.FirstLineIndent;
        lineOffset += paraProps.StartIndent
      } else {
        if (justification == 0) lineOffset = paraProps.StartIndent + paraProps.FirstLineIndent;
        if (justification == 1) lineOffset = -lineMetrics[0] - paraProps.EndIndent;
        if (justification == 2) lineOffset = -lineMetrics[0] / 2
      }
      lineOffset += spanBounds[spanIdx * 2];
      if (boxRect && justification > 2 && (justification == 6 || !isLastLine)) this.justifyLine(spanStart, spanEnd, wordRuns, spanWidth, direction, lineOffset);
      else {
        let runOffsetX = lineOffset;
        for (let wordIdx = spanStart; wordIdx < spanEnd; wordIdx++) {
          wordRuns[wordIdx].offset.x = runOffsetX;
          runOffsetX += wordRuns[wordIdx].bounds.width
        }
      }
    }
    wordRunIdx = lineNode.end;
    for (let wordIdx = lineNode.start; wordIdx < lineNode.end; wordIdx++) {
      const wordBounds = wordRuns[wordIdx].bounds.clone();
      wordBounds.offsetByPoint(wordRuns[wordIdx].offset);
      lineNode.bounds = lineNode.bounds.union(wordBounds);
      maxAscender = Math.max(maxAscender, wordRuns[wordIdx].ascenderHeight);
      maxLineHeight = Math.max(maxLineHeight, wordRuns[wordIdx].lineHeight)
    }
    lineNode.offset.y = lineIdx == 0 ? 0 : lineNodes[lineIdx - 1].offset.y + maxLineHeight;
    if (lineIdx == 0) {
      if (paraRunIdx == 0 && boxRect) yCursor[0] += maxAscender;
      if (paraRunIdx != 0) yCursor[0] += maxLineHeight;
      this.offset.y = yCursor[0]
    } else yCursor[0] += maxLineHeight;
    if (boxRect) lineNode.isVisible = this.offset.y + lineNode.offset.y < boxRect.y + boxRect.height
  }
  const spaceAfter = paraProps.SpaceAfter;
  if (spaceAfter != null) yCursor[0] += spaceAfter
};
TextLayout.ParagraphLayout.prototype.measureLine = function(lineStart, lineEnd, wordRuns, direction, trimTrailing) {
  let lineWidth = 0;
  let trailingWidth = 0;
  for (let wordIdx = lineStart; wordIdx < lineEnd; wordIdx++) lineWidth += wordRuns[wordIdx].bounds.width;
  if (trimTrailing) {
    if (direction == 0)
      for (let wordIdx = lineEnd - 1; wordIdx >= lineStart; wordIdx--)
        if (wordRuns[wordIdx].isSpace || wordRuns[wordIdx].isNewline) lineWidth -= wordRuns[wordIdx].bounds.width;
        else break;
    if (direction == 1)
      for (let wordIdx = lineStart; wordIdx < lineEnd; wordIdx++)
        if (wordRuns[wordIdx].isSpace || wordRuns[wordIdx].isNewline) {
          const spaceWidth = wordRuns[wordIdx].bounds.width;
          lineWidth -= spaceWidth;
          trailingWidth -= spaceWidth
        } else break
  }
  return [lineWidth, trailingWidth]
};
TextLayout.ParagraphLayout.prototype.justifyLine = function(lineStart, lineEnd, wordRuns, targetWidth, direction, offsetX) {
  let glyphWidth = 0;
  let glyphCount = 0;
  let spaceCount = 0;
  let leadingSpaces = 0;
  for (let wordIdx = lineStart; wordIdx < lineEnd; wordIdx++)
    if (wordRuns[wordIdx].isSpace) spaceCount++;
    else {
      glyphWidth += wordRuns[wordIdx].bounds.width;
      glyphCount++
    }if (direction == 0)
      for (let wordIdx = lineEnd - 1; wordIdx >= lineStart; wordIdx--)
        if (wordRuns[wordIdx].isSpace || wordRuns[wordIdx].isNewline) {
          if (wordRuns[wordIdx].isSpace) {
            spaceCount--
          }
        } else break;
  if (direction == 1)
    for (let wordIdx = lineStart; wordIdx < lineEnd; wordIdx++)
      if (wordRuns[wordIdx].isSpace || wordRuns[wordIdx].isNewline) {
        if (wordRuns[wordIdx].isSpace) {
          spaceCount--;
          leadingSpaces++
        }
      } else break;
  if (glyphCount <= 1 || spaceCount == 0) {
    if (glyphCount == 1) wordRuns[lineStart].offset.x = offsetX;
    return
  }
  const spaceWidth = (targetWidth - glyphWidth) / spaceCount;
  let runOffset = -leadingSpaces * spaceWidth;
  for (let wordIdx = lineStart; wordIdx < lineEnd; wordIdx++) {
    if (wordRuns[wordIdx].isSpace) this.glyphs[wordRuns[wordIdx].firstGlyph].bounds.width = wordRuns[wordIdx].bounds.width = spaceWidth;
    wordRuns[wordIdx].offset.x = offsetX + runOffset;
    runOffset += wordRuns[wordIdx].bounds.width
  }
};
TextLayout.WordRun = function(engineData, fontRegistry, textStyle, textStart, glyphs, wordStart, wordLen) {
  this.text = "";
  for (let charIdx = 0; charIdx < wordLen; charIdx++) this.text += textStyle[wordStart + charIdx].char;
  this.isSpace = wordLen == 1 && (textStyle[wordStart].char == " " || textStyle[wordStart].char == "\t");
  this.isNewline = wordLen == 1 && textStyle[wordStart].char == "\n";
  this.start = wordStart;
  this.end = wordStart + wordLen;
  this.bounds = new Rect;
  this.offset = new Point(0, 0);
  this.ascenderHeight = 0;
  this.lineHeight = 0;
  let advanceX = 0;
  const trackingPad = 0;
  if (wordLen == 0) {
    this.lineHeight = textStyle[wordStart].lineHeight;
    this.ascenderHeight = textStyle[wordStart].ascenderHeight;
    this.bounds = new Rect(0, -textStyle[wordStart].lineHeight, 0, textStyle[wordStart].lineHeight)
  }
  let firstGlyphIdx = textStyle[wordStart].glyphIdx;
  let lastGlyphIdx = textStyle[wordStart + wordLen - 1].glyphIdx;
  // Shaping never reached these characters, so there is nothing to place.
  if (firstGlyphIdx == -1) return;
  if (lastGlyphIdx < firstGlyphIdx) {
    let swapIdx = firstGlyphIdx;
    firstGlyphIdx = lastGlyphIdx;
    lastGlyphIdx = swapIdx
  }
  while (lastGlyphIdx + 1 < glyphs.length && glyphs[lastGlyphIdx].charIdx == glyphs[lastGlyphIdx + 1].charIdx) {
    lastGlyphIdx++
  }
  this.firstGlyph = firstGlyphIdx;
  this.lastGlyph = lastGlyphIdx;
  for (let glyphIdx = firstGlyphIdx; glyphIdx <= lastGlyphIdx; glyphIdx++) {
    const glyph = glyphs[glyphIdx];
    let charStyle = textStyle[textStart + glyph.charIdx];
    const fontScale = 1 / charStyle.font.head.unitsPerEm * charStyle.styleSheet.FontSize;
    let extraAdvance = 0;
    if (!charStyle.styleSheet.AutoKerning) advanceX += charStyle.styleSheet.Kerning * 2 * fontScale * charStyle.scale.x;
    let glyphWidth = glyph.advanceWidth * fontScale * charStyle.scale.x;
    glyph.offset = new Point(advanceX, 0);
    glyph.pathTangent = 0;
    glyph.bounds = new Rect(0, -charStyle.lineHeight, glyphWidth, charStyle.lineHeight);
    const glyphPath = Typr.U.glyphToPath(charStyle.font, glyph.glyphId);
    glyph.path = canonicalPath(glyphPath);
    const glyphBounds = glyph.bounds.clone();
    glyphBounds.offsetByPoint(glyph.offset);
    if (charStyle.styleSheet.Tracking != null) extraAdvance = charStyle.styleSheet.Tracking * .001 * charStyle.styleSheet.FontSize;
    if (charStyle.styleSheet.FauxBold == true) extraAdvance += .027 * charStyle.styleSheet.FontSize;
    advanceX += glyphWidth + extraAdvance;
    if (wordLen == 1 && (charStyle.char == " " || charStyle.char == "\t")) glyphBounds.width += 2 * extraAdvance;
    else if (wordLen == 1 && charStyle.char != null && TextLayout.isCJK(charStyle.char.charCodeAt(0))) glyphBounds.width += extraAdvance;
    this.bounds = this.bounds.union(glyphBounds);
    this.ascenderHeight = Math.max(this.ascenderHeight, charStyle.ascenderHeight);
    this.lineHeight = Math.max(this.lineHeight, charStyle.lineHeight)
  }
};
TextLayout.wasmState = 0;
TextLayout.ensureWasm = function() {
  if (TextLayout.wasmState == 2) return true;
  if (TextLayout.wasmState == 1) return false;
  TextLayout.wasmState = 1;

  const fribidiWasmSha384 = "vWJ/UI3tLknAmUHAkx14LJI+Ldh15Dnc6+3aIS+cC38hzwMwJrkplbgQPQtg1ZAu";
  function loadFribidiWasm() {
    fetch("vendor/wasm/fribidi/fribidi.wasm").then(function(wasmResponse) {
      return wasmResponse.arrayBuffer()
    }).then(function(wasmBytes) {
      return crypto.subtle.digest("SHA-384", wasmBytes).then(function(wasmDigest) {
        const digestBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(wasmDigest)));
        if (digestBase64 !== fribidiWasmSha384) throw new Error("fribidi.wasm failed integrity verification");
        return WebAssembly.instantiate(wasmBytes)
      })
    }).then(function(wasmModule) {
      const wasmExports = wasmModule.instance.exports;
      const wasmMemory = wasmExports.memory;
      const embedFlag = 16;
      let rtlFlag = 256;
      const ltrFlag = 1;
      const rtlEmbed = embedFlag | rtlFlag;
      const ltrEmbed = embedFlag | rtlFlag | ltrFlag;
      TextLayout.resolveBidiLevels = function(codePoints, paragraphDirection) {
        const codePointCount = codePoints.length;
        const allocSize = codePointCount * 4 + 4 + codePointCount * 4 + codePointCount * 4 + codePointCount;
        FileFormatRegistry.growWasmMemory(wasmExports, allocSize + codePointCount + 1e7);
        const wasmBytes = new Uint8Array(wasmMemory.buffer);
        const wasmWords = new Uint32Array(wasmMemory.buffer);
        const basePtr = wasmExports.calloc(allocSize, 1);
        const embedPtr = basePtr + codePointCount * 4;
        const typesPtr = embedPtr + 4;
        const bracketsPtr = typesPtr + codePointCount * 4;
        const levelsPtr = bracketsPtr + codePointCount * 4;
        wasmWords.set(codePoints, basePtr >>> 2);
        wasmWords[embedPtr >>> 2] = paragraphDirection == 0 ? rtlEmbed : ltrEmbed;
        wasmExports.fribidi_get_bidi_types(basePtr, codePointCount, typesPtr);
        wasmExports.fribidi_get_bracket_types(basePtr, codePointCount, typesPtr, bracketsPtr);
        wasmExports.fribidi_get_par_embedding_levels_ex(typesPtr, bracketsPtr, codePointCount, embedPtr, levelsPtr);
        const levelBytes = wasmBytes.slice(levelsPtr, levelsPtr + codePointCount);
        wasmExports.free(basePtr);
        return levelBytes
      };
      TextLayout.wasmState = 2;
      const readyEvent = new AppEvent(EventType.uiDispatch, true);
      readyEvent.data = {
        dispatchKind: UiCommand.openResourcePresetPopup,
        scriptHostData: "add",
        popupType: PopupTypes.OPEN_RECENT,
        presetPayload: null
      };
      FontRegistry.instance.dispatch(readyEvent)
    })
  }
  Typr.U.initHB("vendor/wasm/harfbuzz/hb.wasm", loadFribidiWasm);
  return false
};

TextLayout.computePathData = computeTextPathData;
TextLayout.findPathIndex = findPathIndex;
TextLayout.getPathPosition = getPathPosition;

export { TextLayout };
