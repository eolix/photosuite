/**
 * Identifier generation.
 *
 * These identifiers end up inside the files users hand to other people, so what
 * they must not carry matters as much as what they must: no timestamp, no
 * hardware address, no shared prefix or suffix that would link one document to
 * another.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateUuid } from "../../src/core/uid.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("core/uid.js", () => {
  it("produces a well-formed version 4 UUID", () => {
    for (let i = 0; i < 100; i++) {
      assert.match(generateUuid(), UUID_V4, "must be a random-flavoured UUID");
    }
  });

  it("sets the version and variant bits the format requires", () => {
    const uuid = generateUuid();
    // Version nibble opens the third group; the variant bits open the fourth.
    assert.equal(uuid[14], "4", "version 4");
    assert.ok("89ab".includes(uuid[19]), "RFC 4122 variant");
  });

  it("carries no timestamp and no hardware address", () => {
    // A version 1 UUID would repeat its clock and node fields across calls,
    // pinning every identifier to one machine and one moment. Version 4 has
    // no such fields: outside the version and variant nibbles, nothing is
    // shared between two identifiers for long.
    const samples = Array.from({ length: 200 }, generateUuid);
    const tailField = new Set(samples.map((uuid) => uuid.slice(24)));
    assert.equal(tailField.size, samples.length, "the node field must not be fixed");
    const timeFields = new Set(samples.map((uuid) => uuid.slice(9, 18)));
    assert.equal(timeFields.size, samples.length, "the time fields must not be fixed");
  });

  it("does not repeat", () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(generateUuid());
    assert.equal(seen.size, 5000);
  });

  it("shares no prefix or suffix between identifiers", () => {
    // The failure this guards: generating a short random head and pasting it
    // onto one fixed tail, which is both a weak identifier and a fingerprint
    // every saved document would carry.
    const [a, b] = [generateUuid(), generateUuid()];
    assert.notEqual(a.slice(-13), b.slice(-13), "no shared tail");
    assert.notEqual(a.slice(0, 8), b.slice(0, 8), "no shared head");
  });
});
