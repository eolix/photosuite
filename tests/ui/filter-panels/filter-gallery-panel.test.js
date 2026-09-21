import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const panelPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/ui/filter-panels/filter-gallery-panel.js"
);

describe("ui/filter-panels/filter-gallery-panel.js", () => {
  it("documents GEfc wire keys and banded preview", () => {
    const source = fs.readFileSync(panelPath, "utf8");
    assert.match(source, /GEfc/);
    assert.match(source, /FilterBandRunner/);
    assert.match(source, /FilterGalleryThumbnailPanel/);
  });
});
