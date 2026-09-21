/**
 * Golden values for Photoshop .tpl tool-preset envelope.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolPresetParser;

before(async () => {
  ({ ToolPresetParser } = await import("../../../src/features/tool-preset/tool-preset-file.js"));
});

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EMPTY_TPL_HEX = "384254500000000300000001";
const NAMED_TPL_HEX =
  "3842545000000003000000013842494d747074700000002a000000010000000600420072007500730068000000000010000000010000000000006e756c6c000000000000";

describe("features/tool-preset/tool-preset-file.js", () => {
  it("serialize of empty stores writes the 8BTP header only", () => {
    const buffer = ToolPresetParser.serialize({
      samples: [],
      patterns: [],
      list: [],
    });
    assert.equal(bufferToHex(buffer), EMPTY_TPL_HEX);
  });

  it("parse of header-only .tpl yields empty resource lists", () => {
    assert.deepEqual(ToolPresetParser.parse(hexToBuffer(EMPTY_TPL_HEX)), {
      samples: [],
      patterns: [],
      list: [],
      shapes: [],
      layerStyles: [],
    });
  });

  it("serialize/parse round-trips a named tptp list entry", () => {
    const buffer = ToolPresetParser.serialize({
      samples: [],
      patterns: [],
      list: [["Brush", { classID: "null" }]],
    });
    assert.equal(bufferToHex(buffer), NAMED_TPL_HEX);
    assert.deepEqual(ToolPresetParser.parse(hexToBuffer(NAMED_TPL_HEX)), {
      samples: [],
      patterns: [],
      list: [["Brush", { classID: "null" }]],
      shapes: [],
      layerStyles: [],
    });
  });

  it("setName updates the list-entry label", () => {
    const entry = ["Old", {}];
    ToolPresetParser.setName(entry, "New");
    assert.deepEqual(entry, ["New", {}]);
  });
});
