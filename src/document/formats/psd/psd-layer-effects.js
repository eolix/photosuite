/**
 * PSD layer-style effect descriptor normalization.
 *
 * Effects arrive as a flat per-effect descriptor or a `VlLs` multi-instance list;
 * these helpers convert between the two shapes during read/write, reading the
 * effect order and key tables from the schema next door.
 */

import { LayerEffectDefs } from "./effect-defs.js";

function normalizeLayerEffectsOnRead(descriptor) {
  const effectOrder = LayerEffectDefs.order;
  const effectListKeys = LayerEffectDefs.effectKeys;
  for (let effectIndex = 0; effectIndex < effectOrder.length; effectIndex++) {
    const effectSingleKey = effectOrder[effectIndex];
    const effectListKey = effectListKeys[effectIndex];
    if (descriptor[effectListKey] == null) {
      descriptor[effectListKey] = {
        t: "VlLs",
        v: [],
      };
    }
    if (descriptor[effectSingleKey] != null) {
      descriptor[effectListKey].v.push(descriptor[effectSingleKey]);
      delete descriptor[effectSingleKey];
    }
    const visibleEffects = [];
    for (let itemIndex = 0; itemIndex < descriptor[effectListKey].v.length; itemIndex++) {
      const listEntry = descriptor[effectListKey].v[itemIndex];
      if (listEntry.v.present == null || listEntry.v.present.v === true) {
        visibleEffects.push(listEntry);
      }
    }
    descriptor[effectListKey].v = visibleEffects;
  }
}

function normalizeLayerEffectsOnWrite(descriptor) {
  const effectOrder = LayerEffectDefs.order;
  const effectListKeys = LayerEffectDefs.effectKeys;
  for (let effectIndex = 0; effectIndex < effectOrder.length; effectIndex++) {
    const effectSingleKey = effectOrder[effectIndex];
    const effectListKey = effectListKeys[effectIndex];
    const itemCount = descriptor[effectListKey].v.length;
    if (itemCount === 0) {
      delete descriptor[effectListKey];
      continue;
    }
    if (itemCount === 1) {
      descriptor[effectSingleKey] = descriptor[effectListKey].v[0];
      delete descriptor[effectListKey];
      continue;
    }
  }
}

function applyGradientFillDefaults(descriptor, effectType) {
  if (effectType === "GdFl") {
    if (descriptor.Angl == null) {
      descriptor.Angl = {
        v: {
          type: "#Ang",
          val: 0,
        },
        t: "UntF",
      };
    }
    if (descriptor.Algn == null) {
      descriptor.Algn = {
        v: true,
        t: "bool",
      };
    }
    if (descriptor.Scl == null) {
      descriptor.Scl = {
        v: {
          type: "#Prc",
          val: 100,
        },
        t: "UntF",
      };
    }
    if (descriptor.Ofst == null) {
      descriptor.Ofst = {
        v: {
          classID: "Pnt",
          Hrzn: {
            v: {
              type: "#Prc",
              val: 0,
            },
            t: "UntF",
          },
          Vrtc: {
            v: {
              type: "#Prc",
              val: 0,
            },
            t: "UntF",
          },
        },
        t: "Objc",
      };
    }
    if (descriptor.Rvrs == null) {
      descriptor.Rvrs = {
        v: false,
        t: "bool",
      };
    }
    if (descriptor.Dthr == null) {
      descriptor.Dthr = {
        v: false,
        t: "bool",
      };
    }
  }
  if (effectType === "PtFl") {
    if (descriptor.Algn == null) {
      descriptor.Algn = {
        v: true,
        t: "bool",
      };
    }
    if (descriptor.Scl == null) {
      descriptor.Scl = {
        v: {
          type: "#Prc",
          val: 100,
        },
        t: "UntF",
      };
    }
    if (descriptor.phase == null) {
      descriptor.phase = {
        v: {
          classID: "Pnt",
          Hrzn: {
            v: 0,
            t: "doub",
          },
          Vrtc: {
            v: 0,
            t: "doub",
          },
        },
        t: "Objc",
      };
    }
  }
}

export { normalizeLayerEffectsOnRead, normalizeLayerEffectsOnWrite, applyGradientFillDefaults };
