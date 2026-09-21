/**
 * Golden I/O for FontRegistry pure statics + catalog map invalidation.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

window.Event = class Event {
  constructor(type) {
    this.type = type;
  }
};
window.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};
window.dispatchEvent = function (event) {
  const handlers = (this._handlers && this._handlers.get(event && event.type)) || [];
  for (const handler of handlers) handler(event);
  return true;
};
const _add = window.addEventListener.bind(window);
window.addEventListener = function (type, handler) {
  if (!this._handlers) this._handlers = new Map();
  if (!this._handlers.has(type)) this._handlers.set(type, []);
  this._handlers.get(type).push(handler);
  return _add(type, handler);
};

let FontRegistry;

before(async () => {
  ({ FontRegistry } = await import("../../src/fonts/font-registry.js"));
});

describe("fonts/font-registry.js (pure static goldens)", () => {
  it("getPostScriptName replaces spaces with dashes", () => {
    assert.equal(
      FontRegistry.getPostScriptName({ name: { postScriptName: "Foo Bar Baz" } }),
      "Foo-Bar-Baz"
    );
    assert.equal(FontRegistry.getPostScriptName({ name: {} }), null);
  });

  it("weight helpers match goldens", () => {
    const styles = ["Regular", "Bold", "Italic", "Bold Italic", "Light", "Black"];
    assert.deepEqual(
      styles.map((s) => [s, FontRegistry.getWeightIndex(s.toLowerCase())]),
      [
        ["Regular", 8],
        ["Bold", 11],
        ["Italic", 8],
        ["Bold Italic", 11],
        ["Light", 7],
        ["Black", 15],
      ]
    );
    assert.deepEqual(
      styles.map((s) => [s, FontRegistry.isItalicStyle(s.toLowerCase())]),
      [
        ["Regular", 0],
        ["Bold", 0],
        ["Italic", 1],
        ["Bold Italic", 1],
        ["Light", 0],
        ["Black", 0],
      ]
    );
    assert.deepEqual(
      styles.map((s) => [s, FontRegistry.getWeightSortKey(s)]),
      [
        ["Regular", 33554448],
        ["Bold", 33554454],
        ["Italic", 33554449],
        ["Bold Italic", 33554455],
        ["Light", 33554446],
        ["Black", 33554462],
      ]
    );
    assert.equal(FontRegistry.compareByWeight("Bold", "Regular"), 6);
    assert.equal(FontRegistry.findClosestStyle(["Regular", "Bold", "Light"], "Medium"), "Regular");
  });

  it("getScriptBlock maps code points to bitmask + table index", () => {
    assert.deepEqual(FontRegistry.getScriptBlock(65), [0, 0]);
    assert.deepEqual(FontRegistry.getScriptBlock(0x0410), [8, 3]);
    assert.deepEqual(FontRegistry.getScriptBlock(0x4e00), [128, 7]);
    assert.deepEqual(FontRegistry.getScriptBlock(0xac00), [64, 6]);
  });

  it("parseCatalogRow / serializeCatalogRow round-trip compression", () => {
    const row0 = FontRegistry.parseCatalogRow("Arial,Regular,ArialMT,15,0,", null);
    assert.deepEqual(row0, ["Arial", "Regular", "ArialMT", 15, 0, "fs/ArialMT.otf"]);
    const row1 = FontRegistry.parseCatalogRow(",Bold,Arial-BoldMT,15,0,", row0);
    assert.deepEqual(row1, ["Arial", "Bold", "Arial-BoldMT", 15, 0, "fs/Arial-BoldMT.otf"]);
    assert.equal(FontRegistry.serializeCatalogRow([...row1], row0), ",Bold,Arial-BoldMT,,,");
  });

  it("extractFamilyStyle returns family + style for a simple face", () => {
    const face = {
      name: {
        fontFamily: "Helvetica",
        fontSubfamily: "Bold",
        postScriptName: "Helvetica-Bold",
        fullName: "Helvetica Bold",
      },
      OS2: { usWeightClass: 700 },
    };
    assert.deepEqual(FontRegistry.extractFamilyStyle(face), ["Helvetica", "Bold"]);
  });

  it("getScriptNames lists scriptFallbackTable labels", () => {
    assert.deepEqual(FontRegistry.getScriptNames(), [
      "Latin-1",
      "Latin Ext. A",
      "Greek",
      "Cyrillic",
      "Hebrew",
      "Arabic",
      "Hangul",
      "Chi-Jap-Kor",
      "Tibetan",
      "Devanagari",
      "Thai",
      "Khmer",
      "Vietnamese",
    ]);
  });

  it("measureGlyphCoverageRatio uses Typr.U.codeToGlyph hits", () => {
    globalThis.Typr = {
      U: {
        codeToGlyph(_face, codePoint) {
          return codePoint === 65 ? 1 : 0;
        },
      },
    };
    assert.equal(FontRegistry.measureGlyphCoverageRatio({}, [65, 66]), 0.5);
  });

  it("photosuite:fontcatalog-changed clears lazy catalog maps", () => {
    FontRegistry.catalogMap = { X: 1 };
    FontRegistry.catalogMapByFamily = { a: 1 };
    FontRegistry.catalogMapBySubset = { b: 1 };
    window.dispatchEvent(new CustomEvent("photosuite:fontcatalog-changed"));
    assert.equal(FontRegistry.catalogMap, null);
    assert.equal(FontRegistry.catalogMapByFamily, null);
    assert.equal(FontRegistry.catalogMapBySubset, null);
  });

  it("lookupByFamilyStyle / getSubfamilyList after registerCatalogEntry", () => {
    const registry = new FontRegistry();
    FontRegistry.catalogMap = null;
    FontRegistry.catalogMapByFamily = null;
    FontRegistry.catalogMapBySubset = null;
    registry.registerCatalogEntry(["Arial", "Regular", "ArialMT", 15, 0, "sys:/x"]);
    registry.registerCatalogEntry(["Arial", "Bold", "Arial-BoldMT", 15, 0, "sys:/y"]);
    assert.deepEqual(registry.lookupByFamilyStyle("Arial", "Bold"), [
      "Arial",
      "Bold",
      "Arial-BoldMT",
      15,
      0,
      "sys:/y",
    ]);
    assert.deepEqual(registry.getSubfamilyList("Arial"), ["Regular", "Bold"]);
  });

  it("substitutionTable is the extracted fontSubstitutionTable export", async () => {
    const { fontSubstitutionTable } = await import(
      "../../src/fonts/font-substitution-table.js"
    );
    assert.equal(FontRegistry.substitutionTable, fontSubstitutionTable);
    assert.ok(Array.isArray(FontRegistry.substitutionTable.ArialMT));
  });
});
