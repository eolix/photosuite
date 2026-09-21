/**
 * FileLoader / FileProcessor pure helpers (base64, encode specs, names), and
 * the open veil across a deferred parser fetch.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FileLoader;
let FileProcessor;
let parseEncodeFormatSpec;
let resolveLoadDisplayNames;
let shouldSkipZipEntry;
let bindFormatCodecMap;
let hasFormatLoaders;

before(async () => {
  ({
    FileLoader,
    FileProcessor,
    parseEncodeFormatSpec,
    resolveLoadDisplayNames,
    shouldSkipZipEntry
  } = await import("../../../src/ui/shell/file-loader.js"));
  ({ bindFormatCodecMap } = await import(
    "../../../src/document/formats/registry/registry-helpers.js"
  ));
  ({ hasFormatLoaders } = await import(
    "../../../src/document/formats/registry/format-loader-imports.js"
  ));
});

describe("ui/shell/file-loader.js", () => {
  it("parseEncodeFormatSpec jpg/webp quality and psd flags", () => {
    assert.deepEqual(parseEncodeFormatSpec("jpg:0.85"), {
      formatId: "jpg",
      encodeOptions: [85]
    });
    assert.deepEqual(parseEncodeFormatSpec("webp:1"), {
      formatId: "webp",
      encodeOptions: [100]
    });
    assert.deepEqual(parseEncodeFormatSpec("psd:full"), {
      formatId: "psd",
      encodeOptions: [true, true]
    });
    assert.deepEqual(parseEncodeFormatSpec("png"), {
      formatId: "png",
      encodeOptions: null
    });
  });

  // The document is named after the file it came from, so the loader keeps the
  // full file name next to the extension-less base name used for save defaults.
  it("resolveLoadDisplayNames from name and url", () => {
    assert.deepEqual(resolveLoadDisplayNames({ name: "photo.PSD" }), {
      fileName: "photo.PSD",
      baseName: "photo",
      displayName: "photo.PSD"
    });
    assert.deepEqual(resolveLoadDisplayNames({ name: "/home/pat/my.photo.jpg" }), {
      fileName: "my.photo.jpg",
      baseName: "my.photo",
      displayName: "/home/pat/my.photo.jpg"
    });
    assert.deepEqual(resolveLoadDisplayNames({ url: "https://x.test/a/b/c.png?v=2" }), {
      fileName: "c.png",
      baseName: "c",
      displayName: "https://x.test/a/b/c.png?v=2"
    });
    assert.deepEqual(resolveLoadDisplayNames({ url: "data:image/png;base64,xx" }), {
      fileName: "image",
      baseName: "image",
      displayName: "data:image/png;base64,xx"
    });
  });

  it("shouldSkipZipEntry filters metadata and empty", () => {
    assert.equal(shouldSkipZipEntry("__MACOSX/._foo", new Uint8Array([1])), true);
    assert.equal(shouldSkipZipEntry("meta.xml", new Uint8Array([1])), true);
    assert.equal(shouldSkipZipEntry("layer.png", new Uint8Array([])), true);
    assert.equal(shouldSkipZipEntry("layer.png", new Uint8Array([1, 2])), false);
  });

  it("exports FileLoader and FileProcessor", () => {
    assert.equal(typeof FileLoader, "function");
    assert.equal(typeof FileProcessor.processLoadedBytes, "function");
    assert.equal(typeof FileProcessor.encodeDocumentWithFormat, "function");
  });
});

/**
 * A file whose parser is not in the bundle opens in two passes: the first
 * reports "decode pending" and fetches the parser, the second decodes. The veil
 * covers the whole thing, so whoever reports pending owns hiding it — get that
 * wrong and the document appears underneath a "Loading..." panel that never
 * goes away.
 */
describe("ui/shell/file-loader.js deferred parser open", () => {
  it("keeps the veil up for the fetch and drops it once the retry decodes", async () => {
    assert.equal(hasFormatLoaders("fig"), false, "fig parser should start deferred");

    const decoded = [];
    bindFormatCodecMap({
      FIG: {
        isLayered: true,
        decode(bytes, doc) {
          decoded.push(doc.name);
        },
      },
    });

    let veilHidden = 0;
    const fileLoader = {
      hideOpenVeil() {
        veilHidden += 1;
      },
      dispatch() {},
    };

    // Not a recognisable magic number; the .fig name is what picks the format.
    const bytes = new Uint8Array([0, 0, 0, 0]).buffer;
    const pending = FileProcessor.dispatchOpenBytes(
      { name: "poster.fig" },
      bytes,
      fileLoader,
      null,
    );

    // First pass: parser not here yet, so nothing decoded and the veil stays.
    assert.equal(pending, true, "should report decode pending while fetching");
    assert.deepEqual(decoded, []);
    assert.equal(veilHidden, 0, "veil must stay up during the fetch");

    // Let the dynamic import and the retry it schedules run.
    for (let tick = 0; tick < 20 && decoded.length === 0; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.deepEqual(decoded, ["poster.fig"], "retry should decode the document");
    assert.equal(veilHidden, 1, "veil must come down exactly once, after the retry");
  });
});
