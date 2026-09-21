/**
 * AppController shell: pure helpers (edge pan, doc index, cap blurb, file-loader ref).
 *
 * Golden values covering the module’s public behaviour.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let computeEdgeAutoPanDeltas;
let scaleEdgeAutoPanForFrame;
let resolveCurrentDocFromOpenList;
let buildCapFormatBlurbHtml;
let createFileLoaderProcessRef;
let CHROME_LAYOUT_NORMAL;
let CHROME_LAYOUT_MENU_ONLY;
let CHROME_LAYOUT_FULLSCREEN;
let FileLoader;
let AppController;

before(async () => {
  ({
    computeEdgeAutoPanDeltas,
    scaleEdgeAutoPanForFrame,
    resolveCurrentDocFromOpenList,
    buildCapFormatBlurbHtml,
    createFileLoaderProcessRef,
    CHROME_LAYOUT_NORMAL,
    CHROME_LAYOUT_MENU_ONLY,
    CHROME_LAYOUT_FULLSCREEN,
    AppController
  } = await import("../../../src/ui/shell/app-controller.js"));
  ({ FileLoader } = await import("../../../src/ui/shell/file-loader.js"));
});

describe("ui/shell/app-controller.js", () => {
  it("exports AppController and chrome layout mode constants", () => {
    assert.equal(typeof AppController, "function");
    assert.equal(CHROME_LAYOUT_NORMAL, 0);
    assert.equal(CHROME_LAYOUT_MENU_ONLY, 1);
    assert.equal(CHROME_LAYOUT_FULLSCREEN, 2);
  });

  it("computeEdgeAutoPanDeltas matches edge margins", () => {
    assert.deepEqual(
      computeEdgeAutoPanDeltas({ x: 4, y: 100 }, 800, 600),
      { scrollDeltaX: 12, scrollDeltaY: 0 }
    );
    assert.deepEqual(
      computeEdgeAutoPanDeltas({ x: 790, y: 10 }, 800, 600),
      { scrollDeltaX: 6, scrollDeltaY: 6 }
    );
    assert.deepEqual(
      computeEdgeAutoPanDeltas({ x: 400, y: 300 }, 800, 600),
      { scrollDeltaX: 0, scrollDeltaY: 0 }
    );
  });

  it("scaleEdgeAutoPanForFrame caps and flips away from top-left edge", () => {
    assert.deepEqual(
      scaleEdgeAutoPanForFrame(12, 0, { x: 4, y: 100 }),
      { scrollDeltaX: 5, scrollDeltaY: 0 }
    );
    assert.deepEqual(
      scaleEdgeAutoPanForFrame(10, 10, { x: 790, y: 590 }),
      { scrollDeltaX: -5, scrollDeltaY: -5 }
    );
  });

  it("resolveCurrentDocFromOpenList clamps activeDocIndex", () => {
    assert.deepEqual(resolveCurrentDocFromOpenList([], 0), {
      doc: null,
      activeDocIndex: 0
    });
    assert.deepEqual(resolveCurrentDocFromOpenList(["a", "b"], 9), {
      doc: "b",
      activeDocIndex: 1
    });
    assert.deepEqual(resolveCurrentDocFromOpenList(["a", "b"], -1), {
      doc: "a",
      activeDocIndex: 0
    });
    assert.deepEqual(resolveCurrentDocFromOpenList(["a", "b"], null), {
      doc: "a",
      activeDocIndex: 0
    });
  });

  it("buildCapFormatBlurbHtml matches narrow/wide strings", () => {
    assert.equal(
      buildCapFormatBlurbHtml(true),
      "Free online editor supporting <b>PSD</b>, <b>XCF</b>, <b>Sketch</b>, <b>XD</b> and <b>CDR</b> formats."
    );
    assert.equal(
      buildCapFormatBlurbHtml(false),
      "Free online editor supporting <b>PSD</b>, <b>XCF</b>, <b>Sketch</b>, <b>XD</b> and <b>CDR</b> formats. (<b>Adobe Photoshop</b>, <b>GIMP</b>, <b>Sketch App</b>,  <b>Adobe XD</b>, <b>CorelDRAW</b>)."
    );
  });

  it("createFileLoaderProcessRef exposes processLoadedBytes (not opaque qb)", () => {
    const ref = createFileLoaderProcessRef();
    assert.equal(ref.processLoadedBytes, FileLoader.processLoadedBytes);
    assert.equal(ref.qb, undefined);
  });
});
