/**
 * Golden / contract tests for the app entry (src/main.js).
 * Import order and no top-level await are also gated by verify-bootstrap.mjs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainJsPath = path.join(repoRoot, "src/main.js");

// Golden: loader keys passed to FileFormatRegistry.installLoaders.
/**
 * What the bag holds at boot: the pieces every open needs, whatever the format.
 * A format's own parser is absent — `format-loader-imports.js` fetches it the
 * first time someone opens that kind of file. PSDParser is the exception: smart
 * objects and layer extraction encode through it from synchronous code, in
 * documents that were never opened from a .psd.
 */
const EXPECTED_LOADER_KEYS = [
  "VectorPageExporter",
  "VectorPageBuilder",
  "PathRecordCodec",
  "ChannelImageCodec",
  "PSDParser",
];

/** Parsers that must NOT be in the startup bundle. */
const LAZY_PARSER_MODULES = [
  "ai-format.js",
  "af-format.js",
  "cdr-format.js",
  "fig-format.js",
  "fpng-format.js",
  "sketch-format.js",
  "xd-format.js",
  "svg-format.js",
  "xcf-format.js",
];

describe("src/main.js (bootstrap entry)", () => {
  it("verify-bootstrap.mjs exits 0", () => {
    const result = spawnSync("node", ["scripts/verify-bootstrap.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || "verify-bootstrap failed");
  });


  it("buildFileFormatLoaderBag exposes the installLoaders key set", async () => {
    // main.js evaluates side-effect imports; stub enough globals for Node.
    const { installBrowserGlobals } = await import("./helpers/stub-browser-globals.js");
    installBrowserGlobals();

    // Dynamic import of main pulls the full app graph — too heavy for Node.
    // Assert the source bag keys match the golden list instead.
    const source = fs.readFileSync(mainJsPath, "utf8");
    for (const key of EXPECTED_LOADER_KEYS) {
      assert.match(source, new RegExp(`\\b${key}\\b`), `missing loader key ${key}`);
    }
    assert.match(source, /function buildFileFormatLoaderBag\s*\(/);
    assert.match(source, /FileFormatRegistry\.installLoaders\s*\(\s*buildFileFormatLoaderBag\s*\(\s*\)\s*\)/);
    assert.match(source, /initSystemFontsAsDefault\s*\(/);
    assert.match(source, /bootstrapApp\s*\(\s*\)\s*;/);
  });

  // Eleven thousand lines of format parsers between them. Importing one from
  // main.js puts it in the first bundle the window waits on, which is the cost
  // this deferral exists to avoid.
  it("no format parser is reachable from main.js", () => {
    const reached = new Set();
    (function walk(file) {
      if (reached.has(file) || !fs.existsSync(file)) return;
      reached.add(file);
      const source = fs.readFileSync(file, "utf8");
      const importRe =
        /^\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
      for (const match of source.matchAll(importRe)) {
        const spec = match[1] || match[2];
        if (!spec || !spec.startsWith(".")) continue;
        let target = path.resolve(path.dirname(file), spec);
        if (!target.endsWith(".js")) target += ".js";
        walk(target);
      }
    })(mainJsPath);

    const eager = LAZY_PARSER_MODULES.filter((name) =>
      [...reached].some((file) => file.endsWith(path.sep + name)),
    );
    assert.deepEqual(eager, [], "format parsers pulled into the startup bundle");
  });

  it("does not use top-level await", () => {
    const source = fs.readFileSync(mainJsPath, "utf8");
    const withoutImports = source.replace(/^\s*import\s+[\s\S]*?;?\s*$/gm, "");
    const stripped = withoutImports
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.equal(/^\s*await\b/m.test(stripped), false);
  });
});
