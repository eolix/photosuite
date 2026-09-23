/**
 * Lens Correction panel: registration, preferred size, and the
 * descriptor round-trip.
 *
 * The round-trip is the part worth guarding: every control has to land back in
 * the field it came from, and a stored descriptor carrying a value outside a
 * slider's range must survive being loaded and saved again.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

/** The shared stub canvas has no drawing context; panel chrome needs one. */
function installCanvasContext() {
  const context = new Proxy({}, {
    get: (target, key) => {
      if (key === "canvas") return { width: 100, height: 100 };
      if (key === "measureText") return () => ({ width: 10 });
      if (key === "getImageData" || key === "createImageData") {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      if (key === "createLinearGradient" || key === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      return typeof key === "string" && key in target ? target[key] : () => {};
    },
    set: () => true,
  });
  const createElement = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "canvas") element.getContext = () => context;
    return element;
  };
  const sample = createElement("div");
  if (!sample.querySelector) {
    const elementProto = Object.getPrototypeOf(sample);
    Object.defineProperty(elementProto, "querySelector", { value: () => null, enumerable: false });
    Object.defineProperty(elementProto, "querySelectorAll", { value: () => [], enumerable: false });
  }
}

let FilterParameterPanel;
let FilterDefs;
let computePreferredLensCorrectionDialogSize;
let setLensProfileDatabase;
let EventType;

before(async () => {
  installCanvasContext();
  await import("../../../src/ui/filter-panels/filter-parameter-panel.js");
  ({ computePreferredLensCorrectionDialogSize } = await import(
    "../../../src/ui/filter-panels/lens-correction-panel.js"
  ));
  ({ FilterParameterPanel } = await import("../../../src/ui/filter-panels/filter-parameter-panel.js"));
  ({ FilterDefs } = await import("../../../src/features/filters/filter-apply.js"));
  ({ setLensProfileDatabase } = await import("../../../src/features/filters/lens-profile.js"));
  ({ EventType } = await import("../../../src/core/event-bus.js"));
});

/** One camera and one lens, enough to drive the Search Criteria lists. */
const profileDatabase = {
  distortionModels: ["poly3", "poly5", "ptlens"],
  cameras: [{ maker: "Canon", model: "Canon EOS 5D Mark III", mount: "Canon EF", cropFactor: 1 }],
  lenses: [{
    maker: "Canon", model: "Canon EF 24-70mm f/2.8L II USM",
    mount: "Canon EF", cropFactor: 1, aspectRatio: 1.5,
    distortion: [[24, 2, 0.02, -0.06, 0.05], [70, 2, 0.006, -0.02, 0.01]],
    vignetting: [[24, 2.8, 1000, -2, 2.6, -1.2], [70, 2.8, 1000, -1.4, 1.8, -0.8]],
  }],
};

describe("ui/filter-panels/lens-correction-panel.js", () => {
  it("registers a fullscreen LnCr panel with preferred size goldens", () => {
    assert.equal(typeof FilterParameterPanel.LnCr, "function");
    const proto = FilterParameterPanel.LnCr.prototype;
    assert.equal(proto.opensAsModalDialog(), true);
    assert.deepEqual(proto.getPreferredDialogSize(2000, 1500), { width: 1180, height: 860 });
    assert.deepEqual(proto.getPreferredDialogSize(500, 400), { width: 500, height: 400 });
    assert.deepEqual(computePreferredLensCorrectionDialogSize(2000, 1500), { width: 1180, height: 860 });
  });

  it("returns every control to the field it came from", () => {
    const panel = new FilterParameterPanel.LnCr();
    const sent = FilterDefs.create("LnCr");
    const values = {
      LnIa: -37.5, LnRc: 21.25, LnGm: -8.5, LnBy: 44.75,
      LnSb: -60, LnSt: 30, LnVp: 25, LnHp: -15, LnRa: 12.5,
      LnSi: 150, LnNm: true, LnNa: 32, LnAs: true, LnFt: 3,
    };
    for (const key of Object.keys(values)) sent[key].v = values[key];
    sent.LnIs.v.Rd.v = 200;
    sent.LnIs.v.Grn.v = 100;
    sent.LnIs.v.Bl.v = 50;

    panel.writeDescriptorToWidgets(sent);
    const readBack = panel.getValue();
    for (const key of Object.keys(values)) {
      const expected = values[key];
      if (typeof expected === "boolean") assert.equal(readBack[key].v, expected, key);
      else assert.ok(Math.abs(readBack[key].v - expected) < 0.01, `${key}: got ${readBack[key].v}`);
    }
    assert.equal(readBack.LnIs.v.Rd.v, 200);
    assert.equal(readBack.LnIs.v.Grn.v, 100);
    assert.equal(readBack.LnIs.v.Bl.v, 50);
  });

  it("does not clamp a stored descriptor to its slider ranges", () => {
    const panel = new FilterParameterPanel.LnCr();
    const wide = FilterDefs.create("LnCr");
    wide.LnSi.v = 400;
    wide.LnNa.v = 512;
    wide.LnRa.v = 270;
    panel.writeDescriptorToWidgets(wide);
    const readBack = panel.getValue();
    assert.equal(readBack.LnSi.v, 400);
    assert.equal(readBack.LnNa.v, 512);
    assert.equal(readBack.LnRa.v, 270);
  });

  it("round-trips the profile corrections once a profile is available", () => {
    const panel = new FilterParameterPanel.LnCr();
    setLensProfileDatabase(profileDatabase);
    panel.profileDatabase = profileDatabase;
    panel.selectedCamera = profileDatabase.cameras[0];
    panel.selectedLens = profileDatabase.lenses[0];
    panel.refreshProfileChoices();

    const asked = FilterDefs.create("LnCr");
    asked.LnAg.v = true;
    asked.LnAv.v = true;
    panel.writeDescriptorToWidgets(asked);
    const readBack = panel.getValue();
    assert.equal(readBack.LnAg.v, true, "distortion is measured for this lens");
    assert.equal(readBack.LnAv.v, true, "vignetting is measured for this lens");
    assert.equal(readBack.LnPr.v, "Canon EF 24-70mm f/2.8L II USM");
  });

  it("carries the coefficients with the filter, not just the lens name", () => {
    const panel = new FilterParameterPanel.LnCr();
    setLensProfileDatabase(profileDatabase);
    panel.profileDatabase = profileDatabase;
    panel.selectedCamera = profileDatabase.cameras[0];
    panel.selectedLens = profileDatabase.lenses[0];
    panel.documentMetadata = {
      "tiff:Make": "Canon", "tiff:Model": "Canon EOS 5D Mark III",
      "exif:Lens": "Canon EF 24-70mm f/2.8L II USM",
      "exif:FocalLength": [24, 1], "exif:FNumber": [2.8, 1],
    };
    const calibration = panel.getValue().lensProfileCalibration;
    assert.ok(calibration, "the resolved profile should travel on the descriptor");
    assert.equal(calibration.distortion.model, 2);
    assert.ok(Math.abs(calibration.distortion.c0 - 0.02) < 1e-9, "coefficients at 24mm");
    assert.ok(Math.abs(calibration.vignetting.k1 + 2) < 1e-9);
  });

  it("says which corrections a profile cannot make", () => {
    // Roughly half the lenses in the database carry no vignetting measurements.
    // A greyed-out switch with no reason reads as a fault, so the panel names it.
    const panel = new FilterParameterPanel.LnCr();
    panel.profileDatabase = profileDatabase;
    panel.selectedCamera = profileDatabase.cameras[0];
    panel.selectedLens = profileDatabase.lenses[0];
    panel.refreshProfileChoices();
    // No locale tables are loaded here, so Locale.get returns the key path.
    // That still shows which phrases the panel composed, in what order.
    const status = panel.autoHelpEl.textContent;
    assert.ok(status.includes("Canon EF 24-70mm f/2.8L II USM"), status);
    assert.ok(status.includes("notMeasured"), `should say what is missing: ${status}`);
    assert.ok(status.includes("chromaticAberration"), `should name the missing one: ${status}`);
    assert.ok(!status.includes("lensCorrection.vignette"),
      `should not name a correction the lens does have: ${status}`);
  });

  it("offers a correction only where the lens was actually measured", () => {
    const panel = new FilterParameterPanel.LnCr();
    panel.profileDatabase = profileDatabase;
    panel.selectedCamera = profileDatabase.cameras[0];
    panel.selectedLens = profileDatabase.lenses[0];
    panel.refreshProfileChoices();
    // This lens has distortion and vignetting measured, but no chromatic aberration.
    assert.equal(panel.geometricAutoCheckbox.inputEl.disabled, false);
    assert.equal(panel.vignetteAutoCheckbox.inputEl.disabled, false);
    assert.equal(panel.chromaticAutoCheckbox.inputEl.disabled, true);
  });

  it("refresh updates preview quality and redraws without dispatching widgetSelect", () => {
    const panel = new FilterParameterPanel.LnCr();
    let widgetSelectCount = 0;
    panel.on(EventType.widgetSelect, () => {
      widgetSelectCount++;
    });
    panel._previewQuality = "draft";
    panel.refresh();
    assert.equal(panel._previewQuality, "full");
    assert.equal(widgetSelectCount, 0, "LnCr panel refresh must not dispatch widgetSelect to the dialog");
  });
});
