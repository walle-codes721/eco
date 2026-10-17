import { describe, it, expect } from "vitest";
import { deckSlideNumbers, stepDeckSlide, findDeckPage, arrowDelta } from "../src/deck-preview";
// @ts-expect-error browser mirror
import { deckSlideNumbers as numsBrowser, stepDeckSlide as stepBrowser, findDeckPage as findBrowser, arrowDelta as arrowBrowser } from "../public/js/deck-preview-nav.js";

describe("deck preview carousel", () => {
  const pages = [
    { n: 1, rows: [{ text: "Title", kept: false }] },
    { n: 2, rows: [] },
    { n: 3, rows: [{ text: "End", kept: true }] },
  ];

  it("lists every slide number in order, including pages with no rows", () => {
    expect(deckSlideNumbers(pages)).toEqual([1, 2, 3]);
    expect(numsBrowser(pages)).toEqual([1, 2, 3]);
  });

  it("steps across slides with arrow keys and stops at the first and last", () => {
    const nums = deckSlideNumbers(pages);
    expect(stepDeckSlide(nums, 2, -1)).toBe(1);
    expect(stepDeckSlide(nums, 2, 1)).toBe(3);
    expect(stepDeckSlide(nums, 1, -1)).toBe(1);
    expect(stepDeckSlide(nums, 3, 1)).toBe(3);
    expect(stepBrowser(nums, 2, -1)).toBe(1);
  });

  it("turns arrow keys into a slide step, but leaves them to the language select and text fields", () => {
    for (const f of [arrowDelta, arrowBrowser]) {
      expect(f("ArrowLeft", "DIV")).toBe(-1);
      expect(f("ArrowRight", "BUTTON")).toBe(1);
      expect(f("ArrowRight", "INPUT", "checkbox")).toBe(1); // a checkbox has no use for arrows
      expect(f("ArrowLeft", "SELECT")).toBe(0);
      expect(f("ArrowLeft", "INPUT", "text")).toBe(0);
      expect(f("Enter", "DIV")).toBe(0);
    }
  });

  it("finds a page by slide number, or treats a missing page as empty rows", () => {
    expect(findDeckPage(pages, 2).rows).toEqual([]);
    expect(findDeckPage(pages, 99)).toEqual({ n: 99, rows: [] });
    expect(findBrowser(pages, 2).rows).toEqual([]);
  });
});
