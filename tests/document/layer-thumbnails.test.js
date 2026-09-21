/**
 * Golden values for the layer-panel thumbnail painters.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";
import { getDevicePixelRatio, makeElement, resizeCanvasForDevicePixelRatio } from "../../src/core/dom.js";

installBrowserGlobals();

let Rect;
let Locale;
let LayerThumbnails;

function makeImageData(width, height, data) {
  return {
    width,
    height,
    data: data || new Uint8ClampedArray(width * height * 4),
  };
}

function makeCtx(canvas) {
  const ops = [];
  const ctx = {
    canvas,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    _ops: ops,
    createImageData(w, h) {
      return makeImageData(w, h);
    },
    getImageData(_x, _y, w, h) {
      return makeImageData(w, h);
    },
    putImageData(img, x, y) {
      ops.push([
        "put",
        x,
        y,
        img.width,
        img.height,
        Array.from(img.data.slice(0, Math.min(64, img.data.length))),
      ]);
    },
    fillRect(...args) {
      ops.push(["fillRect", ...args, ctx.fillStyle]);
    },
    clearRect(...args) {
      ops.push(["clearRect", ...args]);
    },
    strokeRect(...args) {
      ops.push(["strokeRect", ...args]);
    },
    beginPath() {
      ops.push(["beginPath"]);
    },
    moveTo(...args) {
      ops.push(["moveTo", ...args]);
    },
    lineTo(...args) {
      ops.push(["lineTo", ...args]);
    },
    closePath() {
      ops.push(["closePath"]);
    },
    stroke() {
      ops.push(["stroke", ctx.strokeStyle, ctx.lineWidth]);
    },
    fillText(...args) {
      ops.push(["fillText", ...args, ctx.fillStyle, ctx.font]);
    },
    measureText(text) {
      return { width: text.length * 6 };
    },
    setTransform() {},
    scale() {},
  };
  return ctx;
}

function stubAppForThumbs() {
  // The painters size their canvas through core/dom.js, which reads
  // window.devicePixelRatio (1 here) and writes the CSS size back onto style.
  document.createElement = () => {
    const canvas = { width: 0, height: 0, style: {} };
    canvas.getContext = () => makeCtx(canvas);
    return canvas;
  };
}

/**
 * The painters share module-level redraw caches, so each test starts from a
 * clean slate rather than inheriting a frame or stroke template built earlier.
 */
function freshThumbnails() {
  stubAppForThumbs();
  LayerThumbnails.smartObjectFrameCacheBySize = [];
  LayerThumbnails.linkedLayerFrameCacheBySize = [];
  LayerThumbnails.vectorMaskStrokeStyleTemplate = null;
  LayerThumbnails.thumbImageDataCache = null;
  LayerThumbnails.textLayerThumbCache = null;
  return LayerThumbnails;
}

before(async () => {
  ({ Rect } = await import("../../src/core/math/rect.js"));
  ({ Locale } = await import("../../src/core/i18n/locale.js"));
  ({ LayerThumbnails } = await import("../../src/document/layer-thumbnails.js"));
});

describe("document/layer-thumbnails.js", () => {
  it("solidFillColorToCss packs RGBC to hex", () => {
    const tr = freshThumbnails();
    assert.equal(
      tr.solidFillColorToCss({
        classID: "RGBC",
        Rd: { t: "doub", v: 255 },
        Grn: { t: "doub", v: 128 },
        Bl: { t: "doub", v: 0 },
      }),
      "#ff8000",
    );
  });

  it("drawMaskChannelThumbnail samples density-weighted gray", () => {
    const tr = freshThumbnails();
    const ctx = makeCtx({ width: 0, height: 0, style: {} });
    const channel = new Uint8Array([0, 85, 170, 255]);
    tr.drawMaskChannelThumbnail(
      ctx,
      4,
      4,
      new Rect(0, 0, 4, 4),
      {
        channel,
        rect: new Rect(0, 0, 2, 2),
        isEnabled: true,
        color: 128,
        density: 255,
      },
      false,
    );
    const put = ctx._ops.find((op) => op[0] === "put");
    assert.deepEqual(put[5].slice(0, 16), [
      0, 0, 0, 255, 84, 84, 84, 255, 127, 127, 127, 255, 127, 127, 127, 255,
    ]);
  });

  it("drawDisabledMaskCross geometry for disabled mask", () => {
    const tr = freshThumbnails();
    const ctx = makeCtx({ width: 0, height: 0, style: {} });
    tr.drawMaskChannelThumbnail(
      ctx,
      4,
      4,
      new Rect(0, 0, 4, 4),
      {
        channel: new Uint8Array(4),
        rect: new Rect(0, 0, 2, 2),
        isEnabled: false,
        color: 0,
        density: 255,
      },
      false,
    );
    assert.deepEqual(
      ctx._ops.filter((op) => op[0] === "moveTo" || op[0] === "lineTo" || op[0] === "stroke"),
      [
        ["moveTo", 0.6, 0.6],
        ["lineTo", 3.4, 3.4],
        ["moveTo", 3.4, 0.6],
        ["lineTo", 0.6, 3.4],
        ["stroke", "#bb0000", 3],
      ],
    );
  });

  it("drawRasterThumbnail nearest-neighbor + channel isolate", () => {
    const tr = freshThumbnails();
    const rgba = new Uint8ClampedArray(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      rgba[i * 4] = i * 60;
      rgba[i * 4 + 1] = 100;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const ctx = makeCtx({ width: 0, height: 0, style: {} });
    tr.drawRasterThumbnail(
      ctx,
      4,
      4,
      new Rect(0, 0, 2, 2),
      rgba,
      new Rect(0, 0, 2, 2),
      false,
      null,
    );
    const put = ctx._ops.find((op) => op[0] === "put");
    assert.deepEqual(put[5].slice(0, 32), [
      0, 100, 200, 255, 0, 100, 200, 255, 60, 100, 200, 255, 60, 100, 200, 255, 0, 100, 200, 255, 0,
      100, 200, 255, 60, 100, 200, 255, 60, 100, 200, 255,
    ]);
    const ctxCh = makeCtx({ width: 0, height: 0, style: {} });
    tr.drawRasterThumbnail(
      ctxCh,
      2,
      2,
      new Rect(0, 0, 2, 2),
      rgba,
      new Rect(0, 0, 2, 2),
      false,
      0,
    );
    const putCh = ctxCh._ops.find((op) => op[0] === "put");
    assert.deepEqual(putCh[5].slice(0, 16), [
      0, 0, 0, 255, 60, 60, 60, 255, 60, 60, 60, 255, 60, 60, 60, 255,
    ]);
  });

  it("drawMissingLayerThumbnail and adjustment label", () => {
    const tr = freshThumbnails();
    const missingCtx = makeCtx({ width: 0, height: 0, style: {} });
    tr.drawMissingLayerThumbnail(missingCtx, 20, 20);
    assert.deepEqual(missingCtx._ops.find((op) => op[0] === "fillText"), [
      "fillText",
      ":(",
      5.7,
      14,
      "",
      "14px serif",
    ]);
    const prevGet = Locale.get;
    Locale.get = () => "Brightness";
    const adjCtx = makeCtx({ width: 0, height: 0, style: {} });
    tr.drawAdjustmentLayerThumbnail(adjCtx, 30, 20, "brit");
    Locale.get = prevGet;
    assert.deepEqual(
      adjCtx._ops.filter((op) => op[0] === "fillText" || op[0] === "fillRect").slice(0, 4),
      [
        ["fillRect", 0, 0, 30, 20, "#ffffff"],
        ["fillText", "Bri", 6, 13.4, "#000000", "11px sans-serif"],
        ["fillRect", 0, 0, 30, 2, "#000000"],
        ["fillRect", 0, 18, 30, 2, "#000000"],
      ],
    );
  });

  it("drawLayerStyleThumbFooter geometry", () => {
    const tr = freshThumbnails();
    const ctx = makeCtx({ width: 0, height: 0, style: {} });
    tr.ensureCanvasBackingStore(ctx, 10, 10);
    tr.drawLayerStyleThumbFooter(ctx, 10, 10);
    assert.deepEqual(
      ctx._ops.map((op) => op[0]),
      [
        "fillRect",
        "beginPath",
        "moveTo",
        "lineTo",
        "moveTo",
        "lineTo",
        "moveTo",
        "lineTo",
        "closePath",
        "stroke",
      ],
    );
    assert.deepEqual(ctx._ops[0], ["fillRect", 0, 7.5, 10, 2.5, "#eeeeee"]);
  });
});
