/**
 * home-screen native file drop helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let homeScreenAcceptsFileDrop;
let dropPositionOverElement;
let DocumentTab;

before(async () => {
  ({ homeScreenAcceptsFileDrop, dropPositionOverElement } = await import(
    "../../../src/ui/shell/tauri-home-file-drop.js"
  ));
  ({ DocumentTab } = await import("../../../src/ui/layout/document-tab.js"));
});

describe("ui/shell/tauri-home-file-drop.js", () => {
  it("homeScreenAcceptsFileDrop requires intro with no open documents", () => {
    assert.equal(
      homeScreenAcceptsFileDrop({ appData: { intro: true }, openDocs: [] }),
      true
    );
    assert.equal(
      homeScreenAcceptsFileDrop({ appData: { intro: true }, openDocs: [{}] }),
      false
    );
    assert.equal(
      homeScreenAcceptsFileDrop({ appData: { intro: false }, openDocs: [] }),
      false
    );
  });

  it("dropPositionOverElement maps physical pixels to layout bounds", () => {
    const element = {
      getBoundingClientRect: function() {
        return { left: 100, top: 50, right: 300, bottom: 250 };
      }
    };
    assert.equal(dropPositionOverElement({ x: 150, y: 80 }, element), true);
    assert.equal(dropPositionOverElement({ x: 50, y: 80 }, element), false);
  });

  it("DocumentTab.isExternalFileDrag recognizes OS file drags", () => {
    assert.equal(
      DocumentTab.isExternalFileDrag({ dataTransfer: { types: ["Files"] } }),
      true
    );
    assert.equal(
      DocumentTab.isExternalFileDrag({
        dataTransfer: { types: ["text/plain", "Files"] }
      }),
      true
    );
    assert.equal(
      DocumentTab.isExternalFileDrag({ dataTransfer: { types: ["Text"] } }),
      false
    );
  });
});
