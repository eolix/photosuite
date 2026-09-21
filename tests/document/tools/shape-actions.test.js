/**
 * The "make contentLayer" descriptor every shape-creating gesture ends in.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let defaultShapeDescriptor;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ defaultShapeDescriptor } = await import("../../../src/document/tools/shape-actions.js"));
});

describe("document/tools/shape-actions.js", () => {
  // Mk / contentLayer is the wire shape Photoshop replays a shape layer from;
  // Type starts empty and the fill kind fills it in.
  it("defaultShapeDescriptor matches the make/contentLayer skeleton", () => {
    const descriptor = defaultShapeDescriptor();
    assert.equal(descriptor.classID, "Mk");
    assert.equal(descriptor.null.t, "obj ");
    assert.equal(descriptor.null.v[0].v.classID, "contentLayer");
    assert.equal(descriptor.Usng.v.classID, "contentLayer");
    assert.deepEqual(descriptor.Usng.v.Type.v, {});
  });

  // Each call builds a fresh descriptor: callers fill in Shp and strokeStyle,
  // so a shared object would leak one shape's geometry into the next.
  it("defaultShapeDescriptor returns a fresh descriptor each time", () => {
    assert.notEqual(defaultShapeDescriptor(), defaultShapeDescriptor());
  });
});
