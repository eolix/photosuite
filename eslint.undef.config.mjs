import globals from 'globals';

// Dedicated `no-undef` gate (`npm run verify:undef`). The main lint config keeps
// `no-undef` off because the vendored libraries and the script sandbox arrive as
// ambient globals; this config enables it with those explicitly allowlisted, so
// it only flags genuine undefined references — dropped imports after a code
// move, stale names after a rename.
//
// No application symbol belongs on these lists. Every module imports what it
// uses, and a layer that must reach code above it reads a startup-filled seam
// (`ModelExtensions`, `EngineExtensions`) rather than a name on `globalThis`.

// Photoshop scripting-API objects the script sandbox provides to user scripts.
const scriptingApiGlobals = [
  'app', 'dialog', 'border', 'color', 'cursor', 'display', 'font', 'global',
  'highlight', 'position', 'scaleHow', 'scaleWhen', 'style', 'trans', 'util', 'zoomtype',
];

// Vendored libraries / external bundles attached to the window by <script>.
const vendorGlobals = [
  'Typr', 'UPNG', 'UTIF', 'UZIP', 'pako', 'paper', 'opentype',
  'UDOC', 'FromPS', 'FromPDF', 'FromDXF', 'NETXUS', 'BINDB', 'ADBE', 'PDFJS', 'acorn', 'linear',
];

const allowlist = Object.fromEntries(
  [...scriptingApiGlobals, ...vendorGlobals].map((n) => [n, 'readonly']),
);

export default [
  {
    ignores: [
      'node_modules/**',
      'src/vendor/**',
      'src/external/js/ext-*.js',
      'src/code/modules/**',
      'src/code/deobfuscated-editor/**',
    ],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, ...globals.es2021, ...allowlist },
    },
    // Files carry disable directives for rules the main config enables
    // (e.g. no-loss-of-precision on wire-value data); this gate only runs
    // no-undef, so those directives are expectedly "unused" here.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' },
  },
];
