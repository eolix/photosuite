/**
 * brush-preset-controls helper goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { existsSync } from "node:fs";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let listBundledBrushPresetUrls;
let buildBrushEditorPresetPayload;
let brushPresetDisplayLabel;
let resolveBrushAtVisibleMenuIndex;
let solidColorPreviewCacheKey;
let BrushPickerButton;
let ToolPresetButton;
let StyleButton;
let BrushPresetUtil;

before(async () => {
  ({ BrushPresetUtil } = await import("../../../../src/features/brush/brush-presets.js"));
  ({
    listBundledBrushPresetUrls,
    buildBrushEditorPresetPayload,
    brushPresetDisplayLabel,
    resolveBrushAtVisibleMenuIndex,
    solidColorPreviewCacheKey,
    BrushPickerButton,
    ToolPresetButton,
    StyleButton
  } = await import("../../../../src/ui/widgets/controls/brush-preset-controls.js"));
});

describe("ui/widgets/controls/brush-preset-controls.js", () => {
  it("listBundledBrushPresetUrls names a library that ships with the app", () => {
    const urls = listBundledBrushPresetUrls();
    assert.deepEqual(urls, [
      "libraries/Markers.abr",
      "libraries/Paintbrush_Set.abr",
      "libraries/Pencil_Scribbles.abr",
    ]);
    for (const url of urls) {
      assert.ok(existsSync("src/resources/" + url), url + " is missing from src/resources/");
    }
  });

  it("brushPresetDisplayLabel goldens", () => {
    assert.equal(brushPresetDisplayLabel({ Nm: { v: "a=MyBrush" } }), "MyBrush");
    assert.equal(brushPresetDisplayLabel({}), "Brush");
  });

  it("buildBrushEditorPresetPayload wraps descriptor", () => {
    var payload = buildBrushEditorPresetPayload(null);
    assert.equal(payload.list.length, 1);
    assert.equal(payload.list[0].t, "Objc");
    assert.ok(payload.list[0].v);
    assert.deepEqual(payload.samples, []);
    assert.deepEqual(payload.patterns, []);
  });

  it("resolveBrushAtVisibleMenuIndex skips null entries", () => {
    var orig = BrushPresetUtil.getBrushPresetFromListEntry;
    var entries = ["skip", "keep-a", "skip", "keep-b"];
    BrushPresetUtil.getBrushPresetFromListEntry = function(entry) {
      return entry.indexOf("keep") == 0 ? { id: entry } : null;
    };
    try {
      assert.deepEqual(resolveBrushAtVisibleMenuIndex(entries, 0), { id: "keep-a" });
      assert.deepEqual(resolveBrushAtVisibleMenuIndex(entries, 1), { id: "keep-b" });
      assert.equal(resolveBrushAtVisibleMenuIndex(entries, 2), null);
    } finally {
      BrushPresetUtil.getBrushPresetFromListEntry = orig;
    }
  });

  it("solidColorPreviewCacheKey packs {h,l,O}", () => {
    assert.equal(solidColorPreviewCacheKey({ h: 12, l: 34, O: 56 }), "0c2238");
  });

  it("exports constructors", () => {
    assert.equal(typeof BrushPickerButton, "function");
    assert.equal(typeof ToolPresetButton, "function");
    assert.equal(typeof StyleButton, "function");
  });
});
