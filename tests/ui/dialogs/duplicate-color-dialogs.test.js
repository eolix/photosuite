/**
 * Duplicate Into and Colour Range.
 *
 * DuplicateIntoDialog lists every open document plus a "new project" entry as
 * the duplication target; the name field is only live for that last entry,
 * because an existing document already has a name. Its OK path dispatches a
 * pasteLayers documentAction carrying the source and target documents.
 *
 * Constructing these boots the widget stack, so the prototype methods are
 * driven against the widget state they actually read.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let DuplicateIntoDialog;
let ColorRangeDialog;

before(async () => {
  ({ DuplicateIntoDialog, ColorRangeDialog } = await import(
    "../../../src/ui/dialogs/duplicate-color-dialogs.js"
  ));
});

/** A DuplicateIntoDialog with recording stand-ins for its two widgets. */
function duplicateDialogSpy() {
  const dialog = Object.create(DuplicateIntoDialog.prototype);
  let dropdownValue = 0;
  dialog.destinationDropdown = {
    items: null,
    setItems(items) { this.items = items; },
    setValue(value) { dropdownValue = value; },
    getValue: () => dropdownValue,
  };
  dialog.newDocumentNameInput = {
    value: null,
    enabled: null,
    setValue(value) { this.value = value; },
    getValue() { return this.value; },
    enable() { this.enabled = true; },
    disable() { this.enabled = false; },
  };
  return dialog;
}

const docNamed = (name, layerName) => ({
  name,
  selectedLayerIndices: layerName ? [0] : [],
  layers: layerName ? [{ getName: () => layerName }] : [],
});

describe("ui/dialogs/duplicate-color-dialogs.js", () => {
  it("open lists every open document plus a new-project target", () => {
    const dialog = duplicateDialogSpy();
    const source = docNamed("shot.psd", "Sky");
    const other = docNamed("poster.psd", "Title");

    dialog.open(source, {}, [other, source]);

    assert.deepEqual(dialog.destinationDropdown.items,
      ["poster.psd", "shot.psd", "dialogs.newProject"]);
    assert.equal(dialog.destinationDropdown.getValue(), 1, "the current document is preselected");
    assert.equal(dialog.newDocumentNameInput.value, "Sky", "seeded from the selected layer");
  });

  it("open falls back to a generic name when no layer is selected", () => {
    const dialog = duplicateDialogSpy();
    const source = docNamed("shot.psd", null);

    dialog.open(source, {}, [source]);

    assert.equal(dialog.newDocumentNameInput.value, "Layer");
  });

  it("the name field is live only while the new-project target is chosen", () => {
    const dialog = duplicateDialogSpy();
    const source = docNamed("shot.psd", "Sky");
    const other = docNamed("poster.psd", "Title");
    dialog.open(source, {}, [other, source]);

    // open() preselects an existing document, so the name is not editable.
    assert.equal(dialog.newDocumentNameInput.enabled, false);

    // Index === targetDocuments.length is the trailing "new project" row.
    dialog.destinationDropdown.setValue(2);
    dialog.onDestinationChange(null);
    assert.equal(dialog.newDocumentNameInput.enabled, true);

    dialog.destinationDropdown.setValue(0);
    dialog.onDestinationChange(null);
    assert.equal(dialog.newDocumentNameInput.enabled, false);
  });

  it("ColorRangeDialog.hasOverlay claims the canvas so the eyedropper can sample it", () => {
    const dialog = Object.create(ColorRangeDialog.prototype);
    assert.equal(dialog.hasOverlay(), true);
    assert.equal(dialog.isActive(), true);
  });
});
