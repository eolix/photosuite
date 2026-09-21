/**
 * Pure helpers for mapping discovered sidebar plugins to runtime panel specs.
 */

/**
 * @typedef {object} DiscoveredSidebarPlugin
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} entryPath
 * @property {string} iconPath
 * @property {number} width
 * @property {number} height
 * @property {boolean} themed
 */

/**
 * @typedef {object} SidebarPluginSpec
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} icon
 * @property {number} width
 * @property {number} height
 * @property {boolean} [themed]
 */

/**
 * The folder holding a plugin, derived from its entry file path.
 * @param {string} entryPath
 * @returns {string}
 */
export function pluginDirectoryFromEntryPath(entryPath) {
  const normalized = entryPath.replace(/\\/g, "/");
  const slashIdx = normalized.lastIndexOf("/");
  return slashIdx === -1 ? "" : normalized.slice(0, slashIdx);
}

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isBundlableRelativePluginPath(relativePath) {
  if (relativePath == null || relativePath === "") return false;
  if (/^(https?:|\/\/|data:|blob:|asset:)/i.test(relativePath)) return false;
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  return !normalized.split("/").includes("..");
}

/**
 * @param {string} pluginDirPath
 * @param {string} relativePath
 * @returns {string|null}
 */
export function joinPluginDirectoryPath(pluginDirPath, relativePath) {
  if (!isBundlableRelativePluginPath(relativePath)) return null;
  const base = pluginDirPath.replace(/\\/g, "/").replace(/\/$/, "");
  const relative = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return base + "/" + relative;
}

/**
 * Replace `<script src="relative.js">` tags with inline script bodies.
 * @param {string} entryHtml
 * @param {string} pluginDirPath
 * @param {(absolutePath: string) => (string|null|Promise<string|null>)} readTextFile
 * @returns {Promise<string>}
 */
export async function inlineRelativePluginScripts(entryHtml, pluginDirPath, readTextFile) {
  const scriptPattern = /<script\b([^>]*?\ssrc=["']([^"']+)["'][^>]*)>\s*<\/script>/gi;
  const scriptTags = [];
  let match;
  while ((match = scriptPattern.exec(entryHtml)) != null) {
    scriptTags.push({
      full: match[0],
      attrs: match[1],
      src: match[2]
    });
  }

  let html = entryHtml;
  for (let tagIdx = 0; tagIdx < scriptTags.length; tagIdx++) {
    const tag = scriptTags[tagIdx];
    const filePath = joinPluginDirectoryPath(pluginDirPath, tag.src);
    if (filePath == null) continue;
    const body = await readTextFile(filePath);
    if (body == null) continue;
    const attrsWithoutSrc = tag.attrs.replace(/\ssrc=["'][^"']+["']/i, "");
    const inlineTag = "<script" + attrsWithoutSrc + ">\n" + body + "\n</script>";
    html = html.split(tag.full).join(inlineTag);
  }
  return html;
}

/**
 * Replace `<link rel="stylesheet" href="relative.css">` with inline `<style>` blocks.
 * @param {string} entryHtml
 * @param {string} pluginDirPath
 * @param {(absolutePath: string) => (string|null|Promise<string|null>)} readTextFile
 * @returns {Promise<string>}
 */
export async function inlineRelativePluginStylesheets(entryHtml, pluginDirPath, readTextFile) {
  const linkPattern = /<link\b([^>]*?\shref=["']([^"']+)["'][^>]*?)>/gi;
  const linkTags = [];
  let match;
  while ((match = linkPattern.exec(entryHtml)) != null) {
    if (!/\srel=["']stylesheet["']/i.test(match[1])) continue;
    linkTags.push({
      full: match[0],
      href: match[2]
    });
  }

  let html = entryHtml;
  for (let tagIdx = 0; tagIdx < linkTags.length; tagIdx++) {
    const tag = linkTags[tagIdx];
    const filePath = joinPluginDirectoryPath(pluginDirPath, tag.href);
    if (filePath == null) continue;
    const body = await readTextFile(filePath);
    if (body == null) continue;
    html = html.split(tag.full).join("<style>\n" + body + "\n</style>");
  }
  return html;
}

/**
 * Inline sibling JS/CSS from the plugin folder so the iframe never fetches asset:// URLs.
 * @param {string} entryHtml
 * @param {string} pluginDirPath
 * @param {(absolutePath: string) => (string|null|Promise<string|null>)} readTextFile
 * @returns {Promise<string>}
 */
export async function bundleRelativePluginAssets(entryHtml, pluginDirPath, readTextFile) {
  let html = entryHtml;
  html = await inlineRelativePluginScripts(html, pluginDirPath, readTextFile);
  html = await inlineRelativePluginStylesheets(html, pluginDirPath, readTextFile);
  return html;
}

/**
 * Map a Rust discovery record to a runtime plugin spec.
 * @param {DiscoveredSidebarPlugin} discovered
 * @param {(path: string) => string} toAssetUrl
 * @returns {SidebarPluginSpec}
 */
export function buildSidebarPluginSpecFromDiscovery(discovered, toAssetUrl) {
  return {
    id: discovered.id,
    name: discovered.name,
    url: toAssetUrl(discovered.entryPath),
    icon: toAssetUrl(discovered.iconPath),
    width: discovered.width,
    height: discovered.height,
    themed: discovered.themed === true
  };
}

/**
 * Carry the bundled entry HTML on the spec so the panel can render it with
 * `srcdoc`. A document served that way can be sandboxed into an opaque origin,
 * which a `blob:` URL minted by the host cannot.
 * @param {SidebarPluginSpec} pluginSpec
 * @param {string} entryHtml
 * @returns {SidebarPluginSpec}
 */
export function attachPluginEntryHtml(pluginSpec, entryHtml) {
  return Object.assign({}, pluginSpec, { html: entryHtml, sandboxed: true });
}

/**
 * Stable sidebar panel id for a plugin spec.
 * @param {{ id?: string, name?: string }} pluginSpec
 * @returns {string}
 */
export function resolveSidebarPluginPanelId(pluginSpec) {
  const suffix = pluginSpec.id != null && pluginSpec.id !== ""
    ? pluginSpec.id
    : pluginSpec.name;
  return "plg_" + suffix;
}

/**
 * Filter specs whose panel id is not already registered on the sidebar.
 * @param {*} rightSidebar
 * @param {SidebarPluginSpec[]} pluginSpecs
 * @returns {SidebarPluginSpec[]}
 */
export function filterUnregisteredSidebarPluginSpecs(rightSidebar, pluginSpecs) {
  if (rightSidebar == null || pluginSpecs == null || pluginSpecs.length === 0) return [];

  const pendingSpecs = [];
  for (let specIdx = 0; specIdx < pluginSpecs.length; specIdx++) {
    const pluginSpec = pluginSpecs[specIdx];
    const panelId = resolveSidebarPluginPanelId(pluginSpec);
    if (rightSidebar.findEntryByPanelId(panelId) != null) continue;
    pendingSpecs.push(pluginSpec);
  }
  return pendingSpecs;
}
