/**
 * Growable byte buffer for encode/decode writers (PSD, codecs, file I/O).
 * {@link RenderBuffer} allocates backing storage via {@link allocBuffer}.
 */

import { allocBuffer } from "../engine/compositing/buffer-utils.js";

var INITIAL_CAPACITY = 16;

/**
 * Growable byte buffer for encode/decode writers (PSD, codecs, file I/O).
 * Backed by a {@link Uint8Array} from {@link allocBuffer}.
 */
function RenderBuffer() {
  this.size = INITIAL_CAPACITY;
  this.data = allocBuffer(INITIAL_CAPACITY);
}

/**
 * Ensures at least `offset + byteCount` bytes are available, growing by doubling
 * when needed and copying existing bytes into a new allocation.
 */
RenderBuffer.prototype.ensureCapacity = function (offset, byteCount) {
  var required = offset + byteCount;
  if (required <= this.size) return;

  var oldSize = this.size;
  while (required > this.size) {
    this.size *= 2;
  }

  var grown = allocBuffer(this.size);
  grown.set(this.data.subarray(0, oldSize));
  this.data = grown;
};

export { RenderBuffer };
