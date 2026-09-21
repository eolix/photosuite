/**
 * Correlated colour temperature and the Planckian (black-body) locus.
 *
 * Chromaticities are CIE 1931 `{ x, y }`; the locus table is the Robertson
 * isotemperature set used by the DNG specification, indexed by micro-reciprocal
 * degrees (mired = 1e6 / K) with the isotherm slope at each entry. Tint is a
 * signed offset perpendicular to the locus in CIE 1960 uv, matching the
 * Temperature / Tint pair that raw develop and the Camera Raw filter expose.
 */

const PLANCKIAN_LOCUS_TABLE = [{
    cctMicroReciprocal: 0,
    uCoord: .18006,
    vCoord: .26352,
    tangentSlope: -.24341
  }, {
    cctMicroReciprocal: 10,
    uCoord: .18066,
    vCoord: .26589,
    tangentSlope: -.25479
  }, {
    cctMicroReciprocal: 20,
    uCoord: .18133,
    vCoord: .26846,
    tangentSlope: -.26876
  }, {
    cctMicroReciprocal: 30,
    uCoord: .18208,
    vCoord: .27119,
    tangentSlope: -.28539
  }, {
    cctMicroReciprocal: 40,
    uCoord: .18293,
    vCoord: .27407,
    tangentSlope: -.3047
  }, {
    cctMicroReciprocal: 50,
    uCoord: .18388,
    vCoord: .27709,
    tangentSlope: -.32675
  }, {
    cctMicroReciprocal: 60,
    uCoord: .18494,
    vCoord: .28021,
    tangentSlope: -.35156
  }, {
    cctMicroReciprocal: 70,
    uCoord: .18611,
    vCoord: .28342,
    tangentSlope: -.37915
  }, {
    cctMicroReciprocal: 80,
    uCoord: .1874,
    vCoord: .28668,
    tangentSlope: -.40955
  }, {
    cctMicroReciprocal: 90,
    uCoord: .1888,
    vCoord: .28997,
    tangentSlope: -.44278
  }, {
    cctMicroReciprocal: 100,
    uCoord: .19032,
    vCoord: .29326,
    tangentSlope: -.47888
  }, {
    cctMicroReciprocal: 125,
    uCoord: .19462,
    vCoord: .30141,
    tangentSlope: -.58204
  }, {
    cctMicroReciprocal: 150,
    uCoord: .19962,
    vCoord: .30921,
    tangentSlope: -.70471
  }, {
    cctMicroReciprocal: 175,
    uCoord: .20525,
    vCoord: .31647,
    tangentSlope: -.84901
  }, {
    cctMicroReciprocal: 200,
    uCoord: .21142,
    vCoord: .32312,
    tangentSlope: -1.0182
  }, {
    cctMicroReciprocal: 225,
    uCoord: .21807,
    vCoord: .32909,
    tangentSlope: -1.2168
  }, {
    cctMicroReciprocal: 250,
    uCoord: .22511,
    vCoord: .33439,
    tangentSlope: -1.4512
  }, {
    cctMicroReciprocal: 275,
    uCoord: .23247,
    vCoord: .33904,
    tangentSlope: -1.7298
  }, {
    cctMicroReciprocal: 300,
    uCoord: .2401,
    vCoord: .34308,
    tangentSlope: -2.0637
  }, {
    cctMicroReciprocal: 325,
    uCoord: .24792,
    vCoord: .34655,
    tangentSlope: -2.4681
  }, {
    cctMicroReciprocal: 350,
    uCoord: .25591,
    vCoord: .34951,
    tangentSlope: -2.9641
  }, {
    cctMicroReciprocal: 375,
    uCoord: .264,
    vCoord: .352,
    tangentSlope: -3.5814
  }, {
    cctMicroReciprocal: 400,
    uCoord: .27218,
    vCoord: .35407,
    tangentSlope: -4.3633
  }, {
    cctMicroReciprocal: 425,
    uCoord: .28039,
    vCoord: .35577,
    tangentSlope: -5.3762
  }, {
    cctMicroReciprocal: 450,
    uCoord: .28863,
    vCoord: .35714,
    tangentSlope: -6.7262
  }, {
    cctMicroReciprocal: 475,
    uCoord: .29685,
    vCoord: .35823,
    tangentSlope: -8.5955
  }, {
    cctMicroReciprocal: 500,
    uCoord: .30505,
    vCoord: .35907,
    tangentSlope: -11.324
  }, {
    cctMicroReciprocal: 525,
    uCoord: .3132,
    vCoord: .35968,
    tangentSlope: -15.628
  }, {
    cctMicroReciprocal: 550,
    uCoord: .32129,
    vCoord: .36011,
    tangentSlope: -23.325
  }, {
    cctMicroReciprocal: 575,
    uCoord: .32931,
    vCoord: .36038,
    tangentSlope: -40.77
  }, {
    cctMicroReciprocal: 600,
    uCoord: .33724,
    vCoord: .36051,
    tangentSlope: -116.45
  }];

const D50_CHROMATICITY = {
  x: .34567,
  y: .3585
};

function xyToNormalizedXyz(chromaticity) {
  return {
    x: chromaticity.x / chromaticity.y,
    y: 1,
    zChannel: (1 - chromaticity.x - chromaticity.y) / chromaticity.y
  };
}

function planckianLocusFromChromaticity(chromaticity) {
  var locusTable = PLANCKIAN_LOCUS_TABLE,
    uCoord = 2 * chromaticity.x / (1.5 - chromaticity.x + 6 * chromaticity.y),
    vCoord = 3 * chromaticity.y / (1.5 - chromaticity.x + 6 * chromaticity.y),
    signedDist = 0,
    prevSignedDist = 0,
    tableIdx = 0;
  for (; tableIdx < 31; tableIdx++) {
    signedDist = vCoord - locusTable[tableIdx].vCoord - locusTable[tableIdx].tangentSlope * (uCoord - locusTable[tableIdx].uCoord);
    if (tableIdx > 0 && signedDist < 0) {
      break;
    }
    prevSignedDist = signedDist;
  }
  while (tableIdx >= locusTable.length) tableIdx--;
  signedDist /= Math.sqrt(1 + locusTable[tableIdx].tangentSlope * locusTable[tableIdx].tangentSlope);
  prevSignedDist /= Math.sqrt(1 + locusTable[tableIdx - 1].tangentSlope * locusTable[tableIdx - 1].tangentSlope);
  var segmentBlend = prevSignedDist / (prevSignedDist - signedDist),
    correlatedColorTemp = 1e6 / ((locusTable[tableIdx].cctMicroReciprocal - locusTable[tableIdx - 1].cctMicroReciprocal) * segmentBlend + locusTable[tableIdx - 1].cctMicroReciprocal),
    deltaU = uCoord - ((locusTable[tableIdx].uCoord - locusTable[tableIdx - 1].uCoord) * segmentBlend + locusTable[tableIdx - 1].uCoord),
    deltaV = vCoord - ((locusTable[tableIdx].vCoord - locusTable[tableIdx - 1].vCoord) * segmentBlend + locusTable[tableIdx - 1].vCoord),
    tangentLen = Math.sqrt(1 + locusTable[tableIdx].tangentSlope * locusTable[tableIdx].tangentSlope),
    tangentNormX = 1 / tangentLen,
    tangentNormY = locusTable[tableIdx].tangentSlope / tangentLen,
    prevTangentLen = Math.sqrt(1 + locusTable[tableIdx - 1].tangentSlope * locusTable[tableIdx - 1].tangentSlope),
    prevTangentNormX = 1 / prevTangentLen,
    prevTangentNormY = locusTable[tableIdx - 1].tangentSlope / prevTangentLen,
    perpNormX = (tangentNormX - prevTangentNormX) * segmentBlend + prevTangentNormX,
    perpNormY = (tangentNormY - prevTangentNormY) * segmentBlend + prevTangentNormY,
    perpLen = Math.sqrt(perpNormX * perpNormX + perpNormY * perpNormY);
  perpNormX /= perpLen;
  perpNormY /= perpLen;
  var tintBias = (deltaU * perpNormX + deltaV * perpNormY) * -3e3;
  return {
    correlatedColorTemp: correlatedColorTemp,
    tintBias: tintBias
  };
}

function chromaticityFromTemperatureAndTint(correlatedTemp, tint) {
  var locusTable = PLANCKIAN_LOCUS_TABLE,
    microReciprocal = 1e6 / correlatedTemp,
    tableIdx = 1;
  for (; tableIdx < 31; tableIdx++) {
    if (microReciprocal < locusTable[tableIdx].cctMicroReciprocal) {
      break;
    }
  }
  var segmentBlend = (locusTable[tableIdx].cctMicroReciprocal - microReciprocal) / (locusTable[tableIdx].cctMicroReciprocal - locusTable[tableIdx - 1].cctMicroReciprocal),
    uCoord = (locusTable[tableIdx - 1].uCoord - locusTable[tableIdx].uCoord) * segmentBlend + locusTable[tableIdx].uCoord,
    vCoord = (locusTable[tableIdx - 1].vCoord - locusTable[tableIdx].vCoord) * segmentBlend + locusTable[tableIdx].vCoord,
    tangentLen = Math.sqrt(1 + locusTable[tableIdx].tangentSlope * locusTable[tableIdx].tangentSlope),
    tangentNormX = 1 / tangentLen,
    tangentNormY = locusTable[tableIdx].tangentSlope / tangentLen,
    prevTangentLen = Math.sqrt(1 + locusTable[tableIdx - 1].tangentSlope * locusTable[tableIdx - 1].tangentSlope),
    prevTangentNormX = 1 / prevTangentLen,
    prevTangentNormY = locusTable[tableIdx - 1].tangentSlope / prevTangentLen,
    perpNormX = (prevTangentNormX - tangentNormX) * segmentBlend + tangentNormX,
    perpNormY = (prevTangentNormY - tangentNormY) * segmentBlend + tangentNormY,
    perpLen = Math.sqrt(perpNormX * perpNormX + perpNormY * perpNormY);
  perpNormX /= perpLen;
  perpNormY /= perpLen;
  uCoord += perpNormX * tint / -3e3;
  vCoord += perpNormY * tint / -3e3;
  return {
    x: 1.5 * uCoord / (uCoord - 4 * vCoord + 2),
    y: vCoord / (uCoord - 4 * vCoord + 2)
  };
}

export {
  PLANCKIAN_LOCUS_TABLE,
  D50_CHROMATICITY,
  xyToNormalizedXyz,
  planckianLocusFromChromaticity,
  chromaticityFromTemperatureAndTint
};
