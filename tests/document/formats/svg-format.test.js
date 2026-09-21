import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let SVGLoader;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/formats/registry/file-format-registry.js");
  ({ SVGLoader } = await import("../../../src/document/formats/svg-format.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/svg-format.js", () => {
  it("exports parse and exportSvg entry points", () => {
    assert.equal(typeof SVGLoader.parse, "function");
    assert.equal(typeof SVGLoader.exportSvg, "function");
  });

  it("getTagName returns the local part of a tag name", () => {
    assert.equal(SVGLoader.getTagName({ tagName: "svg:rect" }), "rect");
    assert.equal(SVGLoader.getTagName({ tagName: "g" }), "g");
    assert.equal(SVGLoader.getTagName({ tagName: null }), null);
  });

  it("parseNumberList splits space- or comma-separated numbers", () => {
    assert.deepEqual(SVGLoader.parseNumberList("0 0 100 50"), [0, 0, 100, 50]);
    assert.deepEqual(SVGLoader.parseNumberList("1,2,3"), [1, 2, 3]);
  });

  it("parseLength resolves em/m units against the default size", () => {
    assert.equal(SVGLoader.parseLength("2em", 10), 20);
    assert.equal(SVGLoader.parseLength("5em", 10), 50);
    assert.equal(SVGLoader.parseLength("50px", 10), 50);
    assert.equal(SVGLoader.parseLength("12", 10), 12);
  });

  it("formatNumber trims to 3 decimals and drops trailing zeros", () => {
    assert.equal(SVGLoader.formatNumber(1.23456), "1.235");
    assert.equal(SVGLoader.formatNumber(2), "2");
    assert.equal(SVGLoader.formatNumber(0.1), "0.1");
  });

  it("escapeXml escapes &, <, >, and double quotes", () => {
    assert.equal(SVGLoader.escapeXml("a<b>&\"c"), "a&lt;b&gt;&amp;&quot;c");
  });

  it("matrixToTransformAttr formats a matrix() transform", () => {
    assert.equal(
      SVGLoader.matrixToTransformAttr(new Matrix2D(1, 0, 0, 1, 10, 20)),
      "matrix(1,0,0,1,10,20)",
    );
    assert.equal(
      SVGLoader.matrixToTransformAttr(new Matrix2D(2, 0, 0, 3, 1.5, -4)),
      "matrix(2,0,0,3,1.5,-4)",
    );
  });

  it("getHref prefers xlink:href, falling back to href", () => {
    const withXlink = { getAttribute: (n) => (n === "xlink:href" ? "#a" : null) };
    assert.equal(SVGLoader.getHref(withXlink), "#a");
    const withHref = { getAttribute: (n) => (n === "href" ? "#b" : null) };
    assert.equal(SVGLoader.getHref(withHref), "#b");
  });
});
