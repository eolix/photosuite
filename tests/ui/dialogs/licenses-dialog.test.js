/**
 * Licences dialog: the Markdown subset the notices file is rendered with.
 *
 * The text is injected as HTML, so escaping is the part that matters most, and
 * it is checked against the real THIRD-PARTY-NOTICES.md rather than a fixture —
 * that file is what the dialog shows, and it is the one that changes.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let renderNoticesHtml;

before(async () => {
  ({ renderNoticesHtml } = await import("../../../src/ui/dialogs/licenses-dialog.js"));
});

describe("ui/dialogs/licenses-dialog.js", () => {
  it("renders headings, paragraphs and lists", () => {
    const html = renderNoticesHtml("# Title\n\nA line\nand its continuation.\n\n- first\n- second\n");
    assert.equal(
      html,
      "<h1>Title</h1><p>A line and its continuation.</p><ul><li>first</li><li>second</li></ul>",
    );
  });

  it("renders a table, dropping the dashed separator row", () => {
    const html = renderNoticesHtml("| Crate | Licence |\n|-------|---------|\n| serde | MIT |\n");
    assert.equal(
      html,
      "<table><tr><th>Crate</th><th>Licence</th></tr><tr><td>serde</td><td>MIT</td></tr></table>",
    );
  });

  it("keeps link text and drops the target", () => {
    // An anchor inside the webview would navigate the app away from itself.
    const html = renderNoticesHtml("See [libheif](https://github.com/strukturag/libheif) for this.");
    assert.equal(html, "<p>See libheif for this.</p>");
    assert.equal(html.includes("http"), false);
  });

  it("escapes markup in the source before any of it is applied", () => {
    const html = renderNoticesHtml("## <script>alert(1)</script>\n\n<img src=x onerror=y>\n");
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<img"), false);
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("keeps code blocks verbatim and escaped", () => {
    const html = renderNoticesHtml("```sh\nnode scripts/gen-crate-notices.mjs\n```\n");
    assert.equal(html, "<pre>node scripts/gen-crate-notices.mjs\n</pre>");
  });

  it("renders the notices file the dialog actually shows", () => {
    const markdown = fs.readFileSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.md"), "utf8");
    const html = renderNoticesHtml(markdown);
    // The notices the LGPL asks to be visible in the application itself.
    assert.ok(html.includes("This product includes"), "the LGPL notices did not render");
    assert.ok(html.includes("<h2>GNU Lesser General Public License</h2>"));
    assert.ok(html.includes("Apache License"), "the pdf.js notice did not render");
    assert.ok(html.includes("<table>"), "the crate list did not render");
    // Generated-section markers are structure, not content.
    assert.equal(html.includes("BEGIN GENERATED"), false);
    assert.equal(html.includes("<!--"), false);
  });
});
