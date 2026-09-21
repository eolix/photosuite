/**
 * Golden values for filter-registry (defaults, padding, preset I/O).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterDefs;

before(async () => {
  globalThis.alert = () => {};
  ({ FilterDefs } = await import("../../../src/features/filters/filter-registry.js"));
});

describe("features/filters/filter-registry.js", () => {
  it("getFilterClassIdFromFx prefers FourCC for large filter IDs", () => {
    assert.equal(
      FilterDefs.getFilterClassIdFromFx({
        filterID: { v: 0x4c714679 },
        Fltr: { v: { classID: "X" } },
      }),
      "LqFy",
    );
    assert.equal(
      FilterDefs.getFilterClassIdFromFx({
        filterID: { v: 100 },
        Fltr: { v: { classID: "boxblur" } },
      }),
      "boxblur",
    );
  });

  it("create returns default descriptors for representative filters", () => {
    assert.deepEqual(FilterDefs.create("boxblur"), {
      __name: "Box Blur",
      classID: "boxblur",
      Rds: { t: "UntF", v: { type: "#Pxl", val: 15 } },
    });
    assert.deepEqual(FilterDefs.create("GsnB"), {
      __name: "Gaussian Blur",
      classID: "GsnB",
      Rds: { t: "UntF", v: { type: "#Pxl", val: 7.2 } },
    });
    assert.deepEqual(FilterDefs.create("AdNs"), {
      __name: "Add Noise",
      classID: "AdNs",
      Dstr: { t: "enum", v: { Dstr: "Unfr" } },
      Nose: { t: "UntF", v: { type: "#Prc", val: 20 } },
      Mnch: { t: "bool", v: false },
      FlRs: { t: "long", v: 100691320 },
    });
    assert.deepEqual(FilterDefs.create("UnsM"), {
      __name: "Unsharp Mask",
      classID: "UnsM",
      Amnt: { t: "UntF", v: { type: "#Prc", val: 142 } },
      Rds: { t: "UntF", v: { type: "#Pxl", val: 4.5 } },
      Thsh: { t: "long", v: 0 },
    });
    assert.deepEqual(FilterDefs.create("Ofst"), {
      __name: "Offset",
      classID: "Ofst",
      Hrzn: { t: "long", v: 144 },
      Vrtc: { t: "long", v: 278 },
      Fl: { t: "enum", v: { FlMd: "Wrp" } },
    });
    assert.deepEqual(FilterDefs.create("brit"), {
      __name: "Brightness/Contrast",
      classID: "BrgC",
      Brgh: { t: "long", v: 0 },
      Cntr: { t: "long", v: 0 },
      useLegacy: { t: "bool", v: false },
    });
    assert.deepEqual(FilterDefs.create("fade"), {
      __name: "Fade",
      classID: "fade",
      Opct: { t: "UntF", v: { type: "#Prc", val: 100 } },
      Md: { t: "enum", v: { blendMode: "Nrml" } },
    });
    assert.equal(FilterDefs.create("nope"), null);

    const liquify = FilterDefs.create("LqFy");
    assert.equal(liquify.classID, "LqFy");
    assert.equal(liquify.__name, "Liquify");
    assert.equal(liquify.LqMe.v.length, 272);
  });

  it("createEmptyFilterFxStyle and padding match values", () => {
    const empty = FilterDefs.createEmptyFilterFxStyle();
    assert.equal(empty.v.classID, "filterFXStyle");
    assert.equal(empty.v.enab.v, true);
    assert.deepEqual(empty.v.filterFXList.v, []);

    assert.deepEqual(
      { ...FilterDefs.filterPaddingForClassId("boxblur", FilterDefs.create("boxblur")) },
      { x: 39, y: 39 },
    );
    assert.deepEqual(
      { ...FilterDefs.filterPaddingForClassId("GsnB", FilterDefs.create("GsnB")) },
      { x: 19, y: 19 },
    );
    assert.deepEqual({ ...FilterDefs.filterPaddingForClassId("Avrg", null) }, { x: 0, y: 0 });
    assert.deepEqual(
      {
        ...FilterDefs.maxFilterPaddingFromFxList({
          enab: { v: true },
          filterFXList: {
            v: [
              {
                v: {
                  enab: { v: true },
                  filterID: { v: 100 },
                  Fltr: {
                    v: {
                      classID: "GsnB",
                      Rds: { t: "UntF", v: { type: "#Pxl", val: 5 } },
                    },
                  },
                },
              },
              {
                v: {
                  enab: { v: false },
                  filterID: { v: 100 },
                  Fltr: {
                    v: {
                      classID: "boxblur",
                      Rds: { t: "UntF", v: { type: "#Pxl", val: 50 } },
                    },
                  },
                },
              },
            ],
          },
        }),
      },
      { x: 13, y: 13 },
    );
  });

  it("menu tables and preset serialize preserve wire mappings", () => {
    assert.equal(FilterDefs.filterMenuGroups.length, 13);
    // Camera Raw sits between Filter Gallery and Lens Correction, as in Photoshop.
    assert.deepEqual(
      FilterDefs.filterMenuGroups.slice(0, 4).map((group) => group.filterClassId),
      ["GEfc", "cameraRaw", "LnCr", "LqFy"],
    );
    assert.equal(FilterDefs.names.GsnB, "filters.menu.blur.gaussianBlur");
    assert.equal(FilterDefs.filterScriptKeys.GsnB, "gaussianBlur");
    assert.equal(FilterDefs.scriptNameToFourCc.GaussianBlur, "GsnB");
    const presetValues = [];
    FilterDefs.filterPresetSerialize.GsnB(FilterDefs.create("GsnB"), presetValues);
    assert.deepEqual(presetValues, [7.2]);
  });
});
