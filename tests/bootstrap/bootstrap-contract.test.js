import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mainJsPath = path.join(repoRoot, "src/main.js");
const iconRegistryPath = path.join(repoRoot, "src/assets/icon-registry.js");

describe("bootstrap contract", () => {
  it("verify-bootstrap.mjs exits 0", () => {
    const result = spawnSync("node", ["scripts/verify-bootstrap.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout || "verify-bootstrap failed"
    );
  });

  it("the icon registry offers lookup, override and tint queries", () => {
    // Panels read an icon by key, a launch configuration replaces one, and the
    // theme asks whether it may tint it.
    const source = fs.readFileSync(iconRegistryPath, "utf8");
    for (const fn of ["getIconUrl", "overrideIcon", "isIconTinted"]) {
      assert.match(source, new RegExp(`export function ${fn}\\b`));
    }
  });
});
