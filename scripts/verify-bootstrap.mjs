#!/usr/bin/env node
/**
 * Bootstrap contract checks for the Tauri webview entry (macOS 10.15+ WebKit).
 * Catches load-order and platform issues the behavioural suite cannot see
 * (a top-level await in the entry, for one).
 *
 * Run: npm run verify:bootstrap
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(repoRoot, "src");
const skipDirs = new Set(["vendor", "wasm", "external"]);
const issues = [];

const MAIN_JS = path.join(srcRoot, "main.js");
const ICON_REGISTRY_JS = path.join(srcRoot, "assets/icon-registry.js");
const INDEX_HTML = path.join(srcRoot, "index.html");

function rel(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/** Strip line and block comments for lightweight statement scans. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function collectImportPaths(source) {
  const paths = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import ")) continue;
    const sideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]\s*;?$/);
    if (sideEffect) {
      paths.push(sideEffect[1]);
      continue;
    }
    const named = trimmed.match(/\bfrom\s+['"]([^'"]+)['"]\s*;?$/);
    if (named) paths.push(named[1]);
  }
  return paths;
}

function checkMainJs() {
  const source = read(MAIN_JS);
  const relPath = rel(MAIN_JS);

  const importPaths = collectImportPaths(source);

  if (importPaths.length === 0) {
    issues.push(`${relPath}: no static import statements found`);
    return;
  }

  const bodyWithoutImports = source.replace(
    /^\s*import\s+[\s\S]*?;?\s*$/gm,
    ""
  );
  const stripped = stripComments(bodyWithoutImports);
  if (/^\s*await\b/m.test(stripped)) {
    issues.push(
      `${relPath}: top-level await is not supported on minimum macOS 10.15 WebKit — use static imports only`
    );
  }

  if (/\bawait\s+import\s*\(/.test(stripped)) {
    issues.push(
      `${relPath}: dynamic import() with await breaks bootstrap on minimum WebKit — keep static imports`
    );
  }
}

function checkIconRegistry() {
  const source = read(ICON_REGISTRY_JS);
  const relPath = rel(ICON_REGISTRY_JS);

  for (const fn of ["getIconUrl", "overrideIcon", "isIconTinted"]) {
    if (!new RegExp(`\\bexport\\s+function\\s+${fn}\\b`).test(source)) {
      issues.push(`${relPath}: must export ${fn}()`);
    }
  }
}

function checkIndexHtml() {
  const html = read(INDEX_HTML);
  const relPath = rel(INDEX_HTML);

  if (!/<script\s+type=["']module["']\s+src=["']main\.js["']\s*>\s*<\/script>/i.test(html)) {
    issues.push(`${relPath}: must load main.js as <script type="module" src="main.js">`);
  }

  if (/<script\s+src=["']assets\/icon-registry\.js["']/i.test(html)) {
    issues.push(
      `${relPath}: the icon registry is an ESM module, not a classic script`
    );
  }
}


checkMainJs();
checkIconRegistry();
checkIndexHtml();

if (issues.length) {
  console.error("bootstrap verify FAILED:\n" + issues.map((i) => `  ${i}`).join("\n"));
  process.exit(1);
}

console.log("bootstrap verify: OK");
