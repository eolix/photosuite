/**
 * Golden values for geometry (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UNIT_SUFFIXES, boundingBox, buildHorizontalRulerTicks, clusterRects, docUnitsToPixels, drawRulersOnView, formatDocLength, mergeRects, parseDocLengthToPixels, rulerThicknessPx, subtractRects } from "../../../src/engine/compositing/geometry.js";

installBrowserGlobals();


function installRectanglePackerStub() {
  globalThis.NETXUS = {
    RectanglePacker: class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
        this.cursorX = 0;
        this.cursorY = 0;
      }
      reset(width, height) {
        this.width = width;
        this.height = height;
        this.cursorX = 0;
        this.cursorY = 0;
      }
      findCoords(rectWidth, rectHeight) {
        if (this.cursorX + rectWidth <= this.width && this.cursorY + rectHeight <= this.height) {
          const coords = { x: this.cursorX, y: this.cursorY };
          this.cursorX += rectWidth + 1;
          return coords;
        }
        return null;
      }
    },
  };
}

/** Swap in a 2D-capable canvas for ruler glyph rendering; returns a restore fn. */
function withCanvas2d(run) {
  const original = globalThis.document.createElement;
  globalThis.document.createElement = function () {
    let width = 0;
    let height = 0;
    return {
      get width() {
        return width;
      },
      set width(v) {
        width = v;
      },
      get height() {
        return height;
      },
      set height(v) {
        height = v;
      },
      style: {},
      getContext(type) {
        if (type !== "2d") return null;
        return {
          font: "",
          fillStyle: "",
          fillRect() {},
          fillText() {},
          getImageData(x, y, gw, gh) {
            const data = new Uint8ClampedArray(gw * gh * 4);
            for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 128) & 255;
            return { data, width: gw, height: gh };
          },
        };
      },
    };
  };
  try {
    return run();
  } finally {
    globalThis.document.createElement = original;
  }
}

function checksum(buf, modulus = 7) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum = (sum + buf[i] * (i % modulus + 1)) % 1000003;
  }
  return sum;
}

before(async () => {
  installRectanglePackerStub();
});

describe("geometry", () => {
  it("subtractRects / mergeRects / boundingBox goldens", () => {
    assert.deepEqual(subtractRects([0, 0, 100, 100], [[10, 10, 30, 30]]), [
      [0, 0, 100, 10],
      [0, 10, 30, 100],
      [30, 10, 100, 100],
    ]);
    assert.deepEqual(
      mergeRects([
        [0, 0, 10, 20],
        [10, 0, 20, 20],
        [0, 0, 5, 5],
      ]),
      [
        [0, 0, 20, 20],
        [0, 0, 5, 5],
      ],
    );
    const bbox = boundingBox([new Rect(5, 5, 10, 10), new Rect(20, 0, 5, 15)]);
    assert.deepEqual([bbox.x, bbox.y, bbox.width, bbox.height], [5, 0, 20, 15]);
  });

  it("clusterRects offsets nearby rects with stub packer", () => {
    const rects = [new Rect(0, 0, 10, 10), new Rect(12, 0, 8, 10), new Rect(0, 20, 10, 8)];
    clusterRects(rects, true);
    assert.deepEqual(
      rects.map((r) => [r.x, r.y, r.width, r.height]),
      [
        [0, 0, 10, 10],
        [12, 0, 8, 10],
        [21, 0, 10, 8],
      ],
    );
  });

  it("DpiUtils unit conversion goldens", () => {
    const docState = { dpi: 72, width: 1000 };
    const appState = { prefs: { AppWindow: 1 } };
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((unitIndex) => Math.round(docUnitsToPixels(10, docState, unitIndex) * 1000) / 1000),
      [10, 720, 283.465, 28.346, 100],
    );
    assert.equal(formatDocLength(72, 72, appState, 1000, true), "1.000 in");
    assert.equal(parseDocLengthToPixels("1", 72, appState, 1000), 72);
    assert.deepEqual(UNIT_SUFFIXES, ["px", "in", "cm", "mm", "%"]);
  });

  // The stubbed device-pixel ratio is 1, so the ruler is 16 device pixels.
  it("buildHorizontalRulerTicks matches golden", () => {
    assert.equal(rulerThicknessPx(), 16);
    const ticks = buildHorizontalRulerTicks(1, 0x808080, 0xffffff);
    assert.equal(ticks.step, 50);
    assert.equal(ticks.pixelBuffer.length / (16 * 4), 50);
    assert.equal(checksum(ticks.pixelBuffer, 5), 359602);
  });

  it("drawRulersOnView renders ticks, labels and guide markers to a golden", () => {
    const vw = 120;
    const vh = 90;
    const rt = rulerThicknessPx();
    const view = {
      viewportRect: { width: vw, height: vh },
      zoomScale: 1.5,
      horizontalRulerImageData: { data: new Uint8ClampedArray(vw * rt * 4) },
      verticalRulerImageData: { data: new Uint8ClampedArray(rt * vh * 4) },
      screenToDocPoint: (x, y) => ({ x: x / 1.5, y: y / 1.5 }),
      docToScreenPoint: (x, y) => ({ x: x * 1.5, y: y * 1.5 }),
    };
    withCanvas2d(() => drawRulersOnView(view, 0x304050, 0xf0f0f0, 40, 30));
    assert.equal(checksum(view.horizontalRulerImageData.data), 888044);
    assert.equal(checksum(view.verticalRulerImageData.data), 178586);
    // tickBlue (0x50 = 80) < 128 -> guide marker painted opaque black (0xFF000000).
    const horizPacked = new Uint32Array(view.horizontalRulerImageData.data.buffer);
    assert.equal(horizPacked[40] >>> 0, 0xff000000);
  });
});
