// Photoshop text layer EngineData / txt2 builders. Wire expand/collapse maps
// live in engine-data-codec.js; this module owns document-resource assembly,
// style/paragraph sheet bridging, and the default sheet tables.
import { TextEngineData } from "./text-engine.js";

function TextLayerData() {}

function collectUniqueFonts(textEngineDataList) {
  const uniqueFonts = [];
  const seenFontNames = [];
  for (let engineIdx = 0; engineIdx < textEngineDataList.length; engineIdx++) {
    const fontSet = textEngineDataList[engineIdx].ResourceDict.FontSet;
    for (let fontIdx = 0; fontIdx < fontSet.length; fontIdx++) {
      const fontEntry = fontSet[fontIdx];
      if (seenFontNames.indexOf(fontEntry.Name) !== -1) continue;
      uniqueFonts.push(fontEntry);
      seenFontNames.push(fontEntry.Name);
    }
  }
  return uniqueFonts;
}

function fontEntryToWire(font) {
  const fontWireEntry = {
    _0: {
      _99: "/CoolTypeFont",
      _0: {
        _0: "s" + font.Name,
        _1: "i" + font.Script,
        _2: "i" + font.FontType,
      },
    },
  };
  if (font.Script === 0) delete fontWireEntry._0._0._1;
  return fontWireEntry;
}

function findFontIndexByName(fontSetEntries, fontName) {
  for (let entryIdx = 0; entryIdx < fontSetEntries.length; entryIdx++) {
    if ("s" + fontName === fontSetEntries[entryIdx]._0._0._0) return entryIdx;
  }
  return -1;
}

/**
 * Build EngineData objects from a collapsed txt2 document-resources block.
 * @param {object} textResources Collapsed wire with `_0` resources and `_1` frames.
 * @returns {object[]} EngineData list.
 */
TextLayerData.buildEngineDataFromResources = function (textResources) {
  const engineDataList = TextLayerData.buildEngineDataListFromDocumentResources(textResources._0, textResources._1);
  TextLayerData.syncFontSetIntoEngineData(engineDataList, textResources._0);
  return engineDataList
};
TextLayerData.buildTxt2DocumentBlock = function(textEngineDataList, existingTxt2) {
  const txt2Block = {};
  txt2Block._98 = {
    _0: "i7"
  };
  txt2Block._0 = TextLayerData.buildDocumentResources(textEngineDataList, existingTxt2 ? existingTxt2._0 : null);
  txt2Block._1 = TextLayerData.buildTxt2EngineDocument(textEngineDataList, txt2Block._0, existingTxt2 ? existingTxt2._1 : null);
  return txt2Block
};
TextLayerData.buildDocumentResources = function(textEngineDataList, existingResources) {
  const documentResources = {};
  documentResources._1 = TextLayerData.buildFontSetDescriptor(textEngineDataList, existingResources ? existingResources._1 : null);
  documentResources._2 = {
    _0: [{
      _0: {
        _0: "s"
      }
    }],
    _1: [{
      _0: "i0"
    }]
  };
  documentResources._3 = JSON.parse(JSON.stringify(TextLayerData.mojiKumiTableSetDefaults));
  documentResources._4 = JSON.parse(JSON.stringify(TextLayerData.kinsokuSetDefaults));
  documentResources._5 = TextLayerData.buildStyleSheetRunList(textEngineDataList, documentResources._1._0, existingResources ? existingResources._5 : null);
  documentResources._6 = TextLayerData.buildParagraphSheetRunList(textEngineDataList, existingResources ? existingResources._6 : null);
  documentResources._8 = TextLayerData.buildTextPathFrameList(textEngineDataList, existingResources ? existingResources._8 : null);
  documentResources._9 = TextLayerData.defaultDocumentResources;
  return documentResources
};
TextLayerData.syncFontSetIntoEngineData = function(engineDataList, documentResources) {
  TextLayerData.applyStyleSheetToEngineData(engineDataList, documentResources._5, documentResources._1._0)
};
TextLayerData.buildFontSetDescriptor = function (textEngineDataList, existingFontSet) {
  const uniqueFonts = collectUniqueFonts(textEngineDataList);
  const fontSetDescriptor = { _0: [] };
  for (let fontIdx = 0; fontIdx < uniqueFonts.length; fontIdx++) {
    fontSetDescriptor._0.push(fontEntryToWire(uniqueFonts[fontIdx]));
  }
  return fontSetDescriptor;
};
TextLayerData.buildStyleSheetRunList = function(textEngineDataList, fontSetEntries, existingStyleSheetRuns) {
  const styleSheetRuns = {
      _0: [],
      _1: []
    };

  const defaultStyleEntry = {
    _0: JSON.parse(JSON.stringify(TextLayerData.defaultStyleSheetWire))
  };

  TextLayerData.applyStyleSheetToWire(defaultStyleEntry._0, textEngineDataList[0].ResourceDict.StyleSheetSet[0], fontSetEntries, textEngineDataList[0].ResourceDict.FontSet);
  styleSheetRuns._0.push(defaultStyleEntry);
  styleSheetRuns._1.push({
    _0: "i0"
  });
  styleSheetRuns._0.push({
    _0: {
      _0: "sNone",
      _5: "i0",
      _6: {}
    }
  });
  styleSheetRuns._1.push({
    _0: "i1"
  });
  return styleSheetRuns
};
TextLayerData.applyStyleSheetToEngineData = function(engineDataList, styleSheetRuns, fontSetEntries) {
  const defaultStyleWire = styleSheetRuns._0[0];
  for (let engineIdx = 0; engineIdx < engineDataList.length; engineIdx++) TextLayerData.applyWireToStyleSheet(defaultStyleWire._0, engineDataList[engineIdx].ResourceDict.StyleSheetSet[0], fontSetEntries, engineDataList[engineIdx].ResourceDict.FontSet)
};
TextLayerData.buildParagraphSheetRunList = function(textEngineDataList, existingParagraphRuns) {
  const paragraphSheetRuns = {
      _0: [],
      _1: []
    };

  let paragraphEntry = {
    _0: JSON.parse(JSON.stringify(TextLayerData.defaultParagraphSheetWire))
  };

  TextLayerData.applyParagraphSheetToWire(paragraphEntry._0, textEngineDataList[0].ResourceDict.ParagraphSheetSet[0]);
  paragraphSheetRuns._0.push(paragraphEntry);
  paragraphSheetRuns._1.push({
    _0: "i0"
  });
  paragraphEntry = {
    _0: JSON.parse(JSON.stringify(TextLayerData.defaultParagraphSheetWire))
  };
  TextLayerData.applyParagraphSheetToWire(paragraphEntry._0, textEngineDataList[0].ResourceDict.ParagraphSheetSet[0]);
  paragraphEntry._0._0 = "sBasic Paragraph";
  paragraphEntry._0._6 = "i0";
  paragraphSheetRuns._0.push(paragraphEntry);
  paragraphSheetRuns._1.push({
    _0: "i1"
  });
  return paragraphSheetRuns
};
TextLayerData.buildTextPathFrameList = function(textEngineDataList, existingPathFrames) {
  const pathFrameList = {
    _0: []
  };
  for (let engineIdx = 0; engineIdx < textEngineDataList.length; engineIdx++) {
    const curve = textEngineDataList[engineIdx].Curve;
    const pathFrame = {};
    pathFrameList._0.push({
      _0: pathFrame
    });
    const textType = TextEngineData.getTextType(textEngineDataList[engineIdx]);
    pathFrame._2 = {};
    pathFrame._2._0 = "i" + textType;
    if (textType == 0) {
      pathFrame._2._6 = ["f-1", "f-1"];
      pathFrame._2._11 = {
        _4: "i-1",
        _7: false
      }
    } else if (textType == 1 && curve == null) {
      var boxBounds = TextEngineData.getBoxBounds(textEngineDataList[engineIdx]);
      var boxWidth = boxBounds[2];
      var boxHeight = boxBounds[3];
      pathFrame._1 = {
        _0: TextLayerData.prefixTypedValues("f", [0, 0, 0, 0, boxWidth, 0, boxWidth, 0, boxWidth, 0, boxWidth, 0, boxWidth, boxHeight, boxWidth, boxHeight, boxWidth, boxHeight, boxWidth, boxHeight, 0, boxHeight, 0, boxHeight, 0, boxHeight, 0, boxHeight, 0, 0, 0, 0])
      };
      pathFrame._2._6 = ["f-2", "f-2"];
      pathFrame._2._11 = {
        _4: "i-2",
        _7: false
      }
    } else if (textType == 1) {
      var boxBounds = TextEngineData.getBoxBounds(textEngineDataList[engineIdx]);
      var boxWidth = boxBounds[2];
      var boxHeight = boxBounds[3];
      pathFrame._1 = {
        _0: TextLayerData.prefixTypedValues("f", curve.Points)
      };
      pathFrame._2._6 = ["f-3", "f-3"];
      pathFrame._2._11 = {
        _4: "i-3",
        _7: false
      }
    } else if (textType == 2) {
      pathFrame._1 = {
        _0: TextLayerData.prefixTypedValues("f", curve.Points)
      };
      pathFrame._2._6 = TextLayerData.prefixTypedValues("f", curve.TextOnPathTRange);
      pathFrame._2._11 = {
        _0: curve.Reversed,
        _3: "i0",
        _5: "f0",
        _7: false
      }
    }
  }
  return pathFrameList
};
TextLayerData.buildTxt2EngineDocument = function(textEngineDataList, documentResources, existingEngineDoc) {
  const engineDocument = {};
  engineDocument._0 = JSON.parse(JSON.stringify(TextLayerData.defaultEngineDocument));
  engineDocument._1 = TextLayerData.buildTextFrameList(textEngineDataList, documentResources, existingEngineDoc ? existingEngineDoc._1 : null);
  engineDocument._2 = JSON.parse(JSON.stringify(TextLayerData.defaultStyleSheetWire._6));
  engineDocument._3 = JSON.parse(JSON.stringify(TextLayerData.defaultParagraphSheetWire._5));
  return engineDocument
};
TextLayerData.buildEngineDataListFromDocumentResources = function(documentResources, txt2SiblingBlock) {
  return TextLayerData.parseEngineDataListFromWire(documentResources, txt2SiblingBlock._1);
};
TextLayerData.buildTextFrameList = function(textEngineDataList, documentResources, existingTextFrames) {
  const textFrames = [];
  const fontSetEntries = documentResources._1._0;
  for (let engineIdx = 0; engineIdx < textEngineDataList.length; engineIdx++) {
    const engineData = textEngineDataList[engineIdx];

    const textFrame = {
      _0: {}
    };

    textFrames.push(textFrame);
    const existingFrame = existingTextFrames ? existingTextFrames[engineIdx] : null;
    textFrame._0._0 = "s" + engineData.EngineDict.Editor.Text;
    textFrame._0._0 = textFrame._0._0;

    const paragraphRunsWire = {
      _0: []
    };

    textFrame._0._5 = paragraphRunsWire;
    let paragraphRun = engineData.EngineDict.ParagraphRun;
    for (let runIdx = 0; runIdx < paragraphRun.RunArray.length; runIdx++) {
      const paragraphRunWire = {
        _0: {}
      };
      paragraphRunsWire._0.push(paragraphRunWire);
      paragraphRunWire._0._0 = {
        _0: "s",
        _5: {},
        _6: "i1"
      };
      TextLayerData.applyParagraphSheetToWire(paragraphRunWire._0._0, paragraphRun.RunArray[runIdx].ParagraphSheet);
      paragraphRunWire._1 = "i" + paragraphRun.RunLengthArray[runIdx]
    }

    const styleRunsWire = {
      _0: []
    };

    textFrame._0._6 = styleRunsWire;
    const existingStyleRuns = existingFrame ? existingFrame._0._6 : null;
    paragraphRun = engineData.EngineDict.StyleRun;
    for (let runIdx = 0; runIdx < paragraphRun.RunArray.length; runIdx++) {
      const styleRunWire = {
        _0: {}
      };
      styleRunsWire._0.push(styleRunWire);
      const existingStyleRunWire = existingStyleRuns ? existingStyleRuns._0 : null;
      styleRunWire._0._0 = {
        _0: "s",
        _5: "i1",
        _6: {}
      };
      TextLayerData.applyStyleSheetToWire(styleRunWire._0._0, paragraphRun.RunArray[runIdx].StyleSheet, fontSetEntries, engineData.ResourceDict.FontSet, existingStyleRunWire ? styleRunWire._0._0 : null);
      styleRunWire._1 = "i" + paragraphRun.RunLengthArray[runIdx]
    }
    const alternateGlyphRun = engineData.EngineDict.AlternateGlyphRun;
    if (alternateGlyphRun) {
      const alternateRunsWire = textFrame._0._9 = { _0: [] };
      for (let runIdx = 0; runIdx < alternateGlyphRun.RunArray.length; runIdx++) {
        const alternateRunWire = { _0: {} };
        alternateRunsWire._0.push(alternateRunWire);
        const glyphId = alternateGlyphRun.RunArray[runIdx].Glyph;
        if (glyphId != null) alternateRunWire._0._0 = { _0: "i" + glyphId, _1: "e" };
        alternateRunWire._1 = "i" + alternateGlyphRun.RunLengthArray[runIdx]
      }
    }
    textFrame._0._10 = {
      _0: "i4",
      _2: true
    };
    textFrame._1 = TextLayerData.view.buildTextFrameFromEngineData(engineData, null, engineIdx, null)
  }
  return textFrames
};
TextLayerData.parseEngineDataListFromWire = function(documentResources, wireFrameList) {
  const engineDataList = [];
  const fontSetEntries = documentResources._1._0;
  for (let frameIdx = 0; frameIdx < wireFrameList.length; frameIdx++) {
    const engineData = TextEngineData.cloneEngineData();
    engineDataList.push(engineData);
    const wireFrame = wireFrameList[frameIdx];
    engineData.EngineDict.Editor.Text = wireFrame._0._0.slice(1);
    const paragraphRunTemplate = engineData.EngineDict.ParagraphRun.RunArray[0];
    let paragraphRun = engineData.EngineDict.ParagraphRun;
    const paragraphRunsWire = wireFrame._0._5;
    for (let runIdx = 0; runIdx < paragraphRunsWire._0.length; runIdx++) {
      const paragraphRunWire = paragraphRunsWire._0[runIdx];
      paragraphRun.RunLengthArray[runIdx] = parseInt(paragraphRunWire._1.slice(1));
      paragraphRun.RunArray[runIdx] = JSON.parse(JSON.stringify(paragraphRunTemplate));
      TextLayerData.applyWireToParagraphSheet(paragraphRunWire._0._0, paragraphRun.RunArray[runIdx].ParagraphSheet)
    }
    const styleRunsWire = wireFrame._0._6;
    paragraphRun = engineData.EngineDict.StyleRun;
    if (styleRunsWire)
      for (let runIdx = 0; runIdx < styleRunsWire._0.length; runIdx++) {
        const styleRunWire = styleRunsWire._0[runIdx];
        paragraphRun.RunLengthArray[runIdx] = parseInt(styleRunWire._1.slice(1));
        paragraphRun.RunArray[runIdx] = {
          StyleSheet: {
            StyleSheetData: {}
          }
        };
        TextLayerData.applyWireToStyleSheet(styleRunWire._0._0, paragraphRun.RunArray[runIdx].StyleSheet, fontSetEntries, engineData.ResourceDict.FontSet)
      } else {
        paragraphRun.RunLengthArray[0] = TextEngineData.getLayerText(engineData).length;
        paragraphRun.RunArray[0] = {
          StyleSheet: {
            StyleSheetData: {}
          }
        }
      }
  }
  return engineDataList
};
TextLayerData.applyStyleSheetToWire = function(wireStyleNode, styleSheet, fontSetEntries, fontSet, existingWireStyle) {
  wireStyleNode._0 = "s" + (styleSheet.Name ? styleSheet.Name : "");
  const wireStyleData = wireStyleNode._6;
  const existingStyleData = existingWireStyle ? existingWireStyle._6 : null;
  const styleData = styleSheet.StyleSheetData;
  if (styleData.Font == null) return;
  const fontName = fontSet[styleData.Font].Name;
  const fontIndex = findFontIndexByName(fontSetEntries, fontName);
  wireStyleData._0 = "i" + fontIndex;
  if (styleData.FontSize != null) wireStyleData._1 = "f" + styleData.FontSize;
  if (styleData.FauxBold != null) wireStyleData._2 = styleData.FauxBold;
  if (styleData.FauxItalic != null) wireStyleData._3 = styleData.FauxItalic;
  if (styleData.AutoLeading != null) wireStyleData._4 = styleData.AutoLeading;
  if (styleData.Leading != null) wireStyleData._5 = "f" + styleData.Leading;
  if (styleData.HorizontalScale != null) wireStyleData._6 = "f" + styleData.HorizontalScale;
  if (styleData.VerticalScale != null) wireStyleData._7 = "f" + styleData.VerticalScale;
  if (styleData.Tracking != null) wireStyleData._8 = "i" + styleData.Tracking;
  if (styleData.BaselineShift != null) wireStyleData._9 = "f" + styleData.BaselineShift;
  if (styleData.AutoKerning != null) wireStyleData._11 = "i" + (styleData.AutoKerning ? 1 : 0);
  if (styleData.FontCaps != null) wireStyleData._12 = "i" + styleData.FontCaps;
  if (styleData.FontBaseline != null) wireStyleData._13 = "i" + styleData.FontBaseline;
  if (styleData.Strikethrough != null) wireStyleData._15 = "i" + (styleData.Strikethrough ? 1 : 0);
  if (styleData.Underline != null) wireStyleData._16 = "i" + (styleData.Underline ? 2 : 0);
  if (styleData.Ligatures != null) wireStyleData._18 = styleData.Ligatures;
  if (styleData.DLigatures != null) wireStyleData._19 = styleData.DLigatures;
  if (styleData.Language != null) wireStyleData._38 = "i" + styleData.Language;
  if (styleData.FillColor != null) wireStyleData._53 = {
    _99: "/SimplePaint",
    _0: {
      _0: "i1",
      _1: TextLayerData.prefixTypedValues("f", styleData.FillColor.Values)
    }
  }
};
TextLayerData.applyWireToStyleSheet = function(wireStyleNode, styleSheet, fontSetEntries, fontSet) {
  const wireStyleData = wireStyleNode._6;
  if (wireStyleData == null) return;
  const styleData = styleSheet.StyleSheetData;
  if (wireStyleData._0) {
    const fontIndex = parseInt(wireStyleData._0.slice(1));
    const fontName = fontSetEntries[fontIndex]._0._0._0.slice(1);
    TextEngineData.setTextFont({
      textStyle: styleData,
      fontSet: fontSet
    }, fontName)
  }
  if (wireStyleData._1 != null) styleData.FontSize = parseFloat(wireStyleData._1.slice(1));
  if (wireStyleData._2 != null) styleData.FauxBold = wireStyleData._2;
  if (wireStyleData._3 != null) styleData.FauxItalic = wireStyleData._3;
  if (wireStyleData._4 != null) styleData.AutoLeading = wireStyleData._4;
  if (wireStyleData._5 != null) styleData.Leading = parseFloat(wireStyleData._5.slice(1));
  if (wireStyleData._6 != null) styleData.HorizontalScale = parseFloat(wireStyleData._6.slice(1));
  if (wireStyleData._7 != null) styleData.VerticalScale = parseFloat(wireStyleData._7.slice(1));
  if (wireStyleData._8 != null) styleData.Tracking = parseFloat(wireStyleData._8.slice(1));
  if (wireStyleData._9 != null) styleData.BaselineShift = parseFloat(wireStyleData._9.slice(1));
  if (wireStyleData._11 != null) styleData.AutoKerning = parseFloat(wireStyleData._11.slice(1)) == 1;
  if (wireStyleData._12 != null) styleData.FontCaps = parseFloat(wireStyleData._12.slice(1));
  if (wireStyleData._13 != null) styleData.FontBaseline = parseFloat(wireStyleData._13.slice(1));
  if (wireStyleData._15 != null) styleData.Strikethrough = parseFloat(wireStyleData._15.slice(1)) == 1;
  if (wireStyleData._16 != null) styleData.Underline = parseFloat(wireStyleData._16.slice(1)) == 1;
  if (wireStyleData._18 != null) styleData.Ligatures = wireStyleData._18;
  if (wireStyleData._19 != null) styleData.DLigatures = wireStyleData._19;
  if (wireStyleData._38 != null) styleData.Language = parseFloat(wireStyleData._38.slice(1));
  const fillColorWire = wireStyleData._53;
  if (fillColorWire) {
    const colorType = fillColorWire._0._0;
    const colorValuesWire = fillColorWire._0._1;
    let colorValues = [1, 0, 0, 0];
    const parsedValues = [];
    for (let valueIdx = 0; valueIdx < colorValuesWire.length; valueIdx++) parsedValues[valueIdx] = parseFloat(colorValuesWire[valueIdx].slice(1));
    if (colorType == "i0") colorValues[1] = colorValues[2] = colorValues[3] = parsedValues[1];
    else if (colorType == "i1") colorValues = parsedValues;
    else if (colorType == "i2") colorValues = [1].concat(globalThis.UDOC.C.cmykToRgb(parsedValues.slice(1)));
    else console.log("unknown color type", colorType, parsedValues);
    styleData.FillColor = {
      Type: 1,
      Values: colorValues
    }
  }
};
TextLayerData.applyParagraphSheetToWire = function(wireParagraphNode, paragraphSheet) {
  wireParagraphNode._0 = "s" + (paragraphSheet.Name ? paragraphSheet.Name : "");
  const wireProperties = wireParagraphNode._5;
  const paragraphProperties = paragraphSheet.Properties;
  if (paragraphProperties.Justification != null) wireProperties._0 = "i" + paragraphProperties.Justification;
  if (paragraphProperties.FirstLineIndent != null) wireProperties._1 = "f" + paragraphProperties.FirstLineIndent;
  if (paragraphProperties.StartIndent != null) wireProperties._2 = "f" + paragraphProperties.StartIndent;
  if (paragraphProperties.EndtIndent != null) wireProperties._3 = "f" + paragraphProperties.EndtIndent;
  if (paragraphProperties.SpaceBefore != null) wireProperties._4 = "f" + paragraphProperties.SpaceBefore;
  if (paragraphProperties.SpaceAfter != null) wireProperties._5 = "f" + paragraphProperties.SpaceAfter;
  if (paragraphProperties.AutoHyphenate != null) wireProperties._9 = paragraphProperties.AutoHyphenate;
  if (paragraphProperties._Direction != null) wireProperties._33 = "i" + paragraphProperties._Direction
};
TextLayerData.applyWireToParagraphSheet = function(wireParagraphNode, paragraphSheet) {
  const wireProperties = wireParagraphNode._5;
  if (wireProperties == null) return;
  const paragraphProperties = paragraphSheet.Properties;
  if (wireProperties._0) paragraphProperties.Justification = parseInt(wireProperties._0.slice(1))
};
TextLayerData.prefixTypedValues = function(typePrefix, values) {
  const typedValues = [];
  for (let valueIdx = 0; valueIdx < values.length; valueIdx++) typedValues.push(typePrefix + values[valueIdx]);
  return typedValues
};
TextLayerData.mojiKumiTableSetDefaults = {
  _0: [{
    _0: {
      _0: "sPhotoshop6MojiKumiSet4",
      _5: {
        _0: "i0",
        _3: "i2"
      }
    }
  }, {
    _0: {
      _0: "sPhotoshop6MojiKumiSet3",
      _5: {
        _0: "i0",
        _3: "i4"
      }
    }
  }, {
    _0: {
      _0: "sPhotoshop6MojiKumiSet2",
      _5: {
        _0: "i0",
        _3: "i3"
      }
    }
  }, {
    _0: {
      _0: "sPhotoshop6MojiKumiSet1",
      _5: {
        _0: "i0",
        _3: "i1"
      }
    }
  }, {
    _0: {
      _0: "sYakumonoHankaku",
      _5: {
        _0: "i0",
        _3: "i1"
      }
    }
  }, {
    _0: {
      _0: "sGyomatsuYakumonoHankaku",
      _5: {
        _0: "i0",
        _3: "i3"
      }
    }
  }, {
    _0: {
      _0: "sGyomatsuYakumonoZenkaku",
      _5: {
        _0: "i0",
        _3: "i4"
      }
    }
  }, {
    _0: {
      _0: "sYakumonoZenkaku",
      _5: {
        _0: "i0",
        _3: "i2"
      }
    }
  }],
  _1: [{
    _0: "i0"
  }, {
    _0: "i1"
  }, {
    _0: "i2"
  }, {
    _0: "i3"
  }, {
    _0: "i4"
  }, {
    _0: "i5"
  }, {
    _0: "i6"
  }, {
    _0: "i7"
  }]
};
TextLayerData.kinsokuSetDefaults = {
  _0: [{
    _0: {
      _0: "sNone",
      _5: {
        _0: "s",
        _1: "s",
        _2: "s",
        _3: "s",
        _4: "i0"
      }
    }
  }, {
    _0: {
      _0: "sPhotoshopKinsokuHard",
      _5: {
        _0: "s!),.:;?]}\xA2\u2014\u2019\u201D\u2030\u2103\u2109\u3001\u3002\u3005\u3009\u300B\u300A\u300F\u3011\u3015\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u309B\u309C\u309D\u309E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6\u30FB\u30FC\u30FD\u30FE\uFF01\uFF05\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D",
        _1: "s([{\xA3\xA7\u2018\u201C\u3008\u300A\u300C\u300E\u3010\u3012\u3014\uFF03\uFF04\uFF08\uFF20\uFF3B\uFF5B\uFFE5",
        _2: "s\u2014\u2025\u2026",
        _3: "s\u3001\u3002\uFF0C\uFF0E",
        _4: "i1"
      }
    }
  }, {
    _0: {
      _0: "sPhotoshopKinsokuSoft",
      _5: {
        _0: "s\u2019\u201D\u3001\u3002\u3005\u3009\u300B\u300A\u300F\u3011\u3015\u309D\u309E\u30FB\u30FD\u30FE\uFF01\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D",
        _1: "s\u2018\u201C\u3008\u300A\u300C\u300E\u3010\u3014\uFF08\uFF3B\uFF5B",
        _2: "s\u2014\u2025\u2026",
        _3: "s\u3001\u3002\uFF0C\uFF0E",
        _4: "i2"
      }
    }
  }, {
    _0: {
      _0: "sHard",
      _5: {
        _0: "s!),.:;?]}\xA2\u2014\u2019\u201D\u2030\u2103\u2109\u3001\u3002\u3005\u3009\u300B\u300A\u300F\u3011\u3015\u3041\u3043\u3045\u3047\u3049\u3063\u3083\u3085\u3087\u308E\u309B\u309C\u309D\u309E\u30A1\u30A3\u30A5\u30A7\u30A9\u30C3\u30E3\u30E5\u30E7\u30EE\u30F5\u30F6\u30FB\u30FC\u30FD\u30FE\uFF01\uFF05\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D",
        _1: "s([{\xA3\xA7\u2018\u201C\u3008\u300A\u300C\u300E\u3010\u3012\u3014\uFF03\uFF04\uFF08\uFF20\uFF3B\uFF5B\uFFE5",
        _2: "s\u2014\u2025\u2026",
        _3: "s\u3001\u3002\uFF0C\uFF0E",
        _4: "i1"
      }
    }
  }, {
    _0: {
      _0: "sSoft",
      _5: {
        _0: "s\u2019\u201D\u3001\u3002\u3005\u3009\u300B\u300A\u300F\u3011\u3015\u309D\u309E\u30FB\u30FD\u30FE\uFF01\uFF09\uFF0C\uFF0E\uFF1A\uFF1B\uFF1F\uFF3D\uFF5D",
        _1: "s\u2018\u201C\u3008\u300A\u300C\u300E\u3010\u3014\uFF08\uFF3B\uFF5B",
        _2: "s\u2014\u2025\u2026",
        _3: "s\u3001\u3002\uFF0C\uFF0E",
        _4: "i2"
      }
    }
  }],
  _1: [{
    _0: "i0"
  }, {
    _0: "i1"
  }, {
    _0: "i2"
  }, {
    _0: "i3"
  }, {
    _0: "i4"
  }]
};
TextLayerData.defaultStyleSheetWire = {
  _0: "sNormal RGB",
  _6: {
    _0: "i0",
    _1: "f12",
    _2: false,
    _3: false,
    _4: true,
    _5: "f0",
    _6: "f1",
    _7: "f1",
    _8: "i0",
    _9: "f0",
    _10: "f0",
    _11: "i1",
    _12: "i0",
    _13: "i0",
    _14: "i0",
    _15: "i0",
    _16: "i0",
    _17: "f0",
    _18: true,
    _19: false,
    _20: false,
    _21: false,
    _22: false,
    _23: false,
    _24: false,
    _25: false,
    _26: false,
    _27: false,
    _28: false,
    _29: false,
    _30: "i0",
    _31: false,
    _32: false,
    _33: false,
    _34: false,
    _35: "i2",
    _36: "f0",
    _37: "i2",
    _38: "i0",
    _39: "i0",
    _40: false,
    _41: "i2",
    _42: "i0",
    _43: {
      _0: "f.5"
    },
    _44: "i2",
    _45: "i2",
    _46: "i7",
    _47: "i0",
    _48: "i0",
    _49: "f-1",
    _50: "f-1",
    _51: "i0",
    _52: false,
    _53: {
      _99: "/SimplePaint",
      _0: {
        _0: "i1",
        _1: ["f1", "f0", "f0", "f0"]
      }
    },
    _54: {
      _99: "/SimplePaint",
      _0: {
        _0: "i1",
        _1: ["f1", "f0", "f0", "f0"]
      }
    },
    _55: {
      _99: "/SimpleBlender"
    },
    _56: true,
    _57: false,
    _58: true,
    _59: false,
    _60: false,
    _61: "i0",
    _62: "i0",
    _63: "f1",
    _64: "f4",
    _65: "f0",
    _66: [],
    _67: [],
    _68: "i0",
    _69: "i0",
    _70: "i0",
    _71: "i4",
    _72: "f0",
    _73: "f0",
    _74: false,
    _75: false,
    _76: false,
    _77: true,
    _78: true,
    _79: {
      _99: "/SimplePaint",
      _0: {
        _0: "i1",
        _1: ["f1", "f1", "f1", "f0"]
      }
    },
    _80: false,
    _81: "i0",
    _82: "f3",
    _83: "f3",
    _84: false,
    _85: "i0",
    _86: {
      _99: "/SimpleCustomFeature"
    },
    _87: "f100",
    _88: true
  }
};
TextLayerData.defaultParagraphSheetWire = {
  _0: "sNormal RGB",
  _5: {
    _0: "i0",
    _1: "f0",
    _2: "f0",
    _3: "f0",
    _4: "f0",
    _5: "f0",
    _6: "i1",
    _7: "f1.2",
    _8: "i0",
    _9: true,
    _10: "i6",
    _11: "i2",
    _12: "i2",
    _13: "i0",
    _14: "f36",
    _15: true,
    _16: "f.5",
    _17: ["f.8", "f1", "f1.33"],
    _18: ["f0", "f0", "f0"],
    _19: ["f1", "f1", "f1"],
    _20: "i6",
    _21: false,
    _22: "i0",
    _23: true,
    _24: "i0",
    _25: "i0",
    _27: "/nil",
    _26: false,
    _28: "/nil",
    _29: false,
    _30: {},
    _31: "f36",
    _32: {},
    _33: "i0",
    _34: "i7",
    _35: "i1",
    _36: "/nil",
    _37: "i0",
    _38: false,
    _39: "i0",
    _40: "i2"
  }
};
TextLayerData.defaultDocumentResources = {
  _0: [{
    _0: {
      _0: "skPredefinedNumericListStyleTag",
      _6: "i1"
    }
  }, {
    _0: {
      _0: "skPredefinedUppercaseAlphaListStyleTag",
      _6: "i2"
    }
  }, {
    _0: {
      _0: "skPredefinedLowercaseAlphaListStyleTag",
      _6: "i3"
    }
  }, {
    _0: {
      _0: "skPredefinedUppercaseRomanNumListStyleTag",
      _6: "i4"
    }
  }, {
    _0: {
      _0: "skPredefinedLowercaseRomanNumListStyleTag",
      _6: "i5"
    }
  }, {
    _0: {
      _0: "skPredefinedBulletListStyleTag",
      _6: "i6"
    }
  }],
  _1: [{
    _0: "i0"
  }, {
    _0: "i1"
  }, {
    _0: "i2"
  }, {
    _0: "i3"
  }, {
    _0: "i4"
  }, {
    _0: "i5"
  }]
};
TextLayerData.defaultEngineDocument = {
  _0: {
    _0: "i1",
    _1: [{
      _0: "s ",
      _1: "s1"
    }, {
      _0: "s\r",
      _1: "s6"
    }, {
      _0: "s\t",
      _1: "s0"
    }, {
      _0: "s\u2029",
      _1: "s5"
    }, {
      _0: "s\x03",
      _1: "s5"
    }, {
      _0: "s\u3000",
      _1: "s1"
    }, {
      _0: "s\xAD",
      _1: "s3"
    }]
  },
  _1: "i0",
  _2: "i0",
  _3: "f.583",
  _4: "f.333",
  _5: "f.583",
  _6: "f.333",
  _7: "f.7",
  _8: true,
  _9: [{
    _0: "i0",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i1",
    _1: "s\u201D",
    _2: "s\u201D",
    _3: "s\u2019",
    _4: "s\u2019"
  }, {
    _0: "i2",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i3",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i4",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i5",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i6",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2039",
    _4: "s\u203A"
  }, {
    _0: "i7",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i8",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i9",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i10",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i11",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i12",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i13",
    _1: "s\u201D",
    _2: "s\u201D",
    _3: "s\u2019",
    _4: "s\u2019"
  }, {
    _0: "i14",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i15",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i16",
    _1: "s\u201D",
    _2: "s\u201D",
    _3: "s\u2019",
    _4: "s\u2019"
  }, {
    _0: "i17",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i18",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i19",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i20",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i21",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i22",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i23",
    _1: "s\u201E",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i24",
    _1: "s\u201E",
    _2: "s\u201D",
    _3: "s\u201A",
    _4: "s\u2019"
  }, {
    _0: "i25",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2039",
    _4: "s\u203A"
  }, {
    _0: "i26",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i27",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i28",
    _1: "s\u201E",
    _2: "s\u201D",
    _3: "s\u2019",
    _4: "s\u2019"
  }, {
    _0: "i29",
    _1: "s\u301D",
    _2: "s\u301E"
  }, {
    _0: "i30",
    _1: "s\u300C",
    _2: "s\u300D"
  }, {
    _0: "i31",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i32",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i33",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i34",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i35",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i36",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i37",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i38",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i39",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s<",
    _4: "s>"
  }, {
    _0: "i40",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i41",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s<",
    _4: "s>"
  }, {
    _0: "i42",
    _1: "s\u201E",
    _2: "s\u201C",
    _3: "s\u201A",
    _4: "s\u2018"
  }, {
    _0: "i43",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }, {
    _0: "i44",
    _1: "s\xAB",
    _2: "s\xBB",
    _3: "s\u2039",
    _4: "s\u203A"
  }, {
    _0: "i45",
    _1: "s\u201C",
    _2: "s\u201D",
    _3: "s\u2018",
    _4: "s\u2019"
  }],
  _15: {
    _0: "sWinSoft"
  },
  _16: false
};
TextLayerData.view = {};
TextLayerData.view.buildTextFrameFromEngineData = function(engineData, unusedViewSlot, engineIdx, unusedFlagsSlot) {
  const textFrameWire = {};
  const textType = TextEngineData.getTextType(engineData);
  textFrameWire._0 = [{
    _0: "i" + engineIdx
  }];
  return textFrameWire
};


export { TextLayerData };
