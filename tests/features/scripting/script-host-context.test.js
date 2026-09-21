/**
 * The script host context is the boundary between user scripts and the
 * application: a script can only name what startup bound here, so these tests
 * pin both halves — what is reachable, and what is not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SCRIPT_BUILTIN_BINDINGS,
  getScriptHostBinding,
  hasScriptHostBinding,
  installScriptHostBindings,
  installScriptHostModule,
  listScriptHostBindingNames,
} from "../../../src/features/scripting/script-host-context.js";

describe("features/scripting/script-host-context.js", () => {
  it("binds the language builtins a script does arithmetic and JSON with", () => {
    assert.equal(getScriptHostBinding("Math"), Math);
    assert.equal(getScriptHostBinding("JSON"), JSON);
    assert.equal(getScriptHostBinding("parseInt"), parseInt);
    assert.equal(SCRIPT_BUILTIN_BINDINGS.Date, Date);
  });

  it("binds nothing that would let a script out of the sandbox", () => {
    for (const escapeHatch of [
      "eval",
      "Function",
      "document",
      "window",
      "globalThis",
      "postMessage",
      "fetch",
      "import",
      "__TAURI__",
      "localStorage",
    ]) {
      assert.equal(hasScriptHostBinding(escapeHatch), false, escapeHatch);
    }
  });

  it("installScriptHostBindings adds names and overwrites on a repeat install", () => {
    installScriptHostBindings({ testOnlyBindingA: 1 });
    assert.equal(getScriptHostBinding("testOnlyBindingA"), 1);
    installScriptHostBindings({ testOnlyBindingA: 2 });
    assert.equal(getScriptHostBinding("testOnlyBindingA"), 2);
  });

  it("installScriptHostBindings skips undefined values", () => {
    installScriptHostBindings({ testOnlyUndefined: undefined });
    assert.equal(hasScriptHostBinding("testOnlyUndefined"), false);
  });

  it("installScriptHostModule keeps the first module to claim a name", () => {
    installScriptHostModule({ testOnlyModuleName: "first" });
    installScriptHostModule({ testOnlyModuleName: "second" });
    assert.equal(getScriptHostBinding("testOnlyModuleName"), "first");
  });

  it("listScriptHostBindingNames reports the visible names, sorted", () => {
    const names = listScriptHostBindingNames();
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes("Math"));
  });
});
