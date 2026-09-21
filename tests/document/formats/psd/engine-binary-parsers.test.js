import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let EngineDataParser, BinaryTreeParser;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ EngineDataParser, BinaryTreeParser } =
    await import("../../../../src/document/formats/psd/engine-binary-parsers.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("document/formats/psd/engine-binary-parsers.js", () => {
  it("EngineDataParser.isPrimitive classifies scalars vs containers", () => {
    assert.equal(EngineDataParser.isPrimitive("x"), true);
    assert.equal(EngineDataParser.isPrimitive(5), true);
    assert.equal(EngineDataParser.isPrimitive(true), true);
    assert.equal(EngineDataParser.isPrimitive({}), false);
    assert.equal(EngineDataParser.isPrimitive([]), false);
  });

  it("EngineDataParser.parse reads a small << /Key value >> dict", () => {
    const dict = EngineDataParser.parse(bytes("<<\n/Foo 5\n/Flag true\n>>"));
    assert.equal(dict.Foo, 5);
    assert.equal(dict.Flag, true);
  });

  it("EngineDataParser.parse reads a nested dict and numeric array", () => {
    const dict = EngineDataParser.parse(bytes("<<\n/Arr [ 1 2 3 ]\n/Sub <<\n/N 7\n>>\n>>"));
    assert.deepEqual(dict.Arr, [1, 2, 3]);
    assert.equal(dict.Sub.N, 7);
  });

  it("BinaryTreeParser.isWhitespace matches tab/newline/space only", () => {
    assert.equal(BinaryTreeParser.isWhitespace(9), true);
    assert.equal(BinaryTreeParser.isWhitespace(10), true);
    assert.equal(BinaryTreeParser.isWhitespace(32), true);
    assert.equal(BinaryTreeParser.isWhitespace(65), false);
  });

  it("BinaryTreeParser.formatFloat renders integers and fractions", () => {
    assert.equal(BinaryTreeParser.formatFloat(2), "2.0");
    assert.equal(BinaryTreeParser.formatFloat(0.5), ".50000");
    assert.equal(BinaryTreeParser.formatFloat(-0.5), "-.50000");
    assert.equal(BinaryTreeParser.formatFloat(1.25), "1.25000");
  });
});
