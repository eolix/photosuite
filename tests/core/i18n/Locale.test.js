import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.I18N_DATA = {
  langs: [{ name: "English", code: "en", table: 0 }],
  tables: [
    {
      greet: { hello: "Hello::h" },
      tpl: { welcome: "Hi VAR0" },
      nested: { deep: { leaf: "Found" } },
    },
  ],
};

let Locale;

before(async () => {
  ({ Locale } = await import("../../../src/core/i18n/locale.js"));
  Locale.activeTableIndex = 0;
  Locale.numericKeyCache = {};
});

describe("core/i18n/Locale.js", () => {
  it("parseBracketDelimitedTable parses semicolon segments", () => {
    assert.deepEqual(Locale.parseBracketDelimitedTable("a;b;"), ["a", "b"]);
    assert.deepEqual(Locale.parseBracketDelimitedTable("x;[y;z;]"), [
      "x",
      ["y", "z", null],
    ]);
  });

  it("Locale.get resolves dot paths and strips shortcut suffix", () => {
    assert.equal(Locale.get("greet.hello"), "Hello");
    assert.equal(Locale.get("nested.deep.leaf"), "Found");
    assert.equal(Locale.get("missing.key"), "missing.key");
  });

  it("Locale.get fills VAR placeholders from part paths", () => {
    assert.equal(Locale.get(["tpl.welcome", "greet.hello"]), "Hi Hello");
  });

  it("registerNumericKeys resolves numeric path arrays", () => {
    Locale.registerNumericKeys([[1, 2], "Numeric message"]);
    assert.equal(Locale.get([1, 2]), "Numeric message");
  });

  it("language helpers use I18N_DATA", () => {
    assert.equal(Locale.getCurrentLanguageCode(), "en");
    Locale.setLanguageByCode("en");
    assert.equal(Locale.findLanguageIndex("en"), 0);
    assert.equal(Locale.findLanguageIndex("zz"), -1);
  });

});
