import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let FigmaLoader;
let restoreBrowserGlobals;

const stubDoc = { registerPattern() {} };
const emptyLoadContext = { patternCacheByBlobId: {}, zipEntries: null };
const identityMatrix = new Matrix2D(1, 0, 0, 1, 0, 0);
const layerRect = new Rect(0, 0, 100, 50);

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/formats/registry/file-format-registry.js");
  ({ FigmaLoader } = await import("../../../src/document/formats/fig-format.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/fig-format.js", () => {
  it("exports parse entry point", () => {
    assert.equal(typeof FigmaLoader.parse, "function");
  });

  it("guidEquals matches session and local ids", () => {
    const guid = { sessionID: 1, localID: 2 };
    assert.equal(FigmaLoader.guidEquals(guid, guid), true);
    assert.equal(
      FigmaLoader.guidEquals(guid, { sessionID: 1, localID: 3 }),
      false,
    );
  });

  it("guidLookup resolves guid key map", () => {
    const guid = { sessionID: 1, localID: 2 };
    const table = { "1,2": { name: "x" } };
    assert.equal(FigmaLoader.guidLookup(table, guid).name, "x");
    assert.equal(FigmaLoader.guidLookup(table, { sessionID: 9, localID: 9 }), undefined);
  });

  it("compareLayerOrder sorts by parentIndex.position", () => {
    assert.equal(
      FigmaLoader.compareLayerOrder(
        { parentIndex: { position: 2 } },
        { parentIndex: { position: 1 } },
      ),
      1,
    );
    assert.equal(
      FigmaLoader.compareLayerOrder(
        { parentIndex: { position: 0 } },
        { parentIndex: { position: 1 } },
      ),
      -1,
    );
  });

  it("figmaToBlendMode maps extended Figma blend modes", () => {
    assert.equal(FigmaLoader.figmaToBlendMode("NORMAL"), "norm");
    assert.equal(FigmaLoader.figmaToBlendMode("MULTIPLY"), "mul ");
    assert.equal(FigmaLoader.figmaToBlendMode("LIGHTEN"), "lite");
    assert.equal(FigmaLoader.figmaToBlendMode("SCREEN"), "scrn");
    assert.equal(FigmaLoader.figmaToBlendMode("COLOR_DODGE"), "div ");
    assert.equal(FigmaLoader.figmaToBlendMode("LINEAR_DODGE"), "lddg");
    assert.equal(FigmaLoader.figmaToBlendMode("OVERLAY"), "over");
    assert.equal(FigmaLoader.figmaToBlendMode("DIFFERENCE"), "diff");
    assert.throws(
      () => FigmaLoader.figmaToBlendMode("UNKNOWN"),
      /fig: unsupported blend mode/,
    );
  });

  it("figmaTransformToMatrix builds Matrix2D, zeroes denormals, null → identity", () => {
    const matrix = FigmaLoader.figmaTransformToMatrix({
      m00: 2,
      m10: 0,
      m01: 0,
      m11: 3,
      m02: 10,
      m12: 20,
    });
    assert.deepEqual(
      [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty],
      [2, 0, 0, 3, 10, 20],
    );
    const identity = FigmaLoader.figmaTransformToMatrix(null);
    assert.deepEqual(
      [identity.a, identity.b, identity.c, identity.d, identity.tx, identity.ty],
      [1, 0, 0, 1, 0, 0],
    );
    const denormal = FigmaLoader.figmaTransformToMatrix({
      m00: 1, m10: 1e-30, m01: -1e-25, m11: 1, m02: 0, m12: 0,
    });
    assert.equal(denormal.b, 0);
    assert.equal(denormal.c, 0);
  });

  it("buildShapeGeometry builds rectangle path records", () => {
    const vectorMask = { pathRecords: null };
    FigmaLoader.buildShapeGeometry(
      { type: "RECTANGLE", size: { x: 40, y: 20 }, cornerRadius: 0 },
      [],
      vectorMask,
    );
    assert.ok(Array.isArray(vectorMask.pathRecords));
    assert.ok(vectorMask.pathRecords.length > 2);
  });

  it("figmaColorToDesc wraps RGB descriptor", () => {
    const desc = FigmaLoader.figmaColorToDesc({ r: 1, g: 0.5, b: 0, a: 1 });
    assert.equal(desc.t, "Objc");
    assert.equal(desc.v.classID, "RGBC");
  });

  it("normalizeFills uses opacity, drops invisible fills, promotes opaque image fills", () => {
    const fills = [
      { type: "SOLID", visible: false, opacity: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
      { type: "IMAGE", visible: true, opacity: 1, image: { dataBlob: 0 } },
    ];
    const normalized = FigmaLoader.normalizeFills(fills);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].type, "IMAGE");
  });

  it("normalizeFills promotes imageThumbnail when image blob missing", () => {
    const fills = [{
      type: "IMAGE",
      visible: true,
      opacity: 0.5,
      image: { dataBlob: null },
      imageThumbnail: { dataBlob: 7 },
    }];
    const normalized = FigmaLoader.normalizeFills(fills);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].image.dataBlob, 7);
  });

  it("fillToDescriptor maps solid paint to SoCo with scaled opacity", () => {
    const [kind, descriptor] = FigmaLoader.fillToDescriptor(
      { size: { x: 100, y: 50 } },
      { type: "SOLID", opacity: 0.8, color: { r: 1, g: 0, b: 0, a: 1 } },
      identityMatrix,
      layerRect,
      [],
      stubDoc,
      emptyLoadContext,
    );
    assert.equal(kind, "SoCo");
    assert.equal(descriptor.Opct.v.val, 80);
  });

  it("fillToDescriptor returns None for near-zero opacity", () => {
    const [kind] = FigmaLoader.fillToDescriptor(
      { size: { x: 1, y: 1 } },
      { type: "SOLID", opacity: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      identityMatrix,
      layerRect,
      [],
      stubDoc,
      emptyLoadContext,
    );
    assert.equal(kind, "None");
  });

  it("fillToDescriptor returns None for missing paint", () => {
    const [kind] = FigmaLoader.fillToDescriptor(
      { size: { x: 1, y: 1 } },
      null,
      identityMatrix,
      layerRect,
      [],
      stubDoc,
      emptyLoadContext,
    );
    assert.equal(kind, "None");
  });

  it("imageHashFromFill uses dataBlob or 20-byte hash hex", () => {
    assert.equal(
      FigmaLoader.imageHashFromFill({ image: { dataBlob: "abc" } }),
      "abc",
    );
    const hashBytes = [];
    for (let i = 0; i < 20; i++) hashBytes.push(0x0a);
    assert.equal(
      FigmaLoader.imageHashFromFill({ image: { hash: hashBytes } }),
      "0a".repeat(20),
    );
  });

  it("fillToDescriptor maps IMAGE paint to PtFl pattern descriptor", () => {
    const patternCache = {};
    const loadContext = { patternCacheByBlobId: patternCache, zipEntries: null };
    const blobs = [{
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      decodedRaster: {
        data: new Uint8Array(16),
        rect: new Rect(0, 0, 2, 2),
      },
    }];
    const [kind, descriptor] = FigmaLoader.fillToDescriptor(
      { size: { x: 100, y: 50 } },
      {
        type: "IMAGE",
        opacity: 1,
        imageScaleMode: "FILL",
        transform: { m00: 1, m10: 0, m01: 0, m11: 1, m02: 0, m12: 0 },
        image: { dataBlob: 0 },
      },
      identityMatrix,
      layerRect,
      blobs,
      stubDoc,
      loadContext,
    );
    assert.equal(kind, "PtFl");
    assert.equal(descriptor.Angl.v.type, "#Ang");
    assert.equal(typeof descriptor.Angl.v.val, "number");
  });
});
