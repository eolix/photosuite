/**
 * Golden I/O for ThemeConfig palettes and applyTheme CSS variables.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

const cssProps = {};
document.documentElement = {
  style: {
    setProperty(name, value) {
      cssProps[name] = value;
    },
  },
};
document.querySelector = function () {
  return null;
};

let ThemeConfig;

before(async () => {
  ({ ThemeConfig } = await import("../../../src/ui/config/theme-config.js"));
});

describe("ui/config/theme-config.js", () => {
  it("exposes six named themes with the declared base palette keys", () => {
    assert.deepEqual(
      ThemeConfig.themes.map((theme) => theme.name),
      ["Midnight", "Anthracite", "Slate", "Pearl", "Aubergine", "Ocean"]
    );
    for (const theme of ThemeConfig.themes) {
      assert.deepEqual(Object.keys(theme), [
        "name",
        "--bg-color",
        "--bg-panel",
        "--bg-canvas",
        "--bg-input",
        "--bg-bbtn",
        "--bg-bbtnOver",
        "--brdrLgt",
        "--brdrDrk",
        "--alphaDark",
        "--text-color",
        "--gs-invert",
        "--brdr",
        "--accent",
      ]);
    }
    assert.equal(ThemeConfig.themes[0]["--accent"], 3642623);
    assert.equal(ThemeConfig.themes[3]["--gs-invert"], 0.12);
    assert.equal(ThemeConfig.themes[5]["--bg-color"], 1451327);
  });

  it("applyTheme writes the full Midnight token set", () => {
    for (const key of Object.keys(cssProps)) delete cssProps[key];
    ThemeConfig.applyTheme(0);
    // The per-icon `--icon_*` variables are asserted separately below.
    const colourTokens = Object.keys(cssProps).filter((key) => !key.startsWith("--icon_"));
    assert.deepEqual(colourTokens.sort(), [
      "--accent",
      "--accent-contrast",
      "--accent-focus-ring",
      "--accent-muted",
      "--accent-subtle",
      "--alphaDark",
      "--bg-bbtn",
      "--bg-bbtnOver",
      "--bg-canvas",
      "--bg-color",
      "--bg-input",
      "--bg-panel",
      "--brdr",
      "--brdrDrk",
      "--brdrLgt",
      "--chrome-groove",
      "--gs-invert",
      "--hairline",
      "--hairline-strong",
      "--img20",
      "--input-border",
      "--menu-bg",
      "--modal-border",
      "--surface-active",
      "--surface-hover",
      "--surface-raised",
      "--surface-subtle",
      "--surface-sunken",
      "--text-color",
      "--text-faint",
      "--text-muted",
      "color-scheme",
    ]);
    assert.equal(cssProps["--bg-color"], "#1e2127");
    assert.equal(cssProps["--brdrLgt"], "rgba(255,255,255,0.07)");
    assert.equal(cssProps["--brdrDrk"], "rgba(  0,  0,  0,0.55)");
    assert.equal(cssProps["--accent"], "#3794ff");
    assert.equal(cssProps["--accent-subtle"], "rgba(55,148,255,0.18)");
    assert.equal(cssProps["--accent-muted"], "rgba(55,148,255,0.34)");
    assert.equal(cssProps["--accent-focus-ring"], "rgba(55,148,255,0.42)");
    assert.equal(cssProps["--accent-contrast"], "#ffffff");
    assert.equal(cssProps["--hairline"], "rgba(212,218,229,0.13)");
    assert.equal(cssProps["--hairline-strong"], "rgba(212,218,229,0.22)");
    assert.equal(cssProps["--surface-raised"], "#24272e");
    assert.equal(cssProps["--surface-subtle"], "rgba(212,218,229,0.05)");
    assert.equal(cssProps["--surface-hover"], "rgba(212,218,229,0.09)");
    assert.equal(cssProps["--surface-active"], "rgba(212,218,229,0.16)");
    assert.equal(cssProps["--surface-sunken"], "#15171c");
    // The groove that closes the top chrome: the canvas colour taken a quarter
    // of the way to black, so it is the darkest line in the window.
    assert.equal(cssProps["--chrome-groove"], "#0f1116");
    assert.equal(cssProps["--menu-bg"], "#22262c");
    assert.equal(cssProps["--text-muted"], "#898e97");
    assert.equal(cssProps["--text-faint"], "#60646c");
    assert.equal(cssProps["--modal-border"], "#55575b");
    assert.equal(cssProps["--input-border"], "#4f535b");
    assert.equal(cssProps["--img20"], "20px");
    assert.equal(cssProps["color-scheme"], "dark");
  });

  // Each themed icon gets a url plus an invert factor; a replaced icon carries
  // its own colour and is not inverted.
  it("applyTheme writes a url and an invert factor per themed icon", () => {
    for (const key of Object.keys(cssProps)) delete cssProps[key];
    ThemeConfig.applyTheme(0);
    const iconVars = Object.keys(cssProps).filter((key) => key.startsWith("--icon_"));
    assert.ok(iconVars.length > 0, "no icon variables written");
    for (const urlVar of iconVars.filter((key) => !key.endsWith("_invrt"))) {
      assert.match(cssProps[urlVar], /^url\(\/assets\/ico\/.*\.svg\)$/);
      assert.ok(iconVars.includes(`${urlVar}_invrt`), `${urlVar} has no invert factor`);
    }
  });

  it("picks dark accent-contrast text for a bright accent", () => {
    for (const key of Object.keys(cssProps)) delete cssProps[key];
    const brightAccentIndex = ThemeConfig.themes.length;
    ThemeConfig.themes.push(
      Object.assign({}, ThemeConfig.themes[0], { name: "Probe", "--accent": 0xffe066 })
    );
    ThemeConfig.applyTheme(brightAccentIndex);
    ThemeConfig.themes.pop();
    assert.equal(cssProps["--accent-contrast"], "#101216");
  });
});
