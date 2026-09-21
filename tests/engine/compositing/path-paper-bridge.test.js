/**
 * Golden values for path-paper-bridge (compositing / Paper.js bridge).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { usesCompoundFill } from "../../../src/engine/compositing/path-records.js";
import { ensurePaperJs, paperItemToPathRecords, pathRecordsToPaperPaths, subpathIndicesIntersectingRect, unitePathRecordsWithPaper } from "../../../src/engine/compositing/path-paper-bridge.js";

installBrowserGlobals();

let Point;
let Rect;

function makeSeg(x, y, hinX = 0, hinY = 0, houtX = 0, houtY = 0) {
  return {
    point: { x, y },
    handleIn: { x: hinX, y: hinY },
    handleOut: { x: houtX, y: houtY },
  };
}

function installPaperStub() {
  globalThis.paper = {
    setup() {},
    Color: class {
      constructor(r, g, b) {
        this.r = r;
        this.g = g;
        this.b = b;
      }
    },
    CompoundPath: class {
      constructor(children) {
        this.children = children || [];
        this.fillRule = null;
        this.fillColor = null;
        this.area = 10;
        this.closed = true;
        this.segments = null;
      }
      addChild(child) {
        this.children.push(child);
      }
      remove() {}
      unite(other) {
        const next = new paper.CompoundPath();
        next.area = 10;
        next.closed = true;
        next.children = this.children.concat(other.children || []);
        return next;
      }
      subtract(other) {
        return this.unite(other);
      }
      exclude(other) {
        return this.unite(other);
      }
      intersect(other) {
        return this.unite(other);
      }
    },
    Path: class {
      constructor(segmentData) {
        this.segmentData = segmentData;
        this.closed = false;
        this.fillRule = null;
        this.area = 10;
        this.segments = (segmentData || []).map((seg) => ({
          point: { x: seg[0][0], y: seg[0][1] },
          handleIn: { x: seg[1][0], y: seg[1][1] },
          handleOut: { x: seg[2][0], y: seg[2][1] },
        }));
        this.children = null;
      }
      remove() {}
    },
    Rectangle: class {
      constructor(x, y, width, height) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
      }
    },
  };
  paper.Path.Rectangle = function (rect) {
    const path = new paper.Path();
    path.intersects = () => true;
    path.contains = () => false;
    path.children = [{ segments: [{ point: { x: rect.x, y: rect.y } }] }];
    path.remove = () => {};
    path.fillColor = null;
    return path;
  };
}

function samplePathRecords() {
  return [
    { type: 6 },
    { type: 6 },
    { type: 0, length: 4, fillRule: 0 },
    { type: 1, cp1: new Point(-1, 0), anchor: new Point(0, 0), anchorOut: new Point(1, 0) },
    { type: 1, cp1: new Point(9, 0), anchor: new Point(10, 0), anchorOut: new Point(11, 0) },
    { type: 1, cp1: new Point(9, 10), anchor: new Point(10, 10), anchorOut: new Point(11, 10) },
    { type: 1, cp1: new Point(-1, 10), anchor: new Point(0, 10), anchorOut: new Point(1, 10) },
  ];
}

before(async () => {
  installPaperStub();
  ({ Point } = await import("../../../src/core/math/point.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
});

describe("path-paper-bridge", () => {
  // Paper.js needs a canvas, so setup is deferred to the first call and then
  // never repeated, however many paths are converted afterwards.
  it("ensurePaperJs sets paper up once", () => {
    let setups = 0;
    const realSetup = paper.setup;
    paper.setup = (...args) => {
      setups += 1;
      return realSetup.apply(paper, args);
    };
    try {
      ensurePaperJs();
      ensurePaperJs();
    } finally {
      paper.setup = realSetup;
    }
    assert.ok(setups <= 1, "paper was set up more than once");
    assert.equal(pathRecordsToPaperPaths(samplePathRecords()).length, 1);
  });

  it("paperItemToPathRecords closed/open goldens", () => {
    const closed = paperItemToPathRecords({
      segments: [makeSeg(0, 0), makeSeg(10, 0), makeSeg(10, 10), makeSeg(0, 10), makeSeg(0, 0)],
      closed: true,
    });
    assert.equal(closed.length, 5);
    assert.deepEqual(closed[0], { type: 0, length: 4, fillRule: 0, subpathHeaderFlags: 2 });
    assert.equal(closed[1].type, 1);
    assert.deepEqual([closed[1].anchor.x, closed[1].anchor.y, closed[1].cp1.x, closed[1].anchorOut.x], [0, 0, 0, 0]);
    assert.deepEqual(
      closed.slice(1).map((knot) => knot.type),
      [1, 1, 1, 1],
    );

    const open = paperItemToPathRecords({
      segments: [makeSeg(0, 0), makeSeg(5, 5), makeSeg(10, 0)],
      closed: false,
    });
    assert.deepEqual(open[0], { type: 3, length: 3, fillRule: 0, subpathHeaderFlags: 2 });
    assert.deepEqual(
      open.map((rec) => rec.type),
      [3, 4, 4, 4],
    );
  });

  it("paperItemToPathRecords promotes an open subpath to closed when endpoints coincide", () => {
    const promoted = paperItemToPathRecords({
      segments: [makeSeg(0, 0), makeSeg(10, 0), makeSeg(10, 10), makeSeg(0, 0)],
      closed: false,
    });
    // Duplicate closing knot dropped (length 4 -> 3) and every type demoted by 3
    // (open header 3 -> closed 0, open knots 4 -> closed 1).
    assert.deepEqual(promoted[0], { type: 0, length: 3, fillRule: 0, subpathHeaderFlags: 2 });
    assert.deepEqual(
      promoted.map((rec) => rec.type),
      [0, 1, 1, 1],
    );
    assert.deepEqual(
      promoted.slice(1).map((knot) => [knot.anchor.x, knot.anchor.y]),
      [[0, 0], [10, 0], [10, 10]],
    );
  });

  // The first subpath carries no `all` flag and fill rule 0, which reads as an
  // even-odd compound path, so its children are united rather than subtracted.
  it("pathRecordsToPaperPaths unites the children of a compound path", () => {
    const pairs = pathRecordsToPaperPaths(samplePathRecords());
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0][1], "unite");
    assert.equal(pairs[0][0].children.length, 1);
    assert.deepEqual(pairs[0][0].children[0].segmentData[0], [[0, 0], [-1, 0], [1, 0]]);
  });

  it("unitePathRecordsWithPaper and rect hit-test goldens", () => {
    const records = samplePathRecords();
    const rebuilt = unitePathRecordsWithPaper(records);
    assert.equal(rebuilt.length, 7);
    assert.equal(rebuilt[2].fillRule, 1);
    assert.equal(rebuilt[2].type, 0);
    assert.equal(rebuilt[2].length, 4);
    assert.deepEqual(subpathIndicesIntersectingRect(records, new Rect(0, 0, 20, 20)), [0]);
  });

  // A path that declares a single non-even-odd subpath subtracts instead.
  it("pathRecordsToPaperPaths subtracts a non-compound subpath", () => {
    const records = samplePathRecords();
    records[1] = { type: 6, all: 1 };
    records[2] = { ...records[2], fillRule: 2 };
    assert.equal(pathRecordsToPaperPaths(records)[0][1], "subtract");
  });
});
