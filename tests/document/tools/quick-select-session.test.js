/**
 * The shared quick-select session.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let quickSelectSession;
let getLayerFingerprint;
let CROSSHAIR_INSET_RATIO;
let createQuickSelectSession;
let recomputeQuickSelectSelection;
let resetQuickSelectSelection;
let seedObjectSelectionMask;
let adoptDocumentSelection;
let hasDocumentSelectionDiverged;
let Rect;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({
    quickSelectSession,
    getLayerFingerprint,
    CROSSHAIR_INSET_RATIO,
    createQuickSelectSession,
    recomputeQuickSelectSelection,
    resetQuickSelectSelection,
    seedObjectSelectionMask,
    adoptDocumentSelection,
    hasDocumentSelectionDiverged,
  } = await import("../../../src/document/tools/quick-select-session.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

/** A selection of one filled rectangle, as another tool would leave behind. */
function rectSelection(x, y, width, height) {
  const channel = new Uint8Array(WIDTH * HEIGHT);
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) channel[row * WIDTH + col] = 255;
  }
  return { channel, rect: new Rect(0, 0, WIDTH, HEIGHT) };
}

const WIDTH = 240;
const HEIGHT = 180;

/** A document of one layer: a red disc and a green square on a blue ground. */
function twoObjectDoc() {
  const buffer = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const i = (y * WIDTH + x) * 4;
    const inDisc = Math.hypot(x - 150, y - 90) < 45;
    const inSquare = x > 25 && x < 75 && y > 30 && y < 80;
    buffer[i] = inDisc ? 210 : inSquare ? 40 : 30;
    buffer[i + 1] = inDisc ? 60 : inSquare ? 180 : 40;
    buffer[i + 2] = inDisc ? 50 : inSquare ? 70 : 160;
    buffer[i + 3] = 255;
  }
  return {
    selectedLayerIndices: [0],
    layers: [{
      buffer,
      rect: {
        x: 0, y: 0, width: WIDTH, height: HEIGHT,
        area: () => WIDTH * HEIGHT,
        clone() { return { ...this, clone: this.clone, area: this.area }; },
      },
    }],
  };
}

/** Paint a round dab of brush marks, as a stroke would. */
function dab(session, centerX, centerY, radius, value) {
  session.brushRadius = radius;
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (Math.hypot(x - centerX, y - centerY) <= radius) session.brushMaskBuffer[y * WIDTH + x] = value;
    }
  }
}

/** Drag the brush along a row, resolving the selection as the app does. */
function stroke(session, fromX, toX, centerY, radius, value) {
  for (let centerX = fromX; centerX <= toX; centerX += radius) {
    dab(session, centerX, centerY, radius, value);
    recomputeQuickSelectSelection(session);
  }
}

function selectedArea(session) {
  let area = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) if (session.selectionMaskBuffer[i] > 127) area++;
  return area;
}

describe("document/tools/quick-select-session.js", () => {
  // Until a layer has been analysed the session holds no graph, and an empty
  // key can never match a real layer's fingerprint.
  it("starts with no analysed layer", () => {
    assert.equal(quickSelectSession.key, "");
  });

  // The fingerprint is what decides whether the cached analysis still applies:
  // it covers which layer, where it sits, how big it is, and its first pixels.
  it("fingerprints a layer by index, bounds and leading pixels", () => {
    const doc = {
      selectedLayerIndices: [2],
      layers: [{}, {}, {
        rect: { x: 5, y: 6, width: 20, height: 30 },
        buffer: new Uint8ClampedArray([9, 8, 7, 255, 1, 2, 3, 4]),
      }],
    };
    assert.equal(getLayerFingerprint(doc), "2,5,6,20,30,9,8,7,255");
  });

  // Moving the layer changes the fingerprint, so the analysis is redone.
  it("changes the fingerprint when the layer moves", () => {
    const layer = {
      rect: { x: 0, y: 0, width: 4, height: 4 },
      buffer: new Uint8ClampedArray([1, 2, 3, 4]),
    };
    const doc = { selectedLayerIndices: [0], layers: [layer] };
    const before = getLayerFingerprint(doc);
    layer.rect.x = 1;
    assert.notEqual(getLayerFingerprint(doc), before);
  });

  // The seeded crosshair and the marquee the user drags share this inset, so
  // what is marked as foreground matches what was shown.
  it("insets the foreground crosshair by an eighth of the rectangle", () => {
    assert.equal(CROSSHAIR_INSET_RATIO, 0.12);
  });

  // Each stroke claims the object it was painted across, and keeps what the
  // strokes before it claimed: that is what makes the second stroke of a
  // quick selection an addition.
  it("adds each stroke's object to what earlier strokes claimed", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    stroke(session, 120, 180, 90, 8, 255);
    const discArea = selectedArea(session);
    assert.ok(discArea > Math.PI * 45 * 45 * 0.8);
    assert.equal(session.selectionMaskBuffer[55 * WIDTH + 50], 0);

    stroke(session, 35, 65, 55, 8, 255);
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 255);
    assert.equal(session.selectionMaskBuffer[55 * WIDTH + 50], 255);
    assert.ok(selectedArea(session) > discArea + 1500);
  });

  // Painting over ground the session has already resolved changes nothing, so
  // dragging back over a stroke neither re-cuts it nor undoes it.
  it("ignores marks it has already resolved", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    dab(session, 150, 90, 5, 255);
    recomputeQuickSelectSelection(session);
    const area = selectedArea(session);
    dab(session, 150, 90, 4, 255);
    recomputeQuickSelectSelection(session);
    assert.equal(selectedArea(session), area);
  });

  // A background mark takes its region back out of the selection.
  it("subtracts a region the brush marks as background", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    dab(session, 150, 90, 5, 255);
    recomputeQuickSelectSelection(session);
    dab(session, 50, 55, 5, 255);
    recomputeQuickSelectSelection(session);
    dab(session, 50, 55, 5, 0);
    recomputeQuickSelectSelection(session);
    assert.equal(session.selectionMaskBuffer[55 * WIDTH + 50], 0);
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 255);
  });

  // The object-select tool hands the session a rectangle instead of a stroke:
  // the border is marked background and a crosshair at the centre foreground,
  // so the cut inside the rectangle returns the object the user drew around.
  it("cuts the object out of an object-select rectangle", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    for (const key in session) quickSelectSession[key] = session[key];
    const selection = seedObjectSelectionMask({ x: 90, y: 30, width: 120, height: 120 });
    assert.equal(selection.channel[90 * WIDTH + 150], 255);
    assert.equal(selection.channel[40 * WIDTH + 100], 0);
    let area = 0;
    for (let i = 0; i < WIDTH * HEIGHT; i++) if (selection.channel[i] > 127) area++;
    assert.ok(area > Math.PI * 45 * 45 * 0.8);
    assert.ok(area < 120 * 120);
  });

  // A selection the session did not make means its scribbles describe
  // something that is no longer on screen: stepping back through history is
  // the case that matters.
  it("sees the document's selection diverge from the one it made", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    dab(session, 150, 90, 5, 255);
    recomputeQuickSelectSelection(session);
    const emitted = { channel: session.selectionMaskBuffer.slice(0), rect: session.rect };
    session.emittedSelection = emitted;
    assert.equal(hasDocumentSelectionDiverged(session, emitted), false);
    assert.equal(hasDocumentSelectionDiverged(session, rectSelection(0, 0, 20, 20)), true);
    assert.equal(hasDocumentSelectionDiverged(session, null), true);
  });

  // Once it has diverged the session starts again from what the document
  // holds: the next stroke adds its object to that, and nothing it claimed
  // before the history step comes back.
  it("adds to the selection it adopts, not to the one it had", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    stroke(session, 120, 180, 90, 8, 255);
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 255);

    adoptDocumentSelection(session, rectSelection(0, 140, 30, 30));
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 0);
    assert.equal(session.selectionMaskBuffer[150 * WIDTH + 10], 255);

    stroke(session, 35, 65, 55, 8, 255);
    // The square the new stroke claimed, and the adopted rectangle, and not
    // the disc from before the history step.
    assert.equal(session.selectionMaskBuffer[55 * WIDTH + 50], 255);
    assert.equal(session.selectionMaskBuffer[150 * WIDTH + 10], 255);
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 0);
  });

  // A background scribble has to reach into an adopted selection too, or a
  // selection made elsewhere could never be painted back out.
  it("subtracts from an adopted selection", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    // A rectangle over the disc, overlapping the ground at its corners.
    adoptDocumentSelection(session, rectSelection(100, 40, 100, 100));
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 255);
    assert.equal(session.selectionMaskBuffer[45 * WIDTH + 105], 255);

    stroke(session, 120, 180, 90, 8, 0);
    // The disc goes, and the ground inside the rectangle is left alone.
    assert.equal(session.selectionMaskBuffer[90 * WIDTH + 150], 0);
    assert.equal(session.selectionMaskBuffer[75 * WIDTH + 130], 0);
    assert.equal(session.selectionMaskBuffer[45 * WIDTH + 105], 255);
  });

  // The first stroke of a selection replaces what was there, which is the
  // session being emptied before the stroke starts.
  it("empties the scribbles and the selection on reset", () => {
    const session = createQuickSelectSession(twoObjectDoc());
    dab(session, 150, 90, 5, 255);
    recomputeQuickSelectSelection(session);
    assert.ok(selectedArea(session) > 0);
    resetQuickSelectSelection(session);
    assert.equal(selectedArea(session), 0);
    assert.ok(session.brushMaskBuffer.every((value) => value == 128));
  });
});
