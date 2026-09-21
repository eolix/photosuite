import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let DescriptorCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ DescriptorCodec } = await import("../../../../src/document/formats/psd/descriptor-codec.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

describe("document/formats/psd/descriptor-codec.js", () => {
  it("readOSKey reads a 4-char padded key and a length-prefixed key", () => {
    // len=0 → 4-char padded "Rd  "
    const padded = new Uint8Array([0, 0, 0, 0, ...ascii("Rd  ")]);
    assert.equal(DescriptorCodec.readOSKey(padded, 0), "Rd");
    // len=5 → "warpX"
    const long = new Uint8Array([0, 0, 0, 5, ...ascii("warpX")]);
    assert.equal(DescriptorCodec.readOSKey(long, 0), "warpX");
  });

  it("keySize returns 8 for a padded key, 4+len otherwise", () => {
    assert.equal(DescriptorCodec.keySize(new Uint8Array([0, 0, 0, 0]), 0), 8);
    assert.equal(DescriptorCodec.keySize(new Uint8Array([0, 0, 0, 5]), 0), 9);
  });

  it("readValue decodes a long value node with its byte size", () => {
    const bytes = new Uint8Array([...ascii("long"), 0, 0, 0, 42]);
    const node = DescriptorCodec.readValue(bytes, 0, false, 0);
    assert.equal(node.t, "long");
    assert.equal(node.v, 42);
    assert.equal(node.size, 8);
  });

  it("flattenDescriptor recursively strips type tags (Objc/VlLs/UntF)", () => {
    const desc = {
      classID: "Foo",
      amount: { t: "long", v: 5 },
      angle: { t: "UntF", v: { type: "#Ang", val: 90 } },
      nested: { t: "Objc", v: { classID: "Bar", flag: { t: "bool", v: true } } },
      items: { t: "VlLs", v: [{ t: "long", v: 1 }, { t: "long", v: 2 }] },
    };
    assert.deepEqual(DescriptorCodec.flattenDescriptor(desc), {
      classID: "Foo",
      amount: 5,
      angle: 90,
      nested: { classID: "Bar", flag: true },
      items: [1, 2],
    });
  });
});
