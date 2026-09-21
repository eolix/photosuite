/**
 * Drag-and-drop helpers shared across the Layers panel row widgets
 * (LayersPanel, LayerGroupItem, LayerStyleRow). The drag payload is a JSON
 * string carried on the DataTransfer describing what is being moved — its
 * `kind` is one of "l" layer, "m" raster mask, "vm" vector mask, "s"/"sm"
 * layer effect or its master, "f"/"fm" smart filter or its master — plus the
 * source layer and style indices. These helpers read that payload, classify
 * drops, and turn a completed style drop into a reorder/copy action.
 */
import { Layer } from "../../document/model/layer.js";

/** Read the layer drag payload string from a DataTransfer, or "" if absent. */
export function readLayerDragPayload(dataTransfer) {
  if (dataTransfer == null) return "";
  return dataTransfer.getData("Text") || dataTransfer.getData("text/plain")
}

/** Mutable drag session state shared across panel row widgets. */
export const layerPanelDragState = {
  pointerDrag: null,
  activeDropRow: null,
  styleDrag: null,
  activeStyleDropRow: null,
};

/**
 * Clear whichever row currently shows an insert bar. Both row types expose
 * `clearDropIndicator`, so neither module needs to import the other.
 */
export function clearPanelDropIndicators() {
  if (layerPanelDragState.activeDropRow != null) {
    layerPanelDragState.activeDropRow.clearDropIndicator();
    layerPanelDragState.activeDropRow = null
  }
  if (layerPanelDragState.activeStyleDropRow != null) {
    layerPanelDragState.activeStyleDropRow.clearDropIndicator();
    layerPanelDragState.activeStyleDropRow = null
  }
}

/**
 * The panel row under the pointer. Style sub-rows and layer headers tag their own
 * element, and the two never nest, so at most one of the pair comes back: a style
 * row when the pointer is over an effect or filter, otherwise the layer row whose
 * header it is over.
 */
export function findPanelRowAtPoint(clientX, clientY) {
  let el = document.elementFromPoint(clientX, clientY);
  const found = { styleRow: null, layerRow: null };
  while (el != null) {
    if (found.styleRow == null && el.__layerStyleRow) found.styleRow = el.__layerStyleRow;
    if (found.layerRow == null && el.__layerGroupItemRow) found.layerRow = el.__layerGroupItemRow;
    el = el.parentElement
  }
  return found
}

/**
 * Vertical position of a pointer event within `element`, as a 0..1 ratio from
 * its top edge. Drop handlers use the 0.5 midpoint to decide insert-above vs
 * insert-below.
 */
export function layerPanelEventYRatioInElement(pointerEvent, element) {
  const bounds = element.getBoundingClientRect();
  return (pointerEvent.clientY - bounds.top) / bounds.height
}

/**
 * Turn a completed style/filter drop into a document action: layer-effect
 * kinds ("s"/"sm") copy the style onto the destination layer, smart-filter
 * kinds ("f"/"fm") move the filter to `dropIndex`. Holding Alt keeps the
 * source copy. No-op for other drag kinds.
 */
export function dispatchLayerStyleDragReorder(dragEvent, payload, row, dropIndex) {
  const dragKind = payload.kind,
    layerIndex = row.sectionNode.index,
    sourceLayerIndex = payload.layerIndex;
  if (dragKind == "s" || dragKind == "sm") row.applyEvent({
    actionKind: Layer.copyLayerStyle,
    sourceLayerIndex: sourceLayerIndex,
    destinationLayerIndex: layerIndex,
    effectPathIndices: payload.styleIndex,
    keepSourceOnCopy: dragEvent.altKey
  });
  if (dragKind == "f" || dragKind == "fm") row.applyEvent({
    actionKind: Layer.moveSmartFilter,
    sourceLayerIndex: sourceLayerIndex,
    destinationLayerIndex: layerIndex,
    sourceFilterIndex: payload.styleIndex,
    insertFilterIndex: dropIndex == null ? 0 : dropIndex,
    keepSourceOnCopy: dragEvent.altKey
  })
}
