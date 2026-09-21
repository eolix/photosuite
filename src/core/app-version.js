/**
 * Application version label for the home screen (from Tauri package info).
 */


/** @type {string|null} */
let cachedVersion = null;

/**
 * @returns {Promise<string>}
 */
export async function loadAppVersionInfo() {
  if (cachedVersion) return cachedVersion;
  {
    const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
    if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
      try {
        const version = await tauri.core.invoke("get_app_version");
        if (typeof version === "string" && version !== "") {
          cachedVersion = version;
          return cachedVersion;
        }
      } catch (err) {
        console.warn("PhotoSuite: get_app_version failed", err);
      }
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/**
 * @param {string|null|undefined} version
 * @returns {string}
 */
export function formatAppVersionHeading(version) {
  if (version == null || version === "") return "PhotoSuite";
  return "PhotoSuite " + version;
}
