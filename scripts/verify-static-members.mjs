// A call like `TransformToolBase.getScale(m)` is valid JavaScript whether or not
// anything ever assigns `TransformToolBase.getScale`. It throws only when that
// line runs, so nothing an import or type check does will see it.
//
// For every `X.y` where `X` names a function or class this tree exports —
// whether the file imports it or receives it as a parameter, which is how the
// tool bases are handed to their installers — require that `X.y` is assigned
// somewhere, or that `y` is a static method the class declares. Prototype members and instance fields are out of scope: `X`
// here is a module binding, not an object with a prototype chain to search.
// Usage: node scripts/verify-static-members.mjs
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "vendor" || name === "external" || name === "wasm") continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const all = [...sources.values()].join("\n");

// Bindings that name a function or class exported from this tree — the ones a
// module can hold and hang a static on.
const exported = new Set();
for (const text of sources.values()) {
  for (const m of text.matchAll(/^export (?:function|class) (\w+)/gm)) exported.add(m[1]);
}

// Anything ever assigned as `X.y = …`, plus `static y` inside a class body.
const assigned = new Set();
for (const text of sources.values()) {
  for (const m of text.matchAll(/\b(\w+)\.(\w+)\s*=[^=]/g)) assigned.add(`${m[1]}.${m[2]}`);
  for (const m of text.matchAll(/\bstatic\s+(\w+)\s*[(=]/g)) assigned.add(m[1]);
}

const issues = [];
for (const [file, text] of sources) {
  // `a.b.c()` is a property chain, not a call on an imported binding.
  for (const m of text.matchAll(/(?<![\w.$])(\w+)\.(\w+)\s*\(/g)) {
    const [, obj, member] = m;
    // Constructor-cased only: a lowercase binding of the same name is an
    // instance, and its methods live on a prototype this check cannot follow.
    if (!/^[A-Z]/.test(obj) || !exported.has(obj)) continue;
    if (assigned.has(`${obj}.${member}`) || assigned.has(member)) continue;
    if (member === "call" || member === "apply" || member === "bind" || member === "prototype") continue;
    const lineNo = text.slice(0, m.index).split("\n").length;
    issues.push(`${path.relative(SRC, file)}:${lineNo}: calls ${obj}.${member}(), which nothing assigns`);
  }
}

if (issues.length) {
  console.error("STATIC MEMBERS WITH NO ASSIGNMENT:\n" + [...new Set(issues)].join("\n"));
  process.exit(1);
}
console.log("static members: OK (every call has an assignment)");
