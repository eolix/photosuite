import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let parseDataUrlToBytes;
let collectArtboardLayerIndices;
let listEncodableFormats;
let listSaveFormats;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  ({ parseDataUrlToBytes, collectArtboardLayerIndices, listEncodableFormats, listSaveFormats } = await import(
    "../../../../src/document/formats/registry/registry-api.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/registry/registry-api.js", () => {
  it("parseDataUrlToBytes decodes a base64 data URL payload", () => {
    const bytes = parseDataUrlToBytes("data:text/plain;base64,QUJD");
    assert.deepEqual([...bytes], [65, 66, 67]);
  });

  it("collectArtboardLayerIndices finds _a_ layers", () => {
    const doc = {
      layers: [
        { getName: () => "Background", isVisible: () => true },
        { getName: () => "_a_frame1", isVisible: () => false },
        { getName: () => "_a_frame2", isVisible: () => true },
      ],
    };
    const [indices, visibility] = collectArtboardLayerIndices(doc);
    assert.deepEqual(indices, [1, 2]);
    assert.deepEqual(visibility, [false, true]);
  });

  it("the primary export group offers PNG", () => {
    assert.equal(listEncodableFormats(0).includes("PNG"), true);
  });

  // Save As can write the document itself; Export As only renders it.
  it("listSaveFormats adds PSD and PSB to the export formats", () => {
    const saveFormats = listSaveFormats();
    assert.equal(saveFormats.includes("PSD"), true);
    assert.equal(saveFormats.includes("PSB"), true);
    assert.equal(listEncodableFormats().includes("PSD"), false);
    assert.deepEqual(saveFormats, saveFormats.slice().sort());
  });

  // The list is what the export dropdowns show, so its order is the UI order.
  it("listEncodableFormats is alphabetical", () => {
    const formats = listEncodableFormats();
    assert.deepEqual(formats, formats.slice().sort());
    assert.deepEqual(listEncodableFormats(0), listEncodableFormats(0).slice().sort());
  });
});
