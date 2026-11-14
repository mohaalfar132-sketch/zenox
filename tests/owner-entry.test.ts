import { describe, expect, it } from "vitest";
import { isOwnerEntryWord } from "../lib/owner-entry";

describe("the hidden owner door", () => {
  it("opens for ZANOX in capitals only", () => {
    expect(isOwnerEntryWord("ZANOX")).toBe(true);
    expect(isOwnerEntryWord("  ZANOX  ")).toBe(true);
  });

  it("ignores lowercase, near-misses and the platform name", () => {
    for (const value of ["zanox", "Zanox", "ZENOX", "ZANOX1", "XZANOX", "", "ضيف"]) {
      expect(isOwnerEntryWord(value)).toBe(false);
    }
  });
});
