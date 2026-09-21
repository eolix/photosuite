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
let toPostScriptFallbackName;

before(async () => {
  ({
    getFontCatalog,
    setFontCatalog,
    buildFontCatalogFromSystemFonts,
    toPostScriptFallbackName,
  } = await import("../../src/fonts/system-font-catalog.js"));
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
        style: "Regular",
        postscript_name: "Helvetica",
        path: "/Library/Fonts/Helvetica.ttc",
      },
      {
        family: "Helvetica",
        style: "Italic",
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
});
