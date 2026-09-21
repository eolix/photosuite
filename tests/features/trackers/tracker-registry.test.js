/**
 * Golden values for TrackerRegistry base + History stepping.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let TrackerRegistry;

before(async () => {
  ({ TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js"));
  const { registerTrackers } = await import(
    "../../../src/features/trackers/register-trackers.js"
  );
  registerTrackers(TrackerRegistry);
});

/** Doc with N history entries; each entry records undo/redo calls. */
function makeDoc(entryCount, startIndex) {
  const calls = [];
  const history = [];
  for (let i = 0; i < entryCount; i++) {
    history.push({
      data: { i },
      routingChannel: {
        undo: (data) => calls.push(["undo", data.i]),
        redo: (data) => calls.push(["redo", data.i]),
      },
    });
  }
  return { history, historyIndex: startIndex, panelsDirty: false, calls };
}

describe("features/trackers/tracker-registry.js", () => {
  it("TrackerBase.track dispatches a historyGrouped event with skipActionRecording", () => {
    const tracker = new TrackerRegistry.TrackerBase(7);
    assert.equal(tracker.id, 7);
    const dispatched = [];
    tracker.appDispatcher = { dispatch: (e) => dispatched.push(e) };
    const payload = { uf: "op" };
    tracker.track(payload);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, EventType.historyGrouped);
    assert.equal(dispatched[0].data, payload);
    assert.equal(payload.skipActionRecording, true);
  });

  it("History stepping advances/rewinds the index and calls redo/undo", () => {
    const history = new TrackerRegistry.History();
    const doc = makeDoc(3, 0);

    history.stepHistoryForward(doc); // 0 -> 1, redo entry 1
    assert.equal(doc.historyIndex, 1);
    history.stepHistoryForward(doc); // 1 -> 2, redo entry 2
    assert.equal(doc.historyIndex, 2);
    history.stepHistoryForward(doc); // at last -> no-op
    assert.equal(doc.historyIndex, 2);

    history.stepHistoryBackward(doc); // 2 -> 1, undo entry 2
    assert.equal(doc.historyIndex, 1);
    history.stepHistoryBackward(doc); // 1 -> 0, undo entry 1
    assert.equal(doc.historyIndex, 0);
    history.stepHistoryBackward(doc); // at 0 -> no-op
    assert.equal(doc.historyIndex, 0);

    assert.deepEqual(doc.calls, [
      ["redo", 1],
      ["redo", 2],
      ["undo", 2],
      ["undo", 1],
    ]);
  });

  it("History h_undoredo toggles between undo and redo", () => {
    const history = new TrackerRegistry.History();
    const doc = makeDoc(3, 1);

    history.handleInput({ actionKind: "h_undoredo" }, null, doc); // prefer undo -> back to 0
    assert.equal(doc.historyIndex, 0);
    assert.equal(doc.panelsDirty, true);
    history.handleInput({ actionKind: "h_undoredo" }, null, doc); // toggle -> redo to 1
    assert.equal(doc.historyIndex, 1);
    assert.deepEqual(doc.calls, [
      ["undo", 1],
      ["redo", 1],
    ]);
  });
});
