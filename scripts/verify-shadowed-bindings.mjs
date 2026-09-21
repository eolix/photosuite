// A local binding that reuses the name of a module-scope function silently
// replaces it for the rest of that scope. `copyChannel(...)` then calls
// whatever the local holds — a boolean flag, say — and throws only when that
// line runs. The function may be imported or declared in the same file; both
// break the same way.
//
// ESLint resolves scopes properly, so no-shadow is the check; this narrows its
// report to the callable names, where a shadow turns a call into a crash.
// Usage: node scripts/verify-shadowed-bindings.mjs
import { ESLint } from "eslint";
import fs from "node:fs";
import path from "node:path";
import globals from "globals";

const config = [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.worker, ...globals.es2021 },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "no-shadow": ["error", { builtinGlobals: false, hoist: "all" }] },
  },
];

const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config });
const results = await eslint.lintFiles(["src/**/*.js"]);

const issues = [];
for (const result of results) {
  if (result.filePath.includes("/vendor/") || result.filePath.includes("/external/")) continue;
  const text = fs.readFileSync(result.filePath, "utf8");
  // Names that hold a function in module scope: imported bindings, plus the
  // functions and classes this file declares at the top level.
  const callables = new Set();
  for (const m of text.matchAll(/^import\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) callables.add(name);
    }
  }
  for (const m of text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    callables.add(m[1]);
  }
  for (const message of result.messages) {
    if (message.ruleId !== "no-shadow") continue;
    const name = /'([^']+)'/.exec(message.message)?.[1];
    if (!name || !callables.has(name)) continue;
    issues.push(
      `${path.relative(process.cwd(), result.filePath)}:${message.line}: ` +
        `local \`${name}\` shadows the module-scope function of the same name`,
    );
  }
}

if (issues.length) {
  console.error("LOCALS SHADOWING MODULE-SCOPE FUNCTIONS:\n" + issues.join("\n"));
  process.exit(1);
}
console.log("shadowed bindings: OK (no local hides a module-scope function)");
