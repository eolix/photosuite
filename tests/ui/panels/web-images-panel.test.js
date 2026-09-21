/**
 * WebImagesPanel sidebar click opens webimages dialog route.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType, UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let WebImagesPanel;
let WEB_IMAGES_DIALOG_ROUTE_ID;

before(async () => {
  ({
    WebImagesPanel,
    WEB_IMAGES_DIALOG_ROUTE_ID
  } = await import("../../../src/ui/panels/web-images-panel.js"));
});

describe("ui/panels/web-images-panel.js", () => {
  it("buildOpenWebImagesDialogEvent routes to webimages dialog", () => {
    const evt = WebImagesPanel.buildOpenWebImagesDialogEvent();
    assert.equal(evt.type, EventType.uiDispatch);
    assert.equal(evt.data.dispatchKind, UiCommand.dispatchAppDialogRouter);
    assert.equal(evt.data.dialogRouteId, "webimages");
    assert.equal(evt.data.dialogRouteId, WEB_IMAGES_DIALOG_ROUTE_ID);
  });

  it("onSidebarClick dispatches the open-dialog event", () => {
    const panel = Object.create(WebImagesPanel.prototype);
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    WebImagesPanel.prototype.onSidebarClick.call(panel);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.dialogRouteId, "webimages");
    assert.equal(events[0].data.dispatchKind, UiCommand.dispatchAppDialogRouter);
  });
});
