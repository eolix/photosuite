/**
 * Golden values for action-file (.atn codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ActionParser;
let RenderBuffer;

const SERIALIZED_SAMPLE = [
  0, 0, 0, 16, 0, 0, 0, 7, 0, 77, 0, 121, 0, 32, 0, 83, 0, 101, 0, 116, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0,
  0, 0, 0, 0, 0, 0, 10, 0, 77, 0, 121, 0, 32, 0, 65, 0, 99, 0, 116, 0, 105, 0, 111, 0, 110, 0, 0, 1, 0,
  0, 0, 1, 0, 1, 0, 0, 84, 69, 88, 84, 0, 0, 0, 3, 115, 101, 116, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0,
  0, 1, 0, 0, 0, 0, 0, 0, 110, 117, 108, 108, 0, 0, 0, 0,
];

const SERIALIZED_EMPTY = [0, 0, 0, 16, 0, 0, 0, 2, 0, 69, 0, 0, 0, 0, 0, 0, 0];

function sampleActionSet() {
  return {
    name: "My Set",
    expanded: true,
    children: [
      {
        index: 1,
        shift: false,
        commandKeyEnabled: false,
        color: 0,
        name: "My Action",
        expanded: true,
        children: [
          {
            expanded: false,
            enabled: true,
            dialogOptionsEnabled: false,
            dialogOptions: 0,
            uf: "set",
            eventClassName: "",
            actionDescriptor: { classID: "null" },
          },
        ],
      },
    ],
  };
}

before(async () => {
  ({ ActionParser } = await import("../../../src/features/scripting/action-file.js"));
  ({ RenderBuffer } = await import("../../../src/core/render-buffer.js"));
});

describe("features/scripting/action-file.js", () => {
  it("serialize writes bytes matching the golden bytes", () => {
    const bytes = new Uint8Array(ActionParser.serialize(sampleActionSet()));
    assert.equal(bytes.byteLength, 103);
    assert.deepEqual([...bytes], SERIALIZED_SAMPLE);
    assert.deepEqual(
      [...new Uint8Array(ActionParser.serialize({ name: "E", expanded: false, children: [] }))],
      SERIALIZED_EMPTY,
    );
  });

  it("parse round-trips serialize and preserves tree fields", () => {
    const parsed = ActionParser.parse(ActionParser.serialize(sampleActionSet()));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "My Set");
    assert.equal(parsed[0].expanded, true);
    assert.equal(parsed[0].children.length, 1);
    assert.equal(parsed[0].children[0].name, "My Action");
    assert.equal(parsed[0].children[0].commandKeyEnabled, false);
    const step = parsed[0].children[0].children[0];
    assert.equal(step.uf, "set");
    assert.equal(step.enabled, true);
    assert.equal(step.eventClassName, "");
    assert.equal(step.actionDescriptor.classID, "null");

    // Round-trip: re-serialising the parsed tree reproduces the original bytes.
    assert.deepEqual(
      [...new Uint8Array(ActionParser.serialize(parsed[0]))],
      SERIALIZED_SAMPLE,
    );
  });

  it("length-prefixed string helpers round-trip", () => {
    const buffer = new RenderBuffer();
    ActionParser.writeLengthPrefixedString(buffer, 0, "abcd");
    assert.equal(ActionParser.readLengthPrefixedString(buffer.data, 0), "abcd");
  });
});
