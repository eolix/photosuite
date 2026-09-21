/**
 * number-inputs angle grid math goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let gridIndexToCell;
let pointerCssToGridIndex;
let buildAngleGridLinePositions;
let AngleInput;
let RangeInput;
let SliderDropdown;
let TextRangeInput;

before(async () => {
  ({
    gridIndexToCell,
    pointerCssToGridIndex,
    buildAngleGridLinePositions,
    AngleInput,
    RangeInput,
    SliderDropdown,
    TextRangeInput
  } = await import("../../../../src/ui/widgets/controls/number-inputs.js"));
});

/** Give a stub element a fixed layout box; the stub DOM has no layout engine. */
function stubRect(el, box) {
  el.getBoundingClientRect = () => ({
    left: box.left,
    right: box.right,
    top: box.bottom - 20,
    bottom: box.bottom,
    width: box.right - box.left,
    height: 20,
  });
}

/** Run `action` and return the single event the widget bubbled to its parent. */
function captureDispatch(widget, action) {
  let captured = null;
  widget.parent = { dispatch: (evt) => { captured = evt; } };
  action();
  return captured;
}

describe("ui/widgets/controls/number-inputs.js", () => {
  it("gridIndexToCell goldens", () => {
    assert.deepEqual(gridIndexToCell(0), { col: 0, row: 0 });
    assert.deepEqual(gridIndexToCell(5), { col: 1, row: 2 });
    assert.deepEqual(gridIndexToCell(8), { col: 2, row: 2 });
  });

  it("pointerCssToGridIndex goldens", () => {
    assert.equal(pointerCssToGridIndex(0, 0, 30), 0);
    assert.equal(pointerCssToGridIndex(10, 0, 30), 1);
    assert.equal(pointerCssToGridIndex(0, 10, 30), 3);
    assert.equal(pointerCssToGridIndex(29, 29, 30), 8);
    assert.equal(pointerCssToGridIndex(100, 100, 30), 8);
  });

  it("buildAngleGridLinePositions golden", () => {
    assert.deepEqual(buildAngleGridLinePositions(30), [0.5, 10.5, 20.5, 29.5]);
  });

  it("exports constructors", () => {
    assert.equal(typeof AngleInput, "function");
    assert.equal(typeof RangeInput, "function");
    assert.equal(typeof SliderDropdown, "function");
    assert.equal(typeof TextRangeInput, "function");
  });

  it("SliderDropdown anchors its slider to the field, not the labelled row", () => {
    const slider = new SliderDropdown("properties.size", 0, 100, "px");
    // The row starts at its label, so anchoring there would leave the slider
    // hanging to the left of the field it drives.
    stubRect(slider.el, { left: 200, right: 320, bottom: 40 });
    stubRect(slider.inputEl, { left: 240, right: 300, bottom: 38 });
    stubRect(slider.rangeToggleButton, { left: 300, right: 320, bottom: 38 });

    const opened = captureDispatch(slider, () =>
      slider.onOpenRangeOverlay({ stopPropagation() {} }),
    );

    assert.equal(opened.data.x, 240, "anchored to the input, not the row");
    assert.equal(opened.data.y, 42, "sits just below the row");
    assert.equal(opened.data.overlayWidget, slider.rangeOverlayWidget);
    // Clamped inside the window by the overlay manager once measured.
    assert.equal(opened.data.measureForPosition, true);
  });

  it("SliderDropdown keeps a usable track under a narrow field", () => {
    const slider = new SliderDropdown("properties.size", 0, 100, "px");
    stubRect(slider.el, { left: 0, right: 60, bottom: 20 });
    stubRect(slider.inputEl, { left: 10, right: 40, bottom: 18 });
    stubRect(slider.rangeToggleButton, { left: 40, right: 55, bottom: 18 });

    // The stub DOM keeps no style attribute, so watch the write instead.
    let trackStyle = null;
    slider.rangeEl.setAttribute = (name, value) => {
      if (name === "style") trackStyle = value;
    };

    captureDispatch(slider, () => slider.onOpenRangeOverlay({ stopPropagation() {} }));

    // The field spans 45px; the track floors well above that so the slider
    // stays draggable.
    assert.equal(trackStyle, "width:116px;");
  });
});
