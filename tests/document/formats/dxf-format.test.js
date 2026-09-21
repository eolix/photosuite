import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToDXF } from "../../../src/document/formats/dxf-format.js";

describe("document/formats/dxf-format.js", () => {
  it("ToDXF serializes minimal line entity", () => {
    const writer = new ToDXF();
    writer.StartPage();
    writer.Stroke({
      pth: { crds: [0, 0, 10, 10], cmds: ["M", "L"] },
      colr: [0, 0, 0],
      lwidth: 1,
      ctm: [1, 0, 0, 1, 0, 0],
    });
    writer.Done();
    const dxf = new TextDecoder().decode(new Uint8Array(writer.buffer));
    assert.match(dxf, /SECTION/);
    assert.match(dxf, /LINE/);
  });
});
