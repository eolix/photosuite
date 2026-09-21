/**
 * menu path resolve + AppEvent dispatch goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { AppEvent } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let cloneMenuPayload;
let resolveMenuBarAction;
let dispatchMenuActionDescriptor;
let dispatchMenuBarActionPath;
let isMenuActionDescriptor;

before(async () => {
  ({
    cloneMenuPayload,
    resolveMenuBarAction,
    dispatchMenuActionDescriptor,
    dispatchMenuBarActionPath,
    isMenuActionDescriptor,
  } = await import("../../../src/ui/menu/menu-action-dispatch.js"));
});

const FIXTURE_MENU = [
  {
    menuActions: [
      { appEventType: "ui", payload: { a: 1 } },
      {
        sub: [
          { appEventType: "doc", documentModelType: 7, payload: { x: true } },
          null,
          {
            appEventType: "nested",
            sub: [{ appEventType: "deep", payload: { z: 9 } }],
          },
        ],
      },
    ],
  },
];

describe("ui/menu/menu-action-dispatch.js", () => {
  it("isMenuActionDescriptor requires appEventType", () => {
    assert.equal(isMenuActionDescriptor(null), false);
    assert.equal(isMenuActionDescriptor({}), false);
    assert.equal(isMenuActionDescriptor({ g: "legacy" }), false);
    assert.equal(isMenuActionDescriptor({ appEventType: "ui" }), true);
  });

  it("cloneMenuPayload goldens", () => {
    assert.equal(cloneMenuPayload(undefined), undefined);
    assert.deepEqual(cloneMenuPayload({ q: [1] }), { q: [1] });
    const src = { nested: { n: 2 } };
    const copy = cloneMenuPayload(src);
    copy.nested.n = 99;
    assert.equal(src.nested.n, 2);
  });

  it("resolveMenuBarAction walks path / rejects invalid", () => {
    assert.equal(resolveMenuBarAction(FIXTURE_MENU, [0]), null);
    assert.deepEqual(resolveMenuBarAction(FIXTURE_MENU, [0, 0]), {
      appEventType: "ui",
      payload: { a: 1 },
    });
    assert.deepEqual(resolveMenuBarAction(FIXTURE_MENU, [0, 1, 0]), {
      appEventType: "doc",
      documentModelType: 7,
      payload: { x: true },
    });
    assert.deepEqual(resolveMenuBarAction(FIXTURE_MENU, [0, 1, 2, 0]), {
      appEventType: "deep",
      payload: { z: 9 },
    });
    assert.equal(resolveMenuBarAction(FIXTURE_MENU, [0, 1, 1]), null);
    assert.equal(resolveMenuBarAction([{ menuActions: [{}] }], [0, 0]), null);
  });

  it("dispatchMenuActionDescriptor builds AppEvent", () => {
    const events = [];
    const target = {
      dispatch(evt) {
        events.push({
          type: evt.type,
          channel: evt.routingChannel,
          data: evt.data,
        });
      },
    };
    dispatchMenuActionDescriptor(target, {
      appEventType: "t",
      documentModelType: 3,
      payload: { n: 1 },
    });
    assert.deepEqual(events[0], { type: "t", channel: 3, data: { n: 1 } });
  });

  it("dispatchMenuBarActionPath success / failure", () => {
    const events = [];
    const target = {
      dispatch(evt) {
        events.push({
          type: evt.type,
          channel: evt.routingChannel,
          data: evt.data,
        });
      },
    };
    assert.equal(dispatchMenuBarActionPath(target, FIXTURE_MENU, [0, 0]), true);
    assert.equal(dispatchMenuBarActionPath(target, FIXTURE_MENU, [9, 0]), false);
    assert.deepEqual(events[0], { type: "ui", channel: null, data: { a: 1 } });
  });
});
