import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IndexedQueue, RingQueue, computeMinCut, maxFlowBfs, quickSort } from "../../../src/engine/compositing/posterize.js";

describe("engine/compositing/posterize.js RingQueue", () => {
  it("push, pop, and isEmpty follow ring-buffer semantics", () => {
    const queue = new RingQueue(4);

    queue.push(10);
    assert.equal(queue.isEmpty(), false);
    queue.push(20);
    assert.equal(queue.isEmpty(), false);
    assert.equal(queue.pop(), 10);
    assert.equal(queue.pop(), 20);
    assert.equal(queue.isEmpty(), true);
  });
});

describe("engine/compositing/posterize.js IndexedQueue", () => {
  it("push, remove, pop, and isEmpty track membership", () => {
    const queue = new IndexedQueue(8);

    queue.push(3);
    assert.equal(queue.isEmpty(), false);
    queue.push(7);
    assert.equal(queue.isEmpty(), false);
    queue.remove(3);
    assert.equal(queue.isEmpty(), false);
    assert.equal(queue.top(), 7);
    assert.equal(queue.pop(), 7);
    assert.equal(queue.isEmpty(), true);
  });
});

describe("engine/compositing/posterize.js quickSort", () => {
  it("sorts an integer array in place", () => {
    const values = [5, 1, 4, 2, 3];
    quickSort(values, 0, values.length - 1);
    assert.deepEqual(Array.from(values), [1, 2, 3, 4, 5]);
  });
});

describe("engine/compositing/posterize.js maxFlowBfs", () => {
  it("finds flow on a simple S-A-T path graph", () => {
    const nodeCount = 3;
    const entryCount = 4;
    const source = 0;
    const sink = 2;
    const endpoints = new Uint32Array([0, 1, 1, 2]);
    const caps = new Float64Array([5, 1000, 3, 1000]);

    const result = maxFlowBfs(
      nodeCount,
      entryCount,
      source,
      sink,
      endpoints,
      caps,
    );
    assert.deepEqual(result, { cut: [1], flow: 3 });
  });

  it("finds flow on a diamond graph", () => {
    const nodeCount = 4;
    const entryCount = 8;
    const source = 0;
    const sink = 3;
    const endpoints = new Uint32Array([0, 1, 0, 2, 1, 3, 2, 3]);
    const caps = new Float64Array([10, 1000, 10, 1000, 4, 1000, 5, 1000]);

    const result = maxFlowBfs(
      nodeCount,
      entryCount,
      source,
      sink,
      endpoints,
      caps,
    );
    assert.deepEqual(result, { cut: [2, 3], flow: 9 });
  });
});

describe("engine/compositing/posterize.js computeMinCut", () => {
  it("finds flow on a simple S-A-T path graph", () => {
    const nodeCount = 3;
    const entryCount = 4;
    const source = 0;
    const sink = 2;
    const endpoints = new Uint32Array([0, 1, 1, 2]);
    const caps = new Float64Array([5, 1000, 3, 1000]);

    const result = computeMinCut(
      nodeCount,
      entryCount,
      source,
      sink,
      endpoints,
      caps,
      1e30,
    );
    assert.deepEqual(result, { cut: [1], flow: 3 });
  });

  it("finds flow on a diamond graph", () => {
    const nodeCount = 4;
    const entryCount = 8;
    const source = 0;
    const sink = 3;
    const endpoints = new Uint32Array([0, 1, 0, 2, 1, 3, 2, 3]);
    const caps = new Float64Array([10, 1000, 10, 1000, 4, 1000, 5, 1000]);

    const result = computeMinCut(
      nodeCount,
      entryCount,
      source,
      sink,
      endpoints,
      caps,
      1e30,
    );
    assert.deepEqual(result, { cut: [2, 3], flow: 9 });
  });

  it("early-exits with a null cut once accumulated flow reaches the limit", () => {
    const endpoints = new Uint32Array([0, 1, 0, 2, 1, 3, 2, 3]);
    const caps = new Float64Array([10, 1000, 10, 1000, 4, 1000, 5, 1000]);
    // Augmenting paths are found in bottleneck order [4, 5]; the exact flow at
    // early-exit depends on the boundary-edge selection (last edge per node).
    assert.deepEqual(computeMinCut(4, 8, 0, 3, endpoints, caps, 4), { cut: null, flow: 4 });
    assert.deepEqual(computeMinCut(4, 8, 0, 3, endpoints, caps, 5), { cut: null, flow: 9 });
  });
});
