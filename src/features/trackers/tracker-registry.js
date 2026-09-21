// TrackerRegistry singleton: the TrackerBase event-handler base class and the
// History tracker. Individual trackers attach their handler classes onto this
// registry from the other files in features/trackers/.

import { EventChannel } from "../../document/model/tool-base.js";
import { EventType } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";

const TrackerRegistry = {};

TrackerRegistry.TrackerBase = function (trackerId) {
  this.id = trackerId;
  this.appDispatcher = null;
};
TrackerRegistry.TrackerBase.prototype.handleInput = function (event, dispatcher, doc, panelContext, appData) {};
TrackerRegistry.TrackerBase.prototype.redo = function (historySnapshot, doc) {};
TrackerRegistry.TrackerBase.prototype.undo = function (historySnapshot, doc) {};
TrackerRegistry.TrackerBase.prototype.track = function (actionPayload) {
  const historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = actionPayload;
  actionPayload.skipActionRecording = true;
  this.appDispatcher.dispatch(historyEvent);
};

TrackerRegistry.History = function () {
  TrackerRegistry.TrackerBase.call(this, EventChannel.EVENT_HISTORY);
  this.preferUndoOnToggle = true;
  this.historyIndexAtLastToggle = 0;
};
TrackerRegistry.History.prototype = Object.create(TrackerRegistry.TrackerBase.prototype);
TrackerRegistry.History.prototype.handleInput = function (event, dispatcher, doc, keyboard) {
  doc.panelsDirty = true;
  if (event.actionKind == "h_itemchange") {
    if (event.index < doc.historyIndex) {
      for (let historyIdx = doc.historyIndex; historyIdx > event.index; historyIdx--) this.stepHistoryBackward(doc);
    }
    if (event.index > doc.historyIndex) {
      for (let historyIdx = doc.historyIndex; historyIdx < event.index; historyIdx++) this.stepHistoryForward(doc);
    }
  }
  if (event.actionKind == "h_stepfwd") this.stepHistoryForward(doc);
  if (event.actionKind == "h_stepbck") this.stepHistoryBackward(doc);
  if (event.actionKind == "h_undoredo") {
    let shouldUndo = this.preferUndoOnToggle || this.historyIndexAtLastToggle != doc.historyIndex;
    if (shouldUndo) {
      this.stepHistoryBackward(doc);
      shouldUndo = false;
    } else {
      this.stepHistoryForward(doc);
      shouldUndo = true;
    }
    this.preferUndoOnToggle = shouldUndo;
    this.historyIndexAtLastToggle = doc.historyIndex;
  } else {
    this.preferUndoOnToggle = true;
  }
};
TrackerRegistry.History.prototype.stepHistoryBackward = function (doc) {
  if (doc.historyIndex == 0) return;
  const historyEntry = doc.history[doc.historyIndex];
  historyEntry.routingChannel.undo(historyEntry.data, doc);
  doc.historyIndex--;
};
TrackerRegistry.History.prototype.stepHistoryForward = function (doc) {
  if (doc.historyIndex == doc.history.length - 1) return;
  const historyEntry = doc.history[doc.historyIndex + 1];
  historyEntry.routingChannel.redo(historyEntry.data, doc);
  doc.historyIndex++;
};

export { TrackerRegistry };
