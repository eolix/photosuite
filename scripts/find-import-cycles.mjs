#!/usr/bin/env node
//
// Reports import cycles under src/.
//
// There is no bundler between this source and the webview, so a cycle is not a
// style question: when two modules import each other, whichever loads second
// sees the first only half-evaluated, and a binding it reads at load time is
// undefined. Nothing catches that until the path that uses it runs.
//
// Walks every *.js under src/, extracts `import ... from "<path>";` statements
// (multi-line aware), resolves paths relative to the importing file, and runs
// Tarjan's algorithm to enumerate strongly-connected components. Any component
// of more than one file is a cycle; those wholly inside vendor/ are third-party
// and out of scope.
//
//   node scripts/find-import-cycles.mjs           # report every cycle
//   node scripts/find-import-cycles.mjs --check   # exit 1 if any is outside vendor/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "src");

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);

const importRe = /(?:^|\n)\s*import\s+(?:[^"';]+?\s+from\s+)?["']([^"']+)["']\s*;?/g;

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  let target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(target)) return target;
  if (fs.existsSync(target + ".js")) return target + ".js";
  if (fs.existsSync(path.join(target, "index.js"))) return path.join(target, "index.js");
  return null;
}

const graph = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const deps = new Set();
  let m;
  importRe.lastIndex = 0;
  while ((m = importRe.exec(src)) !== null) {
    const resolved = resolveImport(file, m[1]);
    if (resolved) deps.add(resolved);
  }
  graph.set(file, [...deps]);
}

const index = new Map();
const lowlink = new Map();
const onStack = new Map();
const stack = [];
let counter = 0;
const sccs = [];

function strongConnect(v) {
  index.set(v, counter);
  lowlink.set(v, counter);
  counter++;
  stack.push(v);
  onStack.set(v, true);
  for (const w of graph.get(v) || []) {
    if (!index.has(w)) {
      strongConnect(w);
      lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
    } else if (onStack.get(w)) {
      lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
    }
  }
  if (lowlink.get(v) === index.get(v)) {
    const scc = [];
    let w;
    do {
      w = stack.pop();
      onStack.set(w, false);
      scc.push(w);
    } while (w !== v);
    sccs.push(scc);
  }
}

for (const v of graph.keys()) {
  if (!index.has(v)) strongConnect(v);
}

const cycles = sccs
  .filter((scc) => scc.length > 1)
  .sort((a, b) => b.length - a.length);

const rel = (p) => path.relative(path.dirname(ROOT), p);

// A cycle is "vendor" when every file in it lives under src/vendor — those are
// third-party and out of scope. 
const isVendor = (p) => rel(p).startsWith("src/vendor/");
const nonVendorCycles = cycles.filter((scc) => !scc.every(isVendor));
const maxNonVendorScc = nonVendorCycles.reduce((n, s) => Math.max(n, s.length), 0);

console.log(`Scanned ${files.length} files; ${graph.size} nodes in graph.`);
console.log(`Found ${cycles.length} SCCs of size > 1 (import cycles).`);
for (const scc of cycles) {
  console.log("---");
  console.log(`SCC size ${scc.length}:`);
  for (const f of scc.sort()) console.log("  " + rel(f));
}
console.log(
  `\nNon-vendor cycles: ${nonVendorCycles.length} (largest SCC ${maxNonVendorScc} files).`
);

if (process.argv.includes("--check")) {
  if (nonVendorCycles.length > 0) {
    console.error(
      `\nimport cycles FAILED: ${nonVendorCycles.length} cycle(s) outside vendor/. ` +
        `A module in a cycle is half-initialised when its partner imports it, so a ` +
        `binding reads undefined at load time and throws only on the path that uses ` +
        `it. Break the cycle by moving the shared symbol into a module both can ` +
        `import, or by having the lower layer read a startup-filled registry ` +
        `instead of importing upward.`
    );
    process.exit(1);
  }
  console.log("import cycles: OK (none outside vendor/).");
}

process.exit(0);
