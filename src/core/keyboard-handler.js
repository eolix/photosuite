import { Point } from "./math/point.js";

/**
 * Tracks currently pressed keys and provides key-definition constants used
 * throughout the app for shortcut matching and display.
 *
 * One instance lives on {@link AppWindow}; layer-style dialogs create a local
 * instance when they need isolated shortcut handling.
 */
function KeyboardHandler() {
  /** @type {Set<string>} Physical key codes currently held down. */
  this.pressedKeys = new Set();
  this.initLayoutMap();
  window.__kb = this;
}

/**
 * Hardware layout map populated once on construction (async).
 * Maps physical key codes to the character printed on that key.
 * @type {KeyboardLayoutMap|null}
 */
KeyboardHandler.layoutMap = null;

KeyboardHandler.prototype.initLayoutMap = function () {
  var keyboard = navigator.keyboard;
  // Guard: getLayoutMap() throws in cross-origin iframes.
  if (keyboard && window.top === window.self) {
    keyboard.getLayoutMap().then(function (layoutMap) {
      KeyboardHandler.layoutMap = layoutMap;
    });
  }
};

KeyboardHandler.prototype.reset = function () {
  this.pressedKeys.clear();
};

KeyboardHandler.prototype.onKeyDown = function (code) {
  this.pressedKeys.add(code);
};

KeyboardHandler.prototype.onKeyUp = function (code) {
  this.pressedKeys.delete(code);
  // Reset entirely when no keys remain or when Meta is released.
  // On macOS the OS swallows keyup events for keys pressed while Cmd is held,
  // so releasing Cmd is the only reliable signal to clear phantom state.
  if (this.pressedKeys.size === 0 || KeyboardHandler.hasKeyCode(code, KeyboardHandler.Meta)) {
    this.reset();
  }
};

KeyboardHandler.prototype.isPressed = function (keyDef) {
  for (var i = 0; i < keyDef.codes.length; i++) {
    if (this.pressedKeys.has(keyDef.codes[i])) return true;
  }
  return false;
};

KeyboardHandler.prototype.getArrowMovement = function () {
  var step = this.isPressed(KeyboardHandler.Shift) ? 10 : 1;
  var dx = 0;
  var dy = 0;
  if (this.isPressed(KeyboardHandler.ArrowLeft))  dx = -step;
  if (this.isPressed(KeyboardHandler.ArrowRight)) dx = step;
  if (this.isPressed(KeyboardHandler.ArrowUp))    dy = -step;
  if (this.isPressed(KeyboardHandler.ArrowDown))  dy = step;
  return new Point(dx, dy);
};

KeyboardHandler.prototype.getActiveDigit = function () {
  var digitKeys = KeyboardHandler.DIGIT_KEYS;
  for (var i = 0; i < 10; i++) {
    if (this.isPressed(digitKeys[i])) return i;
  }
  return -1;
};

// ---------------------------------------------------------------------------
// Static utilities
// ---------------------------------------------------------------------------

KeyboardHandler.hasKeyCode = function (code, keyDef) {
  return keyDef.codes.indexOf(code) !== -1;
};

/**
 * Returns true when the browser's default behaviour should be suppressed.
 * Alt-only combos on passthrough keys (digits, +, -, [, ]) are allowed
 * through so OS-level shortcuts remain accessible.
 */
KeyboardHandler.shouldPreventDefault = function (event) {
  var code = event.code;
  if (code === "") return false;
  // The native macOS application menu owns the quit chord (⌘Q). Suppressing the
  // default here swallows the keystroke before the menu's Quit accelerator runs,
  // so let it pass through untouched.
  if (event.metaKey && code === "KeyQ") return false;
  if (event.altKey && !event.shiftKey && !event.ctrlKey) {
    var passthroughKeys = KeyboardHandler.PASSTHROUGH_KEYS;
    for (var i = 0; i < passthroughKeys.length; i++) {
      if (KeyboardHandler.hasKeyCode(code, passthroughKeys[i])) return false;
    }
  }
  return KeyboardHandler.isHandledKey(event);
};

/** Returns true when the app intercepts this keyboard event. */
KeyboardHandler.isHandledKey = function (event) {
  var code = event.code;
  if (code === "") return false;
  return !KeyboardHandler.IGNORED_KEYS.has(code) ||
    (event.shiftKey && (code === "F5" || code === "F6"));
};

/**
 * Renders a shortcut definition as a human-readable string.
 * @param {string|Array<{label:string,macLabel?:string}>} shortcut
 */
KeyboardHandler.formatShortcut = function (shortcut) {
  if (typeof shortcut === "string") return shortcut;
  if (shortcut == null) return "";
  var isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  var parts = [];
  for (var i = 0; i < shortcut.length; i++) {
    var key = shortcut[i];
    var label = key.label ? key.label : key;
    if (isMac && key.macLabel) label = key.macLabel;
    parts.push(label);
  }
  if (isMac || parts.length === 1) return parts.join(" + ");
  var lastKey = parts.pop();
  return parts.join("+") + " + " + lastKey;
};

/**
 * Normalises a raw key code for the current keyboard layout.
 * Prefers the hardware layout map (physical position); falls back to
 * `event.key` for non-QWERTY layouts.
 */
KeyboardHandler.normalizeKeyCode = function (event) {
  var code = event.code;
  var symbolOverrides = { "+": "NumpadAdd", "-": "NumpadSubtract", ".": "Period" };
  var layoutMap = KeyboardHandler.layoutMap;
  if (layoutMap) {
    var mapped = layoutMap.get(code);
    if (mapped) {
      mapped = mapped.toLowerCase();
      var charCode = mapped.charCodeAt(0);
      if (97 <= charCode && charCode <= 122) return "Key" + mapped.toUpperCase();
      if (symbolOverrides[mapped]) return symbolOverrides[mapped];
      return code;
    }
  }
  var key = event.key.toLowerCase();
  if (key.length === 1) {
    var keyCharCode = key.charCodeAt(0);
    if (97 <= keyCharCode && keyCharCode <= 122) return "Key" + key.toUpperCase();
    if (symbolOverrides[key]) return symbolOverrides[key];
  }
  if (key === "control" && code !== "") return "ControlLeft";
  return code;
};

// ---------------------------------------------------------------------------
// Key definitions — {label, macLabel?, codes[]}
// ---------------------------------------------------------------------------

KeyboardHandler.NoTouch      = { name: "No Touch", codes: ["NoTouch"] };
KeyboardHandler.Enter        = { label: "Enter",   codes: ["Enter", "NumpadEnter"] };
KeyboardHandler.Shift        = { label: "Shift",   macLabel: "⇧", codes: ["ShiftLeft", "ShiftRight"] };
KeyboardHandler.Meta         = { label: "Meta",    codes: ["MetaLeft", "MetaRight", "OSLeft", "OSRight"] };
KeyboardHandler.Ctrl         = { label: "Ctrl",    macLabel: "⌘", codes: "ControlLeft ControlRight MetaLeft MetaRight OSLeft OSRight".split(" ") };
KeyboardHandler.Alt          = { label: "Alt",     macLabel: "⌥", codes: ["AltLeft", "AltRight"] };
KeyboardHandler.CtrlOrAlt    = { label: "CtrlOrAlt", codes: KeyboardHandler.Ctrl.codes.concat(KeyboardHandler.Alt.codes) };
KeyboardHandler.Escape       = { label: "Escape",  codes: ["Escape"] };
KeyboardHandler.Space        = { label: "Space",   codes: ["Space"] };
KeyboardHandler.Tab          = { label: "Tab",     codes: ["Tab"] };
KeyboardHandler.Home         = { label: "Home",    codes: ["Home"] };
KeyboardHandler.End          = { label: "End",     codes: ["End"] };
KeyboardHandler.ArrowLeft    = { label: "Left",    codes: ["ArrowLeft"] };
KeyboardHandler.ArrowUp      = { label: "Up",      codes: ["ArrowUp"] };
KeyboardHandler.ArrowRight   = { label: "Right",   codes: ["ArrowRight"] };
KeyboardHandler.ArrowDown    = { label: "Down",    codes: ["ArrowDown"] };
KeyboardHandler.Plus         = { label: "+",       codes: ["NumpadAdd", "Equal"] };
KeyboardHandler.Minus        = { label: "-",       codes: ["NumpadSubtract", "Minus", "Slash"] };
KeyboardHandler.Semicolon    = { label: ";",       codes: ["Semicolon"] };
KeyboardHandler.Dead         = { label: "Dead",    codes: ["Dead"] };
KeyboardHandler.Equal        = { label: "=",       codes: ["Equal"] };
KeyboardHandler.Backspace    = { label: "Backspace", codes: ["Backspace"] };
KeyboardHandler.Delete       = { label: "Delete",  codes: ["Delete"] };
KeyboardHandler.Backslash    = { label: "Backslash", codes: ["Backslash", "IntlBackslash"] };
KeyboardHandler.Backquote    = { label: "Backquote", codes: ["Backquote"] };
KeyboardHandler.BracketLeft  = { label: "[",       codes: ["BracketLeft"] };
KeyboardHandler.BracketRight = { label: "]",       codes: ["BracketRight"] };
KeyboardHandler.Period       = { label: ".",       codes: ["Period"] };
KeyboardHandler.Comma        = { label: ",",       codes: ["Comma"] };
KeyboardHandler.Quote        = { label: "'",       codes: ["Quote"] };

KeyboardHandler.KeyA = { label: "A", codes: ["KeyA"] };
KeyboardHandler.KeyB = { label: "B", codes: ["KeyB"] };
KeyboardHandler.KeyC = { label: "C", codes: ["KeyC"] };
KeyboardHandler.KeyD = { label: "D", codes: ["KeyD"] };
KeyboardHandler.KeyE = { label: "E", codes: ["KeyE"] };
KeyboardHandler.KeyF = { label: "F", codes: ["KeyF"] };
KeyboardHandler.KeyG = { label: "G", codes: ["KeyG"] };
KeyboardHandler.KeyH = { label: "H", codes: ["KeyH"] };
KeyboardHandler.KeyI = { label: "I", codes: ["KeyI"] };
KeyboardHandler.KeyJ = { label: "J", codes: ["KeyJ"] };
KeyboardHandler.KeyK = { label: "K", codes: ["KeyK"] };
KeyboardHandler.KeyL = { label: "L", codes: ["KeyL"] };
KeyboardHandler.KeyM = { label: "M", codes: ["KeyM"] };
KeyboardHandler.KeyN = { label: "N", codes: ["KeyN"] };
KeyboardHandler.KeyO = { label: "O", codes: ["KeyO"] };
KeyboardHandler.KeyP = { label: "P", codes: ["KeyP"] };
KeyboardHandler.KeyQ = { label: "Q", codes: ["KeyQ"] };
KeyboardHandler.KeyR = { label: "R", codes: ["KeyR"] };
KeyboardHandler.KeyS = { label: "S", codes: ["KeyS"] };
KeyboardHandler.KeyT = { label: "T", codes: ["KeyT"] };
KeyboardHandler.KeyU = { label: "U", codes: ["KeyU"] };
KeyboardHandler.KeyV = { label: "V", codes: ["KeyV"] };
KeyboardHandler.KeyW = { label: "W", codes: ["KeyW"] };
KeyboardHandler.KeyX = { label: "X", codes: ["KeyX"] };
KeyboardHandler.KeyY = { label: "Y", codes: ["KeyY"] };
KeyboardHandler.KeyZ = { label: "Z", codes: ["KeyZ"] };

KeyboardHandler.Digit0 = { label: "0", codes: ["Numpad0", "Digit0"] };
KeyboardHandler.Digit1 = { label: "1", codes: ["Numpad1", "Digit1"] };
KeyboardHandler.Digit2 = { label: "2", codes: ["Numpad2", "Digit2"] };
KeyboardHandler.Digit3 = { label: "3", codes: ["Numpad3", "Digit3"] };
KeyboardHandler.Digit4 = { label: "4", codes: ["Numpad4", "Digit4"] };
KeyboardHandler.Digit5 = { label: "5", codes: ["Numpad5", "Digit5"] };
KeyboardHandler.Digit6 = { label: "6", codes: ["Numpad6", "Digit6"] };
KeyboardHandler.Digit7 = { label: "7", codes: ["Numpad7", "Digit7"] };
KeyboardHandler.Digit8 = { label: "8", codes: ["Numpad8", "Digit8"] };
KeyboardHandler.Digit9 = { label: "9", codes: ["Numpad9", "Digit9"] };

/** Ordered Digit0–Digit9 for index-based access (`DIGIT_KEYS[n]`). */
KeyboardHandler.DIGIT_KEYS = [
  KeyboardHandler.Digit0, KeyboardHandler.Digit1, KeyboardHandler.Digit2,
  KeyboardHandler.Digit3, KeyboardHandler.Digit4, KeyboardHandler.Digit5,
  KeyboardHandler.Digit6, KeyboardHandler.Digit7, KeyboardHandler.Digit8,
  KeyboardHandler.Digit9
];

KeyboardHandler.F1  = { label: "F1",  codes: ["F1"] };
KeyboardHandler.F2  = { label: "F2",  codes: ["F2"] };
KeyboardHandler.F3  = { label: "F3",  codes: ["F3"] };
KeyboardHandler.F4  = { label: "F4",  codes: ["F4"] };
KeyboardHandler.F5  = { label: "F5",  codes: ["F5"] };
KeyboardHandler.F6  = { label: "F6",  codes: ["F6"] };
KeyboardHandler.F7  = { label: "F7",  codes: ["F7"] };
KeyboardHandler.F8  = { label: "F8",  codes: ["F8"] };
KeyboardHandler.F9  = { label: "F9",  codes: ["F9"] };
KeyboardHandler.F10 = { label: "F10", codes: ["F10"] };
KeyboardHandler.F11 = { label: "F11", codes: ["F11"] };
KeyboardHandler.F12 = { label: "F12", codes: ["F12"] };

// Defined after all key refs are in place.
KeyboardHandler.IGNORED_KEYS = new Set(
  "ZoomToggle BrightnessDown BrightnessUp AudioVolumeMute AudioVolumeDown AudioVolumeUp LaunchApplication1 F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 Enter Shift Escape KeyV".split(" ")
);

/** Keys allowed through on Alt-only: digits and common zoom/bracket keys. */
KeyboardHandler.PASSTHROUGH_KEYS = KeyboardHandler.DIGIT_KEYS.concat([
  KeyboardHandler.Plus, KeyboardHandler.Minus,
  KeyboardHandler.BracketLeft, KeyboardHandler.BracketRight
]);

export { KeyboardHandler };

let opacityDigitMergeStartedAt = 0;

/**
 * Merge a digit keypress into a running opacity percent (0–100).
 * Digits typed within one second extend the current value; otherwise a fresh
 * tens digit starts (0 → 100).
 */
export function mergeOpacityDigitPercent(currentTens, pressedDigit) {
  let next;
  if (Date.now() - opacityDigitMergeStartedAt > 1000) {
    next = pressedDigit === 0 ? 100 : pressedDigit * 10;
  } else {
    let tens = currentTens;
    if (tens % 10 !== 0) tens *= 10;
    next = (tens + pressedDigit) % 100;
  }
  opacityDigitMergeStartedAt = Date.now();
  return next;
}
