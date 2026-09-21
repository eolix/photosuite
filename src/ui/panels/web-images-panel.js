/**
 * Right-sidebar launcher for the Openverse image-search modal.
 *
 * This panel has no inline body: clicking the sidebar icon opens
 * WebImagesDialog (floating modal) instead of expanding panelBody in the
 * column. DocumentTab.onSidebarBtnClick recognizes onSidebarClick and
 * invokes it instead of the usual panel toggle.
 *
 * Icon: the panels/images icon with theme tinting enabled.
 */

import { BaseTool } from "../widgets/base-tool.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";

/** Dialog router id consumed by the app dialog dispatcher. */
const WEB_IMAGES_DIALOG_ROUTE_ID = "webimages";

function WebImagesPanel() {
  BaseTool.call(
    this,
    "Web Images",
    false,
    getIconUrl("panels/images"),
    BaseTool.PanelId.WEB_IMAGES,
    true
  )
}
WebImagesPanel.prototype = Object.create(BaseTool.prototype);

/**
 * Open the web-images modal via uiDispatch (intercepted sidebar click).
 */
WebImagesPanel.prototype.onSidebarClick = function() {
  this.dispatch(buildOpenWebImagesDialogEvent())
};

/**
 * Build the uiDispatch payload that routes to the web-images dialog.
 */
WebImagesPanel.buildOpenWebImagesDialogEvent = buildOpenWebImagesDialogEvent;

export { WebImagesPanel, WEB_IMAGES_DIALOG_ROUTE_ID };

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function buildOpenWebImagesDialogEvent() {
  const evt = new AppEvent(EventType.uiDispatch, true);
  evt.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: WEB_IMAGES_DIALOG_ROUTE_ID
  };
  return evt
}
