/**
 * lens profile matching and interpolation.
 *
 * A photograph almost never lands exactly on a measured focal length or
 * aperture, and camera bodies write their own and their lenses' names
 * inconsistently. These are the two places that has to be absorbed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entryExifMaker,
  interpolateDistortion,
  interpolateTca,
  interpolateVignetting,
  lensCoversFocalLength,
  listCameraMakers,
  listCameras,
  listLenses,
  matchCamera,
  matchLens,
  matchProfileFromMetadata,
} from "../../../src/features/filters/lens-profile.js";

/** A database shaped like the generated one, small enough to reason about. */
const database = {
  distortionModels: ["poly3", "poly5", "ptlens"],
  cameras: [
    // Nikon writes a different EXIF maker for its SLRs than for its compacts;
    // both are the same brand to somebody reading a list.
    { maker: "Nikon", exifMaker: "Nikon Corporation", model: "Nikon D5100",
      mount: "Nikon F AF", cropFactor: 1.5 },
    { maker: "Nikon", model: "Coolpix P340", mount: "nikonP340", cropFactor: 4.66 },
    { maker: "Canon", model: "Canon EOS 5D Mark III", mount: "Canon EF", cropFactor: 1 },
    { maker: "Canon", model: "Canon EOS 200D", mount: "Canon EF-S", cropFactor: 1.613 },
    { maker: "Apple", model: "iPhone XS", mount: "iPhoneXS", cropFactor: 6.118 },
  ],
  lenses: [
    {
      maker: "Canon", model: "Canon EF 24-70mm f/2.8L II USM",
      mount: "Canon EF", cropFactor: 1, aspectRatio: 1.5,
      // ptlens at both ends, so a focal in between blends coefficients.
      distortion: [[24, 2, 0.02, -0.06, 0.05], [70, 2, 0.006, -0.02, 0.01]],
      tca: [[24, -0.000002, 0, 1.0003, 0.000012, 0, 1.0001],
            [70, 0.000006, 0, 1.0001, -0.000004, 0, 1.0002]],
      vignetting: [
        [24, 2.8, 1000, -2.0, 2.6, -1.2], [24, 8, 1000, -0.6, 0.05, 0.02],
        [70, 2.8, 1000, -1.4, 1.8, -0.8], [70, 8, 1000, -0.3, 0.02, 0.01],
        // A near-focus set that must be ignored in favour of the far one.
        [24, 2.8, 0.5, -9, -9, -9], [70, 8, 0.5, -9, -9, -9],
      ],
    },
    {
      maker: "Canon", model: "Canon EF-S 10-22mm f/3.5-4.5 USM",
      mount: "Canon EF-S", cropFactor: 1.613, aspectRatio: 1.5,
      // Different models at the two ends: blending them would be meaningless.
      distortion: [[10, 2, 0.019, -0.068, 0.051], [22, 0, 0.004, 0, 0]],
    },
    {
      maker: "Apple", model: "iPhone XS back camera 4.25mm f/1.8 & compatibles",
      mount: "iPhoneXS", cropFactor: 6.118, aspectRatio: 1.333,
      aliases: ["fixed lens"],
      distortion: [[4.25, 0, 0.011, 0, 0]],
    },
  ],
};

describe("features/filters/lens-profile.js matching", () => {
  it("matches a camera whether or not the model repeats the maker", () => {
    assert.equal(
      matchCamera(database, { maker: "Canon", model: "Canon EOS 5D Mark III" }).cropFactor, 1);
    assert.equal(
      matchCamera(database, { maker: "Canon", model: "EOS 5D Mark III" }).model,
      "Canon EOS 5D Mark III", "a bare model should still resolve via the maker");
    assert.equal(matchCamera(database, { maker: "Canon", model: "EOS 9999D" }), null);
    assert.equal(matchCamera(database, {}), null);
  });

  it("only offers lenses the body can mount", () => {
    const body = matchCamera(database, { maker: "Canon", model: "Canon EOS 200D" });
    const offered = listLenses(database, body).map((lens) => lens.model);
    assert.deepEqual(offered, ["Canon EF-S 10-22mm f/3.5-4.5 USM"]);
  });

  it("matches a lens by name, and tolerates the padding bodies add", () => {
    const body = matchCamera(database, { maker: "Canon", model: "Canon EOS 5D Mark III" });
    assert.equal(
      matchLens(database, { lens: "Canon EF 24-70mm f/2.8L II USM" }, body).cropFactor, 1);
    assert.equal(
      matchLens(database, { lens: "EF24-70mm f/2.8L II USM" }, body), null,
      "a name that is not a substring either way should not be forced to match");
    assert.equal(
      matchLens(database, { lens: "Canon EF 24-70mm f/2.8L II USM (at 35mm)" }, body).model,
      "Canon EF 24-70mm f/2.8L II USM");
  });

  it("resolves a fixed-lens body even when the file names no lens", () => {
    const phone = matchCamera(database, { maker: "Apple", model: "iPhone XS" });
    const lens = matchLens(database, {}, phone);
    assert.ok(lens && lens.model.startsWith("iPhone XS back camera"));
  });

  it("will not let a generic alias match across mounts", () => {
    // "fixed lens" belongs to the phone; a Canon body must never land on it.
    const body = matchCamera(database, { maker: "Canon", model: "Canon EOS 5D Mark III" });
    assert.notEqual(matchLens(database, { lens: "fixed lens" }, body), null === null ? undefined : null);
    const matched = matchLens(database, { lens: "fixed lens" }, body);
    assert.ok(!matched || matched.mount === "Canon EF");
  });

  it("reads camera, lens and shooting settings out of document metadata", () => {
    const resolved = matchProfileFromMetadata(database, {
      "tiff:Make": "Canon",
      "tiff:Model": "Canon EOS 5D Mark III",
      "exif:Lens": "Canon EF 24-70mm f/2.8L II USM",
      "exif:FocalLength": [50, 1],
      "exif:FNumber": [4, 1],
    });
    assert.equal(resolved.camera.model, "Canon EOS 5D Mark III");
    assert.equal(resolved.lens.model, "Canon EF 24-70mm f/2.8L II USM");
    assert.equal(resolved.focalLength, 50);
    assert.equal(resolved.aperture, 4);
  });
});

describe("features/filters/lens-profile.js interpolation", () => {
  const zoom = database.lenses[0];

  it("blends coefficients between the focal lengths either side", () => {
    const midway = interpolateDistortion(zoom, 47);
    assert.equal(midway.model, 2);
    assert.ok(Math.abs(midway.c0 - 0.013) < 0.0005, `got ${midway.c0}`);
    const wide = interpolateDistortion(zoom, 24);
    assert.ok(Math.abs(wide.c0 - 0.02) < 1e-9, "an exact match should not drift");
  });

  it("clamps outside the measured range instead of extrapolating", () => {
    assert.deepEqual(interpolateDistortion(zoom, 10), interpolateDistortion(zoom, 24));
    assert.deepEqual(interpolateDistortion(zoom, 300), interpolateDistortion(zoom, 70));
  });

  it("takes the nearer measurement when the two use different models", () => {
    const ultraWide = database.lenses[1];
    assert.equal(interpolateDistortion(ultraWide, 11).model, 2, "near 10mm, ptlens");
    assert.equal(interpolateDistortion(ultraWide, 21).model, 0, "near 22mm, poly3");
  });

  it("interpolates chromatic aberration across focal length", () => {
    const midway = interpolateTca(zoom, 47);
    assert.ok(midway.redV > 1.0001 && midway.redV < 1.0003);
    assert.equal(interpolateTca({ tca: null }, 47), null);
  });

  it("interpolates vignetting over focal length and aperture, at the far distance", () => {
    const wideOpen = interpolateVignetting(zoom, 24, 2.8);
    assert.ok(Math.abs(wideOpen.k1 + 2.0) < 1e-9, "should take the 1000-unit distance, not 0.5");
    const stoppedDown = interpolateVignetting(zoom, 24, 8);
    assert.ok(Math.abs(stoppedDown.k1 + 0.6) < 1e-9);
    // Between both axes, and always weaker than wide open.
    const between = interpolateVignetting(zoom, 47, 5.6);
    assert.ok(between.k1 > wideOpen.k1 && between.k1 < stoppedDown.k1);
  });

  it("returns nothing when a lens carries no measurements of that kind", () => {
    const ultraWide = database.lenses[1];
    assert.equal(interpolateTca(ultraWide, 15), null);
    assert.equal(interpolateVignetting(ultraWide, 15, 5.6), null);
  });
});

describe("features/filters/lens-profile.js browsing", () => {
  it("shows one brand where the EXIF strings disagree", () => {
    const makers = listCameraMakers(database);
    assert.equal(makers.filter((maker) => /nikon/i.test(maker)).length, 1,
      "an SLR and a compact should not appear as two Nikons");
    assert.deepEqual(
      listCameras(database, "Nikon").map((camera) => camera.model).sort(),
      ["Coolpix P340", "Nikon D5100"]);
  });

  it("lists the brand but still identifies a body by what it writes", () => {
    const body = matchCamera(database, {
      maker: "NIKON CORPORATION", model: "NIKON D5100",
    });
    assert.ok(body, "the verbose EXIF maker must still identify the body");
    assert.equal(body.maker, "Nikon", "the listed maker is the brand");
    assert.equal(entryExifMaker(body), "Nikon Corporation");
    assert.equal(entryExifMaker({ maker: "Canon" }), "Canon",
      "with nothing else recorded, the brand is what the file says");
  });

  it("will not match a model across brands", () => {
    // Model strings are mostly unique, but the maker is a free extra check.
    assert.equal(
      matchCamera(database, { maker: "Canon", model: "Nikon D5100" }), null);
    assert.ok(
      matchCamera(database, { model: "Nikon D5100" }),
      "a file with no maker recorded should still resolve");
  });

  it("rules out lenses that cannot reach the focal length of the shot", () => {
    const zoom = database.lenses[0];        // 24-70mm
    const ultraWide = database.lenses[1];   // 10-22mm
    const prime = database.lenses[2];       // 4.25mm, a single measurement
    assert.equal(lensCoversFocalLength(zoom, 52), true);
    assert.equal(lensCoversFocalLength(ultraWide, 52), false, "a 10-22 cannot shoot at 52mm");
    assert.equal(lensCoversFocalLength(ultraWide, 15), true);
    assert.equal(lensCoversFocalLength(prime, 4.25), true, "a prime covers its own focal length");
    assert.equal(lensCoversFocalLength(prime, 24), false);
    assert.equal(lensCoversFocalLength(zoom, 0), true, "with no focal length recorded, keep everything");
    assert.equal(lensCoversFocalLength({ }, 52), true, "an unmeasured lens cannot be ruled out");
  });
});
