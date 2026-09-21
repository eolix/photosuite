/**
 * Adobe Illustrator import.
 *
 * An .ai file is one of two containers: a plain PostScript stream, or a PDF
 * whose Illustrator artwork hides in a private /AIMetaData object stream. The
 * loader picks between them from the third byte ('D' of "%PDF"), so that choice
 * is what these cover — a full artwork parse needs a real .ai document and is
 * exercised by the vector codec tests.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let AiFormatLoader;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ AiFormatLoader } = await import("../../../src/document/formats/ai-format.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

const bytesOf = (text) => new Uint8Array([...text].map((c) => c.charCodeAt(0))).buffer;

describe("document/formats/ai-format.js", () => {
  it("routes a PDF-container .ai through the /AIMetaData object stream", () => {
    // "%PDF" puts 'D' (68) at index 2, which is what selects the PDF branch.
    assert.throws(
      () => AiFormatLoader.parse(bytesOf("%PDF-1.5\n1 0 obj\n<< /Type /Catalog >>\n%%EOF\n"), {}),
      (thrown) => thrown === "ai: /AIMetaData not found in PDF",
      "a PDF container with no Illustrator payload must be reported, not silently emptied",
    );
  });

  it("rejects a PDF container whose /AIMetaData anchor is malformed", () => {
    // The reader walks back from the key to the opening '<' of its dictionary;
    // with no '<' before it there is nothing to parse.
    assert.throws(
      () => AiFormatLoader.parse(bytesOf("%PDF/AIMetaData 5 0 R\n"), {}),
      (thrown) => thrown === "ai: malformed /AIMetaData anchor",
    );
  });

  it("treats a stream that does not start with %PDF as raw PostScript", () => {
    // The PostScript branch reads the artwork tree directly, so it fails on the
    // missing structure rather than on the PDF object map.
    assert.throws(
      () => AiFormatLoader.parse(bytesOf("%!PS-Adobe-3.0\n%%EOF\n"), {}),
      (thrown) => thrown !== "ai: /AIMetaData not found in PDF",
    );
  });
});
