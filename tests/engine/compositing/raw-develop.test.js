/**
 * RAW develop: what a camera file looks like once decoded.
 *
 * Sensor data is scene-linear, so rendering it needs a tone curve as well as a
 * colour transform — without one the picture comes out flat and dark. These
 * tests drive the real develop path over a synthetic neutral ramp, using a
 * camera profile taken from the shipped database.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { developRaw, estimateIlluminant } from "../../../src/engine/compositing/raw-functions.js";
import { CAMERA_DATABASE } from "../../../src/engine/compositing/raw-camera-db.js";
import { planckianLocusFromChromaticity } from "../../../src/engine/compositing/color-temperature.js";

/** sRGB encode, for comparing against a plain gamma curve. */
function linearToSrgb(channel) {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** Camera metadata as the decoder assembles it for a Canon CR2. */
function canonMetadata() {
  const profile = CAMERA_DATABASE["canon eos rebel sl2"];
  return {
    t50723: profile[0].map((coefficient) => coefficient / 10000),
    // Camera multipliers relative to green, a typical daylight capture.
    t50728: [0.52, 1.0, 0.63],
  };
}

/**
 * Render a ramp of neutral camera values and return the 0-255 grey each
 * linear level lands on.
 */
function renderNeutralRamp(metadata, levels) {
  const decoded = {
    linearRgbBuffer: new Float32Array(levels.length * 3),
    rawWidth: levels.length,
    rawHeight: 1,
  };
  for (let i = 0; i < levels.length; i++) {
    decoded.linearRgbBuffer[i * 3] = levels[i] * metadata.t50728[0];
    decoded.linearRgbBuffer[i * 3 + 1] = levels[i] * metadata.t50728[1];
    decoded.linearRgbBuffer[i * 3 + 2] = levels[i] * metadata.t50728[2];
  }
  const illuminant = estimateIlluminant(metadata);
  const asShot = planckianLocusFromChromaticity(illuminant);
  const rendered = new Uint8Array(levels.length * 4);
  developRaw(decoded, rendered, metadata, [
    asShot.correlatedColorTemp,
    asShot.tintBias,
    0,
    0,
  ]);
  const greys = [];
  for (let i = 0; i < levels.length; i++) greys.push(rendered[i * 4]);
  return greys;
}

describe("engine/compositing raw develop", () => {
  let metadata;

  before(() => {
    metadata = canonMetadata();
  });

  it("renders a neutral capture neutral", () => {
    const decoded = { linearRgbBuffer: new Float32Array([0.5 * 0.52, 0.5, 0.5 * 0.63]) };
    const illuminant = estimateIlluminant(metadata);
    const asShot = planckianLocusFromChromaticity(illuminant);
    const rendered = new Uint8Array(4);
    developRaw(decoded, rendered, metadata, [
      asShot.correlatedColorTemp, asShot.tintBias, 0, 0,
    ]);
    assert.ok(
      Math.abs(rendered[0] - rendered[1]) <= 1 && Math.abs(rendered[1] - rendered[2]) <= 1,
      `expected a grey, got ${rendered[0]},${rendered[1]},${rendered[2]}`,
    );
  });

  it("as-shot white balance lands in daylight, not at an extreme", () => {
    const illuminant = estimateIlluminant(metadata);
    const asShot = planckianLocusFromChromaticity(illuminant);
    assert.ok(
      asShot.correlatedColorTemp > 4000 && asShot.correlatedColorTemp < 8000,
      `daylight capture solved to ${Math.round(asShot.correlatedColorTemp)} K`,
    );
    assert.ok(Math.abs(asShot.tintBias) < 60, `tint ${Math.round(asShot.tintBias)} is off the locus`);
  });

  it("lifts scene-linear data rather than only gamma-encoding it", () => {
    // Raw is scene-linear and unreadably dark through a plain gamma encode. The
    // baseline curve holds black, keeps a short toe under the deepest shadows,
    // then lifts hard from the low shadows up through the midtones.
    const levels = [0, 0.02, 0.05, 0.1, 0.3, 1];
    const rendered = renderNeutralRamp(metadata, levels);
    const plainGamma = levels.map((level) => Math.round(255 * linearToSrgb(level)));

    assert.equal(rendered[0], 0, "black should stay black");
    assert.ok(rendered[5] >= 250, `white should stay white, got ${rendered[5]}`);
    assert.ok(rendered[1] < plainGamma[1], "the deepest shadows sit under the toe");
    assert.ok(rendered[2] > plainGamma[2] + 5, "shadows should be lifted above a plain gamma encode");
    assert.ok(rendered[3] > plainGamma[3] + 30, "low midtones should be lifted hard");
    assert.ok(rendered[4] > plainGamma[4] + 40, "midtones should be lifted hard");
  });

  it("reaches display white before sensor saturation, leaving highlight headroom", () => {
    // The shoulder tops out early on purpose: the gap between where the curve
    // reaches white and where the sensor clips is what highlight recovery has
    // left to pull back.
    const levels = [0.7, 0.8, 0.9, 1];
    const rendered = renderNeutralRamp(metadata, levels);
    assert.ok(rendered[1] >= 253, `saturation headroom should already be white by 0.8, got ${rendered[1]}`);
    assert.ok(rendered[0] < 253, "0.7 of saturation should not be clipped yet");
  });

  it("the rendered ramp never doubles back on itself", () => {
    const levels = [];
    for (let i = 0; i <= 64; i++) levels.push(i / 64);
    const rendered = renderNeutralRamp(metadata, levels);
    for (let i = 1; i < rendered.length; i++) {
      assert.ok(
        rendered[i] >= rendered[i - 1],
        `level ${levels[i].toFixed(3)} rendered darker than the level below it`,
      );
    }
  });
});
