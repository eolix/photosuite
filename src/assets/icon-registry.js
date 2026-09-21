/**
 * Maps logical icon keys to bundled SVG icon files.
 *
 * {@link ICON_PATH_KEYS} lists every toolbar/panel icon the app needs. Each key
 * resolves to `${ICON_BASE}<key>.svg` under `/assets/ico/`. Most of that set is
 * derived from Tabler Icons (MIT); the rest is drawn for this app.
 *
 * `intro` is the full-color app logo at `/assets/img/icon_full.svg` (not
 * theme-tinted like the toolbar set).
 *
 * Toolbar icons load as plain image URLs (`<img src>` / `background-image`), so an
 * SVG cannot inherit page colour; each file carries a black stroke and the theme
 * tints it through `filter: invert(var(--gs-invert))` (see the `gsicon` class in
 * all.css).
 *
 * A launch configuration may replace an icon with its own artwork. An overridden
 * icon is full-colour, so {@link isIconTinted} reports false for it and the
 * theme leaves it alone.
 */

const ICON_PATH_KEYS = [
  "tools/blur",
  "tools/brush",
  "tools/redeye",
  "tools/crepl",
  "tools/burn",
  "tools/clone",
  "tools/rcrop",
  "tools/pcrop",
  "tools/cshape",
  "tools/dodge",
  "tools/dselect",
  "tools/ellipse",
  "tools/eraser",
  "tools/beraser",
  "tools/eselect",
  "tools/eyedropper",
  "tools/eyedropper_add",
  "tools/eyedropper_rm",
  "tools/pen",
  "tools/fpen",
  "tools/gradient",
  "tools/hand",
  "tools/rview",
  "tools/hbrush",
  "tools/htype",
  "tools/lasso",
  "tools/line",
  "tools/mlasso",
  "tools/move",
  "tools/mwand",
  "tools/patch",
  "tools/camove",
  "tools/pbucket",
  "tools/pencil",
  "tools/plasso",
  "tools/pselect",
  "tools/pshape",
  "tools/oselect",
  "tools/qselect",
  "tools/rect",
  "tools/rselect",
  "tools/ruler",
  "tools/grid-4x4",
  "tools/keyframe-align-horizontal",
  "tools/sharpen",
  "tools/shbrush",
  "tools/smudge",
  "tools/sponge",
  "tools/transform",
  "tools/zoom",
  "tools/corner",
  "tools/slice",
  "tools/sselect",
  "align/h0",
  "align/h1",
  "align/h2",
  "align/hG",
  "align/v0",
  "align/v1",
  "align/v2",
  "align/vG",
  "par/center",
  "par/jall",
  "par/jcenter",
  "par/jleft",
  "par/jright",
  "par/left",
  "par/right",
  "par/lind",
  "par/rind",
  "par/flind",
  "par/bind",
  "par/aind",
  "type/bold",
  "type/caps",
  "type/italic",
  "type/scaps",
  "type/strike",
  "type/sub",
  "type/sup",
  "type/under",
  "lrs/bin",
  "lrs/newlayer",
  "lrs/folder",
  "lrs/mask",
  "lrs/adj",
  "lrs/makesel",
  "lrs/makepath",
  "lrs/arrow_down",
  "lrs/arrow_right",
  "lrs/clipping",
  "lrs/eye",
  "lrs/fx",
  "lrs/chain",
  "lrs/link",
  "lrs/lock",
  "set/front",
  "set/union",
  "set/difference",
  "set/intersection",
  "set/xor",
  "liq/smudge",
  "liq/reconstruct",
  "liq/smooth",
  "liq/twirl",
  "liq/shrink",
  "liq/blow",
  "liq/pleft",
  "caps/butt",
  "caps/round",
  "caps/square",
  "joints/bevel",
  "joints/miter",
  "joints/round",
  "rotate",
  "reload",
  "cross",
  "checkmark",
  "pos",
  "trsp3",
  "prsS",
  "prsO",
  "zoomIn",
  "zoomOut",
  "panels/info",
  "panels/properties",
  "panels/brush",
  "panels/character",
  "panels/paragraph",
  "panels/css",
  "panels/images",
  "panels/history",
  "panels/swatches",
  "panels/layers",
  "panels/channels",
  "panels/paths",
  "panels/histogram",
  "panels/navigator",
  "panels/actions",
  "panels/colour",
  "panels/glyphs",
  "panels/layer-comps",
  "panels/tool-presets",
  "panels/guides",
  "ui/menu",
  "ui/keyboard",
  "ui/plus",
  "ui/reorder",
  "ui/submenu",
  "ui/aspect-lock",
];

const ICON_BASE = "/assets/ico/";

/** Build a fresh key → URL map for all bundled tool and panel icons. */
export function buildIconPathMap() {
  const map = {};
  for (const key of ICON_PATH_KEYS) {
    map[key] = `${ICON_BASE}${key}.svg`;
  }
  map.intro = "/assets/img/icon_full.svg";
  return map;
}

const iconUrlByKey = buildIconPathMap();
const overriddenKeys = new Set();

/** The URL for an icon key, or undefined when the key is not in the set. */
export function getIconUrl(key) {
  return iconUrlByKey[key];
}

/**
 * Replace one icon's artwork, as a launch configuration does. The replacement
 * is used as-is: {@link isIconTinted} reports false for it afterwards.
 */
export function overrideIcon(key, url) {
  iconUrlByKey[key] = url;
  overriddenKeys.add(key);
}

/**
 * True when the theme should tint this icon. The bundled set is black-stroke
 * artwork that the `gsicon` class inverts per theme; replaced artwork carries
 * its own colour and is left as it is.
 */
export function isIconTinted(key) {
  return !overriddenKeys.has(key);
}

/**
 * An `<img>` for a bundled icon. Tinted artwork carries the `gsicon` class so
 * the theme can invert it; replaced artwork does not.
 */
export function iconImgHtml(assetKey, altText, extraClass) {
  let classAttr = extraClass ? extraClass : "";
  if (isIconTinted(assetKey)) classAttr += " gsicon";
  return (
    '<img src="' +
    getIconUrl(assetKey) +
    '" alt="' +
    (altText ? altText : "") +
    '" class="' +
    classAttr +
    '" />'
  );
}
