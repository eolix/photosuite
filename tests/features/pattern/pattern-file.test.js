/**
 * Golden values for pattern-file (.pat codec).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";

installBrowserGlobals();

let PatternFile;
let Rect;

const SERIALIZED_EMPTY = [56, 66, 80, 84, 0, 1, 0, 0, 0, 0];

const SERIALIZED_RENAMED_PATTERN = JSON.parse(
  "[56,66,80,84,0,1,0,0,0,1,0,0,0,1,0,0,0,3,0,1,0,1,0,0,0,8,0,82,0,101,0,110,0,97,0,109,0,101,0,100,0,0,3,97,98,99,0,0,0,3,0,0,0,248,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0,24,0,0,0,1,0,0,0,27,0,0,0,8,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,8,1,0,2,0,10,0,0,0,1,0,0,0,27,0,0,0,8,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,8,1,0,2,0,20,0,0,0,1,0,0,0,27,0,0,0,8,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,8,1,0,2,0,30,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,27,0,0,0,8,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,8,1,0,2,0,255]",
);

function samplePattern(name) {
  const rect = new Rect(0, 0, 1, 1);
  const pixels = allocBuffer(4);
  pixels[0] = 10;
  pixels[1] = 20;
  pixels[2] = 30;
  pixels[3] = 255;
  return {
    name,
    id: "abc",
    pixelData: [pixels, rect],
  };
}

before(async () => {
  ({ PatternFile } = await import("../../../src/features/pattern/pattern-file.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  await import("../../../src/engine/layer-system.js");
});

describe("features/pattern/pattern-file.js", () => {
  it("setName updates pattern.name", () => {
    const pattern = { name: "Tile", id: "abc" };
    PatternFile.setName(pattern, "Renamed");
    assert.equal(pattern.name, "Renamed");
  });

  it("serialize writes 8BPT bytes matching the golden bytes", () => {
    const pattern = samplePattern("Tile");
    PatternFile.setName(pattern, "Renamed");
    const bytes = new Uint8Array(PatternFile.serialize([pattern]));
    assert.equal(bytes.byteLength, 302);
    assert.deepEqual([...bytes], SERIALIZED_RENAMED_PATTERN);
    assert.deepEqual([...new Uint8Array(PatternFile.serialize([]))], SERIALIZED_EMPTY);
  });

  it("parse round-trips serialize", () => {
    const pattern = samplePattern("Tile");
    PatternFile.setName(pattern, "Renamed");
    const parsed = PatternFile.parse(PatternFile.serialize([pattern]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "Renamed");
    assert.equal(parsed[0].id, "abc");
    assert.equal(parsed[0].pixelData[1].width, 1);
    assert.equal(parsed[0].pixelData[1].height, 1);
    assert.deepEqual([...parsed[0].pixelData[0].slice(0, 4)], [10, 20, 30, 255]);
  });
});
