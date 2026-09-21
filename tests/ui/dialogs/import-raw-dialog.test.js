/**
 * Golden I/O for ImportRawDialog constants.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ImportRawDialog;

before(async () => {
  ({ ImportRawDialog } = await import("../../../src/ui/dialogs/import-raw-dialog.js"));
});

describe("ui/dialogs/import-raw-dialog.js", () => {
  it("supportedBitsPerSample matches goldens", () => {
    assert.deepEqual(ImportRawDialog.supportedBitsPerSample, [8, 16]);
  });
});
