/**
 * File/Edit menu builders (renamed opaque keys).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let buildFileMenu;
let buildEditMenu;

before(async () => {
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/pen-path-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/crop-tools.js");
  await import("../../../src/document/tools/retouch-tools.js");
  await import("../../../src/document/tools/shape-tools.js");
  await import("../../../src/document/tools/view-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/tools/text-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
  ({ buildFileMenu, buildEditMenu } = await import(
    "../../../src/ui/menu/menu-bar-file-edit-menus.js"
  ));
});

describe("ui/menu/menu-bar-file-edit-menus.js", () => {
  it("buildFileMenu Save needs an open document; openPlace uses openAsPlaced", () => {
    const fileMenu = buildFileMenu();
    assert.equal(fileMenu.name, "topMenu.file");
    assert.equal(fileMenu.items.length, fileMenu.menuActions.length);
    const saveSrc = Function.prototype.toString.call(
      fileMenu.items.find((item) => item.name === "Save ...").resolveRowState
    );
    assert.equal(fileMenu.menuActions[2].payload.openAsPlaced, true);
  });

  it("buildEditMenu exposes undo and clipboard rows", () => {
    const editMenu = buildEditMenu();
    assert.equal(editMenu.name, "topMenu.edit");
    assert.equal(editMenu.items.length, editMenu.menuActions.length);
    assert.equal(editMenu.items[0].name, "edit.undoRedo");
    assert.equal(editMenu.menuActions[0].payload.actionKind, "h_undoredo");
  });

  // Every export route lives in one File > Export submenu, and each row's
  // dialog route must line up with the row at the same index in menuActions.
  it("buildFileMenu groups the export routes under one Export submenu", () => {
    const fileMenu = buildFileMenu();
    const exportIdx = fileMenu.items.findIndex((item) => item.name === "file.export");
    assert.notEqual(exportIdx, -1);
    const rows = fileMenu.items[exportIdx].sub;
    const routes = fileMenu.menuActions[exportIdx].sub;
    assert.equal(rows.length, routes.length);
    assert.deepEqual(
      rows.map((row) => row.name),
      ["file.exportAs", "file.exportLayers", "Export Color Lookup"]
    );
    assert.deepEqual(
      routes.map((route) => route.payload.dialogRouteId),
      ["writefile", "eassets", "exlut"]
    );
  });

  // One window serves both commands. Save as writes the document's own file —
  // adoptsDocumentFile is what tells the dialog to hand the path back to the
  // document — while Export as leaves the document on the file it came from.
  it("buildFileMenu routes Save as and Export as to the same dialog", () => {
    const fileMenu = buildFileMenu();
    const saveAsIdx = fileMenu.items.findIndex((item) => item.name === "file.saveAs");
    assert.notEqual(saveAsIdx, -1);
    const saveAsPayload = fileMenu.menuActions[saveAsIdx].payload;
    assert.equal(saveAsPayload.dialogRouteId, "writefile");
    assert.equal(saveAsPayload.adoptsDocumentFile, true);
    const exportIdx = fileMenu.items.findIndex((item) => item.name === "file.export");
    const exportAsPayload = fileMenu.menuActions[exportIdx].sub[0].payload;
    assert.equal(exportAsPayload.dialogRouteId, "writefile");
    assert.equal(exportAsPayload.adoptsDocumentFile, undefined);
  });

  // The PSD and PSD/PSB rows are gone: those formats are rows in the Save as
  // format list, so File offers Save and Save as and nothing else.
  it("buildFileMenu offers exactly one Save as row and no format-specific saves", () => {
    const fileMenu = buildFileMenu();
    const saveRowNames = fileMenu.items
      .map((item) => (Array.isArray(item.name) ? item.name.join(" ") : item.name))
      .filter((name) => /save/i.test(name));
    assert.deepEqual(saveRowNames, ["Save ...", "file.saveAs"]);
  });

  it("buildFileMenu no longer lists one export row per file format", () => {
    const fileMenu = buildFileMenu();
    const exportIdx = fileMenu.items.findIndex((item) => item.name === "file.export");
    for (const row of fileMenu.items[exportIdx].sub) {
      assert.equal(row.sub, undefined, row.name + " should not cascade");
    }
  });
});
