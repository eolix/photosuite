/**
 * `core/startup-wiring.js` is the single place where the layers are joined: it
 * binds the names user scripts can resolve and runs the registration steps the
 * first paint depends on.
 * It reaches into every layer, so importing it here would pull in the whole
 * application; these checks read the source instead, and guard the property
 * that makes the rest of the tree navigable — the application surface is not
 * mirrored onto `globalThis` for anyone to pick up implicitly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const startupWiringPath = path.join(repoRoot, "src/core/startup-wiring.js");
const source = fs.readFileSync(startupWiringPath, "utf8");

describe("core/startup-wiring.js bootstrap contract", () => {
  it("runs the startup steps", () => {
    assert.match(source, /installScriptHostContext\(\);/);
    assert.match(source, /installBlockedDialogFallback\(\);/);
    assert.match(source, /installLayerSymbolBridges\(\);/);
    assert.match(source, /warmupRotateCursorAsset\(\);/);
  });

  it("binds the app surface and model types into the script host context", () => {
    assert.match(source, /installScriptHostModule\(moduleNamespace\)/);
    assert.match(source, /CORE_SCRIPT_HOST_MODULES/);
    assert.match(source, /installScriptHostBindings\(MODEL_TYPE_EXPORTS\)/);
    assert.match(source, /AxisDragAnchor/);
  });

  it("assigns nothing onto globalThis beyond the dialog fallback", () => {
    const assignments = [...source.matchAll(/globalThis\.(\w+)\s*(?:\?\?|\|\|)?=[^=]/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(assignments, ["confirm"]);
  });

  it("hands the webview's own confirm to user-prompts before wrapping it", () => {
    assert.match(source, /installWebviewConfirm\(originalConfirm\)/);
  });
});
