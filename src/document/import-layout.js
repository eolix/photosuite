// Shared import-sizing helpers: clamp oversized imported documents to the pixel
// budget (with a user confirm) and read a bounds rect from a {x,y,width,height}
// frame. Used by the vector / app-document loaders (AI, CDR, XD).
import { Rect } from "../core/math/rect.js";
import { confirmUser } from "../core/user-prompts.js";

/** Photoshop / canvas hard limit used when computing import downscale. */
const MAX_IMPORT_EDGE_PX = 30_000;

function exceedsPixelBudget(width, height, maxPixels) {
  return width * height > maxPixels;
}

function exceedsMaxEdge(width, height) {
  return Math.max(width, height) > MAX_IMPORT_EDGE_PX;
}

function scaledDimensions(boundsRect, scale) {
  return {
    width: Math.round(boundsRect.width / scale),
    height: Math.round(boundsRect.height / scale),
  };
}

/**
 * Find the smallest integer downscale factor so the document fits `maxPixels`
 * and neither edge exceeds {@link MAX_IMPORT_EDGE_PX}. Prompts the user when
 * downscaling would be applied.
 */
function computeDocumentDownscale(boundsRect, maxPixels) {
  let scale = 1;
  let scaled = scaledDimensions(boundsRect, scale);

  while (exceedsPixelBudget(scaled.width, scaled.height, maxPixels) || exceedsMaxEdge(scaled.width, scaled.height)) {
    scale++;
    scaled = scaledDimensions(boundsRect, scale);
  }

  if (scale !== 1) {
    const keepOriginalSize = !confirmUser(
      "Your image is quite large (" +
        boundsRect.width +
        " x " +
        boundsRect.height +
        " px).\n" +
        "Press OK to scale it down " +
        scale +
        "x, or Cancel to keep the size.",
    );
    if (keepOriginalSize) scale = 1;
  }

  return scale;
}

function readRect(frame) {
  return new Rect(frame.x, frame.y, frame.width, frame.height);
}

const ImportLayout = {
  computeDocumentDownscale,
  readRect,
};

export { ImportLayout, computeDocumentDownscale, readRect };
