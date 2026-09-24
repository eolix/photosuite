/**
 * A script writes files through `saveAs` / `exportDocument`, and the writer for
 * a format arrives in the same on-demand module as its parser. The evaluator is
 * synchronous, so `ScriptEngine.execute` has to fetch those writers up front —
 * which means first working out which ones the script could possibly reach for.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let deferredWritersNamedBy;
let ensureFormatLoaders;

before(async () => {
  ({ deferredWritersNamedBy } = await import("../../../src/features/scripting/script-engine.js"));
  ({ ensureFormatLoaders } = await import(
    "../../../src/document/formats/registry/format-loader-imports.js"
  ));
});

describe("features/scripting/script-engine.js deferred writers", () => {
  it("asks for nothing when the script names no deferred format", () => {
    assert.deepEqual(deferredWritersNamedBy('app.activeDocument.saveAs("out.png")'), []);
    assert.deepEqual(deferredWritersNamedBy(""), []);
  });

  it("finds the format a saveAs path names, whatever the case", () => {
    assert.deepEqual(deferredWritersNamedBy('doc.saveAs("~/Desktop/art.psd")'), ["psd"]);
    assert.deepEqual(deferredWritersNamedBy('doc.saveAs("~/Desktop/ART.PSD")'), ["psd"]);
  });

  it("finds a format named only in the export options", () => {
    const source = 'doc.exportDocument(f, ExportType.SAVEFORWEB, { fileFormatExtension: "svg" })';
    assert.deepEqual(deferredWritersNamedBy(source), ["svg"]);
  });

  it("collects every deferred format one script mentions", () => {
    const source = 'doc.saveAs("a.psd"); doc.saveAs("b.svg"); doc.saveAs("c.png");';
    assert.deepEqual(deferredWritersNamedBy(source).sort(), ["psd", "svg"]);
  });

  it("matches whole words only, so a longer name is not a false hit", () => {
    // "psdish" is not the PSD writer, and fetching it would be wasted work.
    assert.deepEqual(deferredWritersNamedBy('var psdish = 1; doc.saveAs("out.png")'), []);
  });

  it("stops asking for a writer that is already installed", async () => {
    const source = 'doc.saveAs("out.xcf")';
    assert.deepEqual(deferredWritersNamedBy(source), ["xcf"]);
    await ensureFormatLoaders("xcf");
    assert.deepEqual(deferredWritersNamedBy(source), [], "re-fetched an installed writer");
  });
});
