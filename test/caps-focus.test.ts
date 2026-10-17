// @ts-nocheck — imports a browser module.
import { describe, expect, it } from "vitest";
import { focusIndex } from "../public/js/caps.js";

const r = (bottom: number) => ({ bottom });

describe("focusIndex", () => {
  it("follows the latest line while following live", () => {
    expect(focusIndex([r(100), r(200), r(900)], 300, true)).toBe(2);
  });
  it("picks the bottom-most fully visible line while reading history", () => {
    expect(focusIndex([r(100), r(200), r(400)], 300, false)).toBe(1);
  });
  it("falls back to the first line when none is fully visible", () => {
    expect(focusIndex([r(500), r(600)], 300, false)).toBe(0);
  });
  it("has no focus with no lines", () => {
    expect(focusIndex([], 300, true)).toBe(-1);
  });
});
