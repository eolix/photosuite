/**
 * files handed to the app by the operating system.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let openFilePathsFromOs;

before(async () => {
  ({ openFilePathsFromOs } = await import(
    "../../../src/ui/shell/file-loader.js"
  ));
});

/** Records what the controller was asked to open. */
function makeController() {
  const opened = [];
  return {
    opened,
    fileLoader: {
      openFileByPath(filePath, fileName) {
        opened.push([filePath, fileName]);
      }
    }
  };
}

describe("ui/shell/file-loader.js — OS file opens", () => {
  it("opens every path the OS supplies, in its own tab", () => {
    const controller = makeController();
    openFilePathsFromOs(controller, ["/a/one.psd", "/b/two.png"]);
    assert.deepEqual(controller.opened, [
      ["/a/one.psd", "one.psd"],
      ["/b/two.png", "two.png"]
    ]);
  });

  it("ignores empty and malformed payloads", () => {
    const controller = makeController();
    openFilePathsFromOs(controller, []);
    openFilePathsFromOs(controller, null);
    openFilePathsFromOs(controller, ["", 42, null]);
    openFilePathsFromOs({}, ["/a/one.psd"]);
    assert.deepEqual(controller.opened, []);
  });

  it("associates exactly the extensions the open dialog accepts", () => {
    // The OS only offers PhotoSuite for extensions declared in the bundle config.
    // Anything the dialog accepts but the config omits is a file the user can
    // open from inside the app yet cannot double-click.
    const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
    const listStart = rust.indexOf("const IMAGE_OPEN_EXTENSIONS");
    const dialogList = rust.slice(listStart, rust.indexOf("];", listStart));
    const dialogExts = new Set(dialogList.match(/"([a-z0-9]+)"/g).map((q) => q.slice(1, -1)));

    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const associated = new Set(
      conf.bundle.fileAssociations.flatMap((association) => association.ext)
    );

    const missing = [...dialogExts].filter((ext) => !associated.has(ext));
    const extra = [...associated].filter((ext) => !dialogExts.has(ext));
    assert.deepEqual(missing, [], "extensions the dialog opens but the OS is never told about");
    assert.deepEqual(extra, [], "extensions claimed from the OS that the app cannot open");
  });
});
