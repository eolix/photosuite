/**
 * Golden values for brush-stroke (stamp / softness / stroke math).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let BrushStroke;
let BrushPresetUtil;
let Rect;
let Matrix2D;

before(async () => {
  globalThis.alert = () => {};
  ({ BrushStroke } = await import("../../../src/features/brush/brush-stroke.js"));
  ({ BrushPresetUtil } = await import("../../../src/features/brush/brush-presets.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ Matrix2D } = await import("../../../src/core/math/matrix2d.js"));
  BrushStroke.smoothnessCache = [];
  BrushStroke.stampCache = [];
});

describe("features/brush/brush-stroke.js", () => {
  it("colorIntToRgb / hashRandSeed / gaussian / softness match", () => {
    assert.deepEqual(BrushStroke.colorIntToRgb(0x00aabbcc), {
      h: 0.6666666666666666,
      l: 0.7333333333333333,
      O: 0.8,
    });
    assert.deepEqual(
      [1, 2, 3, 100, 999].map((s) => BrushStroke.hashRandSeed(s)),
      [
        0.5709932786818313, 0.5281594710445089, 0.181392561280284, 0.5551191899251455,
        0.1414979780613171,
      ],
    );
    assert.deepEqual(
      [0, 0.5, 1, 2].map((x) => BrushStroke.gaussianFalloff(x)),
      [0.9973557010035817, 0.5671673174220317, 0.10430246314084657, 0.00011929659135301258],
    );
    assert.deepEqual(
      [
        [0, 0.5],
        [0.5, 0.5],
        [1, 0.5],
        [0.2, 0.1],
      ].map(([r, s]) => BrushStroke.brushSoftness(r, s)),
      [1, 0.9973557010035817, 0.1563305626040556, 0.9707754627898645],
    );
  });

  it("buildSmoothnessTable / cubicBezierBounds / subpixel helpers", () => {
    BrushStroke.smoothnessCache = [];
    const table = BrushStroke.buildSmoothnessTable(0.5);
    assert.equal(table[1], 1762);
    assert.equal(table[2], 8000);
    assert.deepEqual(
      [0, 100, 1000, 4000, 7999].map((i) => table[0][i]),
      [1, 1, 1, 0.000005128384497033054, 8.079516679105262e-42],
    );
    const bez = BrushStroke.cubicBezierBounds(0, 0, 10, 0, 20, 10);
    assert.equal(bez.x, 3.636619309193636);
    assert.equal(bez.y, 1.818309654596818);
    const sub = BrushStroke.subpixelOffset(1.25, 3.75);
    assert.equal(sub.x, 0.25);
    assert.equal(sub.y, 0.75);
    assert.equal(BrushStroke.subpixelDist({ x: 0.2, y: 0.3 }, { x: 0.9, y: 0.1 }), 0.36055512754639896);
    assert.equal(
      BrushStroke.matricesSimilar(new Matrix2D(1, 0, 0, 1, 0.1, 0.2), new Matrix2D(1, 0, 0, 1, 0.15, 0.22)),
      true,
    );
  });

  it("buildBrushShape computed tip goldens", () => {
    const brush = BrushPresetUtil.getDefaultBrushDescriptor();
    const shape = BrushStroke.buildBrushShape(brush, [], []);
    assert.equal(shape.brushScale, 1.2);
    assert.equal(shape.shapeRect.width, 18);
    assert.equal(shape.shapeRect.height, 18);
    let alphaSum = 0;
    for (let i = 3; i < shape.rgbaBuffer.length; i += 4) alphaSum += shape.rgbaBuffer[i];
    assert.equal(alphaSum, 65032);
  });

  it("createBrushStamp + short stroke paint non-empty buffer", () => {
    const brush = BrushPresetUtil.getDefaultBrushDescriptor();
    BrushStroke.stampCache = [];
    const stamp = BrushStroke.createBrushStamp(brush, [], 1, 20);
    assert.equal(stamp[1].width, 20);
    assert.equal(stamp[1].height, 20);
    assert.equal(stamp[2], 15);
    // A dab is the brush shape drawn through its own transform: the 18x18 tip
    // is painted at 1/1.2 of the scale it was built at, so the stamp carries
    // roughly 1/1.44 of the tip's alpha.
    let alphaSum = 0;
    for (let i = 3; i < stamp[0].length; i += 4) alphaSum += stamp[0][i];
    assert.ok(Math.abs(alphaSum - 45010) <= 1, `alphaSum ${alphaSum} should be ~45010`);

    const stroke = new BrushStroke(brush, [], null, { opacity: 1 }, 0xff0000, 0, new Rect(0, 0, 32, 32));
    stroke.moveTo(16, 16, 1);
    stroke.lineTo(20, 16, 1);
    stroke.finish();
    // The dab is ~15px across, so a 4px travel from (16,16) marks x 8..28 and
    // y 8..24 dirty — the stroke repaints its own footprint, not the canvas.
    const dirty = stroke.getDirtyBounds();
    assert.deepEqual(
      { x: dirty.x, y: dirty.y, w: dirty.width, h: dirty.height },
      { x: 8, y: 8, w: 20, h: 16 },
    );
    assert.equal(stroke.getBuffer().some((v) => v !== 0), true);
    assert.equal(stroke.normalizePressure(null), 1);
    assert.equal(stroke.getSpacing(), 0.25);
    assert.throws(() => stroke.normalizePressure(NaN), { message: "Pressure is not a number" });
  });

  it("mode constants stay stable", () => {
    assert.deepEqual(
      [BrushStroke.MODE_PENCIL, BrushStroke.MODE_BLUR, BrushStroke.MODE_SHARPEN, BrushStroke.MODE_SMUDGE],
      ["0", "1", "2", "3"],
    );
  });
});
