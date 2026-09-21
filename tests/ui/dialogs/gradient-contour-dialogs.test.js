/**
 * Golden I/O for gradient / contour dialog helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let GradientEditorDialog;

before(async () => {
  ({ GradientEditorDialog } = await import("../../../src/ui/dialogs/gradient-contour-dialogs.js"));
});

describe("ui/dialogs/gradient-contour-dialogs.js", () => {
  it("compareGradientStopsByLocation sorts by Lctn wire key", () => {
    const cmp = GradientEditorDialog.prototype.compareGradientStopsByLocation;
    assert.equal(cmp({ v: { Lctn: { v: 10 } } }, { v: { Lctn: { v: 20 } } }), -10);
    assert.equal(cmp({ v: { Lctn: { v: 20 } } }, { v: { Lctn: { v: 10 } } }), 10);
    assert.equal(cmp({ v: { Lctn: { v: 5 } } }, { v: { Lctn: { v: 5 } } }), 0);
  });
});
