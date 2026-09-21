import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("filter-gallery/workers/filter-band-worker.js", () => {
  it("module loads as ESM worker script", async () => {
    const url = new URL("../../../../../src/features/filters/gallery/workers/filter-band-worker.js", import.meta.url);
    const source = await import("node:fs/promises").then((fs) => fs.readFile(url, "utf8"));
    assert.match(source, /FilterPixelOps\[job\.kernelName\]/);
    assert.match(source, /self\.onmessage/);
  });
});
