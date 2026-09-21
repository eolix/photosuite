import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let VectorPageExporter;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/formats/registry/file-format-registry.js");
  ({ VectorPageExporter } = await import("../../../src/document/formats/vector-page-exporter.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/vector-page-exporter.js", () => {
  it("exports renderDocumentToPdf entry point", () => {
    assert.equal(typeof VectorPageExporter.renderDocumentToPdf, "function");
  });

  it("putImageToPdf sets the CTM from the image size and resets it after", () => {
    const captured = { ctm: null, args: null };
    const pdfWriter = {
      PutImage(state, buffer, width, height) {
        captured.ctm = state.ctm.slice();
        captured.args = [buffer, width, height];
      },
    };
    const pdfState = { ctm: [1, 0, 0, 1, 0, 0] };
    const imageRect = new Rect(0, 0, 10, 20);
    VectorPageExporter.putImageToPdf(pdfState, pdfWriter, "BUF", imageRect, new Matrix2D(), new Matrix2D());
    // scale(10,-20) then translate(0,20) → [10,0,0,-20,0,20], through identity transforms.
    assert.deepEqual(captured.ctm, [10, 0, 0, -20, 0, 20]);
    assert.deepEqual(captured.args, ["BUF", 10, 20]);
    assert.deepEqual(pdfState.ctm, [1, 0, 0, 1, 0, 0]);
  });

  it("colorToRgb normalizes an RGBC descriptor to 0..1 fractions", () => {
    const rgb = VectorPageExporter.colorToRgb({
      classID: "RGBC",
      Rd: { v: 255 },
      Grn: { v: 51 },
      Bl: { v: 0 },
    });
    assert.equal(rgb.length, 3);
    assert.equal(rgb[0], 1);
    assert.equal(rgb[1], 0.2);
    assert.equal(rgb[2], 0);
  });
});
