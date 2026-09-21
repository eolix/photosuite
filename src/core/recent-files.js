/**
 * Recently opened local files (max five). Metadata lives in settings.json and the
 * preview images in their own store file, keyed by the file path they belong to.
 *
 * Keeping thumbnails out of settings.json keeps a frequently-saved file small;
 * keying them by path rather than by list position means the two stores cannot
 * fall out of step, so re-ordering or dropping an entry needs no matching shuffle
 * on the image side.
 */

import { Rect } from "./math/rect.js";
import { APP_SETTINGS_FILE } from "./app-settings.js";
import { basenameFromPath } from "./file-names.js";
import { getDevicePixelRatio } from "./dom.js";
import { buildMipPyramidAlpha, copyBuffer } from "../engine/compositing/buffer-utils.js";

export const MAX_RECENT_FILES = 5;

/** Thumbnail edge length in CSS pixels for home screen previews. */
export const RECENT_FILE_THUMB_CSS_PX = 160;

/** Persisted under app_data_dir; see tauri-plugin-store. */
export const RECENT_FILE_THUMBNAIL_STORE_FILE = "recent-files-thumbnails.json";

/** @type {Promise<import("@tauri-apps/plugin-store").Store>|null} */
let settingsStorePromise = null;

/** @type {Promise<import("@tauri-apps/plugin-store").Store>|null} */
let thumbnailStorePromise = null;

/** @type {Array<{ path: string, name: string, openedAt: number, thumbnail?: string }>} */
let recentFilesCache = [];

function getTauriCore() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.core ? tauri.core : null;
}

function getTauriStoreApi() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.store ? tauri.store : null;
}

async function openSettingsStore() {
  const storeApi = getTauriStoreApi();
  if (!storeApi || typeof storeApi.load !== "function") return null;
  if (!settingsStorePromise) {
    settingsStorePromise = storeApi.load(APP_SETTINGS_FILE, { autoSave: 100 });
  }
  return settingsStorePromise;
}

function metadataSnapshot(entries) {
  const rows = [];
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const entry = entries[entryIdx];
    rows.push({
      path: entry.path,
      name: entry.name,
      openedAt: entry.openedAt
    });
  }
  return rows;
}

/**
 * Normalize persisted recent-file rows (metadata only — no inline thumbnails).
 * @param {*} stored
 * @returns {Array<{ path: string, name: string, openedAt: number, thumbnail?: string }>}
 */
export function normalizeRecentFileEntries(stored) {
  if (!Array.isArray(stored)) return [];
  const normalized = [];
  for (let entryIdx = 0; entryIdx < stored.length; entryIdx++) {
    const row = stored[entryIdx];
    if (row == null || typeof row.path !== "string" || row.path === "") continue;
    normalized.push({
      path: row.path,
      // The file on disk names the entry, so a renamed or re-saved document
      // never leaves a stale title behind in the list.
      name: basenameFromPath(row.path),
      openedAt: typeof row.openedAt === "number" ? row.openedAt : 0
    });
    if (normalized.length >= MAX_RECENT_FILES) break;
  }
  return normalized;
}

/** @returns {Array<{ path: string, name: string, openedAt: number, thumbnail?: string }>} */
export function getRecentFiles() {
  return recentFilesCache.slice();
}

/**
 * Index of a path in the recent list, or -1 when absent.
 * @param {Array<{ path: string }>} entries
 * @param {string} path
 * @returns {number}
 */
export function findRecentFileIndex(entries, path) {
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    if (entries[entryIdx].path === path) return entryIdx;
  }
  return -1;
}

/**
 * Move one path to the front, drop duplicates, cap at {@link MAX_RECENT_FILES}.
 * @param {Array<{ path: string, name: string, openedAt: number }>} entries
 * @param {{ path: string, name: string, openedAt: number }} nextRow
 * @returns {Array<{ path: string, name: string, openedAt: number }>}
 */
export function buildRecentFileListAfterOpen(entries, nextRow) {
  const deduped = [];
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const cached = entries[entryIdx];
    if (cached.path === nextRow.path) continue;
    deduped.push(cached);
  }
  return [nextRow].concat(deduped).slice(0, MAX_RECENT_FILES);
}

async function openThumbnailStore() {
  const storeApi = getTauriStoreApi();
  if (!storeApi || typeof storeApi.load !== "function") return null;
  if (!thumbnailStorePromise) {
    thumbnailStorePromise = storeApi.load(RECENT_FILE_THUMBNAIL_STORE_FILE, { autoSave: false });
  }
  return thumbnailStorePromise;
}

/**
 * The stored `{ filePath: dataURL }` map, or an empty object when there is none.
 * @returns {Promise<Object.<string, string>>}
 */
export async function loadRecentThumbnailMap() {
  const store = await openThumbnailStore();
  if (!store) return {};
  try {
    const stored = await store.get("thumbnails");
    return isRecentThumbnailMap(stored) ? stored : {};
  } catch (err) {
    console.warn("PhotoSuite: failed to load recent thumbnails", err);
    return {};
  }
}

/**
 * True when `value` maps strings to data URLs. An empty map is valid — it is what
 * a first run, or a list emptied of every entry, legitimately stores.
 * @param {*} value
 * @returns {boolean}
 */
export function isRecentThumbnailMap(value) {
  if (value == null || typeof value !== "object") return false;
  const paths = Object.keys(value);
  for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
    const dataUrl = value[paths[pathIdx]];
    if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) return false;
  }
  return true;
}

/**
 * Keep only the paths still on the recent list, so a thumbnail never outlives the
 * entry it belongs to.
 * @param {Object.<string, string>} thumbnails
 * @param {Array<{ path: string }>} entries
 * @returns {Object.<string, string>}
 */
export function pruneRecentThumbnailMap(thumbnails, entries) {
  const kept = {};
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const path = entries[entryIdx].path;
    if (typeof thumbnails[path] === "string") kept[path] = thumbnails[path];
  }
  return kept;
}

async function saveRecentThumbnailMap(thumbnails) {
  const store = await openThumbnailStore();
  if (!store) return;
  try {
    await store.set("thumbnails", thumbnails);
    await store.save();
  } catch (err) {
    console.warn("PhotoSuite: failed to persist recent thumbnails", err);
  }
}

/**
 * Attach each entry's stored preview, in one read for the whole list.
 * @param {Array<{ path: string, thumbnail?: string }>} entries
 */
export async function attachRecentThumbnailUrls(entries) {
  const thumbnails = await loadRecentThumbnailMap();
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const dataUrl = thumbnails[entries[entryIdx].path];
    if (typeof dataUrl === "string") entries[entryIdx].thumbnail = dataUrl;
    else delete entries[entryIdx].thumbnail;
  }
}

export async function loadRecentFilesFromStore() {
  recentFilesCache = [];
  const store = await openSettingsStore();
  if (!store) return;
  try {
    recentFilesCache = normalizeRecentFileEntries(await store.get("recentFiles"));
    await attachRecentThumbnailUrls(recentFilesCache);
  } catch (err) {
    console.warn("PhotoSuite: failed to load recent files", err);
    recentFilesCache = [];
  }
}

async function persistRecentFilesCache() {
  const store = await openSettingsStore();
  if (!store) return;
  await store.set("recentFiles", metadataSnapshot(recentFilesCache));
  await store.save();
}

async function pushRecentThumbnailJpeg(jpegBytes) {
  const core = getTauriCore();
  if (!core || typeof core.invoke !== "function" || jpegBytes == null) return;
  const body = jpegBytes instanceof Uint8Array ? jpegBytes : new Uint8Array(jpegBytes);
  await core.invoke("push_recent_thumbnail", body);
}

async function compactRecentThumbnailSlot(removedSlot) {
  const core = getTauriCore();
  if (!core || typeof core.invoke !== "function") return;
  await core.invoke("compact_recent_thumbnails", { removedSlot: removedSlot });
}

/**
 * Move a file to the front of the recent list and persist it. Without a fresh
 * preview the stored one is left in place, so reopening a file that failed to
 * render keeps the picture the user recognises.
 * @param {{ path: string, thumbnailDataUrl?: string|null }} entry
 */
export async function recordRecentFile(entry) {
  if (!entry || typeof entry.path !== "string" || entry.path === "") return;
  recentFilesCache = buildRecentFileListAfterOpen(recentFilesCache, {
    path: entry.path,
    name: basenameFromPath(entry.path),
    openedAt: Date.now()
  });

  try {
    const thumbnails = await loadRecentThumbnailMap();
    if (typeof entry.thumbnailDataUrl === "string" && entry.thumbnailDataUrl !== "") {
      thumbnails[entry.path] = entry.thumbnailDataUrl;
    }
    await saveRecentThumbnailMap(pruneRecentThumbnailMap(thumbnails, recentFilesCache));
    await persistRecentFilesCache();
    await attachRecentThumbnailUrls(recentFilesCache);
  } catch (err) {
    console.warn("PhotoSuite: failed to persist recent files", err);
  }
}

/** Remove one path from the recent list (missing or unreadable files). */
export async function removeRecentFile(path) {
  if (typeof path !== "string" || path === "") return;
  const filtered = recentFilesCache.filter(function(cached) {
    return cached.path !== path;
  });
  if (filtered.length === recentFilesCache.length) return;
  recentFilesCache = filtered;
  try {
    const thumbnails = await loadRecentThumbnailMap();
    await saveRecentThumbnailMap(pruneRecentThumbnailMap(thumbnails, recentFilesCache));
    await persistRecentFilesCache();
    await attachRecentThumbnailUrls(recentFilesCache);
  } catch (err) {
    console.warn("PhotoSuite: failed to update recent files", err);
  }
}

/** Forget every recent file and its stored preview. */
export async function clearRecentFiles() {
  recentFilesCache = [];
  try {
    await saveRecentThumbnailMap({});
    await persistRecentFilesCache();
  } catch (err) {
    console.warn("PhotoSuite: failed to clear recent files", err);
  }
}

/** Reload stored previews for the current in-memory list (home screen refresh). */
export async function refreshRecentThumbnailUrls() {
  await attachRecentThumbnailUrls(recentFilesCache);
}

/**
 * @param {*} doc
 * @param {number} [maxCssPx]
 * @returns {string|null}
 */
export function captureDocumentThumbnailDataUrl(doc, maxCssPx) {
  if (maxCssPx == null) maxCssPx = RECENT_FILE_THUMB_CSS_PX;
  if (doc == null || doc.width <= 0 || doc.height <= 0) return null;
  if (typeof document === "undefined") return null;
  try {
    doc.composite();
    const mipChain = [doc.getRasterData(), new Rect(0, 0, doc.width, doc.height)];
    buildMipPyramidAlpha(mipChain);
    const targetPx = Math.max(1, Math.floor(maxCssPx * getDevicePixelRatio()));
    let mipIndex = 0;
    while (mipIndex + 2 < mipChain.length && mipChain[mipIndex + 1].width > targetPx) {
      mipIndex += 2;
    }
    const pixels = mipChain[mipIndex];
    const rect = mipChain[mipIndex + 1];
    if (rect.width <= 0 || rect.height <= 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");
    if (ctx == null) return null;
    const imageData = ctx.createImageData(rect.width, rect.height);
    copyBuffer(pixels, imageData.data);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch (err) {
    console.warn("PhotoSuite: recent-file thumbnail capture failed", err);
    return null;
  }
}

/**
 * Human-readable relative time for the home screen (e.g. "3 days ago").
 * @param {number} openedAtMs
 * @param {number} [nowMs]
 */
export function formatRecentFileAge(openedAtMs, nowMs) {
  if (openedAtMs == null || openedAtMs <= 0) return "";
  if (nowMs == null) nowMs = Date.now();
  const elapsedMs = Math.max(0, nowMs - openedAtMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const monthMs = 30 * dayMs;
  if (elapsedMs < minuteMs) return "Just now";
  if (elapsedMs < hourMs) {
    const minutes = Math.floor(elapsedMs / minuteMs);
    return minutes === 1 ? "1 minute ago" : minutes + " minutes ago";
  }
  if (elapsedMs < dayMs) {
    const hours = Math.floor(elapsedMs / hourMs);
    return hours === 1 ? "1 hour ago" : hours + " hours ago";
  }
  if (elapsedMs < monthMs) {
    const days = Math.floor(elapsedMs / dayMs);
    return days === 1 ? "1 day ago" : days + " days ago";
  }
  const months = Math.floor(elapsedMs / monthMs);
  return months === 1 ? "1 month ago" : months + " months ago";
}

