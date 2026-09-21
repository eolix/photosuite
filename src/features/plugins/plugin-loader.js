/**
 * Drop-in sidebar plugin discovery for the Tauri desktop app.
 *
 * Scans `{app_data_dir}/plugins/<plugin-id>/plugin.json`, bundles entry HTML with
 * sibling JS/CSS via Rust file reads, and returns specs for
 * {@link RightSidebar#registerRuntimePlugins}.
 */

import {
  attachPluginEntryHtml,
  buildSidebarPluginSpecFromDiscovery,
  bundleRelativePluginAssets,
  filterUnregisteredSidebarPluginSpecs,
  pluginDirectoryFromEntryPath
} from "./plugin-spec.js";

function getTauriCore() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.core ? tauri.core : null;
}

/**
 * Convert an absolute filesystem path to a webview-loadable asset URL.
 * @param {string} absolutePath
 * @returns {string}
 */
export function convertPluginAssetUrl(absolutePath) {
  if (absolutePath == null || absolutePath === "") return "";
  const core = getTauriCore();
  if (core && typeof core.convertFileSrc === "function") {
    return core.convertFileSrc(absolutePath);
  }
  return absolutePath;
}

/**
 * Ensure the plugins directory exists and return its absolute path.
 * @returns {Promise<string|null>}
 */
export async function ensureSidebarPluginsDirectory() {
  const core = getTauriCore();
  if (core == null || typeof core.invoke !== "function") return null;
  try {
    const directory = await core.invoke("ensure_plugins_directory");
    return typeof directory === "string" ? directory : null;
  } catch (err) {
    console.warn("PhotoSuite: failed to ensure plugins directory", err);
    return null;
  }
}

async function readPluginTextFile(filePath) {
  const core = getTauriCore();
  if (core == null || typeof core.invoke !== "function") return null;
  try {
    const bytes = await core.invoke("read_file_bytes", { path: filePath });
    if (bytes == null) return null;
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch (err) {
    console.warn("PhotoSuite: failed to read plugin file", filePath, err);
    return null;
  }
}

function mimeTypeForPluginPath(filePath) {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return "application/octet-stream";
  const ext = filePath.slice(dotIdx + 1).toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

async function readPluginFileAsDataUrl(filePath) {
  const core = getTauriCore();
  if (core == null || typeof core.invoke !== "function") return null;
  try {
    const encoded = await core.invoke("read_file_base64", { path: filePath });
    if (encoded == null || encoded === "") return null;
    return "data:" + mimeTypeForPluginPath(filePath) + ";base64," + encoded;
  } catch (err) {
    console.warn("PhotoSuite: failed to read plugin file as data URL", filePath, err);
    return null;
  }
}

/**
 * Bundle plugin entry HTML and icon onto a runtime sidebar spec.
 * @param {object} discovered
 * @returns {Promise<object>}
 */
export async function hydrateDiscoveredPluginSpec(discovered) {
  const pluginDir = pluginDirectoryFromEntryPath(discovered.entryPath);
  const iconDataUrl = await readPluginFileAsDataUrl(discovered.iconPath);
  const pluginSpec = buildSidebarPluginSpecFromDiscovery(discovered, convertPluginAssetUrl);
  if (iconDataUrl != null) pluginSpec.icon = iconDataUrl;

  const entryHtml = await readPluginTextFile(discovered.entryPath);
  if (entryHtml == null) return pluginSpec;

  const bundledHtml = await bundleRelativePluginAssets(entryHtml, pluginDir, readPluginTextFile);
  return attachPluginEntryHtml(pluginSpec, bundledHtml);
}

/**
 * Scan `{app_data_dir}/plugins` and return iframe panel specs.
 * @returns {Promise<object[]>}
 */
export async function loadDiscoveredSidebarPlugins() {
  const core = getTauriCore();
  if (core == null || typeof core.invoke !== "function") return [];

  try {
    await ensureSidebarPluginsDirectory();
    const discovered = await core.invoke("discover_sidebar_plugins_command");
    if (!Array.isArray(discovered) || discovered.length === 0) return [];

    const pluginSpecs = [];
    for (let pluginIdx = 0; pluginIdx < discovered.length; pluginIdx++) {
      const record = discovered[pluginIdx];
      if (record == null || typeof record.id !== "string") continue;
      pluginSpecs.push(await hydrateDiscoveredPluginSpec(record));
    }
    return pluginSpecs;
  } catch (err) {
    console.warn("PhotoSuite: sidebar plugin discovery failed", err);
    return [];
  }
}

/**
 * Register disk plugins on the right sidebar, skipping ids already present.
 * @param {*} rightSidebar
 * @param {object[]} pluginSpecs
 */
export function registerDiscoveredSidebarPlugins(rightSidebar, pluginSpecs) {
  const pendingSpecs = filterUnregisteredSidebarPluginSpecs(rightSidebar, pluginSpecs);
  if (pendingSpecs.length === 0) return;
  rightSidebar.registerRuntimePlugins(pendingSpecs);
}
