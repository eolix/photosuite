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
    // PSD ships in the startup bundle, so a script that writes one waits on nothing.
    assert.deepEqual(deferredWritersNamedBy('doc.saveAs("out.psd")'), []);
  });

  it("finds the format a saveAs path names, whatever the case", () => {
    assert.deepEqual(deferredWritersNamedBy('doc.saveAs("~/Desktop/art.cdr")'), ["cdr"]);
    assert.deepEqual(deferredWritersNamedBy('doc.saveAs("~/Desktop/ART.CDR")'), ["cdr"]);
  });

  it("finds a format named only in the export options", () => {
    const source = 'doc.exportDocument(f, ExportType.SAVEFORWEB, { fileFormatExtension: "svg" })';
    assert.deepEqual(deferredWritersNamedBy(source), ["svg"]);
  });

  it("collects every deferred format one script mentions", () => {
    const source = 'doc.saveAs("a.cdr"); doc.saveAs("b.svg"); doc.saveAs("c.png");';
    assert.deepEqual(deferredWritersNamedBy(source).sort(), ["cdr", "svg"]);
  });

  it("matches whole words only, so a longer name is not a false hit", () => {
    // "cdrish" is not the CorelDRAW writer, and fetching it would be wasted work.
    assert.deepEqual(deferredWritersNamedBy('var cdrish = 1; doc.saveAs("out.png")'), []);
  });

  it("stops asking for a writer that is already installed", async () => {
    const source = 'doc.saveAs("out.xcf")';
    assert.deepEqual(deferredWritersNamedBy(source), ["xcf"]);
    await ensureFormatLoaders("xcf");
    assert.deepEqual(deferredWritersNamedBy(source), [], "re-fetched an installed writer");
  });
});
