/**
 * Golden values for swatch .aco tree / flat codecs and helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let SwatchFile;

before(async () => {
  ({ SwatchFile } = await import("../../../src/features/swatch/swatch-file.js"));
});

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const FLAT_LIST_HEX = "000200010000ffff0000000000000000000200410000";
const ACO_DUAL_VERSION_HEX =
  "000100020000ffff00000000000000000000ffff00000000000200020000ffff000000000000000000020041000000000000ffff000000000000000200420000";
/**
 * Each folder carries its own `zuid`, freshly generated, so those bytes differ
 * every save. The golden masks that one field and pins everything around it.
 * The record is `"zuid"` + `"TEXT"` + a 4-byte length, then 36 UTF-16BE chars.
 */
const FOLDER_ZUID_BYTES = /(7a75696454455854[0-9a-f]{8})((?:00[0-9a-f]{2}){36})/;

/** The UUID a masked run stands for, decoded back from UTF-16BE. */
function zuidFrom(hex) {
  const run = hex.match(FOLDER_ZUID_BYTES);
  return run == null
    ? null
    : run[2].match(/../g).filter((_, i) => i % 2)
        .map((byte) => String.fromCharCode(parseInt(byte, 16))).join("");
}

const maskFolderZuid = (hex) => hex.replace(FOLDER_ZUID_BYTES, "$1<zuid>");

/** Every folder zuid in a serialised tree, in order. */
function allZuids(hex) {
  return [...hex.matchAll(new RegExp(FOLDER_ZUID_BYTES, "g"))].map((run) =>
    run[2].match(/../g).filter((_, i) => i % 2)
      .map((byte) => String.fromCharCode(parseInt(byte, 16))).join(""),
  );
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A copy of the tree with each folder's zuid dropped, so a structural
 * comparison is not defeated by an identity that is random by design. Asserts
 * in passing that every folder actually has one.
 */
function withoutFolderIds(nodes) {
  return nodes.map((node) => {
    if (node[1] != null) return node;
    assert.match(node[4], UUID_V4, `folder ${node[0]} has no identity`);
    return [node[0], node[1], withoutFolderIds(node[2]), node[3]];
  });
}

const TREE_ACO_HEX =
  "000100020000ffff00000000000000000000ffff00000000000200020000ffff000000000000000000020041000000000000ffff0000000000000002004200003842494d706872790000010800000010000000010000000000006e756c6c0000000100000009686965726172636879566c4c73000000044f626a63000000010000000000004772757000000002000000004e6d2020544558540000000800500061006c00650074007400650000000000007a7569645445585400000025<zuid>00004f626a6300000001000000000006707265736574000000004f626a6300000001000000000006707265736574000000004f626a630000000100000000000867726f7570456e6400000000000000";

describe("features/swatch/swatch-file.js", () => {
  it("serializeFlatSwatchList matches byte golden", () => {
    const buffer = SwatchFile.serializeFlatSwatchList([{ name: "A", h: 255, l: 0, O: 0 }]);
    assert.equal(bufferToHex(buffer), FLAT_LIST_HEX);
  });

  it("parseFlat of flat-list golden yields named RGB leaf", () => {
    assert.deepEqual(SwatchFile.parseFlat(hexToBuffer(FLAT_LIST_HEX)), [
      ["A", { h: 255, l: 0, O: 0 }],
    ]);
  });

  it("writeColorBlocks dual-version ACO matches byte golden", () => {
    const buffer = SwatchFile.writeColorBlocks([
      ["A", { h: 255, l: 0, O: 0 }],
      ["B", { h: 0, l: 255, O: 0 }],
    ]);
    assert.equal(bufferToHex(buffer), ACO_DUAL_VERSION_HEX);
  });

  it("parseFlat of dual-version ACO keeps v2 named leaves", () => {
    assert.deepEqual(SwatchFile.parseFlat(hexToBuffer(ACO_DUAL_VERSION_HEX)), [
      ["A", { h: 255, l: 0, O: 0 }],
      ["B", { h: 0, l: 255, O: 0 }],
    ]);
  });

  it("wrapFlatAsTree / collectLeaves round-trip labels and colors", () => {
    const flat = [
      ["Red", { h: 10, l: 20, O: 30 }],
      ["Blue", { h: 0, l: 0, O: 255 }],
    ];
    const tree = SwatchFile.wrapFlatAsTree(flat, "/tmp/MyColors.aco");
    assert.deepEqual(withoutFolderIds(tree), [
      [
        "MyColors",
        null,
        [
          ["Red", { h: 10, l: 20, O: 30 }, null],
          ["Blue", { h: 0, l: 0, O: 255 }, null],
        ],
        true,
      ],
    ]);
    assert.deepEqual(SwatchFile.collectLeaves(tree), flat);
  });

  it("serializeTree matches byte golden and parse restores nested folder", () => {
    const leaves = [
      ["A", { h: 255, l: 0, O: 0 }],
      ["B", { h: 0, l: 255, O: 0 }],
    ];
    const tree = SwatchFile.wrapFlatAsTree(leaves, "Palette.aco");
    const buffer = SwatchFile.serializeTree(tree);
    assert.equal(maskFolderZuid(bufferToHex(buffer)), TREE_ACO_HEX);
    assert.match(zuidFrom(bufferToHex(buffer)), UUID_V4, "the folder carries a real UUID");
    // Reading it back gives the folder the file holds, not that folder wrapped
    // in another one named after the file.
    assert.deepEqual(withoutFolderIds(SwatchFile.parse(buffer, "Palette.aco")), [
      [
        "Palette",
        null,
        [
          ["A", { h: 255, l: 0, O: 0 }, null],
          ["B", { h: 0, l: 255, O: 0 }, null],
        ],
        true,
      ],
    ]);
  });

  it("opening and saving a palette does not bury it a folder deeper each time", () => {
    // The file's hierarchy already names its root. Wrapping it again on every
    // open drove a palette to Palette/Palette/Palette after two saves.
    const folderDepth = (nodes) => {
      let depth = 0;
      let node = nodes[0];
      while (node && node[1] == null) { depth += 1; node = node[2][0]; }
      return depth;
    };
    let tree = SwatchFile.wrapFlatAsTree([["A", { h: 1, l: 2, O: 3 }]], "Palette.aco");
    assert.equal(folderDepth(tree), 1);
    for (let round = 0; round < 3; round++) {
      tree = SwatchFile.parse(SwatchFile.serializeTree(tree), "Palette.aco");
      assert.equal(folderDepth(tree), 1, `depth grew on round trip ${round + 1}`);
      assert.equal(tree[0][0], "Palette", "and it keeps its name");
    }
  });

  it("names that root from the file alone, whatever the path separator", () => {
    // A Windows path split on "/" only would leave the whole path as the
    // folder name: "C:\\Users\\me\\Autumn.aco" rather than "Autumn".
    const two = [
      ["One", null, [["A", { h: 1, l: 2, O: 3 }]], true],
      ["Two", null, [["B", { h: 4, l: 5, O: 6 }]], true],
    ];
    const bytes = SwatchFile.serializeTree(two);
    for (const path of [
      "/Users/me/Palettes/Autumn.aco",
      "C:\\Users\\me\\Palettes\\Autumn.aco",
      "C:/Users/me/Palettes/Autumn.aco",
      "Autumn.aco",
    ]) {
      assert.equal(SwatchFile.parse(bytes, path)[0][0], "Autumn", `named from ${path}`);
    }
  });

  it("still gives a root to a file whose contents need one", () => {
    // Several folders side by side, or loose colours, have nothing to hang
    // from — those take the file name as their root.
    const two = [
      ["One", null, [["A", { h: 1, l: 2, O: 3 }]], true],
      ["Two", null, [["B", { h: 4, l: 5, O: 6 }]], true],
    ];
    const reopened = SwatchFile.parse(SwatchFile.serializeTree(two), "Mixed.aco");
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0][0], "Mixed");
    assert.deepEqual(reopened[0][2].map((node) => node[0]), ["One", "Two"]);
  });

  it("a folder keeps one identity across saves", () => {
    // The zuid identifies the folder for as long as it exists. Minting a new
    // one on every save would make each save look like a different folder, and
    // would rewrite the file even when nothing changed.
    const tree = SwatchFile.wrapFlatAsTree([["A", { h: 1, l: 2, O: 3 }]], "Palette.aco");
    const first = bufferToHex(SwatchFile.serializeTree(tree));
    const second = bufferToHex(SwatchFile.serializeTree(tree));
    assert.equal(first, second, "saving an unchanged palette must not change its bytes");
  });

  it("a folder read back from a file keeps the identity it was saved with", () => {
    const tree = SwatchFile.wrapFlatAsTree([["A", { h: 1, l: 2, O: 3 }]], "Palette.aco");
    const saved = SwatchFile.serializeTree(tree);
    const savedZuid = allZuids(bufferToHex(saved))[0];

    const reopened = SwatchFile.parse(saved, "Palette.aco");
    const resavedZuids = allZuids(bufferToHex(SwatchFile.serializeTree(reopened)));

    assert.ok(resavedZuids.includes(savedZuid), "the stored identity survives a round trip");
  });

  it("gives each folder in a tree its own identity", () => {
    const nested = [["Root", null, [["Inner", null, [["A", { h: 1, l: 2, O: 3 }]], true]], true]];
    const zuids = allZuids(bufferToHex(SwatchFile.serializeTree(nested)));
    assert.equal(zuids.length, 2, "one per folder");
    assert.notEqual(zuids[0], zuids[1]);
    for (const zuid of zuids) assert.match(zuid, UUID_V4);
  });

  it("serialize aliases serializeTree for preset export", () => {
    const tree = SwatchFile.wrapFlatAsTree([["A", { h: 1, l: 2, O: 3 }]], "X.aco");
    // Identical but for the folder zuid, which is freshly generated per call.
    assert.equal(
      maskFolderZuid(bufferToHex(SwatchFile.serialize(tree))),
      maskFolderZuid(bufferToHex(SwatchFile.serializeTree(tree))),
    );
  });

  it("colorChannels maps h/l/O and alternate channel bags", () => {
    assert.deepEqual(SwatchFile.colorChannels({ h: 10, l: 20, O: 30 }), {
      r: 10,
      g: 20,
      b: 30,
      a: 255,
    });
    assert.deepEqual(SwatchFile.colorChannels(null), { r: 0, g: 0, b: 0, a: 255 });
    assert.deepEqual(SwatchFile.colorChannels({ l: 1, i: 2, c: 3, AW: 128 }), {
      r: 1,
      g: 2,
      b: 3,
      a: 128,
    });
  });

  it("leafToTreeNode and migrateStoreToTree match shapes", () => {
    assert.deepEqual(SwatchFile.leafToTreeNode(["X", { h: 10, l: 20, O: 30 }]), [
      "X",
      { h: 10, l: 20, O: 30 },
      null,
    ]);
    const objectStore = [{ name: "c", h: 1, l: 2, O: 3 }];
    SwatchFile.migrateStoreToTree(objectStore);
    assert.deepEqual(withoutFolderIds(objectStore), [
      ["Swatches", null, [["c", { name: "c", h: 1, l: 2, O: 3 }, null]], true],
    ]);
    const pairStore = [["n", { h: 1, l: 2, O: 3 }]];
    SwatchFile.migrateStoreToTree(pairStore);
    assert.deepEqual(withoutFolderIds(pairStore), [
      ["Swatches", null, [["n", { h: 1, l: 2, O: 3 }, null]], true],
    ]);
  });
});
