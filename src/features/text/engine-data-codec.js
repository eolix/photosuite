// Photoshop text EngineData wire ↔ readable key maps and expand/collapse.
// TextLayerData (txt2 builders) lives in engine-data.js and builds on this codec.

function EngineDataCodec() {}
/**
 * Expand a collapsed EngineData wire tree into readable key names.
 * @param {object} wireNode Collapsed wire root.
 * @returns {object} Readable tree.
 */
EngineDataCodec.expandEngineDataWire = function (wireNode) {
  return EngineDataCodec.mapWireToReadable(wireNode, EngineDataCodec.documentResourcesWireMap, 0);
};

/**
 * Collapse a readable EngineData tree back to numbered wire keys.
 * @param {object} readableNode Readable tree root.
 * @returns {object} Collapsed wire tree.
 */
EngineDataCodec.collapseEngineDataWire = function (readableNode) {
  return EngineDataCodec.mapReadableToWire(readableNode, EngineDataCodec.documentResourcesWireMap);
};
EngineDataCodec.mapWireToReadable = function (wireNode, wireMap, depth) {
  if (typeof wireNode == "string") return wireNode;
  if (wireNode instanceof Array) {
    const resultList = [];
    for (let itemIdx = 0; itemIdx < wireNode.length; itemIdx++) {
      resultList[itemIdx] = EngineDataCodec.mapWireToReadable(wireNode[itemIdx], wireMap, depth + 1);
    }
    return resultList;
  }
  const resultNode = {};
  const processedWireKeys = {};
  for (const readableKey in wireMap) {
    const mapEntry = wireMap[readableKey];
    const wireKey = "_" + mapEntry[0];
    if (wireNode[wireKey] != null) {
      resultNode[readableKey] = mapEntry[1]
        ? EngineDataCodec.mapWireToReadable(wireNode[wireKey], mapEntry[1], depth + 1)
        : wireNode[wireKey];
      processedWireKeys[wireKey] = true;
    }
  }
  for (const leftoverKey in wireNode) {
    if (processedWireKeys[leftoverKey] == null) {
      resultNode[leftoverKey] = wireNode[leftoverKey];
    }
  }
  return resultNode;
};
EngineDataCodec.mapReadableToWire = function (readableNode, wireMap) {
  if (readableNode instanceof Array) {
    const wireList = [];
    for (let itemIdx = 0; itemIdx < readableNode.length; itemIdx++) {
      wireList[itemIdx] = EngineDataCodec.mapReadableToWire(readableNode[itemIdx], wireMap);
    }
    return wireList;
  }
  const wireNode = {};
  const processedReadableKeys = {};
  for (const readableKey in wireMap) {
    const mapEntry = wireMap[readableKey];
    const wireKey = "_" + mapEntry[0];
    if (readableNode[readableKey] != null) {
      wireNode[wireKey] = mapEntry[1]
        ? EngineDataCodec.mapReadableToWire(readableNode[readableKey], mapEntry[1])
        : readableNode[readableKey];
      processedReadableKeys[readableKey] = true;
    }
  }
  for (const leftoverKey in readableNode) {
    if (processedReadableKeys[leftoverKey] == null) {
      wireNode[leftoverKey] = readableNode[leftoverKey];
    }
  }
  return wireNode;
};
EngineDataCodec.colorWireMap = {
  _StreamTag: [99],
  _5: [5],
  _Color: [0, {
    _Type: [0],
    _Values: [1]
  }]
};
EngineDataCodec.styleFeaturesWireMap = {
  _Font: [0],
  _FontSize: [1],
  _FauxBold: [2],
  _FauxItalic: [3],
  _AutoLeading: [4],
  _Leading: [5],
  _HorizontalScale: [6],
  _VerticalScale: [7],
  _Tracking: [8],
  _BaselineShift: [9],
  _CharacterRotation: [10],
  _AutoKern: [11],
  _FontCaps: [12],
  _FontBaseline: [13],
  _FontOTPosition: [14],
  _StrikethroughPosition: [15],
  _UnderlinePosition: [16],
  _UnderlineOffset: [17],
  _Ligatures: [18],
  _DiscretionaryLigatures: [19],
  _ContextualLigatures: [20],
  _AlternateLigatures: [21],
  _OldStyle: [22],
  _Fractions: [23],
  _Ordinals: [24],
  _Swash: [25],
  _Titling: [26],
  _ConnectionForms: [27],
  _StylisticAlternates: [28],
  _Ornaments: [29],
  _FigureStyle: [30],
  _ProportionalMetrics: [31],
  _Kana: [32],
  _Italics: [33],
  _Ruby: [34],
  _BaselineDirection: [35],
  _Tsume: [36],
  _StyleRunAlignment: [37],
  _Language: [38],
  _JapaneseAlternateFeature: [39],
  _EnableWariChu: [40],
  _WariChuLineCount: [41],
  _WariChuLineGap: [42],
  _WariChuSubLineAmount: [43, {
    _WariChuSubLineScale: [0]
  }],
  _WariChuWidowAmount: [44],
  _WariChuOrphanAmount: [45],
  _WariChuJustification: [46],
  _TCYUpDownAdjustment: [47],
  _TCYLeftRightAdjustment: [48],
  _LeftAki: [49],
  _RightAki: [50],
  _JiDori: [51],
  _NoBreak: [52],
  _FillColor: [53, EngineDataCodec.colorWireMap],
  _StrokeColor: [54, EngineDataCodec.colorWireMap],
  _Blend: [55, {
    _StreamTag: [99]
  }],
  _FillFlag: [56],
  _StrokeFlag: [57],
  _FillFirst: [58],
  _FillOverPrint: [59],
  _StrokeOverPrint: [60],
  _LineCap: [61],
  _LineJoin: [62],
  _LineWidth: [63],
  _MiterLimit: [64],
  _LineDashOffset: [65],
  _LineDashArray: [66],
  _Type1EncodingNames: [67],
  _Kashidas: [68],
  _DirOverride: [69],
  _DigitSet: [70],
  _DiacVPos: [71],
  _DiacXOffset: [72],
  _DiacYOffset: [73],
  _OverlapSwash: [74],
  _JustificationAlternates: [75],
  _StretchedAlternates: [76],
  _FillVisibleFlag: [77],
  _StrokeVisibleFlag: [78],
  _FillBackgroundColor: [79, EngineDataCodec.colorWireMap],
  _FillBackgroundFlag: [80],
  _UnderlineStyle: [81],
  _DashedUnderlineGapLength: [82],
  _DashedUnderlineDashLength: [83],
  _SlashedZero: [84],
  _StylisticSets: [85],
  _CustomFeature: [86, {
    _StreamTag: [99]
  }],
  _MarkYDistFromBaseline: [87],
  _AutoMydfb: [88]
};
EngineDataCodec.paragraphFeaturesWireMap = {
  _Justification: [0],
  _FirstLineIndent: [1],
  _StartIndent: [2],
  _EndIndent: [3],
  _SpaceBefore: [4],
  _SpaceAfter: [5],
  _DropCaps: [6],
  _AutoLeading: [7],
  _LeadingType: [8],
  _AutoHyphenate: [9],
  _HyphenatedWordSize: [10],
  _PreHyphen: [11],
  _PostHyphen: [12],
  _ConsecutiveHyphens: [13],
  _Zone: [14],
  _HyphenateCapitalized: [15],
  _HyphenationPreference: [16],
  _WordSpacing: [17],
  _LetterSpacing: [18],
  _GlyphSpacing: [19],
  _SingleWordJustification: [20],
  _Hanging: [21],
  _AutoTCY: [22],
  _KeepTogether: [23],
  _BurasagariType: [24],
  _KinsokuOrder: [25],
  _Kinsoku: [27],
  _KurikaeshiMojiShori: [26],
  _MojiKumiTable: [28],
  _EveryLineComposer: [29],
  _TabStops: [30],
  _DefaultTabWidth: [31],
  _DefaultStyle: [32, EngineDataCodec.styleFeaturesWireMap],
  _ParagraphDirection: [33],
  _JustificationMethod: [34],
  _ComposerEngine: [35],
  _ListStyle: [36],
  _ListTier: [37],
  _ListSkip: [38],
  _ListOffset: [39],
  _KashidaWidth: [40]
};
EngineDataCodec.paragraphSheetWireMap = {
  _Name: [0],
  _Features: [5, EngineDataCodec.paragraphFeaturesWireMap],
  _Parent: [6]
};
EngineDataCodec.styleSheetWireMap = {
  _Name: [0],
  _Parent: [5],
  _Features: [6, EngineDataCodec.styleFeaturesWireMap]
};
EngineDataCodec.documentResourcesWireMap = {
  _98: [98, {
    _0: [0]
  }],
  _DocumentResources: [0, {
    _0: [0],
    _FontSet: [1, {
      _Resources: [0, {
        _Resource: [0, {
          _StreamTag: [99],
          _Identifier: [0, {
            _Name: [0],
            _ScriptType: [1],
            _Type: [2],
            _Synthetic: [3],
            _4: [4],
            _MMAxis: [5]
          }]
        }]
      }],
      _1: [1, {
        _0: [0]
      }]
    }],
    _MojiKumiCodeToClassSet: [2, {
      _Resources: [0, {
        _Resource: [0, {
          _Name: [0],
          _Members: [5]
        }]
      }],
      _DisplayList: [1, {
        _Resource: [0]
      }]
    }],
    _MojiKumiTableSet: [3, {
      _Resources: [0, {
        _Resource: [0, {
          _Name: [0],
          _Members: [5, {
            _CodeToClass: [0],
            _AutoTsume: [1, {
              _TsumeMappings: [0, {
                _Before: [0],
                _After: [1],
                _Code: [2]
              }]
            }],
            _Table: [2, {
              _DataArray: [0, {
                _SparseArray: [0, {
                  _Index: [0],
                  _Elements: [1, {
                    _P: [0],
                    _Data: [1, {
                      _A: [0, {
                        _R: [0],
                        _P: [1]
                      }],
                      _B: [1, {
                        _R: [0],
                        _P: [1]
                      }]
                    }]
                  }]
                }]
              }]
            }],
            _PredefinedTag: [3]
          }]
        }]
      }],
      _DisplayList: [1, {
        _Resource: [0]
      }]
    }],
    _KinsokuSet: [4, {
      _Resources: [0, {
        _Resource: [0, {
          _Name: [0],
          _Data: [5, {
            _NoStart: [0],
            _NoEnd: [1],
            _Keep: [2],
            _Hanging: [3],
            _PredefinedTag: [4]
          }]
        }]
      }],
      _DisplayList: [1, {
        _Resource: [0]
      }]
    }],
    _StyleSheetSet: [5, {
      _Resources: [0, {
        _Resource: [0, EngineDataCodec.styleSheetWireMap]
      }],
      _DisplayList: [1, {
        _Resource: [0]
      }]
    }],
    _ParagraphSheetSet: [6, {
      _Resources: [0, {
        _Resource: [0, EngineDataCodec.paragraphSheetWireMap]
      }],
      _DisplayList: [1, {
        _Resource: [0]
      }]
    }],
    _TextFrameSet: [8, {
      _Resources: [0, {
        _Resource: [0, {
          _0: [0],
          _Bezier: [1, {
            _Points: [0]
          }],
          _Data: [2, {
            _Type: [0],
            _LineOrientation: [1],
            _FrameMatrix: [2],
            _TextOnPathTRange: [6],
            _RowGutter: [7],
            _ColumnGutter: [8],
            _FirstBaselineAlignment: [10, {
              _Flag: [0],
              _Min: [1]
            }],
            _PathData: [11, {
              _Reversed: [0],
              _2: [2],
              _3: [3],
              _Spacing: [4],
              _5: [5],
              _7: [7]
            }],
            _12: [12]
          }]
        }]
      }]
    }],
    _ListStyleSet: [9, {
      _Resources: [0, {
        _Resource: [0, {
          _Name: [0],
          _PredefinedTag: [6]
        }]
      }],
      _DisplayList: [1, {
        _Resource: [0]
      }]
    }]
  }],
  _DocumentObjects: [1, {
    _DocumentSettings: [0, {
      _HiddenGlyphFont: [0, {
        _AlternateGlyphFont: [0],
        _WhitespaceCharacterMapping: [1, {
          _WhitespaceCharacter: [0],
          _AlternateCharacter: [1]
        }]
      }],
      _NormalStyleSheet: [1],
      _NormalParagraphSheet: [2],
      _SuperscriptSize: [3],
      _SuperscriptPosition: [4],
      _SubscriptSize: [5],
      _SubscriptPosition: [6],
      _SmallCapSize: [7],
      _UseSmartQuotes: [8],
      _SmartQuoteSets: [9, {
        _Language: [0],
        _OpenDoubleQuote: [1],
        _CloseDoubleQuote: [2],
        _OpenSingleQuote: [3],
        _CloseSingleQuote: [4]
      }],
      _11: [11],
      _LinguisticSettings: [15, {
        _PreferredProvider: [0],
        _LinguisticProviderInfo: [1]
      }],
      _UseSmartLists: [16],
      _DefaultStoryDir: [17],
      _GreekingSize: [20]
    }],
    _TextObjects: [1, {
      _Model: [0, {
        _Text: [0],
        _ParagraphRun: [5, {
          _RunArray: [0, {
            _RunData: [0, {
              _ParagraphSheet: [0, EngineDataCodec.paragraphSheetWireMap]
            }],
            _Length: [1]
          }]
        }],
        _StyleRun: [6, {
          _RunArray: [0, {
            _RunData: [0, {
              _StyleSheet: [0, EngineDataCodec.styleSheetWireMap]
            }],
            _Length: [1]
          }]
        }],
        _FirstKern: [7],
        _8: [8],
        _AlternateGlyphRun: [9, {
          _RunArray: [0, {
            _RunData: [0, {
              _AlternateGlyphSheet: [0, {
                _Glyph: [0],
                _Name: [1],
                _2: [2]
              }],
              _AlternateGlyph: [1]
            }],
            _Length: [1]
          }]
        }],
        _StorySheet: [10, {
          _AntiAlias: [0],
          _UseFractionalGlyphWidths: [2],
          _3: [3],
          _4: [4]
        }],
        _KernRun: [15],
        _HyperlinkRun: [16]
      }],
      _View: [1, {
        _Frames: [0, {
          _Resource: [0]
        }],
        _RenderedData: [1, {
          _RunArray: [0, {
            _RunData: [0, {
              _0: [0],
              _LineCount: [1]
            }],
            _Length: [1]
          }]
        }],
        _Strikes: [2]
      }],
      _OpticalAlignment: [2]
    }],
    _OriginalNormalStyleFeatures: [2, EngineDataCodec.styleFeaturesWireMap],
    _OriginalNormalParagraphFeatures: [3, EngineDataCodec.paragraphFeaturesWireMap]
  }]
};

export { EngineDataCodec };
