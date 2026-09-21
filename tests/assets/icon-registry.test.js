import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";
import {
  buildIconPathMap,
  getIconUrl,
  isIconTinted,
  overrideIcon,
} from "../../src/assets/icon-registry.js";

describe("assets/icon-registry.js", () => {
  it("buildIconPathMap resolves vector keys to /assets/ico and the rest to /assets/icons", () => {
    const map = buildIconPathMap();
    assert.equal(map["tools/brush"], "/assets/ico/tools/brush.svg");
    assert.equal(map["tools/hbrush"], "/assets/ico/tools/hbrush.svg");
    assert.equal(map["panels/layers"], "/assets/ico/panels/layers.svg");
    assert.equal(map.rotate, "/assets/ico/rotate.svg");
    assert.equal(map.zoomIn, "/assets/ico/zoomIn.svg");
    assert.equal(map["ui/menu"], "/assets/ico/ui/menu.svg");
    assert.equal(map["panels/navigator"], "/assets/ico/panels/navigator.svg");
  });

  it("buildIconPathMap includes every bundled icon key", async () => {
    const { readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const icoRoot = fileURLToPath(new URL("../../src/assets/ico", import.meta.url));
    // Every SVG shipped under assets/ico has to be reachable by key, or the UI
    // asks for an icon that is on disk and gets nothing back.
    const onDisk = readdirSync(icoRoot, { recursive: true })
      .filter((entry) => entry.endsWith(".svg"))
      .map((entry) => entry.slice(0, -4).split(sep).join("/"))
      .sort();
    const map = buildIconPathMap();
    const unregistered = onDisk.filter((key) => !(key in map));
    assert.deepEqual(unregistered, []);
    // The map is those icons and the intro mark, which lives outside assets/ico.
    assert.deepEqual(Object.keys(map).sort(), [...onDisk, "intro"].sort());
  });

  it("every mapped icon file exists on disk", async () => {
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const missing = Object.entries(buildIconPathMap())
      .filter(([, url]) => !existsSync(srcRoot + url))
      .map(([key]) => key);
    assert.deepEqual(missing, []);
  });

  it("an SVG in the vector directory is the icon that key resolves to", async () => {
    const { readdirSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const vectorRoot = fileURLToPath(new URL("../../src/assets/ico", import.meta.url));

    const collectSvgPaths = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? collectSvgPaths(join(dir, entry.name))
          : entry.name.endsWith(".svg")
            ? [join(dir, entry.name)]
            : [],
      );

    const map = buildIconPathMap();
    const unwired = collectSvgPaths(vectorRoot)
      .map((path) => relative(vectorRoot, path).replace(/\.svg$/, ""))
      .filter((key) => map[key] !== `/assets/ico/${key}.svg`);
    assert.deepEqual(unwired, []);
  });

  it("getIconUrl resolves a bundled key", () => {
    assert.equal(getIconUrl("tools/pen"), "/assets/ico/tools/pen.svg");
    assert.equal(getIconUrl("not-an-icon"), undefined);
  });

  // A launch configuration ships its own artwork for an icon. That artwork
  // carries its own colour, so the theme must stop inverting it.
  it("overrideIcon replaces the artwork and turns tinting off for that key", () => {
    assert.equal(isIconTinted("tools/pen"), true);
    overrideIcon("tools/pen", "https://example.invalid/pen.png");
    assert.equal(getIconUrl("tools/pen"), "https://example.invalid/pen.png");
    assert.equal(isIconTinted("tools/pen"), false);
    // Untouched keys keep the bundled artwork and stay tinted.
    assert.equal(isIconTinted("tools/brush"), true);
  });

});
