/**
 * Golden I/O for system font catalog store + builder.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

const catalogListeners = new Map();
window.addEventListener = function (type, handler) {
  if (!catalogListeners.has(type)) catalogListeners.set(type, []);
  catalogListeners.get(type).push(handler);
};
window.dispatchEvent = function (event) {
  const handlers = catalogListeners.get(event && event.type) || [];
  for (const handler of handlers) handler(event);
  return true;
};
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

let getFontCatalog;
let setFontCatalog;
let buildFontCatalogFromSystemFonts;
let systemFontStyleName;
let FontRegistry;
let toPostScriptFallbackName;

before(async () => {
  ({
    getFontCatalog,
    setFontCatalog,
    buildFontCatalogFromSystemFonts,
    systemFontStyleName,
    toPostScriptFallbackName,
  } = await import("../../src/fonts/system-font-catalog.js"));
  ({ FontRegistry } = await import("../../src/fonts/font-registry.js"));
});

describe("fonts/system-font-catalog.js (catalog store + builder goldens)", () => {
  it("getFontCatalog returns the empty System placeholder before set", () => {
    assert.deepEqual(getFontCatalog(), {
      subsetNames: [],
      cats: ["System"],
      list: [],
      hasSpriteSheet: false,
    });
  });

  it("setFontCatalog stores the catalog and dispatches photosuite:fontcatalog-changed", () => {
    let fired = 0;
    window.addEventListener("photosuite:fontcatalog-changed", () => {
      fired++;
    });
    const catalog = {
      subsetNames: ["Latin"],
      cats: ["System"],
      list: ["Arial,Regular,ArialMT,8191,0,sys:/x"],
      hasSpriteSheet: false,
    };
    setFontCatalog(catalog);
    assert.equal(getFontCatalog(), catalog);
    assert.equal(fired, 1);
  });

  it("getFontCatalog rejects a catalog missing list or cats arrays", () => {
    setFontCatalog({ subsetNames: [], cats: "System", list: [] });
    assert.deepEqual(getFontCatalog(), {
      subsetNames: [],
      cats: ["System"],
      list: [],
      hasSpriteSheet: false,
    });
  });

  it("toPostScriptFallbackName joins family-style and strips spaces", () => {
    assert.equal(toPostScriptFallbackName("Deja Vu", "Bold Italic"), "DejaVu-BoldItalic");
  });

  it("buildFontCatalogFromSystemFonts emits CSV rows with sys: file keys", () => {
    const catalog = buildFontCatalogFromSystemFonts([
      {
        family: "Helvetica",
        slant: "Regular",
        weight: 400,
        stretch: "Normal",
        postscript_name: "Helvetica",
        path: "/Library/Fonts/Helvetica.ttc",
      },
      {
        family: "Helvetica",
        slant: "Italic",
        weight: 400,
        stretch: "Normal",
        postscript_name: "Helvetica Oblique",
        path: "/Library/Fonts/Helvetica.ttc",
      },
      { family: "", path: "/skip" },
    ]);
    assert.deepEqual(catalog.cats, ["System"]);
    assert.equal(catalog.hasSpriteSheet, false);
    assert.equal(catalog.list.length, 2);
    assert.equal(
      catalog.list[0],
      "Helvetica,Regular,Helvetica,8191,0,sys:/Library/Fonts/Helvetica.ttc",
    );
    assert.equal(
      catalog.list[1],
      "Helvetica,Italic,Helvetica-Oblique,8191,0,sys:/Library/Fonts/Helvetica.ttc",
    );
  });

  // The bug this replaced: Arial ships four faces, the host reported them as
  // two upright and two italic, and the family+style key kept whichever the
  // platform enumerated last — so Regular drew in Arial Bold on Windows.
  it("keeps a family's four faces apart by weight, not just slant", () => {
    const arialFaces = [
      { family: "Arial", slant: "Normal", weight: 700, postscript_name: "Arial-BoldMT", path: "/f/arialbd.ttf" },
      { family: "Arial", slant: "Regular", weight: 400, postscript_name: "ArialMT", path: "/f/arial.ttf" },
      { family: "Arial", slant: "Italic", weight: 700, postscript_name: "Arial-BoldItalicMT", path: "/f/arialbi.ttf" },
      { family: "Arial", slant: "Italic", weight: 400, postscript_name: "Arial-ItalicMT", path: "/f/ariali.ttf" },
    ];
    const rows = buildFontCatalogFromSystemFonts(arialFaces).list.map((row) => row.split(","));
    assert.deepEqual(rows.map((row) => row[1]), ["Bold", "Regular", "Bold Italic", "Italic"]);
    const fileForStyle = Object.fromEntries(rows.map((row) => [row[1], row[5]]));
    assert.equal(fileForStyle.Regular, "sys:/f/arial.ttf", "Regular must not resolve to the bold file");
    assert.equal(fileForStyle.Bold, "sys:/f/arialbd.ttf");
  });

  it("names a face from its width, weight and slant", () => {
    const nameOf = (face) => systemFontStyleName(face);
    assert.equal(nameOf({ slant: "Regular", weight: 400, stretch: "Normal" }), "Regular");
    assert.equal(nameOf({ slant: "Italic", weight: 400, stretch: "Normal" }), "Italic");
    assert.equal(nameOf({ slant: "Regular", weight: 700, stretch: "Normal" }), "Bold");
    assert.equal(nameOf({ slant: "Italic", weight: 700, stretch: "Normal" }), "Bold Italic");
    assert.equal(nameOf({ slant: "Regular", weight: 300, stretch: "Condensed" }), "Condensed Light");
    assert.equal(nameOf({ slant: "Oblique", weight: 900, stretch: "Normal" }), "Black Oblique");
    // A weight between two classes takes the nearer one.
    assert.equal(nameOf({ slant: "Regular", weight: 350, stretch: "Normal" }), "Regular");
    assert.equal(nameOf({ slant: "Regular", weight: 600, stretch: "Normal" }), "SemiBold");
    // A host entry missing the fields at all is still a usable Regular.
    assert.equal(nameOf({}), "Regular");
  });

  // The style dropdown sorts with this, so the composed names have to carry the
  // weight in a word the registry's vocabulary knows.
  it("names styles the font registry can sort by weight", () => {
    const styles = ["Bold", "Regular", "Bold Italic", "Italic"];
    assert.deepEqual(styles.slice().sort(FontRegistry.compareByWeight), [
      "Regular",
      "Italic",
      "Bold",
      "Bold Italic",
    ]);
  });
});
