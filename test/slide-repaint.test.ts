import { describe, it, expect } from "vitest";
import {
  slidesToTranslate,
  slideTargetLangs,
  parseSlideTranslation,
  rowTranslationTexts,
  agreeCoverColor,
  inkOnCover,
} from "../src/slide-repaint";
import type { SlideRow } from "../src/slide-rows";
// @ts-expect-error browser parity
import { agreeCoverColor as agreeCoverBrowser, inkOnCover as inkOnCoverBrowser } from "../public/js/slide-repaint.js";

describe("slide repaint", () => {
  it("translates only the current slide and the next when nothing is stored yet", () => {
    expect(slidesToTranslate(3, 10, new Set(), (n) => (n === 3 || n === 4 ? 2 : 0))).toEqual([3, 4]);
    expect(slidesToTranslate(3, 10, new Set([3]), (n) => (n === 3 || n === 4 ? 2 : 0))).toEqual([4]);
    expect(slidesToTranslate(10, 10, new Set(), (n) => (n === 10 ? 1 : 0))).toEqual([10]);
  });

  it("skips slides with no included rows and slides already stored", () => {
    expect(slidesToTranslate(2, 5, new Set([2, 3]), () => 1)).toEqual([]);
    expect(slidesToTranslate(2, 5, new Set(), (n) => (n === 2 ? 0 : 1))).toEqual([3]);
  });

  it("targets every room language other than the deck language", () => {
    expect(slideTargetLangs(["it", "es", "hi"], "en")).toEqual(["it", "es", "hi"]);
    expect(slideTargetLangs(["it", "es"], "it")).toEqual(["es"]);
  });

  it("accepts model output with one string per included row in each language", () => {
    const parsed = parseSlideTranslation({ out: { it: ["Ciao", "Mondo"], es: ["Hola", "Mundo"] } }, ["it", "es"], 2);
    expect(parsed).toEqual({ it: ["Ciao", "Mondo"], es: ["Hola", "Mundo"] });
  });

  it("rejects the wrong number of row strings", () => {
    expect(parseSlideTranslation({ out: { it: ["Only one"] } }, ["it"], 2)).toBeNull();
  });

  it("falls back to the printed row when a language is missing from the result", () => {
    const rows: SlideRow[] = [
      { text: "Hello", box: { x: 0, y: 0, w: 1, h: 1 }, kept: false },
      { text: "Quote", box: { x: 0, y: 0, w: 1, h: 1 }, kept: true },
    ];
    expect(rowTranslationTexts(rows, { it: ["Ciao"] }, "it", "en")).toEqual([{ paint: "Ciao" }, { paint: null }]);
    expect(rowTranslationTexts(rows, { es: ["Hola"] }, "it", "en")).toEqual([{ paint: null }, { paint: null }]);
    expect(rowTranslationTexts(rows, { it: ["Ciao"] }, "en", "en")).toEqual([{ paint: null }, { paint: null }]);
  });

  it("covers a row when the outside samples agree, and leaves it when they do not", () => {
    expect(agreeCoverColor(["#ffffff", "#ffffff", "#ffffff", "#ffffff"])).toBe("#ffffff");
    expect(agreeCoverColor(["#ffffff", "#112233", "#ffffff", "#ffffff"])).toBeNull();
    expect(inkOnCover("#ffffff")).toBe("black");
    expect(inkOnCover("#111111")).toBe("white");
  });

  it("matches cover helpers in the browser module", () => {
    expect(agreeCoverBrowser(["#ff0000", "#ff0000", "#ff0000", "#ff0000"])).toBe("#ff0000");
    expect(inkOnCoverBrowser("#ff0000")).toBe(inkOnCover("#ff0000"));
  });
});
