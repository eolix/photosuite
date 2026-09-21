#!/usr/bin/env node
// Static import-resolution gate for src/ (no bundler — raw ESM is loaded from
// frontendDist: ../src, so a broken relative path only surfaces at runtime).
//
// Walks every *.js under src/ (skipping vendor/ and wasm/), extracts the
// specifier from every `import`/`export ... from` statement (multi-line aware),
// and verifies each relative specifier resolves to a file that exists on disk.
// Bare directory imports (implicit index.js) are rejected on purpose: this repo
// has no barrels, every import must name a concrete file.
//
// Usage: node scripts/check-imports-resolve.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const SKIP = new Set(["vendor", "wasm"]);

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

// `import ... from "x"` / `export ... from "x"` (multi-line aware), plus the
// side-effect `import "x"` form. A bare `export` without `from` is a
// declaration, not a module specifier, so it must not match.
const fromRe =
  /(?:^|\n)\s*(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']\s*;?/g;
const sideEffectRe = /(?:^|\n)\s*import\s*["']([^"']+)["']\s*;?/g;

const issues = [];

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, "utf8");
  const specs = [];
  let m;
  while ((m = fromRe.exec(src)) !== null) specs.push(m[1]);
  while ((m = sideEffectRe.exec(src)) !== null) specs.push(m[1]);
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue; // bare/node specifier — not ours to resolve
    const target = path.resolve(path.dirname(file), spec);
    const ok = fs.existsSync(target) && fs.statSync(target).isFile();
    if (!ok) {
      const rel = path.relative(ROOT, file);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        issues.push(`${rel}: imports a directory (barrel) "${spec}" — name a concrete file`);
      } else {
        issues.push(`${rel}: unresolved import "${spec}"`);
      }
    }
  }
}

if (issues.length) {
  console.error("import-resolution FAILED:\n" + issues.map((i) => `  ${i}`).join("\n"));
  process.exit(1);
}
console.log(`import-resolution: OK (all relative imports resolve)`);
