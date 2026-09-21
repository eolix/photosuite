import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let CdrLoader;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const mod = await import("../../../src/document/formats/cdr-format.js");
  CdrLoader = mod.CdrLoader;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/cdr-format.js", () => {
  it("cdrVersionFromAsciiByte maps header version bytes", () => {
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(32), 300);
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(0), 0);
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(49), 100);
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(53), 500);
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(54), 600);
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(65), 1000);
    assert.equal(CdrLoader.cdrVersionFromAsciiByte(70), 1500);
  });

  it("findRiffChild matches tag or listType", () => {
    const riffNode = {
      sub: [{ tag: "filt" }, { listType: "cmpr", tag: "LIST" }, { tag: "otlt" }],
    };
    assert.equal(CdrLoader.findRiffChild(riffNode, "filt").tag, "filt");
    assert.equal(CdrLoader.findRiffChild(riffNode, "cmpr").listType, "cmpr");
    assert.equal(CdrLoader.findRiffChild(riffNode, "missing"), null);
  });

  it("readUint8AtCursor advances parse cursor", () => {
    const parseState = { data: new Uint8Array([10, 20, 30]), n: 1, cdrVersion: 500 };
    assert.equal(CdrLoader.readUint8AtCursor(parseState), 20);
    assert.equal(parseState.n, 2);
  });

});
