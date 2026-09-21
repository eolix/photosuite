/**
 * Golden values for TextEngineData editing helpers
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TextEngineData;

before(async () => {
  ({ TextEngineData } = await import("../../../src/features/text/text-engine.js"));
});

describe("features/text/text-engine.js (TextEngineData goldens)", () => {
  it("cloneEngineData starts as a newline point-text layer", () => {
    const engineData = TextEngineData.cloneEngineData();
    assert.equal(TextEngineData.getLayerText(engineData), "\n");
    assert.equal(TextEngineData.getTextType(engineData), 0);
  });

  it("insertText and deleteText update text and run lengths", () => {
    const engineData = TextEngineData.cloneEngineData();
    TextEngineData.insertText(engineData, 0, "Hi");
    assert.equal(TextEngineData.getLayerText(engineData), "Hi\n");
    assert.deepEqual(engineData.EngineDict.StyleRun.RunLengthArray, [3]);
    assert.deepEqual(engineData.EngineDict.ParagraphRun.RunLengthArray, [3]);

    TextEngineData.insertText(engineData, 2, "\nYo");
    assert.equal(TextEngineData.getLayerText(engineData), "Hi\nYo\n");
    assert.deepEqual(engineData.EngineDict.ParagraphRun.RunLengthArray, [3, 3]);
    assert.deepEqual(engineData.EngineDict.StyleRun.RunLengthArray, [6]);

    const deleted = TextEngineData.cloneEngineData();
    TextEngineData.insertText(deleted, 0, "ABCD");
    TextEngineData.deleteText(deleted, 1, 3);
    assert.equal(TextEngineData.getLayerText(deleted), "AD\n");
    assert.deepEqual(deleted.EngineDict.StyleRun.RunLengthArray, [3]);
  });

  it("setAlternateGlyph pins one character to a glyph id", () => {
    const engineData = TextEngineData.cloneEngineData();
    TextEngineData.insertText(engineData, 0, "ABCD");
    // No override yet, so every character shapes through the cmap.
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 0), -1);

    TextEngineData.setAlternateGlyph(engineData, 2, 777);
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 2), 777);
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 1), -1);
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 3), -1);
    // The full-length run split into before / the character / after.
    assert.deepEqual(engineData.EngineDict.AlternateGlyphRun.RunLengthArray, [2, 1, 2]);

    TextEngineData.setAlternateGlyph(engineData, 0, 42);
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 0), 42);
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 2), 777);
    assert.deepEqual(engineData.EngineDict.AlternateGlyphRun.RunLengthArray, [1, 1, 1, 2]);
  });

  it("alternate glyph overrides follow the characters they sit on", () => {
    const engineData = TextEngineData.cloneEngineData();
    TextEngineData.insertText(engineData, 0, "ABCD");
    TextEngineData.setAlternateGlyph(engineData, 2, 777);

    TextEngineData.insertText(engineData, 0, "xy");
    assert.equal(TextEngineData.getLayerText(engineData), "xyABCD\n");
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 4), 777);

    TextEngineData.deleteText(engineData, 0, 2);
    assert.equal(TextEngineData.getLayerText(engineData), "ABCD\n");
    assert.equal(TextEngineData.getAlternateGlyph(engineData, 2), 777);
  });

  it("setTextType / setBoxBounds write Photoshop cookie fields", () => {
    const engineData = TextEngineData.cloneEngineData();
    TextEngineData.setTextType(engineData, 1);
    assert.equal(TextEngineData.getTextType(engineData), 1);
    assert.deepEqual(TextEngineData.getBoxBounds(engineData), [0, 0, 1, 1]);
    TextEngineData.setBoxBounds(engineData, [0, 0, 40, 50]);
    assert.deepEqual(TextEngineData.getBoxBounds(engineData), [0, 0, 40, 50]);
  });

  it("fillColorToRgb maps Type-1 values to h/l/O", () => {
    assert.deepEqual(TextEngineData.fillColorToRgb({ FillColor: { Type: 1, Values: [1, 1, 0, 0] } }), {
      h: 255,
      l: 0,
      O: 0,
    });
    assert.deepEqual(TextEngineData.fillColorToRgb({}), { h: 0, l: 0, O: 0 });
  });

  it("intersectTwoStyles keeps equal nested values", () => {
    assert.deepEqual(
      TextEngineData.intersectTwoStyles({ x: 1, y: { z: 2 }, skip: 3 }, { x: 1, y: { z: 2 }, skip: 9 }),
      { x: 1, y: { z: 2 } },
    );
  });

  it("getJustification flips left/right when paragraph direction is RTL", () => {
    assert.equal(TextEngineData.getJustification({ Justification: 0, _Direction: 1 }), 1);
    assert.equal(TextEngineData.getJustification({ Justification: 0, _Direction: 0 }), 0);
  });

  it("findRunAtChar returns run index and start offset", () => {
    assert.deepEqual(TextEngineData.findRunAtChar([2, 3, 4], 4), { runIdx: 1, runStart: 2 });
  });

  it("createTextLayerData builds TxLr descriptor, warp, and bounds", () => {
    const textShape = TextEngineData.createTextLayerData(10, 20);
    assert.equal(TextEngineData.getAntiAliasMode(textShape), 1);
    assert.equal(textShape.transform.tx, 10);
    assert.equal(textShape.transform.ty, 20);
    assert.equal(textShape.textDescriptor.classID, "TxLr");
    assert.equal(textShape.textDescriptor.AntA.v.Annt, "antiAliasSharp");
    assert.equal(textShape.boundsRect.width, 0);
    assert.equal(textShape.boundsRect.height, 0);
    assert.equal(typeof textShape.warpDescriptor, "object");
  });

  it("getTextStyle exposes fontSet and default 24pt font", () => {
    const engineData = TextEngineData.cloneEngineData();
    const style = TextEngineData.getTextStyle(engineData, 0, 0);
    assert.equal(style.fontSet.length, 3);
    assert.equal(style.textStyle.Font, 0);
    assert.equal(style.textStyle.FontSize, 24);
    TextEngineData.scaleTextStyle(style, 2);
    assert.equal(style.textStyle.FontSize, 48);
  });

  it("createTxLrDescriptor uses PSD TxLr wire keys", () => {
    const descriptor = TextEngineData.createTxLrDescriptor();
    assert.equal(descriptor.classID, "TxLr");
    assert.equal(descriptor.Txt.v, "\0");
    assert.equal(descriptor.Ornt.v.Ornt, "Hrzn");
  });
});
