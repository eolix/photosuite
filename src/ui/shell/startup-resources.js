/**
 * Preset libraries the app seeds itself with at launch: the default brushes,
 * gradients, patterns and shapes a new install starts with.
 *
 * Preset stores are held in memory only, so this is the app's setup step and runs
 * every launch rather than only on first run. Each file goes through the same
 * parsers and the same install path as a library the user drags in, so a default
 * preset and an imported one are indistinguishable once loaded.
 *
 * The files are read straight from the app bundle, in parallel, without the
 * open-file veil — seeding is not an action the user took and must not present
 * itself as one.
 */

import { FileProcessor } from "./file-loader.js";
import { nativeWriteFile } from "../../core/tauri-host.js";

/**
 * Bundle-relative paths of the seed libraries. The format is taken from the
 * extension, exactly as it is for a file opened from disk.
 */
export const STARTUP_PRESET_FILES = [
  "resources/startup/brushes.abr",
  "resources/startup/gradients.grd",
  "resources/startup/patterns.pat",
  "resources/startup/shapes.shc"
];

/**
 * File name from a bundle path, used to detect the preset format.
 * @param {string} resourcePath
 * @returns {string}
 */
export function resourceFileName(resourcePath) {
  const slashIdx = resourcePath.lastIndexOf("/");
  return slashIdx === -1 ? resourcePath : resourcePath.slice(slashIdx + 1);
}

/**
 * Fetch one bundled resource, or null when it cannot be read. A missing library
 * costs the user those presets; it must not stop the app from starting.
 * @param {string} resourcePath
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function fetchStartupResource(resourcePath) {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(resourcePath);
    if (!response.ok) {
      console.warn("PhotoSuite: startup resource unavailable", resourcePath, response.status);
      return null;
    }
    return await response.arrayBuffer();
  } catch (err) {
    console.warn("PhotoSuite: failed to read startup resource", resourcePath, err);
    return null;
  }
}

/**
 * Load every seed library and install its presets.
 * @param {*} fileLoader
 * @param {string[]} [resourcePaths]
 * @returns {Promise<void>}
 */
export async function loadStartupPresetResources(fileLoader, resourcePaths) {
  const paths = resourcePaths != null ? resourcePaths : STARTUP_PRESET_FILES;
  const buffers = await Promise.all(paths.map(fetchStartupResource));
  for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
    const bytes = buffers[pathIdx];
    if (bytes == null) continue;
    try {
      FileProcessor.processLoadedBytes(
        { name: resourceFileName(paths[pathIdx]), suppressPresetAddedAlert: true },
        bytes,
        fileLoader,
        null
      );
    } catch (err) {
      console.warn("PhotoSuite: failed to install startup presets", paths[pathIdx], err);
    }
  }
}

// ---------------------------------------------------------------------------
// Persisted resource store
// ---------------------------------------------------------------------------
// Saved resource libraries
// ---------------------------------------------------------------------------

/**
 * The preset libraries a user chose to keep: brush, gradient, pattern, shape
 * and swatch sets, and their scripts.
 *
 * Each is a plain file in `{app_data_dir}/resources`, named as it was saved, so
 * the folder can be opened, backed up or added to from outside the app. Bytes
 * move over the raw-binary IPC path in both directions rather than through JSON.
 */

function getTauriCore() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.core ? tauri.core : null;
}

/**
 * List the saved libraries.
 * @returns {Promise<Array<{name: string, path: string, size: number}>>}
 */
export async function listSavedResources() {
  const core = getTauriCore();
  if (core == null) return [];
  try {
    const entries = await core.invoke("list_user_resources");
    return Array.isArray(entries) ? entries : [];
  } catch (err) {
    console.warn("PhotoSuite: failed to list saved resources", err);
    return [];
  }
}

/**
 * Read every saved library.
 *
 * One that cannot be read is reported and skipped: a single unreadable file
 * must not cost the user the rest of their libraries.
 *
 * @returns {Promise<Object<string, ArrayBuffer>>} file name to bytes
 */
export async function loadSavedResources() {
  const core = getTauriCore();
  if (core == null) return {};
  const storedFiles = {};
  for (const entry of await listSavedResources()) {
    try {
      const bytes = await core.invoke("read_file_raw", { path: entry.path });
      storedFiles[entry.name] = toArrayBuffer(bytes);
    } catch (err) {
      console.warn("PhotoSuite: failed to read saved resource", entry.name, err);
    }
  }
  return storedFiles;
}

/** `read_file_raw` answers with binary; normalise whatever shape it arrives in. */
function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Uint8Array(bytes).buffer;
}

/**
 * Write one library to the resources folder, replacing any file of that name.
 *
 * @param {string} name file name as the user saved it
 * @param {ArrayBuffer} bytes
 * @returns {Promise<boolean>} whether it was written
 */
export async function saveResource(name, bytes) {
  const core = getTauriCore();
  if (core == null) return false;
  try {
    // Rust resolves and validates the path; the front end never joins one.
    const path = await core.invoke("user_resource_path", { name });
    await nativeWriteFile(path, bytes);
    return true;
  } catch (err) {
    console.warn("PhotoSuite: failed to save resource", name, err);
    return false;
  }
}

/**
 * Remove one saved library. Removing one that is already gone is not an error.
 *
 * @param {string} name
 * @returns {Promise<boolean>} whether it was removed
 */
export async function deleteSavedResource(name) {
  const core = getTauriCore();
  if (core == null) return false;
  try {
    await core.invoke("delete_user_resource", { name });
    return true;
  } catch (err) {
    console.warn("PhotoSuite: failed to remove saved resource", name, err);
    return false;
  }
}

/**
 * Make the resources folder match `storedFiles`: write the libraries it holds
 * and remove the files it no longer does.
 *
 * The in-memory map is what the Resource Manager edits, so this is how a
 * removal there reaches disk. Files already saved at the same size are left
 * alone rather than rewritten — a brush set runs to megabytes.
 *
 * @param {Object<string, ArrayBuffer>} storedFiles file name to bytes
 * @param {(name: string) => void} [onFailure] called per library that would not save
 * @returns {Promise<void>}
 */
export async function syncSavedResources(storedFiles, onFailure) {
  const onDisk = await listSavedResources();
  const onDiskByName = new Map(onDisk.map((entry) => [entry.name, entry]));

  for (const name of Object.keys(storedFiles)) {
    const bytes = storedFiles[name];
    if (!(bytes instanceof ArrayBuffer)) continue;
    const existing = onDiskByName.get(name);
    if (existing && existing.size === bytes.byteLength) continue;
    if (!(await saveResource(name, bytes)) && onFailure) onFailure(name);
  }

  for (const entry of onDisk) {
    if (!(entry.name in storedFiles)) await deleteSavedResource(entry.name);
  }
}
