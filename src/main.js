/**
 * Application entry: run startup wiring, give the layer system its GL context,
 * register format loaders, bootstrap the UI shell, and initialise system fonts
 * before first paint.
 */

import "./core/startup-wiring.js";

import { initLayerSystemGl } from "./engine/layer-system.js";
import { FileFormatRegistry } from "./document/formats/registry/file-format-registry.js";
import { VectorPageExporter } from "./document/formats/vector-page-exporter.js";
import { VectorPageBuilder } from "./document/formats/vector-page-builder.js";
import { PathRecordCodec } from "./document/formats/psd/path-record-codec.js";
import { ChannelImageCodec } from "./document/formats/psd/channel-image-codec.js";
import { PSDParser } from "./document/formats/psd/psd-parser.js";

import "./ui/config/popup-type-parsers.js";
import "./ui/ui.js";

import { initSystemFontsAsDefault } from "./fonts/system-font-catalog.js";
import { precomputeFilterGalleryThumbnails } from "./ui/filter-panels/filter-gallery-thumbnail-panel.js";

// Loader bag for FileFormatRegistry.installLoaders. Kept here (not inside the
// registry module) so format loaders never import the registry and close a cycle.
//
// Only what every open needs. A format's own parser is fetched the first time
// someone opens that kind of file — see
// `document/formats/registry/format-loader-imports.js`.
//
// PSDParser is the exception: smart objects, layer extraction and embedded AI
// patterns encode through it from synchronous code that has no chance to await
// an import, whatever format the open document is, so it ships here.
function buildFileFormatLoaderBag() {
  return {
    VectorPageExporter,
    VectorPageBuilder,
    PathRecordCodec,
    ChannelImageCodec,
    PSDParser,
  };
}

function wireFileFormatLoaders() {
  FileFormatRegistry.installLoaders(buildFileFormatLoaderBag());
}

// Defer system-font discovery so the first paint is not blocked on Tauri FS.
function scheduleSystemFontCatalogInit() {
  setTimeout(() => {
    initSystemFontsAsDefault().catch((error) => {
      console.warn("PhotoSuite: system font init failed", error);
    });
  }, 0);
}

// Warm the filter-gallery thumbnails after first paint so opening the gallery is
// instant: read from the persistent store when available, otherwise render once and
// save for later runs. Deferred and best-effort: if the sample image or filters are
// not ready yet it is a no-op and the gallery renders them lazily on first open.
function scheduleFilterGalleryThumbnailPrecompute() {
  setTimeout(() => {
    Promise.resolve()
      .then(precomputeFilterGalleryThumbnails)
      .catch((error) => {
        console.warn("PhotoSuite: filter gallery thumbnail precompute failed", error);
      });
  }, 0);
}

function bootstrapApp() {
  // The layer system renders on the GPU once it has a canvas; before this it
  // reports WebGL off and the CPU paths run.
  initLayerSystemGl();
  wireFileFormatLoaders();
  scheduleSystemFontCatalogInit();
  scheduleFilterGalleryThumbnailPrecompute();
}

bootstrapApp();
