/**
 * Bitmap mask contour tracing, Bezier fitting, and SVG export.
 */

function createContourTracerInternals() {
  function ContourRun() {
    this.twiceArea = 0;
    this.pointCount = 0;
    this.pathSpec = {};
    this.polylineCoords = [];
    this.minX = 1e5;
    this.minY = 1e5;
    this.maxX = -1;
    this.maxY = -1;
    this.color = 0
  }

  function BezierPathSpec(segmentCount) {
    this.segmentCount = segmentCount;
    this.segmentTypes = new Array(segmentCount);
    this.segmentCoords = new Array(segmentCount * 6);
    this.aim = 0;
    this.handleCoords = new Array(segmentCount * 2);
    this.alpha = new Array(segmentCount);
    this.cornerSmoothness = new Array(segmentCount);
    this.handleBlendT = new Array(segmentCount)
  }

  function traceContourComponents(maskBuffer, width, height, options) {
    function readMaskAt(col, row, mask, stride) {
      return mask[stride * row + col]
    }

    function findNextForegroundPixel(startIdx) {
      var len = maskBuffer.length;
      while (startIdx < len && maskBuffer[startIdx] == 0) startIdx++;
      return startIdx < len ? startIdx : -1
    }

    function ringMajorityAt(col, row, label) {
      for (var ringRadius = 2; ringRadius < 5; ringRadius++) {
        var voteSum = 0;
        for (var ringOffset = -ringRadius + 1; ringOffset <= ringRadius - 1; ringOffset++) {
          voteSum += readMaskAt(col + ringOffset, row + ringRadius - 1, maskBuffer, width) == label ? 1 : -1;
          voteSum += readMaskAt(col + ringRadius - 1, row + ringOffset - 1, maskBuffer, width) == label ? 1 : -1;
          voteSum += readMaskAt(col + ringOffset - 1, row - ringRadius, maskBuffer, width) == label ? 1 : -1;
          voteSum += readMaskAt(col - ringRadius, row + ringOffset, maskBuffer, width) == label ? 1 : -1
        }
        if (voteSum > 0) return 1;
        else if (voteSum < 0) return 0
      }
      return 0
    }

    function walkContourBoundary(startCol, startRow) {
      var contourRun = new ContourRun,
        col = startCol,
        row = startRow,
        stepCol = 0,
        stepRow = 1,
        swapTemp;
      contourRun.color = maskBuffer[startRow * width + startCol];
      contourRun.sign = readMaskAt(startCol, startRow, maskBuffer, width) == contourRun.color ? "+" : "-";
      while (1) {
        contourRun.polylineCoords.push(col, row);
        if (col > contourRun.maxX) contourRun.maxX = col;
        if (col < contourRun.minX) contourRun.minX = col;
        if (row > contourRun.maxY) contourRun.maxY = row;
        if (row < contourRun.minY) contourRun.minY = row;
        contourRun.pointCount++;
        col += stepCol;
        row += stepRow;
        contourRun.twiceArea -= col * stepRow;
        if (col == startCol && row == startRow) break;
        var rightIsLabel = readMaskAt(col + (stepCol + stepRow - 1 >> 1), row + (stepRow - stepCol - 1 >> 1), maskBuffer, width) == contourRun.color,
          leftIsLabel = readMaskAt(col + (stepCol - stepRow - 1 >> 1), row + (stepRow + stepCol - 1 >> 1), maskBuffer, width) == contourRun.color;
        if (leftIsLabel && !rightIsLabel) {
          if (options.borderPolicy == "right" || options.borderPolicy == "black" && contourRun.sign == "+" || options.borderPolicy == "white" && contourRun.sign == "-" || options.borderPolicy == "majority" && ringMajorityAt(col, row, contourRun.color) || options.borderPolicy == "minority" && !ringMajorityAt(col, row, contourRun.color)) {
            swapTemp = stepCol;
            stepCol = -stepRow;
            stepRow = swapTemp
          } else {
            swapTemp = stepCol;
            stepCol = stepRow;
            stepRow = -swapTemp
          }
        } else if (leftIsLabel) {
          swapTemp = stepCol;
          stepCol = -stepRow;
          stepRow = swapTemp
        } else if (!rightIsLabel) {
          swapTemp = stepCol;
          stepCol = stepRow;
          stepRow = -swapTemp
        }
      }
      return contourRun
    }
    var scanIdx = 0,
      contours = [];
    while (true) {
      scanIdx = findNextForegroundPixel(scanIdx);
      if (scanIdx == -1) break;
      var startRow = Math.floor(scanIdx / width),
        contourRun = walkContourBoundary(scanIdx - startRow * width, startRow);
      for (var pairOff = 0; pairOff < contourRun.polylineCoords.length - 2; pairOff += 2) {
        var col = contourRun.polylineCoords[pairOff],
          row = contourRun.polylineCoords[pairOff + 1],
          maskIdx = row * width + col;
        if (col == contourRun.polylineCoords[pairOff + 2] && row + 1 == contourRun.polylineCoords[pairOff + 3] && maskBuffer[maskIdx] != 0) floodFillRegion(maskIdx, maskBuffer, width, 0)
      }
      if (contourRun.twiceArea > options.minArea) contours.push(contourRun)
    }
    for (var contourIdx = 0; contourIdx < contours.length; contourIdx++) contours[contourIdx].parent = -1;
    for (var contourIdx = 1; contourIdx < contours.length; contourIdx++) {
      var child = contours[contourIdx];
      for (var parentIdx = contourIdx - 1; parentIdx >= 0; parentIdx--) {
        var parent = contours[parentIdx];
        if (child.minX < parent.minX || child.maxX > parent.maxX || child.minY < parent.minY || child.maxY > parent.maxY) continue;
        if (!pointInPolygon(parent.polylineCoords, child.polylineCoords[0] + .5, child.polylineCoords[1] + .5)) continue;
        child.parent = parentIdx;
        break
      }
    }
    return contours
  }

  function refineContours(contours, options) {
    function ContourMoment(x, y, sumXY, sumX2, sumY2) {
      this.x = x;
      this.y = y;
      this.sumXY = sumXY;
      this.sumX2 = sumX2;
      this.sumY2 = sumY2
    }

    function wrapIndex(index, count) {
      return (count + index) % count
    }

    function cross2d(ax, ay, bx, by) {
      return ax * by - bx * ay
    }

    function dot2d(ax, ay, bx, by) {
      return ax * bx + ay * by
    }

    function angleInOpenRange(start, value, end) {
      if (start <= end) return start <= value && value < end;
      else return start <= value || value < end
    }

    function evalQuadForm9(coeffs, u, v) {
      var sum = 0;
      sum += u * coeffs[0] * u;
      sum += u * coeffs[1] * v;
      sum += u * coeffs[2];
      sum += v * coeffs[3] * u;
      sum += v * coeffs[4] * v;
      sum += v * coeffs[5];
      sum += coeffs[6] * u;
      sum += coeffs[7] * v;
      sum += coeffs[8];
      return sum
    }

    function lerpScalar(t, from, to) {
      return from + t * (to - from)
    }

    function lineOrient(ax, ay, bx, by) {
      var dxSign = Math.sign(bx - ax),
        dySign = -Math.sign(by - ay);
      return dxSign * (bx - ax) - dySign * (by - ay)
    }

    function dist2(dx, dy) {
      return Math.sqrt(dx * dx + dy * dy)
    }

    function cubicBezierAt(t, p0, p1, p2, p3) {
      var u = 1 - t;
      return u * u * u * p0 + 3 * (u * u * t) * p1 + 3 * (t * t * u) * p2 + t * t * t * p3
    }

    function cubicBezierUnitRoot(ax, ay, bx, by, cx, cy, ox, oy) {
      var crossA = cross2d(ax, ay, ox, oy),
        crossB = cross2d(bx, by, ox, oy),
        crossC = cross2d(cx, cy, ox, oy),
        quadA = crossA - 2 * crossB + crossC,
        quadB = -2 * crossA + 2 * crossB,
        quadC = crossA,
        discriminant = quadB * quadB - 4 * quadA * quadC;
      if (quadA == 0 || discriminant < 0) return -1;
      var sqrtDisc = Math.sqrt(discriminant),
        rootPlus = (-quadB + sqrtDisc) / (2 * quadA),
        rootMinus = (-quadB - sqrtDisc) / (2 * quadA);
      if (rootPlus >= 0 && rootPlus <= 1) return rootPlus;
      else if (rootMinus >= 0 && rootMinus <= 1) return rootMinus;
      else return -1
    }

    function buildPathMoments(contour) {
      contour.originX = contour.polylineCoords[0];
      contour.originY = contour.polylineCoords[1];
      contour.pathMoments = [];
      var moments = contour.pathMoments;
      moments.push(new ContourMoment(0, 0, 0, 0, 0));
      for (var pointIdx = 0; pointIdx < contour.pointCount; pointIdx++) {
        var relX = contour.polylineCoords[pointIdx << 1] - contour.originX,
          relY = contour.polylineCoords[(pointIdx << 1) + 1] - contour.originY;
        moments.push(new ContourMoment(moments[pointIdx].x + relX, moments[pointIdx].y + relY, moments[pointIdx].sumXY + relX * relY, moments[pointIdx].sumX2 + relX * relX, moments[pointIdx].sumY2 + relY * relY))
      }
    }

    function smoothPolylineCorners(contour) {
      var pointCount = contour.pointCount,
        polyline = contour.polylineCoords,
        octantIdx, cornerAtVertex = new Array(pointCount),
        nextDistinctVertex = new Array(pointCount),
        octantCounts = new Array(4),
        lowerHullDx, lowerHullDy, upperHullDx, upperHullDy, stepDx, stepDy, signDx, signDy, edgeDx, edgeDy, foundFullOctant, pointIdx, wrapSteps, trailStart, crossLower, crossLowerUnit, crossUpper, crossUpperUnit, walkVertex = 0;
      contour.farthestCornerWrap = new Array(pointCount);
      for (pointIdx = pointCount - 1; pointIdx >= 0; pointIdx--) {
        if (polyline[pointIdx << 1] != polyline[walkVertex << 1] && polyline[(pointIdx << 1) + 1] != polyline[(walkVertex << 1) + 1]) walkVertex = pointIdx + 1;
        nextDistinctVertex[pointIdx] = walkVertex
      }
      for (pointIdx = pointCount - 1; pointIdx >= 0; pointIdx--) {
        var nextCoordOff = wrapIndex(pointIdx + 1, pointCount) << 1;
        octantCounts[0] = octantCounts[1] = octantCounts[2] = octantCounts[3] = 0;
        octantIdx = (3 + 3 * (polyline[nextCoordOff] - polyline[pointIdx << 1]) + (polyline[nextCoordOff + 1] - polyline[(pointIdx << 1) + 1])) / 2;
        octantCounts[octantIdx]++;
        lowerHullDx = 0;
        lowerHullDy = 0;
        upperHullDx = 0;
        upperHullDy = 0;
        walkVertex = nextDistinctVertex[pointIdx];
        trailStart = pointIdx;
        while (1) {
          foundFullOctant = 0;
          octantIdx = (3 + 3 * Math.sign(polyline[walkVertex * 2] - polyline[trailStart * 2]) + Math.sign(polyline[walkVertex * 2 + 1] - polyline[trailStart * 2 + 1])) / 2;
          octantCounts[octantIdx]++;
          if (octantCounts[0] && octantCounts[1] && octantCounts[2] && octantCounts[3]) {
            cornerAtVertex[pointIdx] = trailStart;
            foundFullOctant = 1;
            break
          }
          edgeDx = polyline[walkVertex * 2] - polyline[pointIdx * 2];
          edgeDy = polyline[walkVertex * 2 + 1] - polyline[pointIdx * 2 + 1];
          if (cross2d(lowerHullDx, lowerHullDy, edgeDx, edgeDy) < 0 || cross2d(upperHullDx, upperHullDy, edgeDx, edgeDy) > 0) {
            break
          }
          if (Math.abs(edgeDx) <= 1 && Math.abs(edgeDy) <= 1) {} else {
            stepDx = edgeDx + (edgeDy >= 0 && (edgeDy > 0 || edgeDx < 0) ? 1 : -1);
            stepDy = edgeDy + (edgeDx <= 0 && (edgeDx < 0 || edgeDy < 0) ? 1 : -1);
            if (cross2d(lowerHullDx, lowerHullDy, stepDx, stepDy) >= 0) {
              lowerHullDx = stepDx;
              lowerHullDy = stepDy
            }
            stepDx = edgeDx + (edgeDy <= 0 && (edgeDy < 0 || edgeDx < 0) ? 1 : -1);
            stepDy = edgeDy + (edgeDx >= 0 && (edgeDx > 0 || edgeDy < 0) ? 1 : -1);
            if (cross2d(upperHullDx, upperHullDy, stepDx, stepDy) <= 0) {
              upperHullDx = stepDx;
              upperHullDy = stepDy
            }
          }
          trailStart = walkVertex;
          walkVertex = nextDistinctVertex[trailStart];
          if (!angleInOpenRange(walkVertex, pointIdx, trailStart)) {
            break
          }
        }
        if (foundFullOctant == 0) {
          signDx = Math.sign(polyline[walkVertex * 2] - polyline[trailStart * 2]);
          signDy = Math.sign(polyline[walkVertex * 2 + 1] - polyline[trailStart * 2 + 1]);
          edgeDx = polyline[trailStart * 2] - polyline[pointIdx * 2];
          edgeDy = polyline[trailStart * 2 + 1] - polyline[pointIdx * 2 + 1];
          crossLower = cross2d(lowerHullDx, lowerHullDy, edgeDx, edgeDy);
          crossLowerUnit = cross2d(lowerHullDx, lowerHullDy, signDx, signDy);
          crossUpper = cross2d(upperHullDx, upperHullDy, edgeDx, edgeDy);
          crossUpperUnit = cross2d(upperHullDx, upperHullDy, signDx, signDy);
          wrapSteps = 1e7;
          if (crossLowerUnit < 0) {
            wrapSteps = Math.floor(crossLower / -crossLowerUnit)
          }
          if (crossUpperUnit > 0) {
            wrapSteps = Math.min(wrapSteps, Math.floor(-crossUpper / crossUpperUnit))
          }
          cornerAtVertex[pointIdx] = wrapIndex(trailStart + wrapSteps, pointCount)
        }
      }
      wrapSteps = cornerAtVertex[pointCount - 1];
      contour.farthestCornerWrap[pointCount - 1] = wrapSteps;
      for (pointIdx = pointCount - 2; pointIdx >= 0; pointIdx--) {
        if (angleInOpenRange(pointIdx + 1, cornerAtVertex[pointIdx], wrapSteps)) {
          wrapSteps = cornerAtVertex[pointIdx]
        }
        contour.farthestCornerWrap[pointIdx] = wrapSteps
      }
      for (pointIdx = pointCount - 1; angleInOpenRange(wrapIndex(pointIdx + 1, pointCount), wrapSteps, contour.farthestCornerWrap[pointIdx]); pointIdx--) {
        contour.farthestCornerWrap[pointIdx] = wrapSteps
      }
    }

    function computeCornerIndices(contour) {
      function chordFitError(contourRun, startIdx, endIdx) {
        var pointCount = contourRun.pointCount,
          polyline = contourRun.polylineCoords,
          moments = contourRun.pathMoments,
          spanSumX, spanSumY, spanSumX2, spanSumXY, spanSumY2, spanPointCount, quadA, quadB, quadC, fitMetric, midRelX, midRelY, chordDx, chordDy, wrapsContour = 0;
        if (endIdx >= pointCount) {
          endIdx -= pointCount;
          wrapsContour = 1
        }
        if (wrapsContour == 0) {
          spanSumX = moments[endIdx + 1].x - moments[startIdx].x;
          spanSumY = moments[endIdx + 1].y - moments[startIdx].y;
          spanSumX2 = moments[endIdx + 1].sumX2 - moments[startIdx].sumX2;
          spanSumXY = moments[endIdx + 1].sumXY - moments[startIdx].sumXY;
          spanSumY2 = moments[endIdx + 1].sumY2 - moments[startIdx].sumY2;
          spanPointCount = endIdx + 1 - startIdx
        } else {
          spanSumX = moments[endIdx + 1].x - moments[startIdx].x + moments[pointCount].x;
          spanSumY = moments[endIdx + 1].y - moments[startIdx].y + moments[pointCount].y;
          spanSumX2 = moments[endIdx + 1].sumX2 - moments[startIdx].sumX2 + moments[pointCount].sumX2;
          spanSumXY = moments[endIdx + 1].sumXY - moments[startIdx].sumXY + moments[pointCount].sumXY;
          spanSumY2 = moments[endIdx + 1].sumY2 - moments[startIdx].sumY2 + moments[pointCount].sumY2;
          spanPointCount = endIdx + 1 - startIdx + pointCount
        }
        midRelX = (polyline[startIdx << 1] + polyline[endIdx << 1]) / 2 - polyline[0];
        midRelY = (polyline[(startIdx << 1) + 1] + polyline[(endIdx << 1) + 1]) / 2 - polyline[1];
        chordDx = polyline[endIdx << 1] - polyline[startIdx << 1];
        chordDy = -(polyline[(endIdx << 1) + 1] - polyline[(startIdx << 1) + 1]);
        quadA = (spanSumX2 - 2 * spanSumX * midRelX) / spanPointCount + midRelX * midRelX;
        quadB = (spanSumXY - spanSumX * midRelY - spanSumY * midRelX) / spanPointCount + midRelX * midRelY;
        quadC = (spanSumY2 - 2 * spanSumY * midRelY) / spanPointCount + midRelY * midRelY;
        fitMetric = chordDy * chordDy * quadA + 2 * chordDy * chordDx * quadB + chordDx * chordDx * quadC;
        return Math.sqrt(fitMetric)
      }
      var pointIdx, cornerSlot, cornerCount, prevCornerIdx, pointCount = contour.pointCount,
        dpCost = new Array(pointCount + 1),
        dpPrevCorner = new Array(pointCount + 1),
        farthestCornerLimit = new Array(pointCount),
        cornerStartForEnd = new Array(pointCount + 1),
        cornerVertices = new Array(pointCount + 1),
        cornerEndReverse = new Array(pointCount + 1),
        candidateCost, bestCost, limitCorner;
      for (pointIdx = 0; pointIdx < pointCount; pointIdx++) {
        limitCorner = wrapIndex(contour.farthestCornerWrap[wrapIndex(pointIdx - 1, pointCount)] - 1, pointCount);
        if (limitCorner == pointIdx) {
          limitCorner = wrapIndex(pointIdx + 1, pointCount)
        }
        if (limitCorner < pointIdx) {
          farthestCornerLimit[pointIdx] = pointCount
        } else {
          farthestCornerLimit[pointIdx] = limitCorner
        }
      }
      cornerSlot = 1;
      for (pointIdx = 0; pointIdx < pointCount; pointIdx++) {
        while (cornerSlot <= farthestCornerLimit[pointIdx]) {
          cornerStartForEnd[cornerSlot] = pointIdx;
          cornerSlot++
        }
      }
      pointIdx = 0;
      for (cornerSlot = 0; pointIdx < pointCount; cornerSlot++) {
        cornerVertices[cornerSlot] = pointIdx;
        pointIdx = farthestCornerLimit[pointIdx]
      }
      cornerVertices[cornerSlot] = pointCount;
      cornerCount = cornerSlot;
      pointIdx = pointCount;
      for (cornerSlot = cornerCount; cornerSlot > 0; cornerSlot--) {
        cornerEndReverse[cornerSlot] = pointIdx;
        pointIdx = cornerStartForEnd[pointIdx]
      }
      cornerEndReverse[0] = 0;
      dpCost[0] = 0;
      for (cornerSlot = 1; cornerSlot <= cornerCount; cornerSlot++) {
        for (pointIdx = cornerEndReverse[cornerSlot]; pointIdx <= cornerVertices[cornerSlot]; pointIdx++) {
          bestCost = -1;
          for (prevCornerIdx = cornerVertices[cornerSlot - 1]; prevCornerIdx >= cornerStartForEnd[pointIdx]; prevCornerIdx--) {
            candidateCost = chordFitError(contour, prevCornerIdx, pointIdx) + dpCost[prevCornerIdx];
            if (bestCost < 0 || candidateCost < bestCost) {
              dpPrevCorner[pointIdx] = prevCornerIdx;
              bestCost = candidateCost
            }
          }
          dpCost[pointIdx] = bestCost
        }
      }
      contour.cornerCount = cornerCount;
      contour.cornerIndices = new Array(cornerCount);
      for (pointIdx = pointCount, cornerSlot = cornerCount - 1; pointIdx > 0; cornerSlot--) {
        pointIdx = dpPrevCorner[pointIdx];
        contour.cornerIndices[cornerSlot] = pointIdx
      }
    }

    function fitBezierPathSpec(contour) {
      function computeCornerFrame(contourRun, segStart, segEnd, centroidOut, normalOut, outOff) {
        var pointCount = contourRun.pointCount,
          moments = contourRun.pathMoments,
          wrapCount = 0,
          normLen;
        while (segEnd >= pointCount) {
          segEnd -= pointCount;
          wrapCount += 1
        }
        while (segStart >= pointCount) {
          segStart -= pointCount;
          wrapCount -= 1
        }
        while (segEnd < 0) {
          segEnd += pointCount;
          wrapCount -= 1
        }
        while (segStart < 0) {
          segStart += pointCount;
          wrapCount += 1
        }
        var spanX = moments[segEnd + 1].x - moments[segStart].x + wrapCount * moments[pointCount].x,
          spanY = moments[segEnd + 1].y - moments[segStart].y + wrapCount * moments[pointCount].y,
          spanX2 = moments[segEnd + 1].sumX2 - moments[segStart].sumX2 + wrapCount * moments[pointCount].sumX2,
          spanXY = moments[segEnd + 1].sumXY - moments[segStart].sumXY + wrapCount * moments[pointCount].sumXY,
          spanY2 = moments[segEnd + 1].sumY2 - moments[segStart].sumY2 + wrapCount * moments[pointCount].sumY2,
          pointSpan = segEnd + 1 - segStart + wrapCount * pointCount;
        centroidOut[outOff] = spanX / pointSpan;
        centroidOut[outOff + 1] = spanY / pointSpan;
        var covXX = (spanX2 - spanX * spanX / pointSpan) / pointSpan,
          covXY = (spanXY - spanX * spanY / pointSpan) / pointSpan,
          covYY = (spanY2 - spanY * spanY / pointSpan) / pointSpan,
          eigenMax = (covXX + covYY + Math.sqrt((covXX - covYY) * (covXX - covYY) + 4 * covXY * covXY)) / 2;
        covXX -= eigenMax;
        covYY -= eigenMax;
        if (Math.abs(covXX) >= Math.abs(covYY)) {
          normLen = Math.sqrt(covXX * covXX + covXY * covXY);
          if (normLen != 0) {
            normalOut[outOff] = -covXY / normLen;
            normalOut[outOff + 1] = covXX / normLen
          }
        } else {
          normLen = Math.sqrt(covYY * covYY + covXY * covXY);
          if (normLen != 0) {
            normalOut[outOff] = -covYY / normLen;
            normalOut[outOff + 1] = covXY / normLen
          }
        }
        if (normLen == 0) {
          normalOut[outOff] = normalOut[outOff + 1] = 0
        }
      }
      var cornerCount = contour.cornerCount,
        cornerIndices = contour.cornerIndices,
        pointCount = contour.pointCount,
        polyline = contour.polylineCoords,
        originX = contour.originX,
        originY = contour.originY,
        cornerCentroids = new Array(cornerCount * 2),
        cornerNormals = new Array(cornerCount * 2),
        cornerQuadForms = new Array(cornerCount),
        projBasis = new Array(3),
        cornerIdx, nextCornerIdx, gridX, rowOff, det2x2, normLenSq, invNormLenSq, bestQuadVal, bestRelX, bestRelY, errX, errY, snapBit;
      contour.pathSpec = new BezierPathSpec(cornerCount);
      for (cornerIdx = 0; cornerIdx < cornerCount; cornerIdx++) {
        nextCornerIdx = cornerIndices[wrapIndex(cornerIdx + 1, cornerCount)];
        nextCornerIdx = wrapIndex(nextCornerIdx - cornerIndices[cornerIdx], pointCount) + cornerIndices[cornerIdx];
        cornerCentroids[cornerIdx << 1] = 0;
        cornerCentroids[(cornerIdx << 1) + 1] = 0;
        cornerNormals[cornerIdx << 1] = 0;
        cornerNormals[(cornerIdx << 1) + 1] = 0;
        computeCornerFrame(contour, cornerIndices[cornerIdx], nextCornerIdx, cornerCentroids, cornerNormals, cornerIdx << 1)
      }
      for (cornerIdx = 0; cornerIdx < cornerCount; cornerIdx++) {
        cornerQuadForms[cornerIdx] = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        normLenSq = cornerNormals[cornerIdx << 1] * cornerNormals[cornerIdx << 1] + cornerNormals[(cornerIdx << 1) + 1] * cornerNormals[(cornerIdx << 1) + 1];
        invNormLenSq = 1 / normLenSq;
        if (normLenSq != 0) {
          projBasis[0] = cornerNormals[(cornerIdx << 1) + 1];
          projBasis[1] = -cornerNormals[cornerIdx << 1];
          projBasis[2] = -projBasis[1] * cornerCentroids[(cornerIdx << 1) + 1] - projBasis[0] * cornerCentroids[cornerIdx << 1];
          for (rowOff = 0; rowOff < 3; rowOff++) {
            cornerQuadForms[cornerIdx][rowOff * 3 + 0] = projBasis[rowOff] * projBasis[0] * invNormLenSq;
            cornerQuadForms[cornerIdx][rowOff * 3 + 1] = projBasis[rowOff] * projBasis[1] * invNormLenSq;
            cornerQuadForms[cornerIdx][rowOff * 3 + 2] = projBasis[rowOff] * projBasis[2] * invNormLenSq
          }
        }
      }
      var mergedQuad = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (cornerIdx = 0; cornerIdx < cornerCount; cornerIdx++) {
        mergedQuad[0] = mergedQuad[1] = mergedQuad[2] = mergedQuad[3] = mergedQuad[4] = mergedQuad[5] = mergedQuad[6] = mergedQuad[7] = mergedQuad[8] = mergedQuad[9] = 0;
        var cornerRelX = polyline[cornerIndices[cornerIdx] << 1] - originX,
          cornerRelY = polyline[(cornerIndices[cornerIdx] << 1) + 1] - originY,
          handleRelX = 0,
          handleRelY = 0;
        nextCornerIdx = wrapIndex(cornerIdx - 1, cornerCount);
        for (rowOff = 0; rowOff < 9; rowOff += 3) {
          mergedQuad[rowOff + 0] = cornerQuadForms[nextCornerIdx][rowOff + 0] + cornerQuadForms[cornerIdx][rowOff + 0];
          mergedQuad[rowOff + 1] = cornerQuadForms[nextCornerIdx][rowOff + 1] + cornerQuadForms[cornerIdx][rowOff + 1];
          mergedQuad[rowOff + 2] = cornerQuadForms[nextCornerIdx][rowOff + 2] + cornerQuadForms[cornerIdx][rowOff + 2]
        }
        while (1) {
          det2x2 = mergedQuad[0] * mergedQuad[4] - mergedQuad[1] * mergedQuad[3];
          if (det2x2 != 0) {
            handleRelX = (-mergedQuad[2] * mergedQuad[4] + mergedQuad[5] * mergedQuad[0]) / det2x2;
            handleRelY = (mergedQuad[2] * mergedQuad[3] - mergedQuad[5] * mergedQuad[0]) / det2x2;
            break
          }
          if (mergedQuad[0] > mergedQuad[4]) {
            projBasis[0] = -mergedQuad[1];
            projBasis[1] = mergedQuad[0]
          } else if (mergedQuad[4]) {
            projBasis[0] = -mergedQuad[4];
            projBasis[1] = mergedQuad[3]
          } else {
            projBasis[0] = 1;
            projBasis[1] = 0
          }
          normLenSq = projBasis[0] * projBasis[0] + projBasis[1] * projBasis[1];
          invNormLenSq = 1 / normLenSq;
          projBasis[2] = -projBasis[1] * cornerRelY - projBasis[0] * cornerRelX;
          for (rowOff = 0; rowOff < 3; rowOff++) {
            mergedQuad[rowOff * 3 + 0] += projBasis[rowOff] * projBasis[0] * invNormLenSq;
            mergedQuad[rowOff * 3 + 1] += projBasis[rowOff] * projBasis[1] * invNormLenSq;
            mergedQuad[rowOff * 3 + 2] += projBasis[rowOff] * projBasis[2] * invNormLenSq
          }
        }
        errX = Math.abs(handleRelX - cornerRelX);
        errY = Math.abs(handleRelY - cornerRelY);
        if (errX <= .5 && errY <= .5) {
          contour.pathSpec.handleCoords[cornerIdx << 1] = handleRelX + originX;
          contour.pathSpec.handleCoords[(cornerIdx << 1) + 1] = handleRelY + originY;
          continue
        }
        bestQuadVal = evalQuadForm9(mergedQuad, cornerRelX, cornerRelY);
        bestRelX = cornerRelX;
        bestRelY = cornerRelY;
        if (mergedQuad[0] != 0) {
          for (snapBit = 0; snapBit < 2; snapBit++) {
            handleRelY = cornerRelY - .5 + snapBit;
            handleRelX = -(mergedQuad[1] * handleRelY + mergedQuad[2]) / mergedQuad[0];
            errX = Math.abs(handleRelX - cornerRelX);
            gridX = evalQuadForm9(mergedQuad, handleRelX, handleRelY);
            if (errX <= .5 && gridX < bestQuadVal) {
              bestQuadVal = gridX;
              bestRelX = handleRelX;
              bestRelY = handleRelY
            }
          }
        }
        if (mergedQuad[4] != 0) {
          for (snapBit = 0; snapBit < 2; snapBit++) {
            handleRelX = cornerRelX - .5 + snapBit;
            handleRelY = -(mergedQuad[3] * handleRelX + mergedQuad[5]) / mergedQuad[4];
            errY = Math.abs(handleRelY - cornerRelY);
            gridX = evalQuadForm9(mergedQuad, handleRelX, handleRelY);
            if (errY <= .5 && gridX < bestQuadVal) {
              bestQuadVal = gridX;
              bestRelX = handleRelX;
              bestRelY = handleRelY
            }
          }
        }
        for (rowOff = 0; rowOff < 2; rowOff++) {
          for (gridX = 0; gridX < 2; gridX++) {
            handleRelX = cornerRelX - .5 + rowOff;
            handleRelY = cornerRelY - .5 + gridX;
            snapBit = evalQuadForm9(mergedQuad, handleRelX, handleRelY);
            if (snapBit < bestQuadVal) {
              bestQuadVal = snapBit;
              bestRelX = handleRelX;
              bestRelY = handleRelY
            }
          }
        }
        contour.pathSpec.handleCoords[cornerIdx << 1] = bestRelX + originX;
        contour.pathSpec.handleCoords[(cornerIdx << 1) + 1] = bestRelY + originY
      }
    }

    function writeBezierSegments(contour) {
      var segCount = contour.pathSpec.segmentCount,
        pathSpec = contour.pathSpec,
        segIdx, nextSeg, farSeg, lineLen, bendMetric, cornerSmooth, blendT, segCoordOff;
      for (segIdx = 0; segIdx < segCount; segIdx++) {
        nextSeg = wrapIndex(segIdx + 1, segCount);
        farSeg = wrapIndex(segIdx + 2, segCount);
        var handleX0 = pathSpec.handleCoords[segIdx << 1],
          handleY0 = pathSpec.handleCoords[(segIdx << 1) + 1],
          handleX2 = pathSpec.handleCoords[farSeg << 1],
          handleY2 = pathSpec.handleCoords[(farSeg << 1) + 1],
          handleX1 = pathSpec.handleCoords[nextSeg << 1],
          handleY1 = pathSpec.handleCoords[(nextSeg << 1) + 1],
          midAx = lerpScalar(.5, handleX2, handleX1),
          midAy = lerpScalar(.5, handleY2, handleY1);
        lineLen = lineOrient(handleX0, handleY0, handleX2, handleY2);
        if (lineLen != 0) {
          bendMetric = cross2d(handleX1 - handleX0, handleY1 - handleY0, handleX2 - handleX0, handleY2 - handleY0) / lineLen;
          bendMetric = Math.abs(bendMetric);
          cornerSmooth = bendMetric > 1 ? 1 - 1 / bendMetric : 0;
          cornerSmooth = cornerSmooth * (1 / .75)
        } else {
          cornerSmooth = 4 / 3
        }
        pathSpec.cornerSmoothness[nextSeg] = cornerSmooth;
        segCoordOff = 3 * nextSeg << 1;
        if (cornerSmooth >= options.lineCornerThreshold) {
          pathSpec.segmentTypes[nextSeg] = 0;
          pathSpec.segmentCoords[segCoordOff + 0] = pathSpec.segmentCoords[segCoordOff + 1] = 0;
          pathSpec.segmentCoords[segCoordOff + 2] = handleX1;
          pathSpec.segmentCoords[segCoordOff + 3] = handleY1;
          pathSpec.segmentCoords[segCoordOff + 4] = midAx;
          pathSpec.segmentCoords[segCoordOff + 5] = midAy
        } else {
          if (cornerSmooth < .55) {
            cornerSmooth = .55
          } else if (cornerSmooth > 1) {
            cornerSmooth = 1
          }
          blendT = .5 + .5 * cornerSmooth;
          pathSpec.segmentTypes[nextSeg] = 1;
          pathSpec.segmentCoords[segCoordOff] = lerpScalar(blendT, handleX0, handleX1);
          pathSpec.segmentCoords[segCoordOff + 1] = lerpScalar(blendT, handleY0, handleY1);
          pathSpec.segmentCoords[segCoordOff + 2] = lerpScalar(blendT, handleX2, handleX1);
          pathSpec.segmentCoords[segCoordOff + 3] = lerpScalar(blendT, handleY2, handleY1);
          pathSpec.segmentCoords[segCoordOff + 4] = midAx;
          pathSpec.segmentCoords[segCoordOff + 5] = midAy
        }
        pathSpec.alpha[nextSeg] = cornerSmooth;
        pathSpec.handleBlendT[nextSeg] = .5
      }
      pathSpec.segmentsFinalized = 1
    }

    function simplifyPathSpec(contour) {
      function CurveMergeCandidate() {
        this.fitErrorSq = 0;
        this.anchorAx = 0;
        this.anchorAy = 0;
        this.anchorBx = 0;
        this.anchorBy = 0;
        this.splitT0 = 0;
        this.splitT1 = 0;
        this.alpha = 0
      }

      function tryMergeCurveRange(contourRun, segStart, segEnd, mergeOut, maxError, turnSign, areaPrefix) {
        var segCount = contourRun.pathSpec.segmentCount,
          segmentCoords = contourRun.pathSpec.segmentCoords,
          handleCoords = contourRun.pathSpec.handleCoords;
        if (segStart == segEnd) return 1;
        var walkSeg = segStart,
          nextSeg = wrapIndex(segStart + 1, segCount),
          stepSeg = wrapIndex(walkSeg + 1, segCount),
          hx0 = handleCoords[segStart << 1],
          hy0 = handleCoords[(segStart << 1) + 1],
          hx1 = handleCoords[nextSeg << 1],
          hy1 = handleCoords[(nextSeg << 1) + 1],
          turnAtMid = turnSign[stepSeg];
        if (turnAtMid == 0) return 1;
        var baseLen = dist2(hx0 - hx1, hy0 - hy1);
        for (walkSeg = stepSeg; walkSeg != segEnd; walkSeg = stepSeg) {
          stepSeg = wrapIndex(walkSeg + 1, segCount);
          var farSeg = wrapIndex(walkSeg + 2, segCount),
            midHx = handleCoords[stepSeg << 1],
            midHy = handleCoords[(stepSeg << 1) + 1],
            farHx = handleCoords[farSeg << 1],
            farHy = handleCoords[(farSeg << 1) + 1];
          if (turnSign[stepSeg] != turnAtMid) return 1;
          if (Math.sign(cross2d(hx1 - hx0, hy1 - hy0, farHx - midHx, farHy - midHy)) != turnAtMid) return 1;
          if (dot2d(hx1 - hx0, hy1 - hy0, farHx - midHx, farHy - midHy) < baseLen * dist2(midHx - farHx, midHy - farHy) * -.999847695156) return 1
        }
        var endOffPrev = wrapIndex(segStart, segCount) * 3 + 2 << 1,
          handleOffNext = wrapIndex(segStart + 1, segCount) << 1,
          handleOffEnd = wrapIndex(segEnd, segCount) << 1,
          endOffWrap = wrapIndex(segEnd, segCount) * 3 + 2 << 1,
          endAx = segmentCoords[endOffPrev],
          endAy = segmentCoords[endOffPrev + 1],
          ctrlAx = handleCoords[handleOffNext],
          ctrlAy = handleCoords[handleOffNext + 1],
          ctrlBx = handleCoords[handleOffEnd],
          ctrlBy = handleCoords[handleOffEnd + 1],
          endBx = segmentCoords[endOffWrap],
          endBy = segmentCoords[endOffWrap + 1],
          originHx = handleCoords[0],
          originHy = handleCoords[1];
        endOffPrev = segEnd * 3 + 2 << 1;
        var closeAx = segmentCoords[endOffPrev],
          closeAy = segmentCoords[endOffPrev + 1],
          signedArea = areaPrefix[segEnd] - areaPrefix[segStart];
        signedArea -= cross2d(closeAx - originHx, closeAy - originHy, closeAx - originHx, closeAy - originHy) / 2;
        if (segStart >= segEnd) {
          signedArea += areaPrefix[segCount]
        }
        var deltaAx = ctrlAx - endAx,
          deltaAy = ctrlAy - endAy,
          deltaBx = ctrlBx - endAx,
          deltaBy = ctrlBy - endAy,
          deltaCx = endBx - endAx,
          deltaCy = endBy - endAy,
          crossAB = cross2d(deltaAx, deltaAy, deltaBx, deltaBy),
          crossAC = cross2d(deltaAx, deltaAy, deltaCx, deltaCy),
          crossBC = cross2d(deltaBx, deltaBy, deltaCx, deltaCy),
          crossSum = crossAB + crossBC - crossAC;
        if (crossAC == crossAB) return 1;
        var splitT0 = crossBC / (crossBC - crossSum),
          splitT1 = crossAC / (crossAC - crossAB),
          halfArea = crossAC * splitT0 / 2;
        if (halfArea == 0) return 1;
        var areaRatio = signedArea / halfArea,
          mergeAlpha = 2 - Math.sqrt(4 - areaRatio / .3);
        mergeOut.anchorAx = lerpScalar(splitT0 * mergeAlpha, endAx, ctrlAx);
        mergeOut.anchorAy = lerpScalar(splitT0 * mergeAlpha, endAy, ctrlAy);
        mergeOut.anchorBx = lerpScalar(splitT1 * mergeAlpha, endBx, ctrlBx);
        mergeOut.anchorBy = lerpScalar(splitT1 * mergeAlpha, endBy, ctrlBy);
        mergeOut.alpha = mergeAlpha;
        mergeOut.splitT0 = splitT0;
        mergeOut.splitT1 = splitT1;
        ctrlAx = mergeOut.anchorAx;
        ctrlAy = mergeOut.anchorAy;
        ctrlBx = mergeOut.anchorBx;
        ctrlBy = mergeOut.anchorBy;
        mergeOut.fitErrorSq = 0;
        for (walkSeg = wrapIndex(segStart + 1, segCount); walkSeg != segEnd; walkSeg = stepSeg) {
          stepSeg = wrapIndex(walkSeg + 1, segCount);
          var knotHx = handleCoords[walkSeg << 1],
            knotHy = handleCoords[(walkSeg << 1) + 1],
            nextHx = handleCoords[stepSeg << 1],
            nextHy = handleCoords[(stepSeg << 1) + 1];
          splitT0 = cubicBezierUnitRoot(ctrlAx - endAx, ctrlAy - endAy, ctrlBx - ctrlAx, ctrlBy - ctrlAy, endBx - ctrlBx, endBy - ctrlBy, nextHx - knotHx, nextHy - knotHy);
          if (splitT0 < -.5) return 1;
          var curveX = cubicBezierAt(splitT0, endAx, ctrlAx, ctrlBx, endBx),
            curveY = cubicBezierAt(splitT0, endAy, ctrlAy, ctrlBy, endBy),
            chordLen = dist2(nextHx - knotHx, nextHy - knotHy);
          if (chordLen == 0) return 1;
          var offset = cross2d(nextHx - knotHx, nextHy - knotHy, curveX - knotHx, curveY - knotHy) / chordLen;
          if (Math.abs(offset) > maxError) return 1;
          if (dot2d(nextHx - knotHx, nextHy - knotHy, curveX - knotHx, curveY - knotHy) < 0 || dot2d(knotHx - nextHx, knotHy - nextHy, curveX - nextHx, curveY - nextHy) < 0) {
            return 1
          }
          mergeOut.fitErrorSq += offset * offset
        }
        for (walkSeg = segStart; walkSeg != segEnd; walkSeg = stepSeg) {
          stepSeg = wrapIndex(walkSeg + 1, segCount);
          var segEndOff = walkSeg * 3 + 2 << 1,
            nextEndOff = stepSeg * 3 + 2 << 1,
            segEndAx = segmentCoords[segEndOff],
            segEndAy = segmentCoords[segEndOff + 1],
            nextEndAx = segmentCoords[nextEndOff],
            nextEndAy = segmentCoords[nextEndOff + 1];
          splitT0 = cubicBezierUnitRoot(ctrlAx - endAx, ctrlAy - endAy, ctrlBx - ctrlAx, ctrlBy - ctrlAy, endBx - ctrlBx, endBy - ctrlBy, nextEndAx - segEndAx, nextEndAy - segEndAy);
          if (splitT0 < -.5) return 1;
          var curveX = cubicBezierAt(splitT0, endAx, ctrlAx, ctrlBx, endBx),
            curveY = cubicBezierAt(splitT0, endAy, ctrlAy, ctrlBy, endBy),
            chordLen = dist2(nextEndAx - segEndAx, nextEndAy - segEndAy);
          if (chordLen == 0) return 1;
          var offset = cross2d(nextEndAx - segEndAx, nextEndAy - segEndAy, curveX - segEndAx, curveY - segEndAy) / chordLen,
            margin = cross2d(nextEndAx - segEndAx, nextEndAy - segEndAy, handleCoords[stepSeg << 1] - segEndAx, handleCoords[(stepSeg << 1) + 1] - segEndAy) / chordLen;
          margin *= .75 * contourRun.pathSpec.alpha[stepSeg];
          if (margin < 0) {
            offset = -offset;
            margin = -margin
          }
          if (offset < margin - maxError) return 1;
          if (offset < margin) {
            mergeOut.fitErrorSq += (offset - margin) * (offset - margin)
          }
        }
        return 0
      }
      var pathSpec = contour.pathSpec,
        segCount = pathSpec.segmentCount,
        handleCoords = pathSpec.handleCoords,
        dpPrevSeg = new Array(segCount + 1),
        dpErrorSq = new Array(segCount + 1),
        dpSegCount = new Array(segCount + 1),
        dpMergeAtEnd = new Array(segCount + 1),
        outSegCount, segIdx, endIdx, mergeOk, mergeCandidate = new CurveMergeCandidate,
        alphaT, nextIdx, signedArea, alphaAtEnd, simplifiedSpec, handleOutT1, handleOutT0, curveTurnSign = new Array(segCount),
        signedAreaPrefix = new Array(segCount + 1);
      for (segIdx = 0; segIdx < segCount; segIdx++) {
        if (pathSpec.segmentTypes[segIdx] == "CURVE") {
          var prevHx = handleCoords[wrapIndex(segIdx - 1, segCount) << 1],
            prevHy = handleCoords[(wrapIndex(segIdx - 1, segCount) << 1) + 1],
            hx = handleCoords[segIdx << 1],
            hy = handleCoords[(segIdx << 1) + 1],
            nextHx = handleCoords[wrapIndex(segIdx + 1, segCount) << 1],
            nextHy = handleCoords[(wrapIndex(segIdx + 1, segCount) << 1) + 1];
          curveTurnSign[segIdx] = Math.sign(cross2d(hx - prevHx, hy - prevHy, nextHx - hx, nextHy - hy))
        } else {
          curveTurnSign[segIdx] = 0
        }
      }
      signedArea = 0;
      signedAreaPrefix[0] = 0;
      var originHx = pathSpec.handleCoords[0],
        originHy = pathSpec.handleCoords[1];
      for (segIdx = 0; segIdx < segCount; segIdx++) {
        nextIdx = wrapIndex(segIdx + 1, segCount);
        if (pathSpec.segmentTypes[nextIdx] == "CURVE") {
          alphaT = pathSpec.alpha[nextIdx];
          var segEndOff = segIdx * 3 + 2 << 1,
            nextEndOff = nextIdx * 3 + 2 << 1,
            endAx = pathSpec.segmentCoords[segEndOff],
            endAy = pathSpec.segmentCoords[segEndOff + 1],
            nextHx = handleCoords[nextIdx << 1],
            nextHy = handleCoords[(nextIdx << 1) + 1],
            nextEndAx = pathSpec.segmentCoords[nextEndOff],
            nextEndAy = pathSpec.segmentCoords[nextEndOff + 1];
          signedArea += .3 * alphaT * (4 - alphaT) * cross2d(nextHx - endAx, nextHy - endAy, nextEndAx - endAx, nextEndAy - endAy) / 2;
          signedArea += cross2d(endAx - originHx, endAy - originHy, nextEndAx - originHx, nextEndAy - originHy) / 2
        }
        signedAreaPrefix[segIdx + 1] = signedArea
      }
      dpPrevSeg[0] = -1;
      dpErrorSq[0] = 0;
      dpSegCount[0] = 0;
      for (endIdx = 1; endIdx <= segCount; endIdx++) {
        dpPrevSeg[endIdx] = endIdx - 1;
        dpErrorSq[endIdx] = dpErrorSq[endIdx - 1];
        dpSegCount[endIdx] = dpSegCount[endIdx - 1] + 1;
        for (segIdx = endIdx - 2; segIdx >= 0; segIdx--) {
          mergeOk = tryMergeCurveRange(contour, segIdx, wrapIndex(endIdx, segCount), mergeCandidate, options.simplifyErrorTolerance, curveTurnSign, signedAreaPrefix);
          if (mergeOk) {
            break
          }
          if (dpSegCount[endIdx] > dpSegCount[segIdx] + 1 || dpSegCount[endIdx] == dpSegCount[segIdx] + 1 && dpErrorSq[endIdx] > dpErrorSq[segIdx] + mergeCandidate.fitErrorSq) {
            dpPrevSeg[endIdx] = segIdx;
            dpErrorSq[endIdx] = dpErrorSq[segIdx] + mergeCandidate.fitErrorSq;
            dpSegCount[endIdx] = dpSegCount[segIdx] + 1;
            dpMergeAtEnd[endIdx] = mergeCandidate;
            mergeCandidate = new CurveMergeCandidate
          }
        }
      }
      outSegCount = dpSegCount[segCount];
      simplifiedSpec = new BezierPathSpec(outSegCount);
      handleOutT1 = new Array(outSegCount);
      handleOutT0 = new Array(outSegCount);
      endIdx = segCount;
      for (var outIdx = outSegCount - 1; outIdx >= 0; outIdx--) {
        var sourceSeg = wrapIndex(endIdx, segCount),
          outCoordOff = outIdx * 3 + 0 << 1,
          srcCoordOff = sourceSeg * 3 + 0 << 1;
        if (dpPrevSeg[endIdx] == endIdx - 1) {
          simplifiedSpec.segmentTypes[outIdx] = pathSpec.segmentTypes[sourceSeg];
          simplifiedSpec.segmentCoords[outCoordOff] = pathSpec.segmentCoords[srcCoordOff];
          simplifiedSpec.segmentCoords[outCoordOff + 1] = pathSpec.segmentCoords[srcCoordOff + 1];
          simplifiedSpec.segmentCoords[outCoordOff + 2] = pathSpec.segmentCoords[srcCoordOff + 2];
          simplifiedSpec.segmentCoords[outCoordOff + 3] = pathSpec.segmentCoords[srcCoordOff + 3];
          simplifiedSpec.segmentCoords[outCoordOff + 4] = pathSpec.segmentCoords[srcCoordOff + 4];
          simplifiedSpec.segmentCoords[outCoordOff + 5] = pathSpec.segmentCoords[srcCoordOff + 5];
          simplifiedSpec.handleCoords[outIdx << 1] = pathSpec.handleCoords[sourceSeg << 1];
          simplifiedSpec.handleCoords[(outIdx << 1) + 1] = pathSpec.handleCoords[(sourceSeg << 1) + 1];
          simplifiedSpec.alpha[outIdx] = pathSpec.alpha[sourceSeg];
          simplifiedSpec.cornerSmoothness[outIdx] = pathSpec.cornerSmoothness[sourceSeg];
          simplifiedSpec.handleBlendT[outIdx] = pathSpec.handleBlendT[sourceSeg];
          handleOutT1[outIdx] = handleOutT0[outIdx] = 1
        } else {
          simplifiedSpec.segmentTypes[outIdx] = "CURVE";
          simplifiedSpec.segmentCoords[outCoordOff] = dpMergeAtEnd[endIdx].anchorAx;
          simplifiedSpec.segmentCoords[outCoordOff + 1] = dpMergeAtEnd[endIdx].anchorAy;
          simplifiedSpec.segmentCoords[outCoordOff + 2] = dpMergeAtEnd[endIdx].anchorBx;
          simplifiedSpec.segmentCoords[outCoordOff + 3] = dpMergeAtEnd[endIdx].anchorBy;
          simplifiedSpec.segmentCoords[outCoordOff + 4] = pathSpec.segmentCoords[srcCoordOff + 4];
          simplifiedSpec.segmentCoords[outCoordOff + 5] = pathSpec.segmentCoords[srcCoordOff + 5];
          simplifiedSpec.handleCoords[outIdx << 1] = lerpScalar(dpMergeAtEnd[endIdx].splitT1, pathSpec.segmentCoords[srcCoordOff + 4], handleCoords[sourceSeg << 1]);
          simplifiedSpec.handleCoords[(outIdx << 1) + 1] = lerpScalar(dpMergeAtEnd[endIdx].splitT1, pathSpec.segmentCoords[srcCoordOff + 5], handleCoords[(sourceSeg << 1) + 1]);
          simplifiedSpec.alpha[outIdx] = dpMergeAtEnd[endIdx].alpha;
          simplifiedSpec.cornerSmoothness[outIdx] = dpMergeAtEnd[endIdx].alpha;
          handleOutT1[outIdx] = dpMergeAtEnd[endIdx].splitT1;
          handleOutT0[outIdx] = dpMergeAtEnd[endIdx].splitT0
        }
        endIdx = dpPrevSeg[endIdx]
      }
      for (outIdx = 0; outIdx < outSegCount; outIdx++) {
        nextIdx = wrapIndex(outIdx + 1, outSegCount);
        simplifiedSpec.handleBlendT[outIdx] = handleOutT1[outIdx] / (handleOutT1[outIdx] + handleOutT0[nextIdx])
      }
      simplifiedSpec.segmentsFinalized = 1;
      contour.pathSpec = simplifiedSpec
    }
    for (var contourIdx = 0; contourIdx < contours.length; contourIdx++) {
      var contour = contours[contourIdx];
      buildPathMoments(contour);
      smoothPolylineCorners(contour);
      computeCornerIndices(contour);
      fitBezierPathSpec(contour);
      writeBezierSegments(contour);
      if (options.simplifyPath) simplifyPathSpec(contour)
    }
  }
  return {
    traceComponents: traceContourComponents,
    refineContours: refineContours
  }
}

const contourTracerInternals = createContourTracerInternals();
export function traceContours(maskBuffer, width, height, minArea) {
  var traceOptions = {
    borderPolicy: "minority",
    minArea: minArea,
    simplifyPath: true,
    lineCornerThreshold: 1,
    simplifyErrorTolerance: .2
  },
  contours = contourTracerInternals.traceComponents(maskBuffer, width, height, traceOptions);
  contourTracerInternals.refineContours(contours, traceOptions);
  return contours
}
export function getPathRecords(contours) {
  var records = [];
  for (var contourIdx = 0; contourIdx < contours.length; contourIdx++) {
  var contour = contours[contourIdx],
    pathSpec = contour.pathSpec,
    commands = ["M"],
    coords = [pathSpec.segmentCoords[(pathSpec.segmentCount - 1) * 6 + 4], pathSpec.segmentCoords[(pathSpec.segmentCount - 1) * 6 + 5]];
  for (var segIdx = 0; segIdx < pathSpec.segmentCount; segIdx++) {
    var coordOff = segIdx * 6;
    if (pathSpec.segmentTypes[segIdx] == 1) {
      commands.push("C");
      for (var i = 0; i < 6; i++) coords.push(pathSpec.segmentCoords[coordOff + i])
    } else if (pathSpec.segmentTypes[segIdx] == 0) {
      commands.push("L");
      for (var i = 2; i < 4; i++) coords.push(pathSpec.segmentCoords[coordOff + i])
    }
  }
  commands.push("Z");
  records.push({
    parent: contour.parent,
    color: contour.color,
    path: {
      coords: coords,
      commands: commands,
      H: coords,
      K: commands
    }
  })
}
  return records
}
export function pointInPolygon(polylineCoords, testX, testY) {
  var vertexCount = polylineCoords.length >> 1,
  prevX, edgeY0 = polylineCoords[2 * vertexCount - 3] - testY,
  prevRelX = polylineCoords[2 * vertexCount - 2] - testX,
  edgeY1 = polylineCoords[2 * vertexCount - 1] - testY,
  yIncreasing = edgeY1 > edgeY0,
  crossCount = 0;
  for (var vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
  prevX = prevRelX;
  edgeY0 = edgeY1;
  prevRelX = polylineCoords[2 * vertexIdx] - testX;
  edgeY1 = polylineCoords[2 * vertexIdx + 1] - testY;
  if (edgeY0 == edgeY1) continue;
  yIncreasing = edgeY1 > edgeY0
}
  for (var vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
  prevX = prevRelX;
  edgeY0 = edgeY1;
  prevRelX = polylineCoords[2 * vertexIdx] - testX;
  edgeY1 = polylineCoords[2 * vertexIdx + 1] - testY;
  if (edgeY0 < 0 && edgeY1 < 0) continue;
  if (edgeY0 > 0 && edgeY1 > 0) continue;
  if (prevX < 0 && prevRelX < 0) continue;
  if (edgeY0 == edgeY1 && Math.min(prevX, prevRelX) <= 0) return true;
  if (edgeY0 == edgeY1) continue;
  var xCross = prevX + (prevRelX - prevX) * -edgeY0 / (edgeY1 - edgeY0);
  if (xCross == 0) return true;
  if (xCross > 0) crossCount++;
  if (edgeY0 == 0 && yIncreasing && edgeY1 > edgeY0) crossCount--;
  if (edgeY0 == 0 && !yIncreasing && edgeY1 < edgeY0) crossCount--;
  yIncreasing = edgeY1 > edgeY0
}
  return (crossCount & 1) == 1
}
export function floodFillRegion(startIdx, maskBuffer, width, fillValue) {
  var targetLabel = maskBuffer[startIdx],
  queue = [startIdx],
  queueHead = 0;
  while (queueHead < queue.length) {
  var maskIdx = queue[queueHead];
  queueHead++;
  maskBuffer[maskIdx] = fillValue;
  if (maskBuffer[maskIdx - width] == targetLabel) {
    queue.push(maskIdx - width);
    maskBuffer[maskIdx - width] = 254
  }
  if (maskBuffer[maskIdx - 1] == targetLabel) {
    queue.push(maskIdx - 1);
    maskBuffer[maskIdx - 1] = 254
  }
  if (maskBuffer[maskIdx + 1] == targetLabel) {
    queue.push(maskIdx + 1);
    maskBuffer[maskIdx + 1] = 254
  }
  if (maskBuffer[maskIdx + width] == targetLabel) {
    queue.push(maskIdx + width);
    maskBuffer[maskIdx + width] = 254
  }
}
}
