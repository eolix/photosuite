/**
 * Golden values for action-desc helpers (refs, locale keys, layer index resolve).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ActionDescUtil;

before(async () => {
  await import("../../../src/features/filters/filter-registry.js");
  await import("../../../src/features/filters/gallery/gallery-filter-defs.js");
  ({ ActionDescUtil } = await import("../../../src/features/scripting/action-desc.js"));
});

describe("features/scripting/action-desc.js", () => {
  it("buildTargetRef builds class or Ordn/Trgt enum refs", () => {
    assert.deepEqual(ActionDescUtil.buildTargetRef("Lyr", false), {
      t: "obj ",
      v: [{ t: "Clss", v: { classID: "Lyr" } }],
    });
    assert.deepEqual(ActionDescUtil.buildTargetRef("Lyr", true), {
      t: "obj ",
      v: [
        {
          t: "Enmr",
          v: { classID: "Lyr", typeID: "Ordn", enum: "Trgt" },
        },
      ],
    });
  });

  it("buildSetLayerPropertyAction wraps a set-Lyr descriptor", () => {
    assert.deepEqual(
      ActionDescUtil.buildSetLayerPropertyAction("Nm", { t: "TEXT", v: "X" }),
      {
        uf: "set",
        actionDescriptor: {
          classID: "null",
          null: ActionDescUtil.buildTargetRef("Lyr", true),
          T: {
            t: "Objc",
            v: { classID: "Lyr", Nm: { t: "TEXT", v: "X" } },
          },
        },
      },
    );
  });

  it("getActionStepLocaleKey maps verbs and make/select targets", () => {
    assert.equal(ActionDescUtil.getActionStepLocaleKey({ uf: "cut" }), "clipboard.cut");
    assert.equal(ActionDescUtil.getActionStepLocaleKey({ uf: "feather" }), "select.feather");
    assert.equal(
      ActionDescUtil.getActionStepLocaleKey({
        uf: "make",
        actionDescriptor: {
          null: {
            v: [{ t: "Enmr", v: { classID: "AdjL", typeID: "Ordn", enum: "Trgt" } }],
          },
        },
      }),
      "layer.newAdjustmentLayer",
    );
    assert.equal(
      ActionDescUtil.getActionStepLocaleKey({
        uf: "select",
        actionDescriptor: {
          null: {
            v: [{ t: "name", v: { classID: "Lyr", val: "Background" } }],
          },
        },
      }),
      'Select Layer "Background"',
    );
    assert.equal(ActionDescUtil.getActionStepLocaleKey({ uf: "purge" }), "Purge");
  });

  it("resolveLayerIndexFromRef resolves name and Ordn enums", () => {
    const doc = {
      layers: [{ getName: () => "A" }, { getName: () => "B" }],
      selectedLayerIndices: [1],
    };
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "name", v: { val: "B" } }),
      1,
    );
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "Enmr", v: { enum: "Trgt" } }),
      1,
    );
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "Enmr", v: { enum: "Bckw" } }),
      0,
    );
    assert.equal(
      ActionDescUtil.resolveLayerIndexFromRef(doc, { t: "prop", v: { keyID: "Bckg" } }),
      0,
    );
  });
});
