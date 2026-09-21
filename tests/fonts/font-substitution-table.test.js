/**
 * Golden smoke for the extracted font substitution priority table.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fontSubstitutionTable } from "../../src/fonts/font-substitution-table.js";

describe("fonts/font-substitution-table.js", () => {
  it("maps ArialMT to Liberation/DejaVu priority list", () => {
    assert.deepEqual(fontSubstitutionTable.ArialMT, ["LiberationSans", "DejaVuSans"]);
  });

  it("reuses shared sansRegular priority for Inter family aliases", () => {
    assert.deepEqual(fontSubstitutionTable.Inter, [
      "ArialMT",
      "Helvetica",
      "HelveticaNeue",
      "LiberationSans",
      "DejaVuSans",
    ]);
    assert.equal(fontSubstitutionTable.Inter, fontSubstitutionTable["Inter-Regular"]);
  });

  it("keeps Exo / Exo2 family aliases", () => {
    assert.ok(Array.isArray(fontSubstitutionTable.Exo));
    assert.ok(Array.isArray(fontSubstitutionTable.Exo2));
  });
});
