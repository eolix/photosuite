/**
 * Golden I/O for FillDialog wire keys.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FILL_KIND_WIRE_KEYS;

before(async () => {
  ({ FILL_KIND_WIRE_KEYS } = await import("../../../src/ui/dialogs/fill-stroke-dialogs.js"));
});

describe("ui/dialogs/fill-stroke-dialogs.js", () => {
  it("FILL_KIND_WIRE_KEYS matches fill kind order", () => {
    assert.deepEqual(FILL_KIND_WIRE_KEYS, [
      "FrgC",
      "BckC",
      "Clr",
      "Blck",
      "Gry",
      "Wht",
      "contentAware",
    ]);
  });
});
