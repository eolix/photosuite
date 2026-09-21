/**
 * app version heading formatter.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

let formatAppVersionHeading;

before(async () => {
  ({ formatAppVersionHeading } = await import("../../src/core/app-version.js"));
});

describe("core/app-version.js", () => {
  it("formatAppVersionHeading shows a single package version", () => {
    assert.equal(formatAppVersionHeading("0.2.0"), "PhotoSuite 0.2.0");
    assert.equal(formatAppVersionHeading(""), "PhotoSuite");
    assert.equal(formatAppVersionHeading(null), "PhotoSuite");
  });
});
