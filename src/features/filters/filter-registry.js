/**
 * Smart-filter PSD descriptor defaults: per-filter parameter tables, menu
 * grouping, and `FilterDefs.create` factories for empty FX lists.
 */

import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { ToolId } from "../../document/model/tool-base.js";
import { GalleryFilterDefs } from "./gallery/gallery-filter-defs.js";
import { CachedLayerData } from "./filter-data-cache.js";;
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { createChannelMixerDefault } from "../adjustments/adjustment-engine.js";
import {
  createCurvesDefault,
  createHueSaturationDefault,
  createLevelsDefault,
  createSelectiveColorDefault,
} from "../../document/formats/psd/adjustment-parsers.js";
import {
  CAMERA_RAW_WIRE_CLASS_ID,
  createCameraRawDefaultDescriptor,
  normalizeCameraRawClassId,
} from "./camera-raw-descriptor.js";

export const FilterDefs = {};
FilterDefs.getFilterClassIdFromFx = function(filterFxEntry) {
  const filterIdValue = filterFxEntry.filterID.v;
  const classId = filterIdValue > 16777215
    ? BinaryUtils.uint32ToFourCC(filterIdValue)
    : filterFxEntry.Fltr.v.classID;
  return normalizeCameraRawClassId(classId);
};
/** Filter menu contents: single filters first, then the category submenus. */
FilterDefs.filterMenuGroups = [{
  filterClassId: "GEfc"
}, {
  filterClassId: "cameraRaw"
}, {
  filterClassId: "LnCr"
}, {
  filterClassId: "LqFy",
  separatorAfter: true
}, {
  groupLabelKey: "3D",
  filterIds: ["lightFilterGradient"]
}, {
  groupLabelKey: "filters.menu.blur.title",
  filterIds: "Avrg,Blr ,BlrM,boxblur,GsnB,Bokh,MtnB,RdlB,surfaceBlur".split(",")
}, {
  groupLabelKey: "filters.menu.distort.title",
  filterIds: "Dspl,Pnch,Plr ,Rple,Shr ,Sphr,Twrl,Wave".split(",")
}, {
  groupLabelKey: "filters.menu.noise.title",
  filterIds: ["AdNs", "Dspc", "DstS", "Mdn "]
}, {
  groupLabelKey: "filters.menu.pixelate.title",
  filterIds: "ClrH,Crst,Frgm,Mztn,Msc ,Pntl".split(",")
}, {
  groupLabelKey: "filters.menu.render.title",
  filterIds: ["Clds", "DfrC", "LnsF"]
}, {
  groupLabelKey: "filters.menu.sharpen.title",
  filterIds: ["Shrp", "ShrE", "ShrM", "smartSharpen", "UnsM"]
}, {
  groupLabelKey: "filters.menu.stylise.title",
  filterIds: "Dfs ,Embs,FndE,oilPaint,Slrz,TrcC,Wnd ".split(",")
}, {
  groupLabelKey: "filters.menu.other.title",
  filterIds: "HghP,Mxm ,Mnm ,Ofst".split(",")
}];
FilterDefs.filterScriptKeys = {
  LqFy: "LqFy",
  Avrg: "Avrg",
  "Blr ": "blurEvent",
  BlrM: "blurMethod",
  boxblur: "boxblur",
  GsnB: "gaussianBlur",
  MtnB: "motionBlur",
  RdlB: "radialBlur",
  surfaceBlur: "surfaceBlur",
  lightFilterGradient: "lightFilterGradient",
  adaptCorrect: "adaptCorrect",
  Pnch: "pinch",
  "Plr ": "polar",
  Rple: "ripple",
  "Shr ": "shear",
  Sphr: "spherize",
  Twrl: "twirl",
  Wave: "wave",
  AdNs: "addNoise",
  DstS: "dustAndScratches",
  "Mdn ": "median",
  ClrH: "colorHalftone",
  Crst: "",
  Frgm: "",
  Mztn: "mezzotint",
  "Msc ": "mosaic",
  Pntl: "",
  Clds: "clouds",
  DfrC: "differenceClouds",
  LnsF: "LnsF",
  Shrp: "sharpen",
  ShrM: "sharpenMore",
  smartSharpen: "smartSharpen",
  UnsM: "unsharpMask",
  FndE: "findEdges",
  oilPaint: "oilPaint",
  HghP: "highPass",
  "Mxm ": "maximum",
  "Mnm ": "minimum",
  Ofst: "offset"
};
FilterDefs.scriptNameToFourCc = {
  AddNoise: "AdNs",
  Average: "Avrg",
  Blur: "Blr ",
  BlurMore: "BlrM",
  Clouds: "Clds",
  DifferenceClouds: "DfrC",
  DustAndScratches: "DstS",
  GaussianBlur: "GsnB",
  HighPass: "HghP",
  Maximum: "Mxm ",
  Minimum: "Mnm ",
  MotionBlur: "MtnB",
  Offset: "Ofst",
  Pinch: "Pnch",
  PolarCoordinates: "Plr ",
  Ripple: "Rple",
  Sharpen: "Shrp",
  SharpenMore: "ShrM",
  Twirl: "Twrl",
  UnsharpMask: "UnsM"
};
FilterDefs.toolLinkedFilterIds = {};
Object.defineProperty(FilterDefs.toolLinkedFilterIds, "rigidTransform", {
  enumerable: true,
  get: function() {
    return ToolId.TOOL_PUPPET_WARP;
  }
});
FilterDefs.names = {
  cameraRaw: "Camera Raw Filter",
  [CAMERA_RAW_WIRE_CLASS_ID]: "Camera Raw Filter",
  lightFilterGradient: "Normal Map",
  rigidTransform: "tools.puppetWarp",
  LnCr: "filters.menu.lensCorrection",
  LqFy: "filters.menu.liquify.title",
  GEfc: "filters.filterGallery",
  Avrg: "filters.menu.blur.average",
  "Blr ": "filters.menu.blur.blur",
  BlrM: "filters.menu.blur.blurMore",
  boxblur: "filters.menu.blur.boxBlur",
  GsnB: "filters.menu.blur.gaussianBlur",
  Bokh: "filters.menu.blur.lensBlur",
  MtnB: "filters.menu.blur.motionBlur",
  RdlB: "filters.menu.blur.radialBlur",
  surfaceBlur: "filters.menu.blur.surfaceBlur",
  Dspl: "filters.menu.distort.displace",
  Pnch: "filters.menu.distort.pinch",
  "Plr ": "filters.menu.distort.polarCoordinates",
  Rple: "filters.menu.distort.ripple",
  "Shr ": "filters.menu.distort.shear",
  Sphr: "filters.menu.distort.spherize",
  Twrl: "filters.menu.distort.twirl",
  Wave: "filters.menu.distort.wave",
  AdNs: "filters.menu.noise.addNoise",
  Dspc: "filters.menu.noise.despeckle",
  DstS: "filters.menu.noise.dustAndScratches",
  "Mdn ": "filters.menu.noise.median",
  ClrH: "filters.menu.pixelate.colourHalftone",
  Crst: "filters.menu.pixelate.crystallise",
  Frgm: "filters.menu.pixelate.fragment",
  Mztn: "filters.menu.pixelate.mezzotint",
  "Msc ": "filters.menu.pixelate.mosaic",
  Pntl: "filters.menu.pixelate.pointillise",
  Clds: "filters.menu.render.clouds",
  DfrC: "filters.menu.render.differenceClouds",
  LnsF: "filters.menu.render.lensFlare",
  Shrp: "filters.menu.sharpen.sharpen",
  ShrE: "filters.menu.sharpen.sharpenEdges",
  ShrM: "filters.menu.sharpen.sharpenMore",
  smartSharpen: "filters.menu.sharpen.smartSharpen",
  UnsM: "filters.menu.sharpen.unsharpMask",
  "Dfs ": "filters.menu.stylise.diffuse",
  Embs: "filters.menu.stylise.emboss",
  FndE: "filters.menu.stylise.findEdges",
  oilPaint: "filters.menu.stylise.oilPaint",
  Slrz: "Solarize",
  TrcC: "Trace Contour",
  "Wnd ": "Wind",
  HghP: "filters.menu.other.highPass",
  "Mxm ": "filters.menu.other.maximum",
  "Mnm ": "filters.menu.other.minimum",
  Ofst: "filters.menu.other.offset",
  adaptCorrect: ["VAR0/VAR1", "styleOptions.toneRange.shadows",
    "styleOptions.toneRange.highlights"
  ]
};

function blurFamilyPadding(filterDescriptor) {
  const radius = filterDescriptor && filterDescriptor.Rds && filterDescriptor.Rds.v ? filterDescriptor.Rds.v.val : 0;
  return radius * 2.57;
}

function motionBlurPadding(filterDescriptor) {
  return filterDescriptor && filterDescriptor.Dstn && filterDescriptor.Dstn.v ? filterDescriptor.Dstn.v.val : 0;
}

const FULL_DOCUMENT_PAD_FILTER_IDS = "Ofst,LqFy,Dspl,Pnch,Rple,Shr ,Sphr,Twrl,Wave,RdlB,Clds,DfrC,Plr ,LnCr,Wnd ,lightFilterGradient,rigidTransform,Frgm".split(",");
const BLUR_PAD_FILTER_IDS = ["GsnB", "boxblur", "smartSharpen", "UnsM", "HghP"];


// Private default-descriptor factories.

function createGalleryEffectsDefault() {
  return {
    __name: "Filter Gallery",
    classID: "GEfc",
    GEfs: {
      t: "VlLs",
      v: [{
        t: "Objc",
        v: GalleryFilterDefs.create("GlwE")
      }]
    }
  }
}

function createCameraRawDefault() {
  return createCameraRawDefaultDescriptor();
}

function createLiquifyDefault() {
  const emptyDisplacementMesh = {
      gridWidth: 5,
      gridHeight: 5,
      map: new Float32Array(5 * 5 * 2)
    };

  const meshBytes = new Uint8Array(CachedLayerData.serialize(emptyDisplacementMesh));
  const meshByteList = [];
  for (let byteIdx = 0; byteIdx < meshBytes.length; byteIdx++) meshByteList.push(meshBytes[byteIdx]);

  const defaultDescriptor = {
    __name: "Liquify",
    classID: "LqFy",
    LqMe: {
      t: "tdta",
      v: meshByteList
    }
  };

  return defaultDescriptor
}

function createRigidTransformDefault() {
  const defaultDescriptor = {
    __name: "Puppet Warp",
    classID: "rigidTransform",
    null: {
      t: "obj ",
      v: [{
        t: "Enmr",
        v: {
          classID: "Lyr",
          typeID: "Ordn",
          enum: "Trgt"
        }
      }]
    },
    rigidType: {
      t: "bool",
      v: true
    },
    puppetShapeList: {
      t: "VlLs",
      v: []
    },
    PuX0: {
      t: "doub",
      v: 0
    },
    PuX1: {
      t: "doub",
      v: 1e3
    },
    PuX2: {
      t: "doub",
      v: 1e3
    },
    PuX3: {
      t: "doub",
      v: 0
    },
    PuY0: {
      t: "doub",
      v: 0
    },
    PuY1: {
      t: "doub",
      v: 0
    },
    PuY2: {
      t: "doub",
      v: 1e3
    },
    PuY3: {
      t: "doub",
      v: 1e3
    }
  };

  return defaultDescriptor
}

function createLensCorrectionDefault() {
  return {
    __name: "Lens Correction",
    classID: "LnCr",
    LnAg: {
      t: "bool",
      v: false
    },
    LnAc: {
      t: "bool",
      v: false
    },
    LnAv: {
      t: "bool",
      v: false
    },
    LnAs: {
      t: "bool",
      v: false
    },
    LnIp: {
      t: "bool",
      v: false
    },
    LnFo: {
      t: "doub",
      v: 0
    },
    LnPr: {
      t: "TEXT",
      v: ""
    },
    LnIa: {
      t: "doub",
      v: 0
    },
    LnI0: {
      t: "doub",
      v: 0
    },
    LnI1: {
      t: "doub",
      v: 0
    },
    LnI2: {
      t: "doub",
      v: 0
    },
    LnI3: {
      t: "doub",
      v: 1
    },
    LnRa: {
      t: "doub",
      v: 0
    },
    LnVp: {
      t: "doub",
      v: 0
    },
    LnHp: {
      t: "doub",
      v: 0
    },
    LnSi: {
      t: "doub",
      v: 100
    },
    LnFt: {
      t: "long",
      v: 0
    },
    LnSb: {
      t: "doub",
      v: 0
    },
    LnSt: {
      t: "long",
      v: 50
    },
    LnRc: {
      t: "doub",
      v: 0
    },
    LnGm: {
      t: "doub",
      v: 0
    },
    LnBy: {
      t: "doub",
      v: 0
    },
    LnNa: {
      t: "long",
      v: 64
    },
    LnIh: {
      t: "long",
      v: 0
    },
    LnIv: {
      t: "long",
      v: 0
    },
    LnIs: {
      t: "Objc",
      v: {
        classID: "RGBC",
        Rd: {
          t: "doub",
          v: 127
        },
        Grn: {
          t: "doub",
          v: 127
        },
        Bl: {
          t: "doub",
          v: 127
        }
      }
    },
    LnNm: {
      t: "bool",
      v: false
    }
  }
}

function createAdaptCorrectDefault() {
  return {
    __name: "Shadow/Highlight",
    classID: "adaptCorrect",
    sdwM: {
      t: "Objc",
      v: {
        __name: "Parameters",
        classID: "adaptCorrectTones",
        Amnt: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 50
          }
        },
        Wdth: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 25
          }
        },
        Rds: {
          t: "long",
          v: 12
        }
      }
    },
    hglM: {
      t: "Objc",
      v: {
        __name: "Parameters",
        classID: "adaptCorrectTones",
        Amnt: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 0
          }
        },
        Wdth: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 0
          }
        },
        Rds: {
          t: "long",
          v: 0
        }
      }
    },
    BlcC: {
      t: "doub",
      v: 0
    },
    WhtC: {
      t: "doub",
      v: 0
    },
    Cntr: {
      t: "long",
      v: 0
    },
    ClrC: {
      t: "long",
      v: 0
    }
  }
}

function createDiffuseDefault() {
  return {
    __name: "Diffuse",
    classID: "Dfs",
    Md: {
      t: "enum",
      v: {
        DfsM: "Nrml"
      }
    },
    FlRs: {
      t: "long",
      v: 14061024
    }
  }
}

function createEmbossDefault() {
  return {
    __name: "Emboss",
    classID: "Embs",
    Angl: {
      t: "long",
      v: 45
    },
    Hght: {
      t: "long",
      v: 5
    },
    Amnt: {
      t: "long",
      v: 100
    }
  }
}

function createOilPaintDefault() {
  return {
    __name: "Oil Paint",
    classID: "oilPaint",
    lightingOn: {
      t: "bool",
      v: true
    },
    stylization: {
      t: "doub",
      v: 3
    },
    brushScale: {
      t: "doub",
      v: 1
    },
    microBrush: {
      t: "doub",
      v: 0
    },
    LghD: {
      t: "long",
      v: 45
    },
    specularity: {
      t: "doub",
      v: 1
    },
    cleanliness: {
      t: "doub",
      v: 2
    }
  }
}

function createTraceContourDefault() {
  return {
    __name: "Trace Contour",
    classID: "TrcC",
    Lvl: {
      t: "long",
      v: 128
    },
    Edg: {
      t: "enum",
      v: {
        CntE: "Lwr"
      }
    }
  }
}

function createWindDefault() {
  return {
    __name: "Wind",
    classID: "Wnd",
    WndM: {
      t: "enum",
      v: {
        WndM: "Wnd"
      }
    },
    Drct: {
      t: "enum",
      v: {
        Drct: "Rght"
      }
    }
  }
}

function createLightFilterGradientDefault() {
  return {
    __name: "Generate Normals",
    classID: "lightFilterGradient",
    blur: {
      t: "doub",
      v: 0
    },
    textureScale: {
      t: "doub",
      v: 1
    },
    Scl: {
      t: "doub",
      v: 1
    },
    Dtl: {
      t: "VlLs",
      v: [{
        t: "doub",
        v: 1
      }, {
        t: "doub",
        v: 1
      }, {
        t: "doub",
        v: 1
      }]
    }
  }
}

function createBoxBlurDefault() {
  return {
    __name: "Box Blur",
    classID: "boxblur",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 15
      }
    }
  }
}

function createGaussianBlurDefault() {
  return {
    __name: "Gaussian Blur",
    classID: "GsnB",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 7.2
      }
    }
  }
}

function createLensBlurDefault() {
  return {
    __name: "Lens Blur",
    classID: "Bokh",
    BkDi: {
      t: "enum",
      v: {
        BtDi: "BeIn"
      }
    },
    BkDp: {
      t: "long",
      v: 0
    },
    BkDs: {
      t: "bool",
      v: false
    },
    BkIs: {
      t: "enum",
      v: {
        BtIs: "BeS6"
      }
    },
    BkIb: {
      t: "doub",
      v: 30
    },
    BkIc: {
      t: "long",
      v: 0
    },
    BkIr: {
      t: "long",
      v: 0
    },
    BkSb: {
      t: "doub",
      v: 0
    },
    BkSt: {
      t: "long",
      v: 255
    },
    BkNa: {
      t: "long",
      v: 0
    },
    BkNt: {
      t: "enum",
      v: {
        BtNt: "BeNu"
      }
    },
    BkNm: {
      t: "bool",
      v: false
    }
  }
}

function createMotionBlurDefault() {
  return {
    __name: "Motion Blur",
    classID: "MtnB",
    Angl: {
      t: "long",
      v: 0
    },
    Dstn: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 4
      }
    }
  }
}

function createRadialBlurDefault() {
  return {
    __name: "Radial Blur",
    classID: "RdlB",
    Amnt: {
      t: "long",
      v: 10
    },
    BlrM: {
      t: "enum",
      v: {
        BlrM: "Spn"
      }
    },
    BlrQ: {
      t: "enum",
      v: {
        BlrQ: "Gd"
      }
    },
    Cntr: {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: {
          t: "doub",
          v: .5
        },
        Vrtc: {
          t: "doub",
          v: .5
        }
      }
    }
  }
}

function createSurfaceBlurDefault() {
  return {
    __name: "Surface Blur",
    classID: "surfaceBlur",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 15
      }
    },
    Thsh: {
      t: "long",
      v: 15
    }
  }
}

function createDisplaceDefault() {
  return {
    __name: "Displace",
    classID: "Dspl",
    HrzS: {
      t: "long",
      v: 10
    },
    VrtS: {
      t: "long",
      v: 10
    },
    DspM: {
      t: "enum",
      v: {
        DspM: "StrF"
      }
    },
    UndA: {
      t: "enum",
      v: {
        UndA: "RptE"
      }
    },
    DspF: {
      t: "Pth ",
      v: {
        sig: "txtu",
        // Tag of the linked-file item holding the displacement map; empty until
        // one is chosen in the dialog, and the filter is a no-op while it is.
        pth: ""
      }
    }
  }
}

function createPinchDefault() {
  return {
    __name: "Pinch",
    classID: "Pnch",
    Amnt: {
      t: "long",
      v: -100
    }
  }
}

function createPolarDefault() {
  return {
    __name: "Polar Coordinates",
    classID: "Plr",
    Cnvr: {
      t: "enum",
      v: {
        Cnvr: "RctP"
      }
    }
  }
}

function createRippleDefault() {
  return {
    __name: "Ripple",
    classID: "Rple",
    Amnt: {
      t: "long",
      v: 999
    },
    RplS: {
      t: "enum",
      v: {
        RplS: "Mdm"
      }
    }
  }
}

function createShearDefault() {
  return {
    __name: "Shear",
    classID: "Shr",
    ShrP: {
      t: "VlLs",
      v: [{
        t: "Objc",
        v: {
          classID: "Pnt",
          Hrzn: {
            t: "doub",
            v: 0
          },
          Vrtc: {
            t: "doub",
            v: 1
          }
        }
      }, {
        t: "Objc",
        v: {
          classID: "Pnt",
          Hrzn: {
            t: "doub",
            v: 0
          },
          Vrtc: {
            t: "doub",
            v: 128
          }
        }
      }]
    },
    UndA: {
      t: "enum",
      v: {
        UndA: "WrpA"
      }
    },
    ShrS: {
      t: "long",
      v: 0
    },
    ShrE: {
      t: "long",
      v: 1
    }
  }
}

function createSpherizeDefault() {
  return {
    __name: "Spherize",
    classID: "Sphr",
    Amnt: {
      t: "long",
      v: 100
    },
    SphM: {
      t: "enum",
      v: {
        SphM: "Nrml"
      }
    }
  }
}

function createTwirlDefault() {
  return {
    __name: "Twirl",
    classID: "Twrl",
    Angl: {
      t: "long",
      v: 90
    }
  }
}

function createWaveDefault() {
  return {
    __name: "Wave",
    classID: "Wave",
    Wvtp: {
      t: "enum",
      v: {
        Wvtp: "WvSn"
      }
    },
    NmbG: {
      t: "long",
      v: 1
    },
    WLMn: {
      t: "long",
      v: 101
    },
    WLMx: {
      t: "long",
      v: 102
    },
    AmMn: {
      t: "long",
      v: 36
    },
    AmMx: {
      t: "long",
      v: 37
    },
    SclH: {
      t: "long",
      v: 100
    },
    SclV: {
      t: "long",
      v: 100
    },
    UndA: {
      t: "enum",
      v: {
        UndA: "WrpA"
      }
    },
    RndS: {
      t: "long",
      v: 743887
    }
  }
}

function createAddNoiseDefault() {
  return {
    __name: "Add Noise",
    classID: "AdNs",
    Dstr: {
      t: "enum",
      v: {
        Dstr: "Unfr"
      }
    },
    Nose: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 20
      }
    },
    Mnch: {
      t: "bool",
      v: false
    },
    FlRs: {
      t: "long",
      v: 100691320
    }
  }
}

function createDustAndScratchesDefault() {
  return {
    __name: "Dust & Scratches",
    classID: "DstS",
    Rds: {
      t: "long",
      v: 2
    },
    Thsh: {
      t: "long",
      v: 26
    }
  }
}

function createMedianDefault() {
  return {
    __name: "Median",
    classID: "Mdn",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 7
      }
    }
  }
}

function createColorHalftoneDefault() {
  return {
    __name: "Color Halftone",
    classID: "ClrH",
    Rds: {
      t: "long",
      v: 8
    },
    Ang1: {
      t: "long",
      v: 10
    },
    Ang2: {
      t: "long",
      v: 40
    },
    Ang3: {
      t: "long",
      v: 70
    },
    Ang4: {
      t: "long",
      v: 80
    }
  }
}

function createCrystallizeDefault() {
  return {
    __name: "Crystallize",
    classID: "Crst",
    ClSz: {
      t: "long",
      v: 10
    },
    FlRs: {
      t: "long",
      v: 1554929224
    }
  }
}

function createMezzotintDefault() {
  return {
    __name: "Mezzotint",
    classID: "Mztn",
    MztT: {
      t: "enum",
      v: {
        MztT: "FnDt"
      }
    },
    FlRs: {
      t: "long",
      v: 204994187
    }
  }
}

function createMosaicDefault() {
  return {
    __name: "Mosaic",
    classID: "Msc",
    ClSz: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 12
      }
    }
  }
}

function createPointillizeDefault() {
  return {
    __name: "Pointillize",
    classID: "Pntl",
    ClSz: {
      t: "long",
      v: 10
    },
    FlRs: {
      t: "long",
      v: 1554929236
    }
  }
}

function createLensFlareDefault() {
  return {
    __name: "Lens Flare",
    classID: "LnsF",
    Brgh: {
      t: "long",
      v: 100
    },
    FlrC: {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: {
          t: "doub",
          v: .19140625
        },
        Vrtc: {
          t: "doub",
          v: .185628741979599
        }
      }
    },
    Lns: {
      t: "enum",
      v: {
        Lns: "Zm"
      }
    }
  }
}

function createSmartSharpenDefault() {
  return {
    __name: "Smart Sharpen",
    classID: "smartSharpen",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    useLegacy: {
      t: "bool",
      v: false
    },
    Amnt: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 150
      }
    },
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 1
      }
    },
    noiseReduction: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 0
      }
    },
    blur: {
      t: "enum",
      v: {
        blurType: "GsnB"
      }
    }
  }
}

function createUnsharpMaskDefault() {
  return {
    __name: "Unsharp Mask",
    classID: "UnsM",
    Amnt: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 142
      }
    },
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 4.5
      }
    },
    Thsh: {
      t: "long",
      v: 0
    }
  }
}

function createHighPassDefault() {
  return {
    __name: "High Pass",
    classID: "HghP",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 3
      }
    }
  }
}

function createMaximumDefault() {
  return {
    __name: "Maximum",
    classID: "Mxm",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 9
      }
    }
  }
}

function createMinimumDefault() {
  return {
    __name: "Minimum",
    classID: "Mnm",
    Rds: {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: 14
      }
    }
  }
}

function createOffsetDefault() {
  return {
    __name: "Offset",
    classID: "Ofst",
    Hrzn: {
      t: "long",
      v: 144
    },
    Vrtc: {
      t: "long",
      v: 278
    },
    Fl: {
      t: "enum",
      v: {
        FlMd: "Wrp"
      }
    }
  }
}

function createCloudsDefault() {
  return {
    __name: "Clouds",
    classID: "Clds",
    FlRs: {
      t: "long",
      v: 1857132644
    }
  }
}

function createDifferenceCloudsDefault() {
  return {
    __name: "Difference Clouds",
    classID: "DfrC",
    FlRs: {
      t: "long",
      v: 1857132644
    }
  }
}

function createBrightnessContrastDefault() {
  return {
    __name: "Brightness/Contrast",
    classID: "BrgC",
    Brgh: {
      t: "long",
      v: 0
    },
    Cntr: {
      t: "long",
      v: 0
    },
    useLegacy: {
      t: "bool",
      v: false
    }
  }
}

function createExposureDefault() {
  return {
    __name: "Exposure",
    classID: "Exps",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    Exps: {
      t: "doub",
      v: 0
    },
    Ofst: {
      t: "doub",
      v: 0
    },
    gammaCorrection: {
      t: "doub",
      v: 1
    }
  }
}

function createVibranceDefault() {
  return {
    __name: "Vibrance",
    classID: "vibrance",
    vibrance: {
      t: "long",
      v: 0
    },
    Strt: {
      t: "long",
      v: 0
    }
  }
}

function createColorBalanceDefault() {
  return {
    __name: "Color Balance",
    classID: "ClrB",
    ShdL: {
      t: "VlLs",
      v: [{
        t: "long",
        v: 0
      }, {
        t: "long",
        v: 0
      }, {
        t: "long",
        v: 0
      }]
    },
    MdtL: {
      t: "VlLs",
      v: [{
        t: "long",
        v: 0
      }, {
        t: "long",
        v: 0
      }, {
        t: "long",
        v: 0
      }]
    },
    HghL: {
      t: "VlLs",
      v: [{
        t: "long",
        v: 0
      }, {
        t: "long",
        v: 0
      }, {
        t: "long",
        v: 0
      }]
    },
    PrsL: {
      t: "bool",
      v: true
    }
  }
}

function createBlackAndWhiteDefault() {
  return {
    __name: "Black & White",
    classID: "BanW",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindCustom"
      }
    },
    Rd: {
      t: "long",
      v: 40
    },
    Yllw: {
      t: "long",
      v: 85
    },
    Grn: {
      t: "long",
      v: 204
    },
    Cyn: {
      t: "long",
      v: 60
    },
    Bl: {
      t: "long",
      v: 20
    },
    Mgnt: {
      t: "long",
      v: 80
    },
    useTint: {
      t: "bool",
      v: true
    },
    tintColor: {
      t: "Objc",
      v: {
        classID: "RGBC",
        Rd: {
          t: "doub",
          v: 0
        },
        Grn: {
          t: "doub",
          v: 0
        },
        Bl: {
          t: "doub",
          v: 0
        }
      }
    }
  }
}

function createPhotoFilterDefault() {
  return {
    __name: "Photo Filter",
    classID: "photoFilter",
    Clr: {
      t: "Objc",
      v: {
        classID: "LbCl",
        Lmnc: {
          t: "doub",
          v: 67.06
        },
        A: {
          t: "doub",
          v: 32
        },
        B: {
          t: "doub",
          v: 120
        }
      }
    },
    Dnst: {
      t: "long",
      v: 80
    },
    PrsL: {
      t: "bool",
      v: true
    }
  }
}

function createGradientMapDefault() {
  return {
    __name: "Gradient Map",
    classID: "GrMp",
    Rvrs: {
      t: "bool",
      v: false
    },
    Grad: LayerEffectDefs.getEffectDefaultByOrderIndex(6).Grad
  }
}

function createThresholdDefault() {
  return {
    __name: "Threshold",
    classID: "Thrs",
    Lvl: {
      t: "long",
      v: 128
    }
  }
}

function createColorLookupDefault() {
  return {
    __name: "Color Lookup",
    classID: "colorLookup"
  }
}

function createInvertDefault() {
  return {
    __name: "Invert",
    classID: "Invr"
  }
}

function createPosterizeDefault() {
  return {
    __name: "Posterize",
    classID: "Pstr",
    Lvls: {
      t: "long",
      v: 3
    }
  }
}

function createReplaceColorDefault() {
  return {
    __name: "Replace Color",
    classID: "RplC",
    Fzns: {
      t: "long",
      v: 55
    },
    Mnm: {
      t: "Objc",
      v: {
        classID: "LbCl",
        Lmnc: {
          t: "doub",
          v: 73.1
        },
        A: {
          t: "doub",
          v: 23.95
        },
        B: {
          t: "doub",
          v: 8.03
        }
      }
    },
    Mxm: {
      t: "Objc",
      v: {
        classID: "LbCl",
        Lmnc: {
          t: "doub",
          v: 73
        },
        A: {
          t: "doub",
          v: 23
        },
        B: {
          t: "doub",
          v: 8
        }
      }
    },
    H: {
      t: "long",
      v: -22
    },
    Strt: {
      t: "long",
      v: 100
    },
    Lght: {
      t: "long",
      v: 2
    }
  }
}

function createFadeDefault() {
  return {
    __name: "Fade",
    classID: "fade",
    Opct: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 100
      }
    },
    Md: {
      t: "enum",
      v: {
        blendMode: "Nrml"
      }
    }
  }
}

function createApplyImageDefault() {
  return {
    classID: "null",
    With: {
      t: "Objc",
      v: {
        classID: "Clcl",
        T: {
          t: "obj ",
          v: [{
            t: "Enmr",
            v: {
              classID: "Chnl",
              typeID: "Chnl",
              enum: "RGB"
            }
          }, {
            t: "Enmr",
            v: {
              classID: "Lyr",
              typeID: "Ordn",
              enum: "Mrgd"
            }
          }]
        },
        Invr: {
          t: "bool",
          v: false
        },
        Clcl: {
          t: "enum",
          v: {
            Clcn: "Nrml"
          }
        },
        Opct: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 100
          }
        },
        PrsT: {
          t: "bool",
          v: false
        }
      }
    }
  }
}

function createBlendOptionsDefault() {
  return {
    classID: "blendOptions",
    Opct: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 100
      }
    },
    Md: {
      t: "enum",
      v: {
        blendMode: "Nrml"
      }
    }
  }
}

const filterDefaultFactories = {
  cameraRaw: createCameraRawDefault,
  [CAMERA_RAW_WIRE_CLASS_ID]: createCameraRawDefault,
  "AdNs": createAddNoiseDefault,
  "Bokh": createLensBlurDefault,
  "Clds": createCloudsDefault,
  "ClrH": createColorHalftoneDefault,
  "Crst": createCrystallizeDefault,
  "DfrC": createDifferenceCloudsDefault,
  "Dfs ": createDiffuseDefault,
  "Dspl": createDisplaceDefault,
  "DstS": createDustAndScratchesDefault,
  "Embs": createEmbossDefault,
  "GEfc": createGalleryEffectsDefault,
  "GsnB": createGaussianBlurDefault,
  "HghP": createHighPassDefault,
  "LnCr": createLensCorrectionDefault,
  "LnsF": createLensFlareDefault,
  "LqFy": createLiquifyDefault,
  "Mdn ": createMedianDefault,
  "Mnm ": createMinimumDefault,
  "Msc ": createMosaicDefault,
  "MtnB": createMotionBlurDefault,
  "Mxm ": createMaximumDefault,
  "Mztn": createMezzotintDefault,
  "Ofst": createOffsetDefault,
  "Plr ": createPolarDefault,
  "Pnch": createPinchDefault,
  "Pntl": createPointillizeDefault,
  "RdlB": createRadialBlurDefault,
  "Rple": createRippleDefault,
  "Shr ": createShearDefault,
  "Sphr": createSpherizeDefault,
  "TrcC": createTraceContourDefault,
  "Twrl": createTwirlDefault,
  "UnsM": createUnsharpMaskDefault,
  "Wave": createWaveDefault,
  "Wnd ": createWindDefault,
  "adaptCorrect": createAdaptCorrectDefault,
  "aply": createApplyImageDefault,
  "blendOptions": createBlendOptionsDefault,
  "blnc": createColorBalanceDefault,
  "blwh": createBlackAndWhiteDefault,
  "boxblur": createBoxBlurDefault,
  "brit": createBrightnessContrastDefault,
  "clrL": createColorLookupDefault,
  "curv": createCurvesDefault,
  "expA": createExposureDefault,
  "fade": createFadeDefault,
  "grdm": createGradientMapDefault,
  "hue2": createHueSaturationDefault,
  "levl": createLevelsDefault,
  "lightFilterGradient": createLightFilterGradientDefault,
  "mixr": createChannelMixerDefault,
  "nvrt": createInvertDefault,
  "oilPaint": createOilPaintDefault,
  "phfl": createPhotoFilterDefault,
  "post": createPosterizeDefault,
  "rigidTransform": createRigidTransformDefault,
  "rplc": createReplaceColorDefault,
  "selc": createSelectiveColorDefault,
  "smartSharpen": createSmartSharpenDefault,
  "surfaceBlur": createSurfaceBlurDefault,
  "thrs": createThresholdDefault,
  "vibA": createVibranceDefault
};

FilterDefs.create = function(filterType) {
  const factory = filterDefaultFactories[normalizeCameraRawClassId(filterType)];
  return factory ? factory() : null;
};
FilterDefs.filterPresetSerialize = {
  AdNs: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Nose.v.val;
    presetValues[1] = ["Gsn", "Unfr"].indexOf(filterDescriptor.Dstr.v.Dstr);
    presetValues[2] = filterDescriptor.Mnch.v
  },
  DstS: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Rds.v;
    presetValues[1] = filterDescriptor.Thsh.v
  },
  GsnB: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Rds.v.val
  },
  HghP: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Rds.v.val
  },
  "Mxm ": function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Rds.v.val
  },
  "Mnm ": function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Rds.v.val
  },
  MtnB: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Angl.v;
    presetValues[1] = filterDescriptor.Dstn.v.val
  },
  Ofst: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Hrzn.v;
    presetValues[1] = filterDescriptor.Vrtc.v;
    presetValues[2] = ["Rpt", "Bckg", "Wrp"].indexOf(filterDescriptor.Fl.v.FlMd)
  },
  Pnch: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Amnt.v
  },
  "Plr ": function(filterDescriptor, presetValues) {
    presetValues[0] = ["RctP", "PlrR"].indexOf(filterDescriptor.Cnvr.v.Cnvr)
  },
  Rple: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Amnt.v;
    presetValues[1] = ["Sml", "Mdm", "Lrg"].indexOf(filterDescriptor.RplS.v.RplS)
  },
  Twrl: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Angl.v
  },
  UnsM: function(filterDescriptor, presetValues) {
    presetValues[0] = filterDescriptor.Amnt.v.val;
    presetValues[1] = filterDescriptor.Rds.v.val;
    presetValues[2] = filterDescriptor.Thsh.v
  }
};
FilterDefs.filterPresetDeserialize = {
  AdNs: function(filterDescriptor, presetValues) {
    filterDescriptor.Nose.v.val = presetValues[0];
    filterDescriptor.Dstr.v.Dstr = ["Gsn", "Unfr"][presetValues[1]];
    filterDescriptor.Mnch.v = presetValues[2]
  },
  DstS: function(filterDescriptor, presetValues) {
    filterDescriptor.Rds.v = presetValues[0];
    filterDescriptor.Thsh.v = presetValues[1]
  },
  GsnB: function(filterDescriptor, presetValues) {
    filterDescriptor.Rds.v.val = presetValues[0]
  },
  HghP: function(filterDescriptor, presetValues) {
    filterDescriptor.Rds.v.val = presetValues[0]
  },
  "Mxm ": function(filterDescriptor, presetValues) {
    filterDescriptor.Rds.v.val = presetValues[0]
  },
  "Mnm ": function(filterDescriptor, presetValues) {
    filterDescriptor.Rds.v.val = presetValues[0]
  },
  MtnB: function(filterDescriptor, presetValues) {
    filterDescriptor.Angl.v = typeof presetValues[0] == "number" ? presetValues[0] : presetValues[0].oc;
    filterDescriptor.Dstn.v.val = presetValues[1]
  },
  Ofst: function(filterDescriptor, presetValues) {
    filterDescriptor.Hrzn.v = presetValues[0];
    filterDescriptor.Vrtc.v = presetValues[1];
    filterDescriptor.Fl.v.FlMd = ["Rpt", "Bckg", "Wrp"][presetValues[2]]
  },
  Pnch: function(filterDescriptor, presetValues) {
    filterDescriptor.Amnt.v = presetValues[0]
  },
  "Plr ": function(filterDescriptor, presetValues) {
    filterDescriptor.Cnvr.v.Cnvr = ["RctP", "PlrR"][presetValues[0]]
  },
  Rple: function(filterDescriptor, presetValues) {
    filterDescriptor.Amnt.v = presetValues[0];
    filterDescriptor.RplS.v.RplS = ["Sml", "Mdm", "Lrg"][presetValues[1]]
  },
  Twrl: function(filterDescriptor, presetValues) {
    filterDescriptor.Angl.v = presetValues[0]
  },
  UnsM: function(filterDescriptor, presetValues) {
    filterDescriptor.Amnt.v.val = presetValues[0];
    filterDescriptor.Rds.v.val = presetValues[1];
    filterDescriptor.Thsh.v = presetValues[2]
  }
};
FilterDefs.maxFilterPaddingFromFxList = function(filterFxStyleDesc) {
  const maxPadding = new Point(0, 0);
  if (filterFxStyleDesc.enab.v == false) return maxPadding;
  const fxList = filterFxStyleDesc.filterFXList.v;
  for (let i = 0; i < fxList.length; i++) {
    const fxEntry = fxList[i].v;
    if (fxEntry.enab.v == false) continue;
    const filterClassId = FilterDefs.getFilterClassIdFromFx(fxEntry);
    const padding = FilterDefs.filterPaddingForClassId(filterClassId, fxEntry.Fltr ? fxEntry.Fltr.v : null);
    if (padding.x > maxPadding.x) maxPadding.x = padding.x;
    if (padding.y > maxPadding.y) maxPadding.y = padding.y
  }
  return maxPadding
};
FilterDefs.filterPaddingForClassId = function(filterClassId, filterDescriptor) {
  let padX = 0;
  let padY = 0;
  // In the split-module build, some callsites can pass a partial / null filter descriptor.
  // Normalize to a full descriptor so radius math doesn't crash.
  if (filterDescriptor == null) filterDescriptor = FilterDefs.create(filterClassId);
  if (BLUR_PAD_FILTER_IDS.indexOf(filterClassId) != -1) padX = padY = blurFamilyPadding(filterDescriptor);
  if (filterClassId == "MtnB") padX = padY = motionBlurPadding(filterDescriptor);
  if (FULL_DOCUMENT_PAD_FILTER_IDS.indexOf(filterClassId) != -1) padX = padY = 1e4;
  if (filterClassId == "GEfc") return GalleryFilterDefs.galleryFilterPadding(filterDescriptor);
  return new Point(Math.ceil(padX), Math.ceil(padY));
};
FilterDefs.createEmptyFilterFxStyle = function() {
  return {
    t: "Objc",
    v: {
      classID: "filterFXStyle",
      enab: {
        t: "bool",
        v: true
      },
      validAtPosition: {
        t: "bool",
        v: true
      },
      filterMaskEnable: {
        t: "bool",
        v: true
      },
      filterMaskLinked: {
        t: "bool",
        v: true
      },
      filterMaskExtendWithWhite: {
        t: "bool",
        v: true
      },
      filterFXList: {
        t: "VlLs",
        v: []
      }
    }
  }
};
