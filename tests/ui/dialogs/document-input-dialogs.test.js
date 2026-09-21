/**
 * Golden I/O for DocumentWindowDialog bound helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let dialogOriginFromBounds;
let dialogFormSizeStyle;

before(async () => {
  ({ dialogOriginFromBounds, dialogFormSizeStyle } = await import(
    "../../../src/ui/dialogs/document-input-dialogs.js"
  ));
});

describe("ui/dialogs/document-input-dialogs.js", () => {
  it("dialogOriginFromBounds insets y by title-bar chrome", () => {
    const origin = dialogOriginFromBounds([10, 50, 210, 150]);
    assert.equal(origin.x, 10);
    assert.equal(origin.y, 17);
  });

  it("dialogFormSizeStyle matches width/height CSS", () => {
    assert.equal(dialogFormSizeStyle([10, 50, 210, 150]), "width:200px; height:100px");
  });
});
