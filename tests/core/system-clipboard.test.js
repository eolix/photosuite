import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clipboardPath = path.join(repoRoot, "src/core/system-clipboard.js");

let clipboardImageSignature;
let isStaleClipboardFrame;
let CLIPBOARD_SIGNATURE_PENDING;

before(async () => {
  ({ clipboardImageSignature, isStaleClipboardFrame, CLIPBOARD_SIGNATURE_PENDING } = await import(
    "../../src/core/system-clipboard.js"
  ));
});

describe("core/system-clipboard.js", () => {
  it("exports clipboard helpers for Tauri plugin", () => {
    const source = fs.readFileSync(clipboardPath, "utf8");
    assert.match(source, /export function getTauriClipboardManager/);
    assert.match(source, /export function writeClipboardText/);
    assert.match(source, /export function writeClipboardRgba/);
    assert.match(source, /export function readClipboardText/);
    assert.match(source, /export function readSystemClipboardForPaste/);
    assert.match(source, /export function readClipboardImageSignature/);
  });

  it("routes vector path clipboard via uiDispatch wire payload", () => {
    const source = fs.readFileSync(clipboardPath, "utf8");
    assert.match(source, /pasteVectorPathsFromClipboard/);
    assert.match(source, /value:\s*text/);
    assert.match(source, /indexOf\("vcb;"\)/);
  });

  it("caps OS clipboard RGBA writes", () => {
    const source = fs.readFileSync(clipboardPath, "utf8");
    assert.match(source, /OS_CLIPBOARD_WRITE_MAX_PIXELS\s*=\s*1024 \* 1024/);
  });

  describe("clipboardImageSignature", () => {
    it("is width x height for a real frame", () => {
      assert.equal(clipboardImageSignature({ width: 4000, height: 3000 }), "4000x3000");
      assert.equal(clipboardImageSignature({ width: 512, height: 512 }), "512x512");
    });
    it("is 'none' for absent or empty frames", () => {
      assert.equal(clipboardImageSignature(null), "none");
      assert.equal(clipboardImageSignature({ width: 0, height: 0 }), "none");
      assert.equal(clipboardImageSignature({ width: 10 }), "none");
    });
  });

  describe("isStaleClipboardFrame — paste prefers in-app payload when pasteboard is unchanged", () => {
    const car = { width: 4000, height: 3000 };
    const pngIcon = { width: 512, height: 512 };
    const external = { width: 800, height: 600 };

    it("no frame is never stale", () => {
      assert.equal(isStaleClipboardFrame(null, "512x512"), false);
    });

    it("no baseline (no in-app copy tracked) → external content wins", () => {
      assert.equal(isStaleClipboardFrame(external, null), false);
      assert.equal(isStaleClipboardFrame(external, undefined), false);
    });

    it("pending baseline (copy just happened, probe not resolved) → treat OS image as stale", () => {
      // A large copy leaves a stale PNG-file icon on the pasteboard while the real
      // image is still being written; nothing may import it in that window.
      assert.equal(isStaleClipboardFrame(pngIcon, CLIPBOARD_SIGNATURE_PENDING), true);
      assert.equal(isStaleClipboardFrame(car, CLIPBOARD_SIGNATURE_PENDING), true);
    });

    it("pasteboard unchanged since copy (matches baseline) → stale, use in-app payload", () => {
      assert.equal(isStaleClipboardFrame(pngIcon, "512x512"), true);
    });

    it("pasteboard changed since copy (another app copied) → not stale, import it", () => {
      assert.equal(isStaleClipboardFrame(external, "512x512"), false);
    });
  });
});
