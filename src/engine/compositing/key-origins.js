/**
 * PSD key-origin descriptors for vector shapes: build, transform, and rebuild
 * path records from rounded-rect / ellipse / line origins.
 */

import { Matrix2D } from '../../core/math/matrix2d.js';
import { isAxisAligned, isPerspectiveFree, matrix2DToHomography, transformPointsArray } from "./homography.js";
import { ellipsePathRecords, linePathRecords, rectanglePathRecords } from "./shape-primitives.js";
import { countSubpaths, knotCountInSubpath, recordIndexForSubpath } from "./path-records.js";


const SHAPE_KIND_RECT = 1;
const SHAPE_KIND_ROUNDED_RECT = 2;
const SHAPE_KIND_LINE = 4;
const SHAPE_KIND_ELLIPSE = 5;
const KEY_ORIGIN_RESOLUTION = 75;
const BOUNDS_SENTINEL = 1e9;
const SCALE_ASPECT_EPSILON = 0.01;

function isKeyOriginActive(originObj) {
  const invalidated = originObj.keyShapeInvalidated;
  return !(invalidated && invalidated.v) && originObj.keyOriginType != null;
}

function normalizeBBoxCorners(bbox) {
  return [
    Math.min(bbox[0], bbox[2]),
    Math.min(bbox[1], bbox[3]),
    Math.max(bbox[0], bbox[2]),
    Math.max(bbox[1], bbox[3]),
  ];
}

/**
 * Rotate/flip rounded-rect corner radii to match the linear part of a homography.
 */
function transformRoundedRectRadii(radii, linear, scaleRadii, scaleX) {
  linear.roundNearZero();
  if (linear.w == 0) {
    radii.push(radii.shift());
    linear.rotate(Math.PI / 2);
    linear.roundNearZero();
  }
  if (linear.w < 0) {
    let swap = radii[0];
    radii[0] = radii[1];
    radii[1] = swap;
    swap = radii[2];
    radii[2] = radii[3];
    radii[3] = swap;
  }
  if (linear.d < 0) {
    let swap = radii[0];
    radii[0] = radii[3];
    radii[3] = swap;
    swap = radii[1];
    radii[1] = radii[2];
    radii[2] = swap;
  }
  if (scaleRadii) {
    for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
      radii[cornerIdx] = radii[cornerIdx] * scaleX;
    }
  }
  return radii;
}

function shouldInvalidateForHomography(homography, scaleRadii, shapeKind, scaleX, scaleY) {
  const axisAligned = isAxisAligned(homography);
  const perspectiveFree = isPerspectiveFree(homography);
  return (
    !axisAligned ||
    !perspectiveFree ||
    (scaleRadii && shapeKind == SHAPE_KIND_ROUNDED_RECT && Math.abs(1 - scaleX / scaleY) > SCALE_ASPECT_EPSILON)
  );
}

export function invalidateAllKeyOrigins(keyOriginList) {
  for (let originIdx = 0; originIdx < keyOriginList.length; originIdx++) {
    invalidateKeyOriginAtIndex(keyOriginList, originIdx);
  }
}

export function invalidateKeyOriginAtIndex(keyOriginList, originIdx) {
  keyOriginList[originIdx].v.keyShapeInvalidated = {
    t: "bool",
    v: true,
  };
}

export function assignKeyOriginIndices(keyOriginList) {
  for (let originIdx = 0; originIdx < keyOriginList.length; originIdx++) {
    keyOriginList[originIdx].v.keyOriginIndex.v = originIdx;
  }
}

/**
 * One empty key origin per subpath in `pathRecords` — the `vogk` list a
 * vector-shape layer carries alongside its path.
 */
export function createForSubpaths(pathRecords) {
  const origins = [];
  const subpathCount = countSubpaths(pathRecords);
  for (let subpathIdx = 0; subpathIdx < subpathCount; subpathIdx++) {
    origins.push(createEmptyKeyOrigin());
  }
  return origins;
}

export function createEmptyKeyOrigin() {
  return {
    t: "Objc",
    v: {
      classID: "null",
      keyOriginIndex: {
        t: "long",
        v: 0,
      },
      keyShapeInvalidated: {
        t: "bool",
        v: true,
      },
    },
  };
}

export function keyOriginFromShapeDescriptor(shapeDesc) {
  shapeDesc = shapeDesc.v;
  const shapeKindByClassId = {
    Rctn: 2,
    Ln: 4,
    Elps: 5,
  };
  const shapeKind = shapeKindByClassId[shapeDesc.classID];
  const cornerRadii = shapeDesc.topLeft ? cornerRadiiFromUnitQuad(shapeDesc) : null;
  let lineEndpoints = null;
  let lineWidth = 0;
  if (shapeKind == SHAPE_KIND_LINE) {
    const startPt = shapeDesc.Strt.v;
    const endPt = shapeDesc.End.v;
    lineEndpoints = [startPt.Hrzn.v.val, startPt.Vrtc.v.val, endPt.Hrzn.v.val, endPt.Vrtc.v.val];
    lineWidth = shapeDesc.Wdth.v.val;
  }
  if (shapeKind == null) {
    return null;
  }
  return buildKeyOriginFromGeom(
    shapeKind,
    shapeKind == SHAPE_KIND_LINE ? null : unitRectToBBoxArray(shapeDesc),
    cornerRadii,
    lineEndpoints,
    lineWidth,
  );
}

export function buildKeyOriginDescriptor(shapeClassId, bbox, cornerRadii, lineEndpoints, lineWidth, shapeName) {
  const shapeDesc = {
    classID: shapeClassId,
    unitValueQuadVersion: {
      t: "long",
      v: 1,
    },
  };
  if (bbox) {
    setPxCornersOnDescriptor(shapeDesc, ["Left", "Top", "Rght", "Btom"], bbox);
  }
  if (cornerRadii) {
    setPxCornersOnDescriptor(shapeDesc, ["topLeft", "topRight", "bottomRight", "bottomLeft"], cornerRadii);
  }
  if (shapeClassId == "Ln") {
    shapeDesc.Strt = {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: lineEndpoints[0],
          },
        },
        Vrtc: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: lineEndpoints[1],
          },
        },
      },
    };
    shapeDesc.End = {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: lineEndpoints[2],
          },
        },
        Vrtc: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: lineEndpoints[3],
          },
        },
      },
    };
    shapeDesc.Wdth = {
      t: "UntF",
      v: {
        type: "#Pxl",
        val: lineWidth,
      },
    };
  }
  if (shapeName) {
    shapeDesc.Nm = {
      t: "TEXT",
      v: shapeName,
    };
  }
  return {
    t: "Objc",
    v: shapeDesc,
  };
}

export function buildKeyOriginFromGeom(shapeKind, bbox, cornerRadii, lineEndpoints, lineWeight) {
  const keyOrigin = createEmptyKeyOrigin();
  const originObj = keyOrigin.v;
  delete originObj.keyShapeInvalidated;
  originObj.keyOriginType = {
    t: "long",
    v: shapeKind,
  };
  originObj.keyOriginResolution = {
    t: "doub",
    v: KEY_ORIGIN_RESOLUTION,
  };
  if (shapeKind == SHAPE_KIND_LINE) {
    originObj.keyOriginLineStart = {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: {
          t: "doub",
          v: lineEndpoints[0],
        },
        Vrtc: {
          t: "doub",
          v: lineEndpoints[1],
        },
      },
    };
    originObj.keyOriginLineEnd = {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: {
          t: "doub",
          v: lineEndpoints[2],
        },
        Vrtc: {
          t: "doub",
          v: lineEndpoints[3],
        },
      },
    };
    bbox = normalizeBBoxCorners(lineEndpoints);
    originObj.keyOriginLineWeight = {
      t: "doub",
      v: lineWeight,
    };
    originObj.keyOriginLineArrowSt = {
      t: "bool",
      v: false,
    };
    originObj.keyOriginLineArrowEnd = {
      t: "bool",
      v: false,
    };
    originObj.keyOriginLineArrWdth = {
      t: "doub",
      v: 0,
    };
    originObj.keyOriginLineArrLngth = {
      t: "doub",
      v: 0,
    };
    originObj.keyOriginLineArrConc = {
      t: "long",
      v: 0,
    };
  }
  const unitRect = {
    classID: "unitRect",
    unitValueQuadVersion: {
      t: "long",
      v: 1,
    },
  };
  originObj.keyOriginShapeBBox = {
    t: "Objc",
    v: unitRect,
  };
  setKeyOriginBBox(originObj, bbox);
  if (cornerRadii != null) {
    const radiiDesc = {
      classID: "radii",
      unitValueQuadVersion: {
        t: "long",
        v: 1,
      },
    };
    originObj.keyOriginRRectRadii = {
      t: "Objc",
      v: radiiDesc,
    };
    setKeyOriginCornerRadii(originObj, cornerRadii);
  }
  return keyOrigin;
}

export function transformKeyOriginsWithMatrix(keyOriginList, homography, subpathFilter, scaleRadii) {
  const scaleX = Math.max(Math.abs(homography[0]), Math.abs(homography[1]));
  const scaleY = Math.max(Math.abs(homography[3]), Math.abs(homography[4]));
  for (let originIdx = 0; originIdx < keyOriginList.length; originIdx++) {
    const originObj = keyOriginList[originIdx].v;
    if (!isKeyOriginActive(originObj)) {
      continue;
    }
    if (subpathFilter.length != 0 && subpathFilter.indexOf(originIdx) == -1) {
      continue;
    }
    const shapeKind = originObj.keyOriginType.v;
    if (shouldInvalidateForHomography(homography, scaleRadii, shapeKind, scaleX, scaleY)) {
      invalidateKeyOriginAtIndex(keyOriginList, originIdx);
      continue;
    }
    const bbox = bboxArrayFromKeyOrigin(originObj);
    transformPointsArray(homography, bbox);
    setKeyOriginBBox(originObj, normalizeBBoxCorners(bbox));
    if (shapeKind == SHAPE_KIND_ROUNDED_RECT) {
      const radii = cornerRadiiFromKeyOrigin(originObj);
      const linear = new Matrix2D(homography[0], homography[1], homography[3], homography[4], 0, 0);
      setKeyOriginCornerRadii(
        originObj,
        transformRoundedRectRadii(radii, linear, scaleRadii, scaleX),
      );
    }
    if (shapeKind == SHAPE_KIND_LINE) {
      originObj.keyOriginLineWeight.v *= scaleX;
      const endpoints = lineEndpointsFromKeyOrigin(originObj);
      transformPointsArray(homography, endpoints);
      setLineEndpointsOnKeyOrigin(originObj, endpoints);
    }
  }
}

export function rebuildVectorMaskFromKeyOrigins(keyOriginList, vectorMask) {
  let pathRecords = vectorMask.pathRecords;
  for (let originIdx = 0; originIdx < keyOriginList.length; originIdx++) {
    const originObj = keyOriginList[originIdx].v;
    if (!isKeyOriginActive(originObj)) {
      continue;
    }
    const shapeKind = originObj.keyOriginType.v;
    const bbox = bboxArrayFromKeyOrigin(originObj);
    const left = bbox[0];
    const top = bbox[1];
    const right = bbox[2];
    const bottom = bbox[3];
    let newRecords;
    if (shapeKind == SHAPE_KIND_RECT) {
      newRecords = rectanglePathRecords(left, top, right - left, bottom - top, 0);
    } else if (shapeKind == SHAPE_KIND_ROUNDED_RECT) {
      const cornerRadii = cornerRadiiFromKeyOrigin(originObj);
      newRecords = rectanglePathRecords(left, top, right - left, bottom - top, cornerRadii);
    } else if (shapeKind == SHAPE_KIND_LINE) {
      const endpoints = lineEndpointsFromKeyOrigin(originObj);
      newRecords = linePathRecords(
        endpoints[0],
        endpoints[1],
        endpoints[2],
        endpoints[3],
        originObj.keyOriginLineWeight.v,
      );
    } else if (shapeKind == SHAPE_KIND_ELLIPSE) {
      newRecords = ellipsePathRecords(left, top, right - left, bottom - top);
    }
    const subpathStart = recordIndexForSubpath(pathRecords, originIdx);
    // More origins than subpaths: this origin describes geometry the mask does
    // not hold, so there is nothing to rebuild from it. Splicing at -1 would
    // take a record off the preamble and leave the array malformed.
    if (subpathStart == -1) continue;
    const knotCount = knotCountInSubpath(pathRecords, originIdx);
    newRecords[2].fillRule = pathRecords[subpathStart].fillRule;
    const savedRecords = pathRecords;
    pathRecords = pathRecords.slice(0, subpathStart);
    for (let recIdx = 2; recIdx < newRecords.length; recIdx++) {
      pathRecords.push(newRecords[recIdx]);
    }
    for (let recIdx = subpathStart + knotCount; recIdx < savedRecords.length; recIdx++) {
      pathRecords.push(savedRecords[recIdx]);
    }
  }
  vectorMask.pathRecords = pathRecords;
  vectorMask.maskCombineDirty = true;
}

export function aggregateKeyOriginBounds(layer) {
  let minLeft = BOUNDS_SENTINEL;
  let maxRight = -minLeft;
  let minTop = BOUNDS_SENTINEL;
  let maxBottom = -minTop;
  let sampleRadii = null;
  const paths = layer.getPaths();
  const pathList = paths[0];
  const pathIndices = paths[1];
  for (let pathIdx = 0; pathIdx < pathIndices.length; pathIdx++) {
    const pathLayer = pathList[pathIndices[pathIdx]];
    const keyOrigins = pathLayer.add.vogk;
    if (keyOrigins == null) {
      continue;
    }
    const subpathMask = pathLayer.add.vmsk.C;
    for (let originIdx = 0; originIdx < keyOrigins.length; originIdx++) {
      const originObj = keyOrigins[originIdx].v;
      if (!isKeyOriginActive(originObj)) {
        continue;
      }
      if (pathIndices.length == 1 && subpathMask.length != 0 && subpathMask.indexOf(originIdx) == -1) {
        continue;
      }
      const shapeKind = originObj.keyOriginType.v;
      if (shapeKind != SHAPE_KIND_LINE) {
        const bbox = bboxArrayFromKeyOrigin(originObj);
        minLeft = Math.min(minLeft, bbox[0]);
        minTop = Math.min(minTop, bbox[1]);
        maxRight = Math.max(maxRight, bbox[2]);
        maxBottom = Math.max(maxBottom, bbox[3]);
      }
      if (shapeKind == SHAPE_KIND_ROUNDED_RECT && sampleRadii == null) {
        sampleRadii = cornerRadiiFromKeyOrigin(originObj);
      }
    }
  }
  return [minLeft < maxRight ? [minLeft, minTop, maxRight, maxBottom] : null, sampleRadii];
}

export function applyHomographyToKeyOrigins(layer, targetBBox, cornerRadii) {
  const sourceBBox = aggregateKeyOriginBounds(layer)[0];
  let homography;
  if (sourceBBox) {
    const fitMatrix = new Matrix2D();
    fitMatrix.translate(-sourceBBox[0], -sourceBBox[1]);
    fitMatrix.scale(1 / (sourceBBox[2] - sourceBBox[0]), 1 / (sourceBBox[3] - sourceBBox[1]));
    fitMatrix.scale(targetBBox[2] - targetBBox[0], targetBBox[3] - targetBBox[1]);
    fitMatrix.translate(targetBBox[0], targetBBox[1]);
    homography = matrix2DToHomography(fitMatrix);
  }
  const paths = layer.getPaths();
  const pathList = paths[0];
  const pathIndices = paths[1];
  for (let pathIdx = 0; pathIdx < pathIndices.length; pathIdx++) {
    const pathLayer = pathList[pathIndices[pathIdx]];
    const keyOrigins = pathLayer.add.vogk;
    if (keyOrigins == null) {
      continue;
    }
    const subpathMask = pathLayer.add.vmsk.C;
    for (let originIdx = 0; originIdx < keyOrigins.length; originIdx++) {
      const originObj = keyOrigins[originIdx].v;
      if (!isKeyOriginActive(originObj)) {
        continue;
      }
      if (pathIndices.length == 1 && subpathMask.length != 0 && subpathMask.indexOf(originIdx) == -1) {
        continue;
      }
      const shapeKind = originObj.keyOriginType.v;
      if (shapeKind != SHAPE_KIND_LINE && targetBBox[0] != null) {
        const bbox = bboxArrayFromKeyOrigin(originObj);
        transformPointsArray(homography, bbox);
        setKeyOriginBBox(originObj, bbox);
      }
      if (shapeKind == SHAPE_KIND_ROUNDED_RECT && cornerRadii != null) {
        setKeyOriginCornerRadii(originObj, cornerRadii);
      }
    }
  }
}

export function bboxArrayFromKeyOrigin(originObj) {
  return unitRectToBBoxArray(originObj.keyOriginShapeBBox.v);
}

export function unitRectToBBoxArray(unitRect) {
  const left = unitRect.Left.v.val;
  const right = unitRect.Rght.v.val;
  const top = unitRect.Top.v.val;
  const bottom = unitRect.Btom.v.val;
  return [left, top, right, bottom];
}

export function setKeyOriginBBox(originObj, bbox) {
  setPxCornersOnDescriptor(originObj.keyOriginShapeBBox.v, ["Left", "Top", "Rght", "Btom"], bbox);
}

export function cornerRadiiFromKeyOrigin(originObj) {
  return cornerRadiiFromUnitQuad(originObj.keyOriginRRectRadii.v);
}

export function cornerRadiiFromUnitQuad(unitQuad) {
  const radii = [];
  const cornerKeys = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
    radii.push(unitQuad[cornerKeys[cornerIdx]].v.val);
  }
  return radii;
}

export function setKeyOriginCornerRadii(originObj, radii) {
  setPxCornersOnDescriptor(originObj.keyOriginRRectRadii.v, ["topLeft", "topRight", "bottomRight", "bottomLeft"], radii);
}

export function setPxCornersOnDescriptor(desc, cornerKeys, values) {
  for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
    if (values[cornerIdx] != null) {
      desc[cornerKeys[cornerIdx]] = {
        t: "UntF",
        v: {
          type: "#Pxl",
          val: values[cornerIdx],
        },
      };
    }
  }
}

export function lineEndpointsFromKeyOrigin(originObj) {
  const startPt = originObj.keyOriginLineStart.v;
  const endPt = originObj.keyOriginLineEnd.v;
  return [startPt.Hrzn.v, startPt.Vrtc.v, endPt.Hrzn.v, endPt.Vrtc.v];
}

export function setLineEndpointsOnKeyOrigin(originObj, endpoints) {
  const startPt = originObj.keyOriginLineStart.v;
  const endPt = originObj.keyOriginLineEnd.v;
  startPt.Hrzn.v = endpoints[0];
  startPt.Vrtc.v = endpoints[1];
  endPt.Hrzn.v = endpoints[2];
  endPt.Vrtc.v = endpoints[3];
}
