/**
 * Unique identifiers.
 *
 * Placed items, linked files, patterns, swatch folders and presets are each
 * identified by a UUID in the descriptor tree, and two of them colliding means
 * one silently stands in for the other.
 */

/**
 * A random (version 4) UUID.
 *
 * Version 4 is 122 bits of randomness carrying neither a timestamp nor a
 * hardware address, so an identifier says nothing about the machine or the
 * moment that produced it.
 *
 * @returns {string} e.g. `339561f5-f162-4a15-ae6b-47ff292cfdc0`
 */
export function generateUuid() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

let nextUniqueId = 0;

/** Monotonic integer id for in-session objects (layers, widgets, etc.). */
export function allocateNextUniqueId() {
  nextUniqueId += 1;
  return nextUniqueId;
}
