/**
 * The action that makes a shape layer.
 *
 * Drawing a rectangle, dropping a path, or picking a fill from the layer-style
 * dialog all end in the same "make contentLayer" descriptor: a shape, a fill of
 * one of the three kinds, and a stroke style. Building it in one place keeps
 * what the pen writes and what the shape tools write identical, which is what
 * lets history replay either of them.
 */

import { LayerEffectDefs } from "../formats/psd/effect-defs.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";

export function defaultShapeDescriptor() {
  return {
    classID: "Mk",
    null: {
      t: "obj ",
      v: [{
        t: "Clss",
        v: {
          classID: "contentLayer"
        }
      }]
    },
    Usng: {
      t: "Objc",
      v: {
        classID: "contentLayer",
        Type: {
          t: "Objc",
          v: {}
        }
      }
    }
  };
}

export function buildShapeAction(fillKindIndex, fillDescriptor) {
  const shapeDescriptor = defaultShapeDescriptor();
  if (fillDescriptor == null) fillDescriptor = LayerEffectDefs.getFillLayerDefault(fillKindIndex);
  TrackerRegistry.LayerEffectsTracker.copyContentFillToDescriptor(
    fillDescriptor,
    shapeDescriptor.Usng.v.Type.v,
    fillKindIndex,
  );
  return {
    uf: "make",
    actionDescriptor: shapeDescriptor,
  };
}

export function buildShapePathAction(shapeDescriptor, appData) {
  const fillSnapshot = appData.currentFill;
  const strokeDescriptor = JSON.parse(JSON.stringify(appData.currentStroke));
  if (fillSnapshot.fillKind == 0) strokeDescriptor.fillEnabled.v = false;
  const shapeAction = buildShapeAction(
    Math.max(0, fillSnapshot.fillKind - 1),
    fillSnapshot.fillDescriptor,
  );
  shapeAction.actionDescriptor.Usng.v.Shp = shapeDescriptor;
  shapeAction.actionDescriptor.Usng.v.strokeStyle = {
    t: "Objc",
    v: strokeDescriptor,
  };
  return shapeAction;
}
