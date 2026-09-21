import { AppEvent } from "../../core/event-bus.js";

/**
 * Resolve `MenuBar.data` `menuActions` paths and dispatch {@link AppEvent}s.
 *
 * Native and HTML menus both end up here. See `src/ui/menu/README.md`.
 * Payload: `{ path: number[] }` or `{ action: { appEventType, … } }`.
 */



/**
 * Deep-clone plain JSON data (menu payloads must not carry functions).
 * @param {*} value
 * @returns {*}
 */
export function cloneMenuPayload(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Walk `menuData[topIdx].menuActions` then optional `.sub` segments.
 *
 * @param {Array<{ menuActions: Array<object> }>} menuData Same shape as {@link MenuBar.data}.
 * @param {number[]} path [topMenuIndex, menuActionIndex, ...subMenuIndices]
 * @returns {{ appEventType: string, documentModelType?: *, payload?: * }|null}
 */
export function resolveMenuBarAction(menuData, path) {
  const node = walkMenuActionPath(menuData, path);
  if (node == null || node.appEventType == null) return null;
  return node;
}

/**
 * @param {{ appEventType?: string }|null|undefined} action
 * @returns {boolean}
 */
export function isMenuActionDescriptor(action) {
  return action != null && action.appEventType != null;
}

/**
 * @param {{ dispatch: function }} dispatchTarget Usually {@link AppController}.
 * @param {{ appEventType: string, documentModelType?: *, payload?: * }} descriptor
 */
export function dispatchMenuActionDescriptor(dispatchTarget, descriptor) {
  const fields = readMenuActionFields(descriptor);
  const evt = buildMenuAppEvent(fields);
  dispatchTarget.dispatch(evt);
}

/**
 * @param {{ dispatch: function }} dispatchTarget
 * @param {Array<{ menuActions: Array<object> }>} menuData
 * @param {number[]} path
 * @returns {boolean} Whether an action was resolved and dispatched.
 */
export function dispatchMenuBarActionPath(dispatchTarget, menuData, path) {
  const node = resolveMenuBarAction(menuData, path);
  if (!node) return false;
  dispatchMenuActionDescriptor(dispatchTarget, node);
  return true;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ menuActions: Array<object> }>} menuData
 * @param {number[]} path
 * @returns {object|null}
 */
function walkMenuActionPath(menuData, path) {
  if (!menuData || !path || path.length < 2) return null;
  const top = menuData[path[0]];
  if (!top || !top.menuActions) return null;
  let node = top.menuActions[path[1]];
  if (node == null) return null;
  for (let segmentIdx = 2; segmentIdx < path.length; segmentIdx++) {
    if (!node.sub) return null;
    node = node.sub[path[segmentIdx]];
    if (node == null) return null;
  }
  return node;
}

/**
 * Normalize a menu action descriptor into event fields.
 * @param {{ appEventType: string, documentModelType?: *, payload?: * }} descriptor
 */
function readMenuActionFields(descriptor) {
  return {
    appEventType: descriptor.appEventType,
    routingChannel: descriptor.documentModelType !== undefined ? descriptor.documentModelType : null,
    payload: descriptor.payload !== undefined ? descriptor.payload : null
  };
}

/**
 * @param {{ appEventType: string, routingChannel: *, payload: * }} fields
 * @returns {AppEvent}
 */
function buildMenuAppEvent(fields) {
  const evt = new AppEvent(fields.appEventType, true);
  evt.routingChannel = fields.routingChannel != null ? fields.routingChannel : null;
  evt.data = fields.payload !== undefined ? cloneMenuPayload(fields.payload) : null;
  return evt;
}
