/**
 * Brush descriptor schema, default preset, and helpers to build brush presets
 * from list entries. Consumed by brush UI, tools, and the `.abr` loader.
 */

const BrushPresetUtil = {};

/** Deep-clone a JSON-serialisable value. */
BrushPresetUtil.deepClone = function(value) {
  return JSON.parse(JSON.stringify(value))
};

/**
 * Return a default brushPreset descriptor, optionally as a sampled tip keyed by data URL / uid.
 */
BrushPresetUtil.getDefaultBrushDescriptor = function(sampledDataUrl) {
  const descriptor = BrushPresetUtil.deepClone(BrushPresetUtil.defaultBrushPreset);
  const brushTip = descriptor.Brsh.v;
  if (sampledDataUrl != null) {
    delete brushTip.Hrdn;
    brushTip.classID = "sampledBrush";
    brushTip.Nm = {
      t: "TEXT",
      v: "layer.png"
    };
    brushTip.sampledData = {
      t: "TEXT",
      v: sampledDataUrl
    }
  }
  return descriptor
};

/**
 * Unwrap a brush list entry to a brushPreset descriptor, or null when invalid / grouped.
 */
BrushPresetUtil.getBrushPresetFromListEntry = function(entry) {
  if (entry == null) return null;
  const preset = entry.v != null ? entry.v : entry;
  if (preset == null || preset.Brsh == null || preset.Brsh.v == null) return null;
  const tip = preset.Brsh.v;
  if (tip.classID == "brushGroup") return null;
  if (tip.diameter == null && tip.Dmtr != null) tip.diameter = tip.Dmtr;
  if (tip.diameter == null || tip.diameter.v == null) return null;
  return preset
};

/** Remove invalid / grouped entries from a brush preset list in place. */
BrushPresetUtil.sanitizeBrushPresetList = function(list) {
  if (list == null) return;
  for (let entryIdx = list.length - 1; entryIdx >= 0; entryIdx--)
    if (BrushPresetUtil.getBrushPresetFromListEntry(list[entryIdx]) == null) list.splice(entryIdx, 1)
};

BrushPresetUtil.defaultBrushPreset = {
  classID: "brushPreset",
  Nm: {
    t: "TEXT",
    v: "Custom Brush"
  },
  Brsh: {
    t: "Objc",
    v: {
      classID: "computedBrush",
      diameter: {
        t: "UntF",
        v: {
          type: "#Pxl",
          val: 15
        }
      },
      Hrdn: {
        t: "UntF",
        v: {
          type: "#Prc",
          val: 100
        }
      },
      Angl: {
        t: "UntF",
        v: {
          type: "#Ang",
          val: 0
        }
      },
      Rndn: {
        t: "UntF",
        v: {
          type: "#Prc",
          val: 100
        }
      },
      Spcn: {
        t: "UntF",
        v: {
          type: "#Prc",
          val: 25
        }
      },
      Intr: {
        t: "bool",
        v: true
      },
      flipX: {
        t: "bool",
        v: false
      },
      flipY: {
        t: "bool",
        v: false
      }
    }
  },
  useTipDynamics: {
    t: "bool",
    v: false
  },
  useScatter: {
    t: "bool",
    v: false
  },
  dualBrush: {
    t: "Objc",
    v: {
      classID: "dualBrush",
      useDualBrush: {
        t: "bool",
        v: false
      }
    }
  },
  brushGroup: {
    t: "Objc",
    v: {
      classID: "brushGroup",
      useBrushGroup: {
        t: "bool",
        v: false
      }
    }
  },
  useTexture: {
    t: "bool",
    v: false
  },
  usePaintDynamics: {
    t: "bool",
    v: false
  },
  useColorDynamics: {
    t: "bool",
    v: false
  },
  Wtdg: {
    t: "bool",
    v: false
  },
  Nose: {
    t: "bool",
    v: false
  },
  Rpt: {
    t: "bool",
    v: false
  }
};

BrushPresetUtil.brushDescriptorSchema = {};

/**
 * Fill missing required / tip fields on a brushPreset descriptor (logs extras / gaps).
 */
BrushPresetUtil.brushDescriptorSchema.validate = function(descriptor) {
  const schema = BrushPresetUtil.brushDescriptorSchema;
  const requiredKeys = schema.requiredKeys;
  const presentKeys = [];
  fillMissingDefaults(descriptor, requiredKeys, schema.defaultJsonByKey);
  for (let keyIdx = 0; keyIdx < requiredKeys.length; keyIdx++) presentKeys.push(requiredKeys[keyIdx]);
  collectEnabledFeatureKeys(descriptor, schema.featureRules, presentKeys, false);
  for (let key in descriptor)
    if (presentKeys.indexOf(key) == -1) console.log("Extra parameter " + key);
  validateBrushTip(descriptor.Brsh.v)
};

/**
 * Add defaults for enabled feature groups, or strip their keys when disabled.
 */
BrushPresetUtil.brushDescriptorSchema.normalize = function(descriptor) {
  const featureRules = BrushPresetUtil.brushDescriptorSchema.featureRules;
  const defaults = BrushPresetUtil.brushDescriptorSchema.defaultJsonByKey;
  for (let ruleIdx = 0; ruleIdx < featureRules.length; ruleIdx++) {
    const triggerKeys = featureRules[ruleIdx][0];
    const conditionalKeys = featureRules[ruleIdx][1];
    if (featureTriggersEnabled(descriptor, triggerKeys, true)) {
      for (let keyIdx = 0; keyIdx < conditionalKeys.length; keyIdx++)
        if (descriptor[conditionalKeys[keyIdx]] == null) {
          descriptor[conditionalKeys[keyIdx]] = JSON.parse(defaults[conditionalKeys[keyIdx]])
        }
    } else
      for (let keyIdx = 0; keyIdx < conditionalKeys.length; keyIdx++)
        if (descriptor[conditionalKeys[keyIdx]] != null) {
          delete descriptor[conditionalKeys[keyIdx]]
        }
  }
};

BrushPresetUtil.brushDescriptorSchema.tipSchema = {};
BrushPresetUtil.brushDescriptorSchema.tipSchema.requiredKeys = "classID Dmtr Angl Spcn Intr flipX flipY".split(" ");
BrushPresetUtil.brushDescriptorSchema.tipSchema.defaultJsonByKey = {
  flipX: "{\"t\":\"bool\",\"v\":false}",
  flipY: "{\"t\":\"bool\",\"v\":false}"
};
BrushPresetUtil.brushDescriptorSchema.tipSchema.keysByClassId = {
  computedBrush: ["Hrdn", "Rndn"],
  sampledBrush: ["Nm", "Rndn", "sampledData"],
  dBrush: "Shp Dnst Lngt clumping thickness stiffness physics".split(" "),
  dTips: "dtipsType Shp dtipsLengthRatio dtipsHardness dtipsGridSize dtipsErodibleTipHeightMap physics dtipsAirbrushCutoffAngle dtipsAirbrushGranularity dtipsAirbrushStreakiness dtipsAirbrushSplatSize dtipsAirbrushSplatCount".split(" ")
};
BrushPresetUtil.brushDescriptorSchema.featureRules = [
  [
    ["useTipDynamics"], "flipX flipY brushProjection minimumDiameter minimumRoundness tiltScale szVr angleDynamics roundnessDynamics".split(" ")
  ],
  [
    ["usePaintDynamics"],
    ["prVr", "opVr", "wtVr", "mxVr"]
  ],
  [
    ["useBrushPose"], "overridePoseAngle overridePoseTiltX overridePoseTiltY overridePosePressure brushPosePressure brushPoseTiltX brushPoseTiltY brushPoseAngle".split(" ")
  ],
  [
    ["useTexture"], "TxtC interpretation textureBlendMode textureDepth minimumDepth textureDepthDynamics Txtr textureScale InvT textureBrightness textureContrast".split(" ")
  ],
  [
    ["useColorDynamics"], "clVr H Strt Brgh purity colorDynamicsPerTip".split(" ")
  ],
  [
    ["useScatter"],
    ["Cnt", "countDynamics", "bothAxes", "scatterDynamics"]
  ],
  [
    ["useScatter", "bothAxes"],
    ["Spcn"]
  ]
];
BrushPresetUtil.brushDescriptorSchema.requiredKeys = "classID Nm Brsh useTipDynamics usePaintDynamics useColorDynamics useScatter useTexture useBrushSize useBrushPose Wtdg Nose Rpt dualBrush brushGroup".split(" ");
BrushPresetUtil.brushDescriptorSchema.defaultJsonByKey = {
  useBrushSize: "{\"t\":\"bool\",\"v\":false}",
  useBrushPose: "{\"t\":\"bool\",\"v\":false}",
  brushGroup: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brushGroup\",\"useBrushGroup\":{\"t\":\"bool\",\"v\":false}}}",
  flipX: "{\"t\":\"bool\",\"v\":false}",
  flipY: "{\"t\":\"bool\",\"v\":false}",
  brushProjection: "{\"t\":\"bool\",\"v\":false}",
  minimumDiameter: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}",
  minimumRoundness: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":25}}",
  tiltScale: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":200}}",
  szVr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":2},\"fStp\":{\"t\":\"long\",\"v\":1},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  angleDynamics: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  roundnessDynamics: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  prVr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":2},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  opVr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  wtVr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  mxVr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  overridePoseAngle: "{\"t\":\"bool\",\"v\":false}",
  overridePoseTiltX: "{\"t\":\"bool\",\"v\":true}",
  overridePoseTiltY: "{\"t\":\"bool\",\"v\":true}",
  overridePosePressure: "{\"t\":\"bool\",\"v\":true}",
  brushPosePressure: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":9}}",
  brushPoseTiltX: "{\"t\":\"long\",\"v\":0}",
  brushPoseTiltY: "{\"t\":\"long\",\"v\":0}",
  brushPoseAngle: "{\"t\":\"long\",\"v\":0}",
  TxtC: "{\"t\":\"bool\",\"v\":false}",
  interpretation: "{\"t\":\"bool\",\"v\":true}",
  textureBlendMode: "{\"t\":\"enum\",\"v\":{\"blendMode\":\"CBrn\"}}",
  textureDepth: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":37}}",
  minimumDepth: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":97}}",
  textureDepthDynamics: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  Txtr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"Ptrn\",\"Nm\":{\"t\":\"TEXT\",\"v\":\"$$$/Presets/Patterns/Patterns_pat/Laidhorizontal=Laid-horizontal\"},\"Idnt\":{\"t\":\"TEXT\",\"v\":\"52a93427-f5d6-1172-a989-8dc82a43aa51\"}}}",
  textureScale: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":99}}",
  InvT: "{\"t\":\"bool\",\"v\":false}",
  textureBrightness: "{\"t\":\"long\",\"v\":14}",
  textureContrast: "{\"t\":\"long\",\"v\":100}",
  Cnt: "{\"t\":\"doub\",\"v\":4}",
  countDynamics: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":1},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":98}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  bothAxes: "{\"t\":\"bool\",\"v\":false}",
  scatterDynamics: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":1},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":56}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  clVr: "{\"t\":\"Objc\",\"v\":{\"classID\":\"brVr\",\"bVTy\":{\"t\":\"long\",\"v\":0},\"fStp\":{\"t\":\"long\",\"v\":25},\"jitter\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}},\"Mnm\":{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}}}",
  H: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}",
  Strt: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}",
  Brgh: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":36}}",
  purity: "{\"t\":\"UntF\",\"v\":{\"type\":\"#Prc\",\"val\":0}}",
  colorDynamicsPerTip: "{\"t\":\"bool\",\"v\":false}"
};

export { BrushPresetUtil };

function fillMissingDefaults(descriptor, requiredKeys, defaultJsonByKey) {
  for (let keyIdx = 0; keyIdx < requiredKeys.length; keyIdx++)
    if (descriptor[requiredKeys[keyIdx]] == null) descriptor[requiredKeys[keyIdx]] = JSON.parse(defaultJsonByKey[requiredKeys[keyIdx]])
}

function featureTriggersEnabled(descriptor, triggerKeys, requirePresence) {
  let allEnabled = true;
  for (let ruleIdx = 0; ruleIdx < triggerKeys.length; ruleIdx++) {
    const trigger = descriptor[triggerKeys[ruleIdx]];
    if (requirePresence) allEnabled = allEnabled && trigger && trigger.v == true;
    else allEnabled = allEnabled && trigger.v == true
  }
  return allEnabled
}

function collectEnabledFeatureKeys(descriptor, featureRules, presentKeys, requirePresence) {
  for (let ruleIdx = 0; ruleIdx < featureRules.length; ruleIdx++) {
    const triggerKeys = featureRules[ruleIdx][0];
    const conditionalKeys = featureRules[ruleIdx][1];
    if (!featureTriggersEnabled(descriptor, triggerKeys, requirePresence)) continue;
    for (let keyIdx = 0; keyIdx < conditionalKeys.length; keyIdx++) {
      if (descriptor[conditionalKeys[keyIdx]] == null) console.log("Missing conditional parameter " + conditionalKeys[keyIdx]);
      else presentKeys.push(conditionalKeys[keyIdx])
    }
  }
}

function validateBrushTip(tipDescriptor) {
  const tipSchema = BrushPresetUtil.brushDescriptorSchema.tipSchema;
  const requiredKeys = tipSchema.requiredKeys;
  const presentKeys = [];
  fillMissingDefaults(tipDescriptor, requiredKeys, tipSchema.defaultJsonByKey);
  for (let keyIdx = 0; keyIdx < requiredKeys.length; keyIdx++)
    if (tipDescriptor[requiredKeys[keyIdx]]) presentKeys.push(requiredKeys[keyIdx]);
    else console.log("Missing default parameter " + requiredKeys[keyIdx]);
  const classKeys = tipSchema.keysByClassId[tipDescriptor.classID];
  for (let keyIdx = 0; keyIdx < classKeys.length; keyIdx++)
    if (tipDescriptor[classKeys[keyIdx]] == null && classKeys[keyIdx] != "dtipsGridSize" && classKeys[keyIdx] != "dtipsErodibleTipHeightMap" && tipDescriptor.a1M != 1) console.log("Missing conditional parameter " + classKeys[keyIdx]);
    else presentKeys.push(classKeys[keyIdx]);
  for (let key in tipDescriptor)
    if (presentKeys.indexOf(key) == -1) console.log("Extra parameter " + key)
}
