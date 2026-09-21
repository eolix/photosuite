// Flattened cubic path samples used to place text-on-path glyphs.

/**
 * Sample a text-on-path curve into polyline coords, segment indices, and
 * cumulative arc lengths. Returns
 * `[flatCoords, segmentIndices, arcLengths, totalLength, startLength, endLength]`.
 * @param {{Points: number[], TextOnPathTRange: number[], Reversed: boolean}} curveDescriptor
 * @returns {[number[], number[], number[], number, number, number]}
 */
export function computeTextPathData(curveDescriptor) {
  let points = curveDescriptor.Points;
  const pointCount = points.length;
  const segmentCount = pointCount >>> 3;
  let tRange = curveDescriptor.TextOnPathTRange;
  if (curveDescriptor.Reversed) {
    const reversedPoints = points.slice(0);
    for (let pointIdx = 0; pointIdx < pointCount; pointIdx += 2) {
      reversedPoints[pointIdx] = points[pointCount - 2 - pointIdx];
      reversedPoints[pointIdx + 1] = points[pointCount - 1 - pointIdx];
    }
    points = reversedPoints;
    tRange = [segmentCount - tRange[1] % segmentCount, segmentCount - tRange[0] % segmentCount];
  }
  const flatCoords = [];
  const segmentIndices = [0];
  const arcLengths = [0];
  let prevX = 0;
  let prevY = 0;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx += 8) {
    const dx = points[pointIdx + 6] - points[pointIdx + 0];
    const dy = points[pointIdx + 7] - points[pointIdx + 1];
    const sampleCount = Math.round(4 * Math.sqrt(dx * dx + dy * dy));
    for (let sampleIdx = 0; sampleIdx < sampleCount; sampleIdx++) {
      const t = sampleIdx / sampleCount;
      const invT = 1 - t;
      const curveX =
        invT * invT * invT * points[pointIdx + 0] +
        3 * invT * invT * t * points[pointIdx + 2] +
        3 * invT * t * t * points[pointIdx + 4] +
        t * t * t * points[pointIdx + 6];
      const curveY =
        invT * invT * invT * points[pointIdx + 1] +
        3 * invT * invT * t * points[pointIdx + 3] +
        3 * invT * t * t * points[pointIdx + 5] +
        t * t * t * points[pointIdx + 7];
      flatCoords.push(curveX, curveY);
      if (pointIdx + sampleIdx != 0) {
        const segDx = curveX - prevX;
        const segDy = curveY - prevY;
        arcLengths.push(arcLengths[arcLengths.length - 1] + Math.sqrt(segDx * segDx + segDy * segDy));
        segmentIndices.push((pointIdx >>> 3) + t);
      }
      prevX = curveX;
      prevY = curveY;
    }
  }
  const arcCount = arcLengths.length;
  const totalLength = arcLengths[arcCount - 1];
  const startIdx = findPathIndex(tRange[0], segmentIndices);
  const endIdx = findPathIndex(tRange[1] % segmentCount, segmentIndices);
  let startLength = arcLengths[startIdx % arcCount];
  let endLength = arcLengths[endIdx % arcCount];
  if (startLength >= endLength) endLength += totalLength;
  return [flatCoords, segmentIndices, arcLengths, totalLength, startLength, endLength];
}

/**
 * First index in `segmentIndices` whose value is >= `tValue`.
 * @param {number} tValue
 * @param {number[]} segmentIndices
 * @returns {number}
 */
export function findPathIndex(tValue, segmentIndices) {
  let idx = 0;
  while (segmentIndices[idx] < tValue) idx++;
  return idx;
}

/**
 * Point and unit tangent on a polyline at arc-length `distance`.
 * @param {number[]} flatCoords
 * @param {number} distance
 * @returns {[number, number, number, number]} x, y, tangentX, tangentY
 */
export function getPathPosition(flatCoords, distance) {
  let traveled = 0;
  let coordIdx = 0;
  let segDx;
  let segDy;
  let segLen;
  while (traveled < distance) {
    segDx = flatCoords[coordIdx + 2] - flatCoords[coordIdx];
    segDy = flatCoords[coordIdx + 3] - flatCoords[coordIdx + 1];
    segLen = Math.sqrt(segDx * segDx + segDy * segDy);
    traveled += segLen;
    coordIdx += 2;
  }
  return [flatCoords[coordIdx], flatCoords[coordIdx + 1], segDx / segLen, segDy / segLen];
}
