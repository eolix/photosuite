/**
 * Boykov-Kolmogorov max-flow and supporting queues for graph-cut posterization.
 *
 * Adjacency construction, BFS max-flow, min-cut search, ring and indexed
 * queues, and in-place quicksort.
 */

const SOURCE_TREE = 1;
const SINK_TREE = 2;
const INF_BOTTLENECK = 1e30;
const INF_DISTANCE = 1e9;

/** Round up to the next power-of-two ring-buffer mask. */
function nextPowerOfTwoCapacity(requested) {
  let capacity = requested;
  capacity |= capacity >> 1;
  capacity |= capacity >> 2;
  capacity |= capacity >> 4;
  capacity |= capacity >> 8;
  capacity |= capacity >> 16;
  return capacity;
}

let scratchBuffer = new Uint32Array(1);

/**
 * Fixed-capacity ring buffer queue backed by a power-of-two mask.
 * @param {number} capacity minimum slot count before rounding up
 */
export function RingQueue(capacity) {
  const mask = nextPowerOfTwoCapacity(capacity);
  this.buffer = new Uint32Array(mask + 1);
  this.mask = mask;
  this.head = 0;
  this.tail = 0;
};

RingQueue.prototype = {
  push(value) {
    const at = this.tail;
    this.buffer[at] = value;
    this.tail = (at + 1) & this.mask;
  },
  pop() {
    const at = this.head;
    const value = this.buffer[at];
    this.head = (at + 1) & this.mask;
    return value;
  },
  isEmpty() {
    return this.head === this.tail;
  },
  reset() {
    this.head = 0;
    this.tail = 0;
  },
};

/**
 * Ring queue with O(1) membership tracking for arbitrary node ids.
 * @param {number} capacity minimum slot count before rounding up
 */
export function IndexedQueue(capacity) {
  const mask = nextPowerOfTwoCapacity(capacity);
  this.buffer = new Uint32Array(mask + 1);
  this.positions = new Uint32Array(mask + 1);
  this.mask = mask;
  this.head = 0;
  this.tail = 0;
};

IndexedQueue.prototype = {
  top() {
    return this.buffer[this.head];
  },
  peekTail() {
    return this.buffer[this.tail];
  },
  push(value) {
    if (this.positions[value] !== 0) {
      return;
    }
    this.positions[value] = this.tail + 1;
    const at = this.tail;
    this.buffer[at] = value;
    this.tail = (at + 1) & this.mask;
  },
  pop() {
    const at = this.head;
    const value = this.buffer[at];
    this.positions[value] = 0;
    this.head = (at + 1) & this.mask;
    return value;
  },
  isEmpty() {
    return this.head === this.tail;
  },
  remove(value) {
    const pos = this.positions[value] - 1;
    if (pos === -1) {
      return;
    }
    this.positions[value] = 0;
    if (pos === this.head) {
      this.pop();
      return;
    }
    const moved = this.pop();
    this.buffer[pos] = moved;
    this.positions[moved] = pos + 1;
  },
  wrapIndex(index) {
    return (index + this.mask + 1) & this.mask;
  },
};

export function swapAt(array, i, j) {
  const tmp = array[i];
  array[i] = array[j];
  array[j] = tmp;
};

export function partition(array, lo, hi) {
  const pivot = array[(lo + hi) >>> 1];
  while (lo <= hi) {
    while (array[lo] < pivot) {
      lo++;
    }
    while (array[hi] > pivot) {
      hi--;
    }
    if (lo <= hi) {
      swapAt(array, lo, hi);
      lo++;
      hi--;
    }
  }
  return lo;
};

export function quickSort(array, lo, hi) {
  const split = partition(array, lo, hi);
  if (lo < split - 1) {
    quickSort(array, lo, split - 1);
  }
  if (split < hi) {
    quickSort(array, split, hi);
  }
};

export function buildAdjacency(
  nodeCount,
  entryCount,
  source,
  sink,
  endpoints,
  caps,
) {
  const firstEdge = new Uint32Array(nodeCount);
  let cursor = 0;
  let edges = scratchBuffer;
  if (edges.length < entryCount * 4) {
    scratchBuffer = edges = new Uint32Array(entryCount * 4);
  }
  const weights = new Float64Array(edges.buffer);

  for (let entry = 0; entry < entryCount; entry += 2) {
    const u = endpoints[entry];
    const v = endpoints[entry + 1];
    const capForward = caps[entry];
    const capBackward = caps[entry + 1];

    edges[cursor] = v;
    weights[cursor + 2 >> 1] = capForward;
    edges[cursor + 1] = firstEdge[u];
    firstEdge[u] = cursor + 1;
    cursor += 4;

    edges[cursor] = u;
    weights[cursor + 2 >> 1] = capBackward;
    edges[cursor + 1] = firstEdge[v];
    firstEdge[v] = cursor + 1;
    cursor += 4;
  }

  return { edges, weights, firstEdge };
};

export function setParent(
  parent,
  parentEdge,
  child,
  tree,
  parentEdgeOf,
  dist,
  timestamp,
) {
  tree[child] = tree[parent];
  parentEdgeOf[child] = parentEdge + 1;
  dist[child] = dist[parent] + 1;
  timestamp[child] = timestamp[parent];
};

export function recomputeDistance(
  node,
  source,
  sink,
  parentEdgeOf,
  edges,
  time,
  timestamp,
  dist,
) {
  let startNode = node;
  let parentEdge = parentEdgeOf[node] - 1;
  let steps = 0;

  while (parentEdge !== -1 && timestamp[node] !== time) {
    node = edges[parentEdge ^ 4];
    parentEdge = parentEdgeOf[node] - 1;
    steps++;
  }

  if (parentEdge === -1 && node !== source && node !== sink) {
    return INF_DISTANCE;
  }

  const baseDist = dist[node] + steps;
  steps = 0;
  parentEdge = parentEdgeOf[startNode] - 1;

  while (startNode !== node) {
    dist[startNode] = baseDist - steps;
    steps++;
    timestamp[startNode] = time;
    startNode = edges[parentEdge ^ 4];
    parentEdge = parentEdgeOf[startNode] - 1;
  }

  return baseDist;
};

/**
 * Grow source/sink search trees until an opposing-tree boundary edge appears.
 * @returns {number} oriented boundary edge index, or -1 when exhausted
 */
function growActiveTree(active, state) {
  const {
    edges,
    residual,
    firstEdge,
    tree,
    parentEdge,
    dist,
    timestamp,
  } = state;

  while (!active.isEmpty()) {
    const node = active.top();
    const nodeTree = tree[node];
    let edge = firstEdge[node] - 1;
    let boundaryEdge = -1;

    // Scan the node's full edge list, keeping the last opposing-tree boundary
    // edge; continuing the scan also adopts remaining free neighbors.
    while (edge !== -1) {
      const neighbor = edges[edge];
      const neighborTree = tree[neighbor];
      const orientedEdge = edge ^ nodeTree - 1 << 2;

      if (residual[orientedEdge + 2 >> 1] !== 0) {
        if (neighborTree === 0) {
          setParent(
            node,
            edge,
            neighbor,
            tree,
            parentEdge,
            dist,
            timestamp,
          );
          active.push(neighbor);
        } else if (
          neighborTree === nodeTree
          && timestamp[neighbor] <= timestamp[node]
          && dist[neighbor] > dist[node]
        ) {
          setParent(
            node,
            edge,
            neighbor,
            tree,
            parentEdge,
            dist,
            timestamp,
          );
        } else if (neighborTree !== nodeTree) {
          boundaryEdge = orientedEdge;
        }
      }

      edge = edges[edge + 1] - 1;
    }

    if (boundaryEdge !== -1) {
      return boundaryEdge;
    }

    active.pop();
  }

  return -1;
}

/** Build the augmenting path edge list from a boundary edge. */
function buildAugmentingPath(boundaryEdge, path, parentEdge, edges) {
  let pathLen = 0;
  let cursor = boundaryEdge;

  while (cursor !== -1) {
    path[pathLen] = cursor;
    pathLen++;
    cursor = parentEdge[edges[cursor ^ 4]] - 1;
  }

  const half = pathLen >> 1;
  for (let k = 0; k < half; k++) {
    const swap = path[k];
    path[k] = path[pathLen - k - 1];
    path[pathLen - k - 1] = swap;
  }

  cursor = parentEdge[edges[boundaryEdge]] - 1;
  while (cursor !== -1) {
    path[pathLen] = cursor ^ 4;
    pathLen++;
    cursor = parentEdge[edges[cursor ^ 4]] - 1;
  }

  return pathLen;
}

/** Push bottleneck units along the path and enqueue newly orphaned nodes. */
function augmentAlongPath(path, pathLen, state, orphans) {
  const { edges, residual, tree, parentEdge } = state;
  let bottleneck = INF_BOTTLENECK;

  for (let k = 0; k < pathLen; k++) {
    bottleneck = Math.min(bottleneck, residual[path[k] + 2 >> 1]);
  }

  for (let k = 0; k < pathLen; k++) {
    const forwardEdge = path[k];
    const reverseEdge = forwardEdge ^ 4;
    const tailNode = edges[reverseEdge];
    const headNode = edges[forwardEdge];

    residual[forwardEdge + 2 >> 1] -= bottleneck;
    residual[reverseEdge + 2 >> 1] += bottleneck;

    if (residual[forwardEdge + 2 >> 1] === 0 && tree[tailNode] === tree[headNode]) {
      if (tree[tailNode] === SOURCE_TREE) {
        parentEdge[headNode] = 0;
        orphans.push(headNode);
      }
      if (tree[tailNode] === SINK_TREE) {
        parentEdge[tailNode] = 0;
        orphans.push(tailNode);
      }
    }
  }

  return bottleneck;
}

/** Re-parent orphan nodes or detach them from the active set. */
function adoptOrphans(orphans, active, state, time, source, sink) {
  const {
    edges,
    residual,
    firstEdge,
    tree,
    parentEdge,
    dist,
    timestamp,
  } = state;

  while (!orphans.isEmpty()) {
    const orphan = orphans.pop();
    const orphanTree = tree[orphan];
    let edge = firstEdge[orphan] - 1;
    const treeOffset = orphanTree === SOURCE_TREE ? 4 : 0;
    let bestParent = 0;
    let bestParentEdge = 0;
    let bestDist = INF_DISTANCE;

    while (edge !== -1) {
      const neighbor = edges[edge];
      const reverseNeighborEdge = edge ^ 4;
      const orientedEdge = edge ^ treeOffset;

      if (
        tree[neighbor] === orphanTree
        && residual[orientedEdge + 2 >> 1] > 0
        && recomputeDistance(
          neighbor,
          source,
          sink,
          parentEdge,
          edges,
          time,
          timestamp,
          dist,
        ) + 1
          < bestDist
      ) {
        bestParent = neighbor;
        bestParentEdge = reverseNeighborEdge;
        bestDist = dist[neighbor] + 1;
      }

      edge = edges[edge + 1] - 1;
    }

    if (bestParentEdge !== 0) {
      setParent(
        bestParent,
        bestParentEdge,
        orphan,
        tree,
        parentEdge,
        dist,
        timestamp,
      );
      continue;
    }

    edge = firstEdge[orphan] - 1;
    while (edge !== -1) {
      const neighbor = edges[edge];
      const orientedEdge = edge ^ treeOffset;

      if (tree[neighbor] === orphanTree) {
        if (residual[orientedEdge + 2 >> 1] > 0) {
          active.push(neighbor);
        }
        if (parentEdge[neighbor] === edge + 1) {
          parentEdge[neighbor] = 0;
          orphans.push(neighbor);
        }
      }

      edge = edges[edge + 1] - 1;
    }

    tree[orphan] = 0;
    active.remove(orphan);
  }
}

function collectTreeCutEdges(tree, entryCount, endpoints) {
  const cutEdges = [];

  for (let entry = 0; entry < entryCount; entry += 2) {
    const u = endpoints[entry];
    const v = endpoints[entry + 1];

    if (tree[u] === SOURCE_TREE && tree[v] !== SOURCE_TREE) {
      cutEdges.push(entry >> 1);
    }
    if (tree[v] === SOURCE_TREE && tree[u] !== SOURCE_TREE) {
      cutEdges.push((entryCount + entry) >> 1);
    }
  }

  return cutEdges;
}

export function computeMinCut(
  nodeCount,
  entryCount,
  source,
  sink,
  endpoints,
  caps,
  flowLimit,
) {
  const adjacency = buildAdjacency(
    nodeCount,
    entryCount,
    source,
    sink,
    endpoints,
    caps,
  );
  const edges = adjacency.edges;
  const residual = adjacency.weights;
  const firstEdge = adjacency.firstEdge;
  const path = new Uint32Array(nodeCount);
  const active = new IndexedQueue(nodeCount);
  let time = 1;
  let flow = 0;

  active.push(source);
  active.push(sink);

  const orphans = new IndexedQueue(nodeCount);
  const tree = new Uint8Array(nodeCount);
  const parentEdge = new Uint32Array(nodeCount);
  tree[source] = SOURCE_TREE;
  tree[sink] = SINK_TREE;

  const timestamp = new Uint32Array(nodeCount);
  const dist = new Uint32Array(nodeCount);
  dist[source] = 0;
  dist[sink] = 0;
  timestamp[source] = 1;
  timestamp[sink] = 1;

  const flowState = {
    edges,
    residual,
    firstEdge,
    tree,
    parentEdge,
    dist,
    timestamp,
  };

  while (true) {
    const boundaryEdge = growActiveTree(active, flowState);

    if (boundaryEdge === -1) {
      break;
    }

    time++;
    const pathLen = buildAugmentingPath(
      boundaryEdge,
      path,
      parentEdge,
      edges,
    );
    const bottleneck = augmentAlongPath(path, pathLen, flowState, orphans);

    flow += bottleneck;
    if (flow >= flowLimit) {
      return { cut: null, flow };
    }

    adoptOrphans(orphans, active, flowState, time, source, sink);
  }

  return {
    cut: collectTreeCutEdges(tree, entryCount, endpoints),
    flow,
  };
};

export function maxFlowBfs(
  nodeCount,
  entryCount,
  source,
  sink,
  endpoints,
  caps,
) {
  const adjacency = buildAdjacency(
    nodeCount,
    entryCount,
    source,
    sink,
    endpoints,
    caps,
  );
  const edges = adjacency.edges;
  const residual = adjacency.weights;
  const firstEdge = adjacency.firstEdge;
  let flow = 0;
  const parent = new Uint32Array(nodeCount * 2);
  const queue = new RingQueue(nodeCount);
  let neighbor = 0;

  while (true) {
    queue.reset();
    queue.push(source);

    for (let i = 0; i < nodeCount; i++) {
      parent[i << 1] = 0;
    }

    while (!queue.isEmpty()) {
      const node = queue.pop();
      let edge = firstEdge[node] - 1;

      while (edge !== -1) {
        neighbor = edges[edge];
        if (
          parent[neighbor << 1] === 0
          && residual[edge + 2 >> 1] > 0
          && neighbor !== source
        ) {
          parent[neighbor << 1] = node + 1;
          parent[(neighbor << 1) + 1] = edge;
          queue.push(neighbor);
        }
        edge = edges[edge + 1] - 1;
      }

      if (parent[sink << 1] !== 0) {
        break;
      }
    }

    if (parent[sink << 1] === 0) {
      break;
    }

    let bottleneck = INF_BOTTLENECK;
    let traceNode = sink;

    while (true) {
      const prevNode = parent[traceNode << 1] - 1;
      if (prevNode === -1) {
        break;
      }
      const pathEdge = parent[(traceNode << 1) + 1];
      bottleneck = Math.min(bottleneck, residual[pathEdge + 2 >> 1]);
      traceNode = prevNode;
    }

    traceNode = sink;
    while (true) {
      const prevNode = parent[traceNode << 1] - 1;
      if (prevNode === -1) {
        break;
      }
      const pathEdge = parent[(traceNode << 1) + 1];
      const reverseEdge = pathEdge ^ 4;
      residual[pathEdge + 2 >> 1] -= bottleneck;
      residual[reverseEdge + 2 >> 1] += bottleneck;
      traceNode = prevNode;
    }

    flow += bottleneck;
  }

  const cutEdges = [];
  for (let entry = 0; entry < entryCount; entry += 2) {
    const u = endpoints[entry];
    const v = endpoints[entry + 1];

    if (
      (parent[u << 1] !== 0 || u === source)
      && parent[v << 1] === 0
      && v !== source
    ) {
      cutEdges.push(entry >> 1);
    }
    if (
      (parent[v << 1] !== 0 || v === source)
      && parent[u << 1] === 0
      && u !== source
    ) {
      cutEdges.push((entryCount + entry) >> 1);
    }
  }

  return { cut: cutEdges, flow };
};

