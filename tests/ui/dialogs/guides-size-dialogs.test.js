/**
 * Golden I/O for the pure helpers behind the Add Guides and size dialogs: the
 * guide-position tokenizer and the summary line both size dialogs show above
 * their fields.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let formatPixelSizeSummary;
let tokenizeGuideInputText;

before(async () => {
  ({ formatPixelSizeSummary, tokenizeGuideInputText } = await import(
    "../../../src/ui/dialogs/guides-size-dialogs.js"
  ));
});

describe("ui/dialogs/guides-size-dialogs.js", () => {
  it("tokenizeGuideInputText splits comma-separated guide positions", () => {
    assert.deepEqual(tokenizeGuideInputText("10, 20,30"), ["10", "20", "30"]);
    assert.deepEqual(tokenizeGuideInputText(""), []);
    assert.deepEqual(tokenizeGuideInputText("  100  200 "), ["100", "200"]);
  });

  it("formatPixelSizeSummary reports dimensions and megapixels", () => {
    assert.equal(formatPixelSizeSummary(1920, 1080), "1920 x 1080, 2.1 MPx");
    assert.equal(formatPixelSizeSummary(100, 100), "100 x 100, 0.0 MPx");
    assert.equal(formatPixelSizeSummary(4000, 3000), "4000 x 3000, 12.0 MPx");
  });
});
