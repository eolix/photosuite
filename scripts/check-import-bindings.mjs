#!/usr/bin/env node
// Static import-binding gate. Two checks:
//
// 1. Every `import { X } from "./y.js"` names an export y.js actually provides.
//    Catches mismatches the path-only resolver misses and eslint can't
//    (no-undef is off here) — a symbol imported after it moved elsewhere.
// 2. Nothing assigns to a name it imported. An import binding is readonly, so
//    `showToast = fn` throws at run time, and only on the code path that runs
//    it — a module that replaces a function at startup needs an installer the
//    owning module exports, not an assignment.
// 3. Nothing calls a free function as a method. The modules in
//    FREE_FUNCTION_MODULES export functions that take their subject as the
//    first argument; `node.compositeLayerGpu(...)` is a call that survives every
//    static check and throws only when that branch runs, so a clipping-mask path
//    that makes such a call reaches the app unflagged without this.
//
// Star re-exports and default are not deeply verified.
// Usage: node scripts/check-import-bindings.mjs
import fs from "node:fs"; import path from "node:path";
const SRC=path.resolve("src");
// Modules whose exports take their subject as the first argument, never `this`,
// and whose names are distinctive enough that any `.name(` is a mistake. A
// module exporting a common verb (`cancel`, `addClass`) does not belong here:
// other objects legitimately have methods by those names.
const FREE_FUNCTION_MODULES=[
  "document/render/layer-compositor.js",
  "document/render/raster-transform.js",
  "document/formats/psd/descriptor-codec.js",
  "document/model/guide-snapping.js",
  "document/model/layer-translate.js",
  "document/tools/flood-select.js",
  "document/tools/selection-actions.js",
  "document/tools/shape-actions.js",
  "engine/compositing/anti-alias.js",
];
function walk(d,o=[]){for(const n of fs.readdirSync(d)){if(["vendor","wasm"].includes(n))continue;const p=path.join(d,n);fs.statSync(p).isDirectory()?walk(p,o):n.endsWith(".js")&&o.push(p);}return o;}
const files=walk(SRC);
// collect exported names per file
function exportsOf(src){
  const names=new Set();
  // export { a, b as c }  and  export { a } from "..."
  for(const m of src.matchAll(/export\s*\{([^}]*)\}/g)){
    for(const part of m[1].split(",")){
      const t=part.trim(); if(!t)continue;
      const as=t.split(/\s+as\s+/); names.add((as[1]||as[0]).trim());
    }
  }
  // export function/const/let/var/class Name
  for(const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  if(/export\s+default/.test(src)) names.add("default");
  if(/export\s*\*/.test(src)) names.add("*"); // star re-export — can't verify, mark
  return names;
}
const exp=new Map();
for(const f of files) exp.set(f, exportsOf(fs.readFileSync(f,"utf8")));
const issues=[];
const impRe=/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
for(const f of files){
  const src=fs.readFileSync(f,"utf8");
  for(const m of src.matchAll(impRe)){
    const spec=m[2]; if(!spec.startsWith("."))continue;
    let t=path.resolve(path.dirname(f),spec); if(!t.endsWith(".js"))t+=".js";
    if(!exp.has(t))continue; // unresolved handled elsewhere
    const tExp=exp.get(t); if(tExp.has("*"))continue; // star re-export, skip
    for(const part of m[1].split(",")){
      const t0=part.trim(); if(!t0)continue;
      const local=t0.split(/\s+as\s+/)[0].trim();
      if(!tExp.has(local)) issues.push(`${path.relative(SRC,f)}: imports { ${local} } from ${spec} — NOT exported there`);
    }
  }
}
// 2. assignment to an imported binding
for(const f of files){
  const src=fs.readFileSync(f,"utf8");
  const imported=new Set();
  for(const m of src.matchAll(impRe))
    for(const part of m[1].split(",")){
      const t0=part.trim(); if(!t0)continue;
      imported.add(t0.split(/\s+as\s+/).pop().trim());
    }
  for(const name of imported){
    const assignRe=new RegExp("^\\s*"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\s*(=[^=]|\\+=|-=)","gm");
    for(const m of src.matchAll(assignRe)){
      const line=src.slice(0,m.index).split("\n").length;
      issues.push(`${path.relative(SRC,f)}:${line}: assigns to imported binding \`${name}\` — imports are readonly; export an installer instead`);
    }
  }
}
// 3. free functions called as methods
const freeNames=new Set();
for(const rel of FREE_FUNCTION_MODULES){
  const f=path.join(SRC,rel);
  if(!fs.existsSync(f)){issues.push(`check-import-bindings: ${rel} not found`);continue;}
  for(const m of fs.readFileSync(f,"utf8").matchAll(/^export function (\w+)\s*\(/gm)) freeNames.add(m[1]);
}
// A free function may still be published as a static somewhere (`X.name = name`).
// That call works, so only flag names nothing publishes: those throw at runtime.
const allSrc=files.map(f=>fs.readFileSync(f,"utf8")).join("\n");
const published=new Set();
for(const name of freeNames)
  if(new RegExp("\\.[ \\t]*"+name+"[ \\t]*=[^=]").test(allSrc)) published.add(name);
for(const f of files){
  const src=fs.readFileSync(f,"utf8");
  for(const name of freeNames){
    if(published.has(name))continue;
    const callRe=new RegExp("\\.[ \\t]*"+name+"[ \\t]*\\(","g");
    for(const m of src.matchAll(callRe)){
      const line=src.slice(0,m.index).split("\n").length;
      issues.push(`${path.relative(SRC,f)}:${line}: calls \`${name}\` as a method, and nothing assigns it as one — it is a free function; pass its subject as the first argument`);
    }
  }
}
if(issues.length){console.error("BINDING MISMATCHES:\n"+issues.join("\n"));process.exit(1);}
console.log("imports resolve, none are assigned to, and no free function is called as a method");
