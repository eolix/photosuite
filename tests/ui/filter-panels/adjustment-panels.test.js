/**
 * adjustment FilterParameterPanel constructors + setFields/getFields goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterParameterPanel;
let FilterDefs;
let BlendModes;

before(async () => {
  await import("../../../src/ui/filter-panels/filter-parameter-panel.js");
  await import("../../../src/ui/filter-panels/adjustment-panels.js");
  ({ FilterParameterPanel } = await import("../../../src/ui/filter-panels/filter-parameter-panel.js"));
  ({ FilterDefs } = await import("../../../src/features/filters/filter-apply.js"));
  ({ BlendModes } = await import("../../../src/document/model/blend-modes.js"));
});

const ADJUSTMENT_PANEL_KEYS = [
  "aply", "blnc", "blwh", "brit", "clrL", "curv", "expA", "fade", "grdm",
  "hue2", "levl", "mixr", "nvrt", "phfl", "post", "rplc", "selc", "thrs", "vibA",
];

describe("ui/filter-panels/adjustment-panels.js", () => {
  it("registers every adjustment panel constructor", () => {
    for (const key of ADJUSTMENT_PANEL_KEYS) {
      assert.equal(typeof FilterParameterPanel[key], "function", key);
    }
  });

  it("brit setFields/getFields golden", () => {
    const panel = new FilterParameterPanel.brit();
    const descriptor = FilterDefs.create("brit");
    descriptor.Brgh.v = 12;
    descriptor.Cntr.v = -5;
    descriptor.useLegacy.v = true;
    const values = [0, 0, false];
    panel.setFields(descriptor, values);
    assert.deepEqual(values, [12, -5, true]);
    const out = FilterDefs.create("brit");
    panel.getFields(out, values);
    assert.equal(out.Brgh.v, 12);
    assert.equal(out.Cntr.v, -5);
    assert.equal(out.useLegacy.v, true);
  });

  it("fade / vibA / thrs / post / expA field goldens", () => {
    const fade = new FilterParameterPanel.fade();
    const fadeDesc = FilterDefs.create("fade");
    fadeDesc.Opct.v.val = 42;
    fadeDesc.Md.v.blendMode = BlendModes.psdNames[3];
    const fadeValues = [0, 0];
    fade.setFields(fadeDesc, fadeValues);
    assert.deepEqual(fadeValues, [42, 3]);
    assert.equal(BlendModes.psdNames[3], "Mltp");
    const fadeOut = FilterDefs.create("fade");
    fade.getFields(fadeOut, fadeValues);
    assert.equal(fadeOut.Opct.v.val, 42);
    assert.equal(fadeOut.Md.v.blendMode, "Mltp");

    const vib = new FilterParameterPanel.vibA();
    const vibDesc = FilterDefs.create("vibA");
    vibDesc.vibrance.v = 7;
    vibDesc.Strt.v = -3;
    const vibValues = [0, 0];
    vib.setFields(vibDesc, vibValues);
    assert.deepEqual(vibValues, [7, -3]);

    const thrs = new FilterParameterPanel.thrs();
    const thrsDesc = FilterDefs.create("thrs");
    thrsDesc.Lvl.v = 128;
    const thrsValues = [0];
    thrs.setFields(thrsDesc, thrsValues);
    assert.deepEqual(thrsValues, [128]);

    const post = new FilterParameterPanel.post();
    const postDesc = FilterDefs.create("post");
    postDesc.Lvls.v = 8;
    const postValues = [0];
    post.setFields(postDesc, postValues);
    assert.deepEqual(postValues, [8]);

    const exp = new FilterParameterPanel.expA();
    const expDesc = FilterDefs.create("expA");
    expDesc.Exps.v = 1.5;
    expDesc.Ofst.v = -0.1;
    expDesc.gammaCorrection.v = 1.2;
    const expValues = [0, 0, 0];
    exp.setFields(expDesc, expValues);
    assert.deepEqual(expValues, [1.5, -0.1, 1.2]);
  });

  it("blwh / phfl / blnc / mixr / overlay goldens", () => {
    const blwh = new FilterParameterPanel.blwh();
    const blwhDesc = FilterDefs.create("blwh");
    blwhDesc.useTint.v = true;
    const channelKeys = ["Rd", "Yllw", "Grn", "Cyn", "Bl", "Mgnt"];
    for (let i = 0; i < 6; i++) blwhDesc[channelKeys[i]].v = 10 + i;
    const blwhValues = new Array(8).fill(0);
    blwh.setFields(blwhDesc, blwhValues);
    assert.equal(blwhValues[0], true);
    assert.equal(blwhValues[1].classID, "RGBC");
    assert.deepEqual(blwhValues.slice(2), [10, 11, 12, 13, 14, 15]);

    const phfl = new FilterParameterPanel.phfl();
    const phflDesc = FilterDefs.create("phfl");
    phflDesc.Dnst.v = 33;
    phflDesc.PrsL.v = false;
    const phflValues = [null, 0, true];
    phfl.setFields(phflDesc, phflValues);
    assert.equal(phflValues[1], 33);
    assert.equal(phflValues[2], false);
    assert.equal(phflValues[0].classID, "LbCl");

    const blnc = new FilterParameterPanel.blnc();
    const bal = FilterDefs.create("blnc");
    bal.ShdL.v[0].v = 11;
    bal.ShdL.v[1].v = -7;
    bal.ShdL.v[2].v = 3;
    bal.PrsL.v = true;
    blnc.setValue(bal);
    assert.deepEqual(blnc.rgbInputs.map((input) => input.getValue()), [11, -7, 3]);
    assert.equal(blnc.preserveLuminosityCheckbox.getValue(), true);
    const balOut = blnc.getValue();
    assert.deepEqual(balOut.ShdL.v.map((entry) => entry.v), [11, -7, 3]);
    assert.equal(balOut.PrsL.v, true);

    const mixr = new FilterParameterPanel.mixr();
    mixr.setValue(FilterDefs.create("mixr"));
    mixr.redraw();
    assert.equal(mixr.monochromaticCheckbox.getValue(), false);
    assert.deepEqual(mixr.channelMixInputs.map((input) => input.getValue()), [100, 0, 0, 0]);

    assert.equal(FilterParameterPanel.curv.prototype.hasOverlay(), true);
    assert.equal(FilterParameterPanel.hue2.prototype.hasOverlay(), true);
    assert.equal(FilterParameterPanel.levl.prototype.hasOverlay(), true);

    const rplc = new FilterParameterPanel.rplc();
    const rplcDesc = FilterDefs.create("rplc");
    const rplcValues = [0, null, 0, 0, 0];
    rplc.setFields(rplcDesc, rplcValues);
    assert.equal(rplcValues[0], 55);
    assert.equal(rplcValues[2], -22);
    assert.equal(rplcValues[3], 100);
    assert.equal(rplcValues[4], 2);
    assert.equal(rplcValues[1].classID, "LbCl");
  });
});
