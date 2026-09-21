/**
 * PSD slice descriptor helpers: build and update the `slice` action-descriptor
 * tree used for web/export slice bounds. No tool dependency — safe
 * for parsers and export paths.
 */

export function createDefaultSliceDescriptor() {
  return {
    t: "Objc",
    v: {
      classID: "slice",
      sliceID: {
        t: "long",
        v: 0,
      },
      groupID: {
        t: "long",
        v: 0,
      },
      origin: {
        t: "enum",
        v: {
          ESliceOrigin: "userGenerated",
        },
      },
      Type: {
        t: "enum",
        v: {
          ESliceType: "Img",
        },
      },
      bounds: {
        t: "Objc",
        v: {
          classID: "Rct1",
          Top: {
            t: "long",
            v: 0,
          },
          Left: {
            t: "long",
            v: 0,
          },
          Btom: {
            t: "long",
            v: 0,
          },
          Rght: {
            t: "long",
            v: 0,
          },
        },
      },
      url: {
        t: "TEXT",
        v: "",
      },
      null: {
        t: "TEXT",
        v: "",
      },
      Msge: {
        t: "TEXT",
        v: "",
      },
      altTag: {
        t: "TEXT",
        v: "",
      },
      cellTextIsHTML: {
        t: "bool",
        v: true,
      },
      cellText: {
        t: "TEXT",
        v: "",
      },
      horzAlign: {
        t: "enum",
        v: {
          ESliceHorzAlign: "default",
        },
      },
      vertAlign: {
        t: "enum",
        v: {
          ESliceVertAlign: "default",
        },
      },
      bgColorType: {
        t: "enum",
        v: {
          ESliceBGColorType: "None",
        },
      },
      topOutset: {
        t: "long",
        v: 0,
      },
      leftOutset: {
        t: "long",
        v: 0,
      },
      bottomOutset: {
        t: "long",
        v: 0,
      },
      rightOutset: {
        t: "long",
        v: 0,
      },
    },
  };
}

export function writeSliceBoundsToDescriptor(sliceList, sliceIndex, bounds) {
  var boundsNode = sliceList[sliceIndex].v.bounds.v;
  boundsNode.Left.v = bounds[0];
  boundsNode.Top.v = bounds[1];
  boundsNode.Rght.v = bounds[2];
  boundsNode.Btom.v = bounds[3];
}

/**
 * @param {object[]} slices
 * @param {number} sliceIndex
 * @returns {number[]}
 */
export function readSliceBoundsArray(slices, sliceIndex) {
  const boundsStruct = slices[sliceIndex].v.bounds.v;
  return [
    boundsStruct.Left.v,
    boundsStruct.Top.v,
    boundsStruct.Rght.v,
    boundsStruct.Btom.v,
    sliceIndex,
  ];
}
