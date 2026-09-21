import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let XCFParser;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  if (typeof globalThis.alert !== "function") globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ XCFParser } = await import("../../../src/document/formats/xcf-format.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/xcf-format.js", () => {
  it("exports parse entry point", () => {
    assert.equal(typeof XCFParser.parse, "function");
  });

  it("parseSExprTokens tokenizes atoms, strings, and nested lists", () => {
    const source = '(text "hi there" (color 1 0 0))';
    const tokens = [];
    XCFParser.parseSExprTokens(source, 1, tokens);
    assert.deepEqual(tokens, [
      "text",
      "hi there",
      ["color", "1", "0", "0"],
    ]);
  });

  it("parseTextParasite folds an s-expression into a bindings object", () => {
    const source = '(text "Hello") (font "Sans") (font-size "24")';
    const bytes = new TextEncoder().encode(source + "\0");
    const bindings = XCFParser.parseTextParasite(bytes);
    assert.equal(bindings.text, "Hello");
    assert.equal(bindings.font, "Sans");
    assert.equal(bindings["font-size"], "24");
  });

  it("channelCountForBitDepth maps XCF depth codes to sample channels", () => {
    assert.equal(XCFParser.channelCountForBitDepth(100), 1);
    assert.equal(XCFParser.channelCountForBitDepth(250), 2);
    assert.equal(XCFParser.channelCountForBitDepth(350), 4);
    assert.equal(XCFParser.channelCountForBitDepth(750), 8);
    assert.throws(() => XCFParser.channelCountForBitDepth(999), /unsupported bit depth/);
  });

  it("resolveGimpFontName splits a trailing style suffix with a dash", () => {
    assert.equal(XCFParser.resolveGimpFontName("Sans Bold"), "Sans-Bold");
    assert.equal(XCFParser.resolveGimpFontName("Arial"), "Arial");
  });
});
