import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

globalThis.I18N_DATA = {
  langs: [
    { name: "English", code: "en", table: 0 },
    { name: "French", code: "fr", table: 1 },
  ],
  tables: [{ hello: "Hello" }, { hello: "Bonjour" }],
};

let getAvailableLanguages;
let getTranslationTables;
let getTranslationTableByIndex;
let setTranslationTableByIndex;

before(async () => {
  const mod = await import("../../../src/core/i18n/i18n-store.js");
  getAvailableLanguages = mod.getAvailableLanguages;
  getTranslationTables = mod.getTranslationTables;
  getTranslationTableByIndex = mod.getTranslationTableByIndex;
  setTranslationTableByIndex = mod.setTranslationTableByIndex;
});

describe("core/i18n/i18n-store.js", () => {
  it("reads languages and tables from globalThis.I18N_DATA", () => {
    assert.equal(getAvailableLanguages().length, 2);
    assert.equal(getAvailableLanguages()[0].code, "en");
    assert.equal(getTranslationTables().length, 2);
    assert.equal(getTranslationTableByIndex(1).hello, "Bonjour");
  });

  it("setTranslationTableByIndex mutates the startup tables array", () => {
    setTranslationTableByIndex(0, { hello: "Hi" });
    assert.equal(getTranslationTableByIndex(0).hello, "Hi");
    setTranslationTableByIndex(0, { hello: "Hello" });
  });

  it("returns empty arrays when I18N_DATA is missing", () => {
    const saved = globalThis.I18N_DATA;
    globalThis.I18N_DATA = undefined;
    assert.deepEqual(getAvailableLanguages(), []);
    assert.deepEqual(getTranslationTables(), []);
    globalThis.I18N_DATA = saved;
  });

  it("setTranslationTableByIndex throws without I18N_DATA", () => {
    const saved = globalThis.I18N_DATA;
    globalThis.I18N_DATA = undefined;
    assert.throws(() => setTranslationTableByIndex(0, {}), /No i18n data/);
    globalThis.I18N_DATA = saved;
  });

});
