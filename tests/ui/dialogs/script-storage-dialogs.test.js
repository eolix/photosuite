/**
 * Golden I/O for script demo snippets and storage sort helper exposure.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let SCRIPT_DEMO_SNIPPETS;

before(async () => {
  ({ SCRIPT_DEMO_SNIPPETS } = await import("../../../src/ui/dialogs/script-storage-dialogs.js"));
});

describe("ui/dialogs/script-storage-dialogs.js", () => {
  it("SCRIPT_DEMO_SNIPPETS matches demo table", () => {
    assert.equal(SCRIPT_DEMO_SNIPPETS.length, 3);
    assert.equal(SCRIPT_DEMO_SNIPPETS[0].label, "dialogs.script.demoHello");
    assert.match(SCRIPT_DEMO_SNIPPETS[0].sourceText, /Hello PhotoSuite/);
    assert.equal(SCRIPT_DEMO_SNIPPETS[1].label, "dialogs.script.demoProcessLayers");
    assert.equal(SCRIPT_DEMO_SNIPPETS[2].label, "dialogs.script.demoCloneLayers");
  });
});
