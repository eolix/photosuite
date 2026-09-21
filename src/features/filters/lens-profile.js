/**
 * Lens correction profiles: loading the measured database, matching a camera
 * and lens to a photograph, and reading the coefficients for the settings it
 * was actually taken at.
 *
 * The database is generated from Lensfun by `src/vendor/js/lensfun/build.sh`;
 * that directory's README documents the models and the two radius conventions
 * they use. This module is only concerned with finding the right row and
 * interpolating between neighbours — the pixels are the applicator's job.
 *
 * Measurements exist at particular focal lengths, and for vignetting at
 * particular apertures and subject distances too. A photograph almost never
 * lands exactly on one, so every lookup interpolates between the neighbours
 * that bracket it and clamps at the ends of the measured range.
 */

/** BINDB key for the generated profile database. */
export const LENS_PROFILE_DATABASE_KEY = "data/lens-profiles";

/** Distortion model ids, matching the `distortionModels` order in the database. */
export const DISTORTION_POLY3 = 0;
export const DISTORTION_POLY5 = 1;
export const DISTORTION_PTLENS = 2;

let loadedDatabase = null;
let pendingLoad = null;

/**
 * The profile database, fetched once and shared. Returns null when it cannot be
 * loaded, which leaves the Auto tab reporting that no profiles are available
 * rather than failing.
 *
 * @param {(url: string) => Promise<Response>} [fetchResource] Injectable for tests.
 * @returns {Promise<object|null>}
 */
export function loadLensProfileDatabase(fetchResource) {
  if (loadedDatabase) return Promise.resolve(loadedDatabase);
  if (pendingLoad) return pendingLoad;
  const url = typeof BINDB !== "undefined" ? BINDB[LENS_PROFILE_DATABASE_KEY] : null;
  if (!url) return Promise.resolve(null);
  const request = fetchResource || ((target) => fetch(target));
  pendingLoad = request(url)
    .then((response) => response.json())
    .then((database) => {
      loadedDatabase = database;
      pendingLoad = null;
      return database;
    })
    .catch(() => {
      pendingLoad = null;
      return null;
    });
  return pendingLoad;
}

/** Install a database directly, for tests and for callers that bundle their own. */
export function setLensProfileDatabase(database) {
  loadedDatabase = database;
  pendingLoad = null;
}

/** The database if it is already in memory, otherwise null. */
export function getLoadedLensProfileDatabase() {
  return loadedDatabase;
}

// --- Browsing -----------------------------------------------------------------

function compareText(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/**
 * The literal EXIF `Make` an entry answers to.
 *
 * `maker` is the brand; where a body writes something else into its files —
 * Nikon's SLRs say "Nikon Corporation" — the entry carries that too, and it is
 * what a file has to be checked against.
 */
export function entryExifMaker(entry) {
  return entry.exifMaker || entry.maker;
}

/** Distinct camera brands, sorted. */
export function listCameraMakers(database) {
  const makers = new Set();
  for (const camera of database.cameras) makers.add(camera.maker);
  return Array.from(makers).sort(compareText);
}

/** Cameras sold under one brand, sorted by model. */
export function listCameras(database, maker) {
  return database.cameras
    .filter((camera) => camera.maker === maker)
    .sort((left, right) => compareText(left.model, right.model));
}

/**
 * Lenses that fit a camera. Mount is the real constraint — a lens the body
 * cannot take is never the right profile — with everything offered when no
 * camera is chosen.
 */
export function listLenses(database, camera) {
  const lenses = camera
    ? database.lenses.filter((lens) => lens.mount === camera.mount)
    : database.lenses.slice(0);
  return lenses.sort((left, right) =>
    compareText(left.maker + " " + left.model, right.maker + " " + right.model));
}

/**
 * Whether a lens could have taken a shot at this focal length.
 *
 * Measurements span the range a lens actually covers, so a 10-22mm zoom cannot
 * be the answer for a frame shot at 52mm. Files often name no lens — Nikon
 * writes it into the maker note rather than a standard tag — and a mount alone
 * can leave a couple of hundred candidates, so this is what makes the list
 * usable when the metadata falls short.
 */
export function lensCoversFocalLength(lens, focalLength) {
  if (!(focalLength > 0)) return true;
  let lowest = Infinity;
  let highest = 0;
  for (const table of [lens.distortion, lens.tca, lens.vignetting]) {
    for (const row of table || []) {
      if (row[0] < lowest) lowest = row[0];
      if (row[0] > highest) highest = row[0];
    }
  }
  if (!(highest > 0)) return true;
  // A prime is measured at one focal length; allow the rounding a body applies.
  const tolerance = Math.max(0.5, lowest * 0.02);
  return focalLength >= lowest - tolerance && focalLength <= highest + tolerance;
}

export function findCamera(database, maker, model) {
  return database.cameras.find(
    (camera) => camera.maker === maker && camera.model === model) || null;
}

export function findLens(database, model) {
  return database.lenses.find((lens) => lens.model === model) || null;
}

// --- Matching a photograph ----------------------------------------------------

function normalizeName(text) {
  return String(text == null ? "" : text).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Every name an entry answers to: its own, plus its English display name. */
function namesOf(entry) {
  return entry.aliases ? [entry.model].concat(entry.aliases) : [entry.model];
}

/**
 * The camera a file was taken with, from its EXIF make and model.
 *
 * Bodies write the maker into the model string inconsistently — "Canon EOS 5D"
 * against a bare "EOS 5D" — so a maker-qualified form is tried alongside the
 * raw one.
 *
 * @param {object} database
 * @param {{ maker?: string, model?: string }} identity EXIF `tiff:Make` / `tiff:Model`.
 */
export function matchCamera(database, identity) {
  const model = normalizeName(identity && identity.model);
  if (!model) return null;
  const maker = normalizeName(identity && identity.maker);
  const qualified = maker && !model.startsWith(maker) ? maker + " " + model : model;
  for (const camera of database.cameras) {
    if (!makerMatches(maker, camera)) continue;
    for (const name of namesOf(camera)) {
      const candidate = normalizeName(name);
      if (candidate === model || candidate === qualified) return camera;
    }
  }
  return null;
}

/**
 * Whether a file's EXIF `Make` can belong to this entry. Bodies from one brand
 * disagree about how much of the company name to write, so either string
 * containing the other is close enough; a file with no maker recorded is not
 * held against the entry.
 */
function makerMatches(fileMaker, camera) {
  if (!fileMaker) return true;
  const brand = normalizeName(camera.maker);
  const exif = normalizeName(entryExifMaker(camera));
  return fileMaker.includes(brand) || brand.includes(fileMaker) ||
    fileMaker.includes(exif) || exif.includes(fileMaker);
}

/**
 * The lens a file was taken with. Candidates are restricted to the body's mount
 * before names are compared, so a generic display name such as "fixed lens"
 * can only ever resolve to the lens that body actually has.
 *
 * @param {object} database
 * @param {{ lens?: string }} identity EXIF `exif:Lens`.
 * @param {object|null} camera Matched camera, when one was found.
 */
export function matchLens(database, identity, camera) {
  const candidates = listLenses(database, camera);
  const wanted = normalizeName(identity && identity.lens);
  if (wanted) {
    for (const lens of candidates) {
      for (const name of namesOf(lens)) {
        if (normalizeName(name) === wanted) return lens;
      }
    }
    // Cameras pad lens names with mount or maker prefixes; fall back to a
    // containment test, but only inside the mount-filtered set.
    for (const lens of candidates) {
      const candidate = normalizeName(lens.model);
      if (candidate && (wanted.includes(candidate) || candidate.includes(wanted))) return lens;
    }
  }
  // A body with one fixed lens has only one possible answer — but only when the
  // file named no lens at all. If it named one and nothing matched, the honest
  // result is no profile: guessing would silently correct with the wrong glass.
  if (!wanted && camera && candidates.length === 1) return candidates[0];
  return null;
}

/**
 * Camera, lens and shooting settings resolved from a document's metadata.
 * @returns {{ camera: object|null, lens: object|null, focalLength: number, aperture: number }}
 */
export function matchProfileFromMetadata(database, metadata) {
  const identity = {
    maker: metadata && metadata["tiff:Make"],
    model: metadata && metadata["tiff:Model"],
    lens: metadata && metadata["exif:Lens"],
  };
  const camera = matchCamera(database, identity);
  return {
    camera,
    lens: matchLens(database, identity, camera),
    focalLength: readMetadataNumber(metadata, "exif:FocalLength"),
    aperture: readMetadataNumber(metadata, "exif:FNumber"),
  };
}

/** EXIF numbers arrive as plain values or as rational pairs. */
function readMetadataNumber(metadata, key) {
  const raw = metadata && metadata[key];
  if (raw == null) return 0;
  if (Array.isArray(raw)) return raw[1] ? raw[0] / raw[1] : 0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

// --- Interpolation ------------------------------------------------------------

/** Blend factor for `value` between two measurements, clamped at both ends. */
function blendFactor(value, low, high) {
  if (!(high > low)) return 0;
  const position = (value - low) / (high - low);
  return position < 0 ? 0 : position > 1 ? 1 : position;
}

/**
 * The two rows bracketing `target` in column `column`, or the nearest single row
 * when the target sits outside the measured range.
 */
function bracket(rows, column, target) {
  let below = null;
  let above = null;
  for (const row of rows) {
    const value = row[column];
    if (value <= target && (!below || value > below[column])) below = row;
    if (value >= target && (!above || value < above[column])) above = row;
  }
  if (!below) return [above, above];
  if (!above) return [below, below];
  return [below, above];
}

function mix(low, high, factor) {
  return low + (high - low) * factor;
}

/**
 * Distortion coefficients at a focal length.
 *
 * The two neighbours can be measured with different models, in which case
 * blending their coefficients would be meaningless — the nearer one wins.
 *
 * @returns {{ model: number, c0: number, c1: number, c2: number }|null}
 */
export function interpolateDistortion(lens, focalLength) {
  const rows = lens && lens.distortion;
  if (!rows || !rows.length) return null;
  const [low, high] = bracket(rows, 0, focalLength);
  const factor = blendFactor(focalLength, low[0], high[0]);
  if (low[1] !== high[1]) {
    const nearer = factor < 0.5 ? low : high;
    return { model: nearer[1], c0: nearer[2], c1: nearer[3], c2: nearer[4] };
  }
  return {
    model: low[1],
    c0: mix(low[2], high[2], factor),
    c1: mix(low[3], high[3], factor),
    c2: mix(low[4], high[4], factor),
  };
}

/**
 * Transverse chromatic aberration coefficients at a focal length.
 * @returns {{ redB, redC, redV, blueB, blueC, blueV }|null}
 */
export function interpolateTca(lens, focalLength) {
  const rows = lens && lens.tca;
  if (!rows || !rows.length) return null;
  const [low, high] = bracket(rows, 0, focalLength);
  const factor = blendFactor(focalLength, low[0], high[0]);
  return {
    redB: mix(low[1], high[1], factor),
    redC: mix(low[2], high[2], factor),
    redV: mix(low[3], high[3], factor),
    blueB: mix(low[4], high[4], factor),
    blueC: mix(low[5], high[5], factor),
    blueV: mix(low[6], high[6], factor),
  };
}

/**
 * Vignetting coefficients at a focal length and aperture.
 *
 * Measurements are a grid over focal length, aperture and subject distance.
 * Distance is settled first by taking the furthest measured — a photograph's
 * subject distance is rarely recorded, and the far end is the common case —
 * then focal length, then aperture.
 *
 * @returns {{ k1: number, k2: number, k3: number }|null}
 */
export function interpolateVignetting(lens, focalLength, aperture) {
  const rows = lens && lens.vignetting;
  if (!rows || !rows.length) return null;
  let furthest = 0;
  for (const row of rows) if (row[2] > furthest) furthest = row[2];
  const atDistance = rows.filter((row) => row[2] === furthest);

  const [focalLow, focalHigh] = bracket(atDistance, 0, focalLength);
  const focalFactor = blendFactor(focalLength, focalLow[0], focalHigh[0]);
  const lowSet = atDistance.filter((row) => row[0] === focalLow[0]);
  const highSet = atDistance.filter((row) => row[0] === focalHigh[0]);
  const low = atAperture(lowSet, aperture);
  const high = atAperture(highSet, aperture);
  return {
    k1: mix(low.k1, high.k1, focalFactor),
    k2: mix(low.k2, high.k2, focalFactor),
    k3: mix(low.k3, high.k3, focalFactor),
  };
}

function atAperture(rows, aperture) {
  const [low, high] = bracket(rows, 1, aperture);
  const factor = blendFactor(aperture, low[1], high[1]);
  return {
    k1: mix(low[3], high[3], factor),
    k2: mix(low[4], high[4], factor),
    k3: mix(low[5], high[5], factor),
  };
}
