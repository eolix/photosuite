/**
 * OverlayManager pure helpers (palette match, banner id, popup place), and the
 * bridge that gives `showToast` somewhere to paint.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let OverlayManager;
let matchCommandPaletteQuery;
let resolveBannerIdentity;
let computePopupAnchorPlacement;
let showToast;
let installToastPainter;

before(async () => {
  ({
    OverlayManager,
    matchCommandPaletteQuery,
    resolveBannerIdentity,
    computePopupAnchorPlacement
  } = await import("../../../src/ui/shell/overlay-manager.js"));
  ({ showToast, installToastPainter } = await import("../../../src/core/user-prompts.js"));
});

const SAMPLE_ROWS = [
  [["File", "Open"], [0, 1]],
  [["Edit", "Copy"], [1, 2]],
  [["Tools", "Brush"], [-1, 5]]
];

describe("ui/shell/overlay-manager.js", () => {
  it("matchCommandPaletteQuery AND-token goldens", () => {
    assert.deepEqual(matchCommandPaletteQuery("op", SAMPLE_ROWS), {
      matchedRows: [
        [["File", "Open"], [0, 1]],
        [["Edit", "Copy"], [1, 2]]
      ],
      highlightRangesByRow: [[-1, [0, 2]], [-1, [1, 3]]],
      queryTokens: ["op"]
    });
    assert.deepEqual(matchCommandPaletteQuery("edit copy", SAMPLE_ROWS), {
      matchedRows: [[["Edit", "Copy"], [1, 2]]],
      highlightRangesByRow: [[[0, 4], [0, 4]]],
      queryTokens: ["edit", "copy"]
    });
    assert.deepEqual(matchCommandPaletteQuery("", SAMPLE_ROWS), {
      matchedRows: [],
      highlightRangesByRow: [],
      queryTokens: [""]
    });
  });

  it("resolveBannerIdentity string and object forms", () => {
    assert.deepEqual(resolveBannerIdentity("loading"), {
      id: "loading",
      text: "loading",
      key: "\"loading\""
    });
    assert.deepEqual(resolveBannerIdentity({ id: "x", text: "y" }), {
      id: "x",
      text: "y",
      key: "\"x\""
    });
    assert.deepEqual(resolveBannerIdentity({ key: "k" }), {
      id: "k",
      text: { key: "k" },
      key: "\"k\""
    });
  });

  it("computePopupAnchorPlacement goldens", () => {
    assert.deepEqual(
      computePopupAnchorPlacement(800, 600, 100, 100, 50, 50, {}),
      { anchorX: 100, anchorY: 100 }
    );
    assert.deepEqual(
      computePopupAnchorPlacement(800, 600, 780, 550, 100, 100, {}),
      { anchorX: 695, anchorY: 448 }
    );
    assert.deepEqual(
      computePopupAnchorPlacement(800, 600, 780, 550, 100, 100, {
        anchorAbove: true,
        y: 550
      }),
      { anchorX: 695, anchorY: 448 }
    );
    assert.deepEqual(
      computePopupAnchorPlacement(800, 600, 100, 100, 50, 50, {
        pinToAnchorY: true,
        y: 42
      }),
      { anchorX: 100, anchorY: 42 }
    );
  });

  it("collectMenuCommandRows skips disabled and flattens leaves", () => {
    const rows = [];
    OverlayManager.collectMenuCommandRows(
      [
        { name: "a", resolveRowState: () => ({ enabled: false }) },
        {
          name: "b",
          sub: [{ name: "c" }]
        },
        { name: "d" }
      ],
      ["Root"],
      [0],
      rows,
      null,
      null
    );
    assert.deepEqual(rows, [
      [["Root", "b", "c"], [0, 1, 0]],
      [["Root", "d"], [0, 2]]
    ]);
  });

  it("exports OverlayManager constructor", () => {
    assert.equal(typeof OverlayManager, "function");
  });
});

// Constructing the chrome is what wires showToast to the banner. The wiring has
// to go through installToastPainter: an imported binding cannot be reassigned,
// and the failure only shows up when the app boots.
describe("ui/shell/overlay-manager.js toast bridge", () => {
  it("constructing an OverlayManager gives showToast a painter", () => {
    installToastPainter(null);
    const painted = [];
    const overlayManager = new OverlayManager();
    overlayManager.showToastAlert = (message, durationMs) => painted.push([message, durationMs]);
    // Re-run the bridge now that the spy is in place.
    installToastPainter(overlayManager.showToastAlert.bind(overlayManager));

    showToast("saved", 2000);
    assert.deepEqual(painted, [["saved", 2000]]);
    installToastPainter(null);
  });

  it("showToast before the chrome exists is silent, not a crash", () => {
    installToastPainter(null);
    assert.doesNotThrow(() => showToast("no chrome yet"));
  });
});
