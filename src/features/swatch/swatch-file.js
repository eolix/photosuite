// Photoshop swatch library codec (.aco / .ase). Colour-record bytes are handled
// by SwatchColorCodec; this module owns ACO dual-version blocks, ASE blocks,
// the optional phry hierarchy trailer, and the panel tree helpers built on top.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { basenameFromPath, stripFileExtension } from "../../core/file-names.js";
import { generateUuid } from "../../core/uid.js";

/**
 * Tree nodes are arrays. A folder is `[name, null, children, true, zuid]`; a
 * colour is `[name, color, null]`. The zuid identifies the folder for as long
 * as it exists, so it is minted when the folder is created and preserved when
 * one is read back from a file.
 */
const FOLDER_ZUID_INDEX = 4;
import { RenderBuffer } from "../../core/render-buffer.js";
import { PSDResourceParser } from "../../document/formats/psd/psd-resource-parser.js";
import { SwatchColorCodec } from "../../document/formats/psd/swatch-color-codec.js";
import { rgbToHex } from "../../engine/compositing/color-math.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";

const ASE_SIGNATURE = "ASEF";
/** Adobe Swatch Exchange group-start block type. */
const ASE_BLOCK_GROUP_START = 0xc001;
/** Adobe Swatch Exchange colour entry block type. */
const ASE_BLOCK_COLOR = 1;

function SwatchFile() {}

/**
 * Parse an `.aco` / `.ase` buffer into a folder tree for the swatches panel.
 * @param {ArrayBuffer} arrayBuffer Raw file bytes.
 * @param {string} [path] Optional path used for the root folder label.
 * @returns {object[]} Tree roots: `[name, color|null, children|null, isFolder?]`.
 */
SwatchFile.parse = function (arrayBuffer, path) {
  const bytes = new Uint8Array(arrayBuffer);
  const leaves = [];
  let cursor = 0;
  if (BinaryUtils.readString(bytes, 0, 4) === ASE_SIGNATURE) {
    cursor = SwatchFile.parseAse(bytes, leaves);
  } else {
    cursor = readAcoColorBlocks(bytes, cursor, leaves);
  }
  const hierarchyRoots = SwatchFile.applyHierarchy(bytes, cursor, leaves, path);
  if (hierarchyRoots) return hierarchyRoots;
  return SwatchFile.wrapFlatAsTree(leaves, path);
};

/**
 * Parse only the ACO colour blocks (no hierarchy / tree wrap).
 * @param {ArrayBuffer} arrayBuffer Raw `.aco` bytes.
 * @returns {Array} Flat `[name, color]` leaves.
 */
SwatchFile.parseFlat = function (arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const leaves = [];
  readAcoColorBlocks(bytes, 0, leaves);
  return leaves;
};

/**
 * Parse an ASEF body into flat `[label, color]` leaves.
 * @param {Uint8Array} bytes File bytes (signature already identified).
 * @param {Array} leaves Destination leaf list.
 * @returns {number} Byte offset after the last ASE block.
 */
SwatchFile.parseAse = function (bytes, leaves) {
  let cursor = 8;
  const blockCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  let groupName = null;
  let colorName = null;
  for (let blockIdx = 0; blockIdx < blockCount; blockIdx++) {
    const blockType = BinaryUtils.readUint16(bytes, cursor);
    cursor += 2;
    const blockSize = BinaryUtils.readUint32BE(bytes, cursor);
    cursor += 4;
    const blockEnd = cursor + blockSize;
    if (blockType === ASE_BLOCK_GROUP_START || blockType === ASE_BLOCK_COLOR) {
      const nameLen = BinaryUtils.readUint16(bytes, cursor);
      cursor += 2;
      const name = BinaryUtils.readUnicodeName(bytes, cursor, nameLen - 1);
      cursor += nameLen * 2;
      if (blockType === ASE_BLOCK_COLOR) colorName = name;
      else groupName = name;
    }
    if (blockType === ASE_BLOCK_COLOR) {
      leaves.push(readAseColorLeaf(bytes, cursor, groupName, colorName));
    }
    cursor = blockEnd;
  }
  return cursor;
};

/**
 * Attach an ACO colour list to a `phry` hierarchy trailer when present.
 * @returns {object[]|null} Tree roots, or null when no hierarchy is present.
 */
SwatchFile.applyHierarchy = function (bytes, offset, leaves, path) {
  if (offset + 3 >= bytes.length) return null;
  const tags = {};
  PSDResourceParser.parseAdditionalLayerInfo(bytes, offset, bytes.length, tags, false);
  const hierarchyList = tags.phry && tags.phry.hierarchy && tags.phry.hierarchy.v;
  if (!hierarchyList || hierarchyList.length === 0) return null;
  const folderStack = [[]];
  let leafIndex = 0;
  for (let entryIdx = 0; entryIdx < hierarchyList.length; entryIdx++) {
    const parentChildren = folderStack[folderStack.length - 1];
    const entry = hierarchyList[entryIdx].v;
    const classId = entry.classID;
    if (classId === "Grup") {
      const folderChildren = [];
      folderStack.push(folderChildren);
      // Carry the folder's stored identity through, so a file that is opened
      // and saved again keeps the same one rather than being reissued.
      const storedZuid = entry.zuid && entry.zuid.v;
      parentChildren.push([entry.Nm.v, null, folderChildren, true, storedZuid || generateUuid()]);
    } else if (classId === "preset") {
      if (leafIndex < leaves.length) {
        parentChildren.push(SwatchFile.leafToTreeNode(leaves[leafIndex++]));
      }
    } else if (classId === "groupEnd") {
      folderStack.pop();
    }
  }
  const topLevel = folderStack[0];

  // A file whose hierarchy is already one folder is returned as it stands.
  // Wrapping it in another folder named after the file would add a level of
  // nesting every time the palette is opened and saved again, so one saved and
  // reopened twice would sit three folders deep.
  if (topLevel.length === 1 && topLevel[0][1] == null) return topLevel;

  // Anything else — several folders, or colours sitting at the top level —
  // needs a root to hang from, and the file name is the only name available.
  let rootName = "Swatches";
  if (path) rootName = stripFileExtension(basenameFromPath(path));
  return [[rootName, null, topLevel, true, generateUuid()]];
};

/** Convert a flat leaf into a tree colour node. */
SwatchFile.leafToTreeNode = function (leaf) {
  if (Array.isArray(leaf) && leaf.length >= 3) return leaf;
  if (Array.isArray(leaf) && leaf.length >= 2) return [leaf[0], leaf[1], null];
  const label = leaf.name ? leaf.name.split("=").pop() : "Color";
  return [label, leaf, null];
};

/**
 * Promote a flat in-memory swatch store to a single-folder tree in place.
 * @param {Array} store Preset store array (mutated).
 */
SwatchFile.migrateStoreToTree = function (store) {
  if (!store || !store.length) return;
  if (store.length && store[0] && !Array.isArray(store[0])) {
    appendWrappedFlat(store, store.splice(0), null);
  } else if (
    store.length &&
    Array.isArray(store[0]) &&
    store[0].length === 2 &&
    store[0][1] &&
    !Array.isArray(store[0][1])
  ) {
    appendWrappedFlat(store, store.splice(0), null);
  }
};

/**
 * Wrap flat leaves as a single root folder tree.
 * @param {Array} flat Flat leaves or an already-nested tree.
 * @param {string} [path] Optional path for the root label.
 * @returns {object[]} Tree roots.
 */
SwatchFile.wrapFlatAsTree = function (flat, path) {
  if (!flat || flat.length === 0) return [];
  if (Array.isArray(flat[0]) && flat[0].length >= 3 && flat[0][2] != null && Array.isArray(flat[0][2])) {
    return flat;
  }
  const children = [];
  for (let leafIdx = 0; leafIdx < flat.length; leafIdx++) {
    children.push(flatLeafToChildNode(flat[leafIdx], leafIdx));
  }
  let rootName = "Swatches";
  if (path) rootName = stripFileExtension(basenameFromPath(path));
  return [[rootName, null, children, true, generateUuid()]];
};

/**
 * Collect `[name, color]` leaves from a folder tree (depth-first).
 * @param {object[]} nodes Tree nodes.
 * @param {Array} [out] Optional destination list.
 * @returns {Array} Flat leaves.
 */
SwatchFile.collectLeaves = function (nodes, out) {
  if (!out) out = [];
  for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
    const node = nodes[nodeIdx];
    if (node[1] == null) SwatchFile.collectLeaves(node[2], out);
    else out.push([node[0], node[1]]);
  }
  return out;
};

/**
 * Walk a tree into ACO colour leaves plus `phry` hierarchy descriptor entries.
 */
SwatchFile.buildHierarchyEntries = function (nodes, colorLeaves, hierarchyEntries) {
  for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
    const node = nodes[nodeIdx];
    if (node[1] == null) {
      // A folder built before this field existed gets one now, stored back on
      // the node so every later save writes the same value.
      if (!node[FOLDER_ZUID_INDEX]) node[FOLDER_ZUID_INDEX] = generateUuid();
      hierarchyEntries.push(createFolderStartEntry(node[0], node[FOLDER_ZUID_INDEX]));
      SwatchFile.buildHierarchyEntries(node[2], colorLeaves, hierarchyEntries);
      hierarchyEntries.push(createGroupEndEntry());
    } else {
      hierarchyEntries.push(createPresetEntry());
      colorLeaves.push([node[0], node[1]]);
    }
  }
};

/**
 * Write ACO versions 1 and 2 colour blocks for named leaves.
 * @param {Array} leaves `[name, color]` pairs.
 * @returns {ArrayBuffer} Dual-version ACO payload (no hierarchy).
 */
SwatchFile.writeColorBlocks = function (leaves) {
  const buffer = new RenderBuffer();
  let cursor = 0;
  for (let version = 1; version < 3; version++) {
    BinaryUtils.writeUint16(buffer, cursor, version);
    cursor += 2;
    BinaryUtils.writeUint16(buffer, cursor, leaves.length);
    cursor += 2;
    for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
      const name = leaves[leafIdx][0];
      const color = leaves[leafIdx][1];
      buffer.ensureCapacity(cursor, 10);
      SwatchColorCodec.writeSwatchColorAt(buffer.data, cursor, color);
      cursor += 10;
      if (version === 2) {
        const label = name + "\0";
        BinaryUtils.writeUnicodeString(buffer, cursor, label);
        cursor += 4 + label.length * 2;
      }
    }
  }
  return buffer.data.slice(0, cursor).buffer;
};

/**
 * Serialise a folder tree to ACO + `phry` hierarchy.
 * @param {object[]} tree Tree roots.
 * @returns {ArrayBuffer} Encoded `.aco` bytes.
 */
SwatchFile.serializeTree = function (tree) {
  const colorLeaves = [];
  const hierarchyEntries = [];
  SwatchFile.buildHierarchyEntries(tree, colorLeaves, hierarchyEntries);
  const acoBytes = SwatchFile.writeColorBlocks(colorLeaves);
  const buffer = new RenderBuffer();
  buffer.ensureCapacity(0, acoBytes.byteLength + 65536);
  buffer.data.set(new Uint8Array(acoBytes), 0);
  const end = PSDResourceParser.writeAdditionalLayerInfo(
    buffer,
    acoBytes.byteLength,
    {
      phry: {
        classID: "null",
        hierarchy: {
          t: "VlLs",
          v: hierarchyEntries,
        },
      },
    },
    false,
  );
  return buffer.data.slice(0, end).buffer;
};

/** Alias of {@link SwatchFile.serializeTree} for preset-resource export. */
SwatchFile.serialize = function (tree) {
  return SwatchFile.serializeTree(tree);
};

/**
 * Map an internal swatch colour bag to RGBA channel numbers for UI thumbs.
 * @param {object|null} color Colour with `h/l/O` or `l/i/c` channels.
 * @returns {{r:number,g:number,b:number,a:number}}
 */
SwatchFile.colorChannels = function (color) {
  if (color == null) return { r: 0, g: 0, b: 0, a: 255 };
  if (color.h != null) {
    return {
      r: color.h,
      g: color.l,
      b: color.O,
      a: color.AW == null ? 255 : color.AW,
    };
  }
  return {
    r: color.l,
    g: color.i,
    b: color.c,
    a: color.AW == null ? 255 : color.AW,
  };
};

/**
 * Render a solid colour swatch thumbnail as a data URL.
 * @param {object} node Tree colour node (`node[1]` is the colour).
 * @param {number} width Canvas width.
 * @param {number} height Canvas height.
 * @returns {string} `toDataURL` result, or `""` when unavailable.
 */
SwatchFile.renderSwatchThumb = function (node, width, height) {
  const color = node[1];
  if (color == null) return "";
  const channels = SwatchFile.colorChannels(color);
  const hex = rgbToHex((channels.r << 16) | (channels.g << 8) | channels.b);
  let ctx = SwatchFile._thumbCtx;
  if (ctx == null) {
    const canvas = typeof document != "undefined" ? document.createElement("canvas") : null;
    if (canvas == null) return "";
    ctx = SwatchFile._thumbCtx = canvas.getContext("2d");
  }
  const canvas = ctx.canvas;
  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = "#" + hex;
  ctx.fillRect(0, 0, width, height);
  return canvas.toDataURL();
};

/** Alias of {@link SwatchFile.serializeTree}. */
SwatchFile.serializeSwatchLeaves = function (nodes) {
  return SwatchFile.serializeTree(nodes);
};

/**
 * Read one ACO version colour block into `leaves`.
 * @returns {number} Byte offset after the block.
 */
SwatchFile.readColorBlock = function (bytes, offset, leaves) {
  const version = BinaryUtils.readUint16(bytes, offset);
  offset += 2;
  const count = BinaryUtils.readUint16(bytes, offset);
  offset += 2;
  for (let colorIdx = 0; colorIdx < count; colorIdx++) {
    const color = SwatchColorCodec.readSwatchColorAt(bytes, offset);
    offset += 10;
    let name = "clr" + colorIdx;
    if (version === 2) {
      name = BinaryUtils.readUnicodeName(bytes, offset);
      offset += 4 + name.length * 2 + 2;
    }
    leaves.push([name, color]);
  }
  return offset;
};

/**
 * Serialise a flat list of colour objects (version-2 ACO only).
 * @param {object[]} swatches Colours with optional `name`.
 * @returns {ArrayBuffer}
 */
SwatchFile.serializeFlatSwatchList = function (swatches) {
  const buffer = new RenderBuffer();
  let cursor = 0;
  BinaryUtils.writeUint16(buffer, cursor, 2);
  cursor += 2;
  BinaryUtils.writeUint16(buffer, cursor, swatches.length);
  cursor += 2;
  for (let swatchIdx = 0; swatchIdx < swatches.length; swatchIdx++) {
    const swatch = swatches[swatchIdx];
    buffer.ensureCapacity(cursor, 10);
    SwatchColorCodec.writeSwatchColorAt(buffer.data, cursor, swatch);
    cursor += 10;
    const label = (swatch.name ? swatch.name : "") + "\0";
    BinaryUtils.writeUnicodeString(buffer, cursor, label);
    cursor += 4 + label.length * 2;
  }
  return buffer.data.slice(0, cursor).buffer;
};

/** Assign a display name on a colour object swatch. */
SwatchFile.setName = function (swatch, name) {
  swatch.name = name;
};

function readAcoColorBlocks(bytes, cursor, leaves) {
  cursor = SwatchFile.readColorBlock(bytes, cursor, leaves);
  if (cursor + 3 < bytes.length) {
    leaves.length = 0;
    cursor = SwatchFile.readColorBlock(bytes, cursor, leaves);
  }
  return cursor;
}

function readAseColorLeaf(bytes, cursor, groupName, colorName) {
  const space = BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  const channel0 = BinaryUtils.readFloat32(bytes, cursor);
  cursor += 4;
  const channel1 = BinaryUtils.readFloat32(bytes, cursor);
  cursor += 4;
  const channel2 = BinaryUtils.readFloat32(bytes, cursor);
  cursor += 4;
  const label = (groupName ? groupName + " : " : "") + colorName;
  if (space === "CMYK") {
    const channelK = BinaryUtils.readFloat32(bytes, cursor);
    return [label, aseCmykToRgb(channel0, channel1, channel2, channelK)];
  }
  return [
    label,
    {
      h: channel0 * 255,
      l: channel1 * 255,
      O: channel2 * 255,
    },
  ];
}

function aseCmykToRgb(cyan, magenta, yellow, black) {
  return psdColorToRgb({
    classID: "CMYC",
    Cyn: { t: "doub", v: 100 - cyan * 100 },
    Mgnt: { t: "doub", v: 100 - magenta * 100 },
    Ylw: { t: "doub", v: 100 - yellow * 100 },
    Blck: { t: "doub", v: 100 - black * 100 },
  });
}

function flatLeafToChildNode(item, leafIdx) {
  if (Array.isArray(item) && item.length >= 3) return item;
  if (Array.isArray(item) && item.length >= 2) return [item[0], item[1], null];
  const label = item.name ? item.name.split("=").pop() : "Color " + (leafIdx + 1);
  return [label, item, null];
}

function appendWrappedFlat(store, flat, rootPathLabel) {
  const wrapped = SwatchFile.wrapFlatAsTree(flat, rootPathLabel);
  for (let rootIdx = 0; rootIdx < wrapped.length; rootIdx++) {
    store.push(wrapped[rootIdx]);
  }
}

function createFolderStartEntry(folderName, folderZuid) {
  return {
    t: "Objc",
    v: {
      classID: "Grup",
      Nm: { t: "TEXT", v: folderName },
      zuid: { t: "TEXT", v: folderZuid },
    },
  };
}

function createGroupEndEntry() {
  return {
    t: "Objc",
    v: { classID: "groupEnd" },
  };
}

function createPresetEntry() {
  return {
    t: "Objc",
    v: { classID: "preset" },
  };
}

export { SwatchFile };
