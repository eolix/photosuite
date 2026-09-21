/**
 * Camera Raw filter: descriptor shape, and the develop behaviour the dialog's
 * controls promise — every panel switch removes its panel's effect completely,
 * and each slider moves the image in the direction its label claims.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAMERA_RAW_MODE_RAW,
  CAMERA_RAW_SECTIONS,
  listCameraRawSliderSpecs,
  CAMERA_RAW_WIRE_CLASS_ID,
  RAW_SLIDER_RANGES,
  RAW_WHITE_BALANCE_PRESETS,
  collectCameraRawScalars,
  createCameraRawDefaultDescriptor,
  normalizeCameraRawClassId,
  readScalar,
} from "../../../src/features/filters/camera-raw-descriptor.js";
import { applyCameraRawFilter } from "../../../src/features/filters/camera-raw-apply.js";
import {
  buildCalibrationMatrix,
  buildWhiteBalanceMatrix,
  estimateTemperatureAndTintFromNeutral,
} from "../../../src/features/filters/camera-raw-color.js";

function makeRect(width, height) {
  return { width, height, x: 0, y: 0, clone() { return { ...this }; } };
}

/** A small colour field: every pixel a different hue and brightness. */
function makeColourfulPlate(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    pixels[pixel * 4] = (pixel * 37) % 256;
    pixels[pixel * 4 + 1] = (pixel * 91) % 256;
    pixels[pixel * 4 + 2] = (pixel * 13) % 256;
    pixels[pixel * 4 + 3] = 255;
  }
  return pixels;
}

function develop(source, width, height, mutateDescriptor) {
  const descriptor = createCameraRawDefaultDescriptor();
  if (mutateDescriptor) mutateDescriptor(descriptor);
  const dest = new Uint8Array(source.length);
  const rect = makeRect(width, height);
  applyCameraRawFilter(
    "cameraRaw",
    { buffer: source, rect },
    descriptor,
    null,
    null,
    { buffer: dest, rect },
  );
  return dest;
}

function countDifferences(a, b) {
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) differing++;
  }
  return differing;
}

/** Mean of one channel across the buffer. */
function channelMean(pixels, channel) {
  let total = 0;
  for (let offset = channel; offset < pixels.length; offset += 4) total += pixels[offset];
  return total / (pixels.length / 4);
}

describe("camera-raw-descriptor", () => {
  it("defaults carry the Adobe class id and start every panel switched on", () => {
    const descriptor = createCameraRawDefaultDescriptor();
    assert.equal(descriptor.classID, CAMERA_RAW_WIRE_CLASS_ID);
    assert.equal(normalizeCameraRawClassId(CAMERA_RAW_WIRE_CLASS_ID), "cameraRaw");
    assert.equal(descriptor.WBal.v.WBal, "AsSh");
    for (const section of CAMERA_RAW_SECTIONS) {
      assert.equal(readScalar(descriptor, section.enableKey, null), true, section.id);
    }
  });

  it("every slider the dialog builds has a default in the descriptor", () => {
    const descriptor = createCameraRawDefaultDescriptor();
    const scalars = collectCameraRawScalars(descriptor);
    for (const section of CAMERA_RAW_SECTIONS) {
      for (const group of section.groups || []) {
        for (const slider of group.sliders) {
          assert.notEqual(scalars[slider.key], undefined, section.id + "/" + slider.key);
          assert.ok(
            scalars[slider.key] >= slider.min && scalars[slider.key] <= slider.max,
            slider.key + " default outside its range",
          );
        }
      }
    }
  });

  it("camera files retune Temperature to kelvin and keep every preset in range", () => {
    assert.equal(RAW_SLIDER_RANGES.Temp.min, 2000);
    assert.equal(RAW_SLIDER_RANGES.Tint.min, -150);
    for (const name in RAW_WHITE_BALANCE_PRESETS) {
      const [temperature, tint] = RAW_WHITE_BALANCE_PRESETS[name];
      assert.ok(
        temperature >= RAW_SLIDER_RANGES.Temp.min && temperature <= RAW_SLIDER_RANGES.Temp.max,
        name + " temperature outside the slider range",
      );
      assert.ok(
        tint >= RAW_SLIDER_RANGES.Tint.min && tint <= RAW_SLIDER_RANGES.Tint.max,
        name + " tint outside the slider range",
      );
    }
  });

  it("Calibration matches the Camera Raw panel: a shadow tint and three primaries", () => {
    const calibration = CAMERA_RAW_SECTIONS.find((section) => section.id === "calibration");
    assert.deepEqual(
      calibration.groups.map((group) => group.heading),
      ["Shadows", "Red Primary", "Green Primary", "Blue Primary"],
    );
    assert.deepEqual(
      calibration.groups.map((group) => group.sliders.map((slider) => slider.label)),
      [["Tint"], ["Hue", "Saturation"], ["Hue", "Saturation"], ["Hue", "Saturation"]],
    );
    assert.deepEqual(
      calibration.groups[1].sliders.map((slider) => slider.key),
      ["RHue", "RSat"],
    );
  });
});

describe("camera-raw-color", () => {
  it("a zeroed slider pair is an identity transform, not a near-identity one", () => {
    assert.equal(buildWhiteBalanceMatrix(0, 0), null);
    assert.equal(buildCalibrationMatrix([0, 0, 0], [0, 0, 0]), null);
  });

  it("positive temperature warms and positive tint pushes magenta", () => {
    const grey = 0.2;
    const warm = [0, 0, 0];
    const tinted = [0, 0, 0];
    const warmMatrix = buildWhiteBalanceMatrix(60, 0);
    const tintMatrix = buildWhiteBalanceMatrix(0, 60);
    for (let i = 0; i < 3; i++) {
      warm[i] = warmMatrix[i * 3] * grey + warmMatrix[i * 3 + 1] * grey + warmMatrix[i * 3 + 2] * grey;
      tinted[i] = tintMatrix[i * 3] * grey + tintMatrix[i * 3 + 1] * grey + tintMatrix[i * 3 + 2] * grey;
    }
    assert.ok(warm[0] > warm[2], "warm: red should exceed blue");
    assert.ok(tinted[0] > tinted[1] && tinted[2] > tinted[1], "magenta: green should be lowest");
  });

  it("the eyedropper recovers a slider pair that neutralises the sample", () => {
    const warm = buildWhiteBalanceMatrix(40, 15);
    const grey = 0.25;
    const sampled = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      sampled[i] = warm[i * 3] * grey + warm[i * 3 + 1] * grey + warm[i * 3 + 2] * grey;
    }
    const encoded = sampled.map((v) => Math.pow(Math.max(0, v), 1 / 2.2));
    const recovered = estimateTemperatureAndTintFromNeutral(encoded[0], encoded[1], encoded[2]);
    // The sample was warmed, so neutralising it must cool the image back down.
    assert.ok(recovered.temperature < -10, `expected a cooling correction, got ${recovered.temperature}`);
  });
});

describe("camera-raw-apply", () => {
  const width = 16;
  const height = 16;
  const plate = makeColourfulPlate(width, height);

  it("leaves the image untouched at defaults", () => {
    assert.equal(countDifferences(develop(plate, width, height), plate), 0);
  });

  it("a switched-off panel removes its effect completely", () => {
    for (const section of CAMERA_RAW_SECTIONS) {
      const developed = develop(plate, width, height, (descriptor) => {
        // Push every slider in this panel hard, then switch the panel off.
        for (const group of section.groups || []) {
          for (const slider of group.sliders) {
            descriptor[slider.key] = { t: "long", v: Math.round(slider.max * 0.8) };
          }
        }
        if (section.id === "geometry") descriptor.PerU = { t: "long", v: 4 };
        descriptor[section.enableKey] = { t: "bool", v: false };
      });
      assert.equal(countDifferences(developed, plate), 0, section.id + " leaked with its switch off");
    }
  });

  /**
   * Controls that only shape another slider's effect, so they do nothing on
   * their own: grain has no size or roughness until there is grain, and a split
   * tone has no hue or balance until one of its halves has saturation.
   */
  const MODIFIER_ONLY_KEYS = ["GrainSize", "GrainFrequency", "STHH", "STSH", "STB"];

  it("every slider on its own changes the image", () => {
    // The develop pass skips itself outright when nothing has been asked for,
    // so a slider missing from that check would silently stop working.
    for (const spec of listCameraRawSliderSpecs()) {
      if (MODIFIER_ONLY_KEYS.indexOf(spec.key) !== -1) continue;
      const moved = develop(plate, width, height, (descriptor) => {
        descriptor[spec.key] = { t: "long", v: Math.round(spec.max * 0.8) };
      });
      assert.ok(countDifferences(moved, plate) > 0, spec.key + " did nothing on its own");
    }
  });

  it("exposure brightens and darkens without a dead zone at low settings", () => {
    const brighter = develop(plate, width, height, (d) => { d.Ex12 = { t: "doub", v: 1 }; });
    const darker = develop(plate, width, height, (d) => { d.Ex12 = { t: "doub", v: -1 }; });
    assert.ok(channelMean(brighter, 0) > channelMean(plate, 0));
    assert.ok(channelMean(darker, 0) < channelMean(plate, 0));
  });

  it("a one-point contrast change is a one-point change, not a jump", () => {
    const nudged = develop(plate, width, height, (d) => { d.Cr12 = { t: "long", v: 1 }; });
    let largest = 0;
    for (let i = 0; i < plate.length; i++) {
      largest = Math.max(largest, Math.abs(nudged[i] - plate[i]));
    }
    assert.ok(largest <= 2, `contrast +1 moved a channel by ${largest}`);
  });

  it("temperature is a colour control, not a hidden exposure control", () => {
    const warmed = develop(plate, width, height, (d) => { d.Temp = { t: "long", v: 60 }; });
    const beforeLuma =
      channelMean(plate, 0) * 0.2126 + channelMean(plate, 1) * 0.7152 + channelMean(plate, 2) * 0.0722;
    const afterLuma =
      channelMean(warmed, 0) * 0.2126 + channelMean(warmed, 1) * 0.7152 + channelMean(warmed, 2) * 0.0722;
    assert.ok(channelMean(warmed, 0) > channelMean(plate, 0), "warming should raise red");
    assert.ok(
      Math.abs(afterLuma - beforeLuma) < beforeLuma * 0.12,
      `overall brightness moved ${afterLuma - beforeLuma} while only the temperature changed`,
    );
  });

  it("colour noise reduction is continuous as it leaves zero", () => {
    const barelyOn = develop(plate, width, height, (d) => { d.CNR = { t: "long", v: 1 }; });
    let largest = 0;
    for (let i = 0; i < plate.length; i++) largest = Math.max(largest, Math.abs(barelyOn[i] - plate[i]));
    assert.ok(largest <= 4, `colour noise reduction at 1 moved a channel by ${largest}`);
  });

  it("a mixer band moves its own hues and leaves the others alone", () => {
    const reddened = develop(plate, width, height, (d) => { d.SA_R = { t: "long", v: 100 }; });
    assert.ok(countDifferences(reddened, plate) > 0, "the red band should do something");
    const untouched = develop(plate, width, height, (d) => {
      d.SA_R = { t: "long", v: 100 };
      d.EnableColorAdjustments = { t: "bool", v: false };
    });
    assert.equal(countDifferences(untouched, plate), 0);
  });

  it("a camera file leaves white balance and exposure to the decoder", () => {
    // The decoder has already spent the highlight headroom on these two, so the
    // raster stage must not apply them a second time.
    const asRaw = develop(plate, width, height, (d) => {
      d.CMod = { t: "TEXT", v: CAMERA_RAW_MODE_RAW };
      d.Temp = { t: "long", v: 8000 };
      d.Tint = { t: "long", v: 40 };
      d.Ex12 = { t: "doub", v: 2 };
    });
    assert.equal(countDifferences(asRaw, plate), 0);
  });

  it("a camera file still runs every stage below exposure", () => {
    const asRaw = develop(plate, width, height, (d) => {
      d.CMod = { t: "TEXT", v: CAMERA_RAW_MODE_RAW };
      d.Cr12 = { t: "long", v: 60 };
    });
    assert.ok(countDifferences(asRaw, plate) > 0, "contrast should still apply to a camera file");
  });

  it("the calibration shadow tint acts on shadows, not on highlights", () => {
    const shadow = new Uint8Array([20, 20, 20, 255, 235, 235, 235, 255]);
    const tinted = develop(shadow, 2, 1, (d) => { d.ShdT = { t: "long", v: 100 }; });
    assert.ok(tinted[0] > shadow[0], "shadow should pick up magenta");
    assert.ok(tinted[1] < shadow[1], "shadow green should drop");
    assert.ok(Math.abs(tinted[4] - shadow[4]) <= 1, "highlight should be left alone");
  });
});
