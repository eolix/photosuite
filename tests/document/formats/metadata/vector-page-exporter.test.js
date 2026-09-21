import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let VectorPageExporter;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ VectorPageExporter } = await import("../../../../src/document/formats/vector-page-exporter.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/vector-page-exporter.js", () => {
  it("colorToRgb normalizes RGBC channels to 0-1", () => {
    const rgb = VectorPageExporter.colorToRgb({
      classID: "RGBC",
      Rd: { v: 255 },
      Grn: { v: 128 },
      Bl: { v: 0 },
    });
    assert.deepEqual(rgb, [1, 128 / 255, 0]);
  });
});
