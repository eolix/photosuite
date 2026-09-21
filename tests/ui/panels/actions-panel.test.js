/**
 * ActionsPanel / ActionsListItem (tree events, export payload).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { clearElement } from "../../../src/core/dom.js";
import { iconImgHtml } from "../../../src/assets/icon-registry.js";

installBrowserGlobals();

let ActionsPanel;
let ActionsListItem;
let Locale;
let PopupTypes;

before(async () => {
  ({ Locale } = await import("../../../src/core/i18n/locale.js"));
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  Locale.get = (key) => (typeof key === "string" ? key : String(key));
  ({ ActionsPanel, ActionsListItem } = await import(
    "../../../src/ui/panels/actions-panel.js"
  ));
});

describe("ui/panels/actions-panel.js", () => {
  it("ActionsListItem click dispatches rowAction sel + treePath", () => {
    const item = new ActionsListItem([0, 1], "[]", true, "Action 0");
    const events = [];
    item.dispatch = (evt) => events.push(evt);
    item.onMouseUp({
      detail: 1,
      target: { tagName: "DIV" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.rowAction, "sel");
    assert.deepEqual(events[0].data.treePath, [0, 1]);
  });

  it("rename confirm uses newName", () => {
    const item = new ActionsListItem([0], "[]", true, "Set");
    const events = [];
    item.dispatch = (evt) => events.push(evt);
    item.onRenameConfirm("Renamed");
    assert.equal(events[0].data.rowAction, "nchange");
    assert.equal(events[0].data.newName, "Renamed");
    assert.deepEqual(events[0].data.treePath, [0]);
  });

  it("fold / enab / nchange mutate name/expanded/enabled", () => {
    const panel = Object.create(ActionsPanel.prototype);
    panel.redraw = () => {};
    const actionSets = [
      {
        name: "Action Set 0",
        expanded: true,
        children: [
          {
            name: "Action 0",
            expanded: true,
            commandKeyEnabled: false,
            children: [{ enabled: true, uf: "set" }],
          },
        ],
      },
    ];
    panel.doc = { actionSets, recordingActionSet: null };

    panel.onItemSelect({ data: { rowAction: "fold", treePath: [0] } });
    assert.equal(actionSets[0].expanded, false);

    panel.onItemSelect({ data: { rowAction: "enab", treePath: [0, 0, 0] } });
    assert.equal(actionSets[0].children[0].children[0].enabled, false);

    panel.onItemSelect({
      data: { rowAction: "nchange", treePath: [0], newName: "Renamed Set" },
    });
    assert.equal(actionSets[0].name, "Renamed Set");
  });

  it("export dispatch uses popupTypeId", () => {
    const panel = Object.create(ActionsPanel.prototype);
    panel.doc = {
      actionSets: [{ name: "S", children: [], expanded: true }],
      recordingActionSet: null,
    };
    panel.selectedPath = [0];
    const exportBtn = {};
    panel.items = [null, null, null, null, null, exportBtn];
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onFooterClick({ currentTarget: exportBtn });
    assert.equal(events.length, 1);
    assert.equal(events[0].data.popupTypeId, PopupTypes.ACTIONS);
    assert.equal(events[0].data.actionSetIndex, 0);
  });
});
