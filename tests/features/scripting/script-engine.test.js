/**
 * Golden values for script-engine pure helpers / builtins.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ScriptEngine;
let hasScriptHostBinding;

before(async () => {
  ({ ScriptEngine } = await import("../../../src/features/scripting/script-engine.js"));
  ({ hasScriptHostBinding } = await import(
    "../../../src/features/scripting/script-host-context.js"
  ));
});

describe("features/scripting/script-engine.js", () => {
  it("applyBinaryOperator / applyUnaryOperator match arithmetic", () => {
    assert.equal(ScriptEngine.applyBinaryOperator(2, 3, "+"), 5);
    assert.equal(ScriptEngine.applyBinaryOperator(10, 4, "-"), 6);
    assert.equal(ScriptEngine.applyBinaryOperator(3, 4, "*"), 12);
    assert.equal(ScriptEngine.applyUnaryOperator(5, "-"), -5);
    assert.equal(ScriptEngine.applyUnaryOperator(false, "!"), true);
  });

  it("scriptBuiltinEnums expose ExtendScript Units and DialogModes", () => {
    assert.equal(ScriptEngine.ScriptEval.scriptBuiltinEnums.Units.CM, 2);
    assert.equal(ScriptEngine.ScriptEval.scriptBuiltinEnums.Units.MM, 3);
    assert.equal(ScriptEngine.ScriptEval.scriptBuiltinEnums.DialogModes.ALL, 0);
    assert.equal(ScriptEngine.ScriptEval.scriptBuiltinEnums.DialogModes.NO, 2);
    assert.equal(ScriptEngine.ScriptEval.scriptBuiltinEnums.SaveDocumentType.PNG, "png");
    assert.equal(ScriptEngine.ScriptEval.scriptBuiltinEnums.BlendMode.HUE, "hue ");
  });

  it("rectToBoundsArray builds UnitValue corners", () => {
    assert.deepEqual(
      ScriptEngine.ScriptEval.rectToBoundsArray({ x: 1, y: 2, width: 3, height: 4 }, null),
      [
        { o: "UnitValue", value: 1 },
        { o: "UnitValue", value: 2 },
        { o: "UnitValue", value: 4 },
        { o: "UnitValue", value: 6 },
      ],
    );
  });

  it("charIDToTypeID / stringIDToTypeID alias maps match their golden values", () => {
    const appObj = { o: "Application", value: null };
    const stubDoc = {
      getCurrentDoc: () => null,
      openDocs: [],
      dispatch() {},
    };
    assert.equal(
      ScriptEngine.ScriptEval.invokeScriptObjectMethod(appObj, "charIDToTypeID", ["Mk"], stubDoc, {}),
      "make",
    );
    assert.equal(
      ScriptEngine.ScriptEval.invokeScriptObjectMethod(appObj, "charIDToTypeID", ["slct"], stubDoc, {}),
      "select",
    );
    assert.equal(
      ScriptEngine.ScriptEval.invokeScriptObjectMethod(appObj, "stringIDToTypeID", ["red"], stubDoc, {}),
      "Rd",
    );
    assert.equal(
      ScriptEngine.ScriptEval.invokeScriptObjectMethod(appObj, "stringIDToTypeID", ["unknown"], stubDoc, {}),
      "unknown",
    );
  });

  it("a script sees only the names bound in the script host context", () => {
    // The interpreter resolves free identifiers through script-host-context.js,
    // so the page and the module graph are out of a script's reach: `eval` and
    // `document` are simply names nobody bound.
    assert.equal(hasScriptHostBinding("Math"), true);
    assert.equal(hasScriptHostBinding("eval"), false);
    assert.equal(hasScriptHostBinding("document"), false);
    assert.equal(hasScriptHostBinding("postMessage"), false);
    assert.equal(hasScriptHostBinding("__TAURI__"), false);
  });

  it("resolveIdentifier hands back bound values and null for everything else", () => {
    const stubDoc = { getCurrentDoc: () => null, openDocs: [], dispatch() {} };
    const env = { __scriptGlobals: {} };
    assert.equal(ScriptEngine.resolveIdentifier("Math", stubDoc, env), Math);
    assert.equal(ScriptEngine.resolveIdentifier("document", stubDoc, env), null);
    // `window` in a script is the script's own globals object, not the page.
    assert.equal(ScriptEngine.resolveIdentifier("window", stubDoc, env), env.__scriptGlobals);
  });
});
