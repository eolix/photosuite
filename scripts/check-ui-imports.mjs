#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const root = new URL("..", import.meta.url).pathname;
const uiRoot = join(root, "src/ui");

const errors = [];

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (name.endsWith(".js")) files.push(path);
  }
  return files;
}

const forbidden = [
  /from\s+['"]\.\/ui\.js['"]/,
  /from\s+['"][^'"]*\/ui\/ui\.js['"]/,
  /from\s+['"]\.\/ThemeConfig\.js['"]/,
  /from\s+['"]\.\/popupTypes\.js['"]/,
  /from\s+['"][^'"]*\/ui\/InputHandler\.js['"]/,
  /from\s+['"][^'"]*\/tool-option-bar\.js['"]/,
  /from\s+['"][^'"]*\/tool-options\.js['"]/,
  // Module paths are kebab-case; a PascalCase path names no file here.
  /from\s+['"][^'"]*\/panels\/[A-Z][^'"]*\.js['"]/,
  /from\s+['"][^'"]*\/filter-panels\/[A-Z][^'"]*\.js['"]/,
  /from\s+['"][^'"]*\/widgets\/[A-Z][^'"]*\.js['"]/,
  /from\s+['"][^'"]*\/dialogs\/(BaseDialog|WebImagesDialog|settings-shell|files-media|image-project|export-web|layer-style)\.js['"]/,
];

for (const file of walk(uiRoot)) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  for (const re of forbidden) {
    if (re.test(text)) {
      errors.push(`${rel}: forbidden import matching ${re}`);
    }
  }
  if (rel.startsWith("src/ui/panels/") || rel.startsWith("src/ui/dialogs/") || rel.startsWith("src/ui/widgets/")) {
    if (/from\s+['"][^'"]*\/shell\/app-controller/.test(text)) {
      errors.push(`${rel}: panels/dialogs/widgets must not import shell/app-controller`);
    }
  }
}

if (errors.length) {
  console.error("UI import check failed:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log("UI import check passed.");
process.exit(0);
