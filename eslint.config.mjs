import js from '@eslint/js';
import globals from 'globals';

// Photoshop scripting-API objects the script sandbox provides to user scripts.
const scriptingApiGlobals = [
  'app', 'dialog', 'border', 'color', 'cursor', 'display', 'font', 'global',
  'highlight', 'position', 'scaleHow', 'scaleWhen', 'style', 'trans', 'util', 'zoomtype',
];

// Vendored libraries attached to the window by <script> in index.html.
const vendorGlobals = [
  'Typr', 'UPNG', 'UTIF', 'UZIP', 'pako', 'paper', 'opentype',
  'UDOC', 'FromPS', 'FromPDF', 'FromDXF', 'NETXUS', 'BINDB', 'ADBE', 'PDFJS', 'acorn', 'linear',
];

// No application symbol belongs on these lists. Every module imports what it
// uses; nothing is published on `globalThis`.
const ambientGlobals = Object.fromEntries(
  [...scriptingApiGlobals, ...vendorGlobals].map((name) => [name, 'readonly']),
);

/**
 * Lints the PhotoSuite `src` tree (Tauri `frontendDist`).
 * Tweak `ignores` if you add vendored or generated bundles under `src`.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      // Git submodules (photopea/UPNG.js, UTIF.js, UZIP.js, Typr.js)
      'src/vendor/**',
      'src/external/js/ext-*.js',
      // Catenated IIFE segments — not valid JS when parsed alone
      'src/code/modules/**',
      'src/code/deobfuscated-editor/**',
    ],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      // ES modules: `src/main.js` is loaded as `<script type="module">`.
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker,
        ...globals.es2021,
        ...ambientGlobals,
      },
    },
    rules: {
      ...js.configs.recommended.rules,

      // A dropped import or a stale name after a rename reads as an undefined
      // global, which throws only on the branch that runs it. The ambient
      // globals above are allowlisted so this flags genuine references.
      'no-undef': 'error',

      // A statement that only reads a member does nothing. It is what a lost
      // assignment target looks like — `this.x;` where `this.x = null;` was
      // meant — and it is not in the recommended set. Short-circuit guards
      // (`fn && fn()`) and side-effecting ternaries are how this tree writes
      // conditional calls, so both stay allowed.
      'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],

      // Short names, shared globals and wire-value data the tree carries.
      'no-unused-vars': 'off',
      // Declarations open with a placeholder (`var w = 0, h = 0;`) and the
      // branch below assigns the real value; the placeholder never reads back.
      'no-useless-assignment': 'off',
      'no-redeclare': 'off',
      'no-constant-condition': 'off',
      'no-constant-binary-expression': 'off',
      'no-empty': 'off',
      'no-self-assign': 'off',
      'no-dupe-keys': 'off',
      'no-unreachable': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
    },
  },
];
