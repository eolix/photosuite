/**
 * Persistent cache for the Filter Gallery preview thumbnails.
 *
 * The thumbnails are deterministic for a given rasterized size, so they are
 * rendered once and written to a dedicated plugin-store file; later app runs
 * read them back instead of re-rendering every filter at startup. The stored
 * set is invalidated by two keys: `signature` (thumbnail pixel size, which
 * folds in display DPI and viewport width) and `version` (bumped when a gallery
 * filter's output changes). Any mismatch is treated as absent so the panel
 * regenerates and re-persists.
 *
 * A separate file from settings.json keeps the ~megabyte of data-URL strings out
 * of the frequently-saved settings store. Outside the Tauri runtime (tests, plain
 * web) every call is a no-op and the panel falls back to its in-memory render.
 */


/** Persisted under app_data_dir; see tauri-plugin-store. */
export const FILTER_GALLERY_THUMBNAIL_STORE_FILE = "filter-gallery-thumbnails.json";

/** Bump when any gallery filter's rendered output changes, to discard stale thumbnails. */
export const FILTER_GALLERY_THUMBNAIL_CACHE_VERSION = 1;

/** @type {Promise<import("@tauri-apps/plugin-store").Store>|null} */
let thumbnailStorePromise = null;

function getTauriStoreApi() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.store ? tauri.store : null;
}

async function openThumbnailStore() {
  const storeApi = getTauriStoreApi();
  if (!storeApi || typeof storeApi.load !== "function") return null;
  if (!thumbnailStorePromise) {
    thumbnailStorePromise = storeApi.load(FILTER_GALLERY_THUMBNAIL_STORE_FILE, { autoSave: false });
  }
  return thumbnailStorePromise;
}

/**
 * True when `value` is a plain object whose every value is a data-URL string.
 * @param {*} value
 * @returns {boolean}
 */
export function isFilterGalleryThumbnailMap(value) {
  if (value == null || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
    const dataUrl = value[keys[keyIdx]];
    if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) return false;
  }
  return true;
}

/**
 * Read the persisted `{ filterKey: dataURL }` map for one size signature, or null
 * when nothing is stored for it (missing file, version bump, different size, or a
 * malformed entry). Never throws — a store error resolves to null.
 * @param {string} signature
 * @returns {Promise<Object.<string, string>|null>}
 */
export async function loadPersistedFilterGalleryThumbnails(signature) {
  const store = await openThumbnailStore();
  if (!store) return null;
  try {
    const version = await store.get("version");
    if (version !== FILTER_GALLERY_THUMBNAIL_CACHE_VERSION) return null;
    if ((await store.get("signature")) !== signature) return null;
    const thumbnails = await store.get("thumbnails");
    return isFilterGalleryThumbnailMap(thumbnails) ? thumbnails : null;
  } catch (err) {
    console.warn("PhotoSuite: failed to load filter gallery thumbnails", err);
    return null;
  }
}

/**
 * Write the `{ filterKey: dataURL }` map for one size signature, replacing any
 * stored signature so the file holds only the current display size.
 * Never throws — a store error is logged and swallowed.
 * @param {string} signature
 * @param {Object.<string, string>} thumbnails
 * @returns {Promise<void>}
 */
export async function persistFilterGalleryThumbnails(signature, thumbnails) {
  if (!isFilterGalleryThumbnailMap(thumbnails)) return;
  const store = await openThumbnailStore();
  if (!store) return;
  try {
    await store.set("version", FILTER_GALLERY_THUMBNAIL_CACHE_VERSION);
    await store.set("signature", signature);
    await store.set("thumbnails", thumbnails);
    await store.save();
  } catch (err) {
    console.warn("PhotoSuite: failed to persist filter gallery thumbnails", err);
  }
}
