import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let SketchLoader;
let getSketchClassName;
let computeSketchImportScale;
let readRect;
let parseBracketedPoint;
let sketchColorToRgbDesc;
let writeSketchColorToRgba;
let readRgbaToSketchColor;
let buildLayerTransformMatrix;
let SKETCH_BLEND_MODE_NAMES;
let sketchContextOpacity;
let Matrix2D;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const matrixMod = await import("../../../src/core/math/matrix2d.js");
  Matrix2D = matrixMod.Matrix2D;
  const mod = await import("../../../src/document/formats/sketch-format.js");
  SketchLoader = mod.SketchLoader;
  getSketchClassName = mod.getSketchClassName;
  computeSketchImportScale = mod.computeSketchImportScale;
  readRect = mod.readRect;
  parseBracketedPoint = mod.parseBracketedPoint;
  sketchColorToRgbDesc = mod.sketchColorToRgbDesc;
  writeSketchColorToRgba = mod.writeSketchColorToRgba;
  readRgbaToSketchColor = mod.readRgbaToSketchColor;
  buildLayerTransformMatrix = mod.buildLayerTransformMatrix;
  SKETCH_BLEND_MODE_NAMES = mod.SKETCH_BLEND_MODE_NAMES;
  sketchContextOpacity = mod.sketchContextOpacity;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/sketch-format.js", () => {

  it("getSketchClassName reads _class or $class", () => {
    assert.equal(getSketchClassName({ _class: "rectangle" }), "rectangle");
    assert.equal(getSketchClassName({ $class: "group" }), "group");
  });

  it("getSketchClassName promotes _isArtb groups to artboard", () => {
    assert.equal(getSketchClassName({ _class: "group", _isArtb: true }), "artboard");
  });

  it("readRect maps Sketch frame JSON to Rect", () => {
    const rect = readRect({ x: 10, y: 20, width: 30, height: 40 });
    assert.equal(rect.x, 10);
    assert.equal(rect.y, 20);
    assert.equal(rect.width, 30);
    assert.equal(rect.height, 40);
  });

  it("parseBracketedPoint parses Sketch point strings", () => {
    const point = parseBracketedPoint("{12.5,7.25}");
    assert.equal(point.x, 12.5);
    assert.equal(point.y, 7.25);
  });

  it("sketchColorToRgbDesc packs Sketch RGBA into PSD RGB desc", () => {
    const desc = sketchColorToRgbDesc({ red: 1, green: 0.5, blue: 0.25 });
    assert.equal(desc.Rd.v, 255);
    assert.equal(desc.Grn.v, 127.5);
    assert.equal(desc.Bl.v, 63.75);
  });

  it("writeSketchColorToRgba / readRgbaToSketchColor round-trip", () => {
    const rgba = new Float32Array(4);
    writeSketchColorToRgba({ red: 0.2, green: 0.4, blue: 0.6, alpha: 0.8 }, rgba);
    assert.deepEqual(Array.from(rgba), [51, 102, 153, 204]);
    const color = { red: 0, green: 0, blue: 0, alpha: 0 };
    readRgbaToSketchColor(rgba, color);
    assert.equal(color.red, 0.2);
    assert.equal(color.green, 0.4);
    assert.equal(color.blue, 0.6);
    assert.equal(color.alpha, 0.8);
  });

  it("buildLayerTransformMatrix returns a scaled matrix for framed layers", () => {
    const matrix = buildLayerTransformMatrix(
      {
        frame: { x: 10, y: 20, width: 100, height: 50 },
        rotation: 0,
        isFlippedHorizontal: false,
        isFlippedVertical: false,
      },
      new Matrix2D(2, 0, 0, 2, 0, 0),
    );
    assert.equal(matrix.getScale(), 2);
    const center = matrix.transformPoint({ x: 60, y: 45 });
    assert.ok(Number.isFinite(center.x) && Number.isFinite(center.y));
  });

  it("SKETCH_BLEND_MODE_NAMES exposes Sketch blend index table", () => {
    assert.equal(SKETCH_BLEND_MODE_NAMES[0], "Nrml");
    assert.equal(SKETCH_BLEND_MODE_NAMES.length, 18);
  });

  it("computeSketchImportScale returns a positive integer scale", () => {
    const scale = computeSketchImportScale({ width: 100, height: 100, x: 0, y: 0, area() { return 10000; } }, 8192 * 8192);
    assert.equal(scale, 1);
  });

  it("sketchContextOpacity reads Sketch contextSettings.opacity", () => {
    assert.equal(sketchContextOpacity({ opacity: 0.5 }), 0.5);
    assert.equal(sketchContextOpacity(null), 1);
  });

  it("SketchLoader re-exports sketchBlendModeNames alias", () => {
    assert.equal(SketchLoader.sketchBlendModeNames, SKETCH_BLEND_MODE_NAMES);
  });
});
