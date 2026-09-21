/**
 * The set of names a user script can see.
 *
 * `ScriptEngine` interprets scripts from an AST, so every free identifier is
 * resolved by this module rather than by the JavaScript engine. A script
 * therefore sees exactly three groups of names:
 *
 * 1. the language builtins in {@link SCRIPT_BUILTIN_BINDINGS},
 * 2. the application bindings installed at startup via
 *    {@link installScriptHostBindings} (the Photoshop scripting API surface,
 *    the document model types, the imaging namespaces),
 * 3. whatever the script itself declares.
 *
 * Every other name resolves to `null`. The page, the DOM, the Tauri bridge and
 * the module graph are not reachable from a script, and a script cannot reach
 * a binding by guessing at a name that startup did not install.
 */

/**
 * Language builtins available to scripts. These are the host's own objects:
 * scripts do arithmetic, string work and JSON with them, so they are bound
 * directly rather than proxied.
 */
export const SCRIPT_BUILTIN_BINDINGS = Object.freeze({
  Array,
  ArrayBuffer,
  Boolean,
  console,
  Date,
  Error,
  Float32Array,
  Infinity,
  JSON,
  Map,
  Math,
  NaN,
  Number,
  Object,
  Promise,
  RegExp,
  Set,
  String,
  Uint8Array,
  Uint8ClampedArray,
  decodeURI,
  decodeURIComponent,
  encodeURI,
  encodeURIComponent,
  isFinite,
  isNaN,
  parseFloat,
  parseInt,
});

/** name → value for everything a script may resolve. */
const scriptHostBindings = new Map(Object.entries(SCRIPT_BUILTIN_BINDINGS));

/**
 * Add application bindings to the script context. Called from startup wiring,
 * which is the one place that holds references to every layer. Later calls
 * overwrite earlier bindings of the same name.
 *
 * @param {Object<string, unknown>} bindings name → value to expose to scripts
 */
export function installScriptHostBindings(bindings) {
  for (const [name, value] of Object.entries(bindings)) {
    if (value === undefined) continue;
    scriptHostBindings.set(name, value);
  }
}

/**
 * Add every exported name of a module namespace as a binding. Skips names that
 * are already bound, so the caller's ordering decides which module wins a
 * collision.
 *
 * @param {Object} moduleNamespace an `import * as` namespace object
 */
export function installScriptHostModule(moduleNamespace) {
  for (const [name, value] of Object.entries(moduleNamespace)) {
    if (value === undefined || scriptHostBindings.has(name)) continue;
    scriptHostBindings.set(name, value);
  }
}

/** True when `name` is visible to scripts. */
export function hasScriptHostBinding(name) {
  return scriptHostBindings.has(name);
}

/** The value bound to `name`, or `undefined` when the name is not visible. */
export function getScriptHostBinding(name) {
  return scriptHostBindings.get(name);
}

/** Every visible name, sorted — for diagnostics and tests. */
export function listScriptHostBindingNames() {
  return [...scriptHostBindings.keys()].sort();
}
