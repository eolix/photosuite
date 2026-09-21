/**
 * WebImagesDialog Openverse search helpers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

const enLocale = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../src/core/i18n/locales/en.json"),
    "utf8",
  ),
);
globalThis.I18N_DATA = {
  langs: [{ name: "English", code: "en", table: 0 }],
  tables: [enLocale],
};

let WebImagesDialog;
let buildOpenverseImagesSearchUrl;
let resolveTotalPages;
let computeRateLimitWaitMs;
let buildResultTooltip;
let buildPlacementName;
let formatPreviewStatusLine;

before(async () => {
  ({
    WebImagesDialog,
    buildOpenverseImagesSearchUrl,
    resolveTotalPages,
    computeRateLimitWaitMs,
    buildResultTooltip,
    buildPlacementName,
    formatPreviewStatusLine,
  } = await import("../../../src/ui/dialogs/web-images-dialog.js"));
});

describe("ui/dialogs/web-images-dialog.js", () => {
  it("buildResultTooltip goldens", () => {
    assert.equal(
      buildResultTooltip({
        title: "Sunset",
        creator: "Ada",
        license: "cc0",
        license_version: "1.0",
      }),
      "Sunset by Ada (CC0 1.0)",
    );
    assert.equal(buildResultTooltip({}), "Untitled");
  });

  it("buildPlacementName goldens", () => {
    assert.equal(buildPlacementName({ title: "a/b:c*.jpg" }), "abc.jpg.jpg");
    assert.equal(buildPlacementName({}), "openverse.jpg");
  });

  it("rate / page / URL constants and helpers", () => {
    assert.equal(WebImagesDialog.API_MIN_INTERVAL_MS, 1000);
    assert.equal(WebImagesDialog.LOAD_MORE_INTERVAL_MS, 3000);
    assert.equal(WebImagesDialog.PREVIEW_STAGGER_MS, 120);
    assert.equal(WebImagesDialog.BURST_EXHAUSTED_WAIT_MS, 60000);

    assert.equal(
      buildOpenverseImagesSearchUrl("cats", 2),
      "https://api.openverse.org/v1/images/"
        + "?q=cats&page=2&page_size=20&license_type=commercial,modification",
    );

    assert.equal(resolveTotalPages(5, 1, 20, false, 0), 5);
    assert.equal(resolveTotalPages(undefined, 1, 20, false, 0), 2);
    assert.equal(resolveTotalPages(undefined, 2, 20, true, 2), 3);
    assert.equal(resolveTotalPages(undefined, 1, 5, false, 0), 0);

    const burstZero = {
      getResponseHeader(name) {
        if (name === "X-RateLimit-Available-anon_burst") return "0";
        return null;
      },
      status: 200,
    };
    assert.equal(computeRateLimitWaitMs(burstZero, 60000), 60000);

    const retryAfter = {
      getResponseHeader(name) {
        if (name === "Retry-After") return "3";
        return null;
      },
      status: 200,
    };
    assert.equal(computeRateLimitWaitMs(retryAfter, 60000), 3000);

    assert.equal(
      formatPreviewStatusLine(0, "dogs"),
      "No loadable previews for \u201Cdogs\u201D.",
    );
    assert.equal(
      formatPreviewStatusLine(1, "dogs"),
      "1 preview \u2014 click to place into active document.",
    );
    assert.equal(
      formatPreviewStatusLine(2, "dogs"),
      "2 previews \u2014 click to place into active document.",
    );
  });
});
