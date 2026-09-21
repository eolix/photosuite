// A subclass takes its base's prototype with `Object.create(Base.prototype)`.
//
// `X.prototype = new Base()` runs the base constructor once, at module load, so
// every reference-typed field it assigns — an array, an object, a cache — lands
// on the one prototype the whole subtree inherits, and instances share it.
// Usage: node scripts/verify-prototype-chains.mjs
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

const PROTOTYPE_FROM_INSTANCE = /\.prototype\s*=\s*new\s+[A-Za-z_$]/;

const issues = [];
for (const file of walk(SRC)) {
  const rel = path.relative(process.cwd(), file);
  fs.readFileSync(file, "utf8").split("\n").forEach((line, idx) => {
    if (/^\s*(?:\*|\/\/)/.test(line)) return;
    if (PROTOTYPE_FROM_INSTANCE.test(line)) {
      issues.push(`${rel}:${idx + 1}: ${line.trim()}`);
    }
  });
}

if (issues.length) {
  console.error(
    "PROTOTYPES BUILT FROM AN INSTANCE (use Object.create(Base.prototype)):\n"
    + issues.join("\n"),
  );
  process.exit(1);
}
console.log("prototype chains: OK (no prototype is a constructed instance)");
