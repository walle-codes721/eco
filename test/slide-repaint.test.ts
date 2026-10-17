import { describe, it, expect } from "vitest";
import {
  slidesToTranslate,
  slideTargetLangs,
  parseSlideTranslation,
  rowTranslationTexts,
  agreeCoverColor,
  inkOnCover,
  showDesignedPage,
  slideViewToggleVisible,
  rowRectOnCanvas,
} from "../src/slide-repaint";
import { rowsForTranslation, type SlideRow } from "../src/slide-rows";
import {
  agreeCoverColor as agreeCoverBrowser,
  inkOnCover as inkOnCoverBrowser,
  showDesignedPage as showDesignedBrowser,
  slideViewToggleVisible as toggleBrowser,
  rowRectOnCanvas as rectBrowser,
  // @ts-expect-error browser parity
} from "../public/js/slide-repaint.js";
// @ts-expect-error browser parity
import { rowsForTranslation as rowsForTranslationBrowser } from "../public/js/slide-rows.js";

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
  });

  it("offers English to listeners of a deck that is not in English", () => {
    expect(slideTargetLangs(["it", "es"], "it")).toEqual(["en", "es"]);
    expect(slideTargetLangs(["it"], "zh-Hans")).toEqual(["en", "it"]);
  });

  it("accepts model output with one string per included row in each language", () => {
    const parsed = parseSlideTranslation({ out: { it: ["Ciao", "Mondo"], es: ["Hola", "Mundo"] } }, ["it", "es"], 2);
    expect(parsed).toEqual({ it: ["Ciao", "Mondo"], es: ["Hola", "Mundo"] });
  });

  it("rejects the wrong number of row strings", () => {
    expect(parseSlideTranslation({ out: { it: ["Only one"] } }, ["it"], 2)).toBeNull();
  });

  it("keeps the good languages when one language is missing or has the wrong count", () => {
    expect(parseSlideTranslation({ out: { it: ["Ciao", "Mondo"], hi: ["सिर्फ़ एक"] } }, ["it", "es", "hi"], 2))
      .toEqual({ it: ["Ciao", "Mondo"] });
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

  it("shows the designed page when the listener language is the deck language or the switch is on", () => {
    expect(showDesignedPage("en", "en", false)).toBe(true);
    expect(showDesignedPage("it", "en", true)).toBe(true);
    expect(showDesignedPage("it", "en", false)).toBe(false);
  });

  it("offers the slide view switch only when the listener language is not the deck language", () => {
    expect(slideViewToggleVisible("en", "en")).toBe(false);
    expect(slideViewToggleVisible("it", "en")).toBe(true);
    expect(slideViewToggleVisible("hi", "en")).toBe(true);
  });

  it("places a row on the canvas using the page's own width and height", () => {
    // A 600x400 pt page drawn at 2x onto a 1200x800 canvas: x and width double, y flips from the bottom.
    const r = rowRectOnCanvas({ x: 50, y: 300, w: 100, h: 20 }, { pageW: 600, pageH: 400, canvasW: 1200, canvasH: 800 });
    expect(r.x).toBe(100);
    expect(r.w).toBe(200);
    expect(r.y + r.h).toBeGreaterThanOrEqual((400 - 300) * 2); // covers the baseline
    expect(r.y).toBeLessThan((400 - 300 - 20) * 2 + 1); // reaches the top of the glyphs
  });

  it("extends the cover below the baseline so descenders are covered", () => {
    const base = { pageW: 100, pageH: 100, canvasW: 100, canvasH: 100 };
    const r = rowRectOnCanvas({ x: 0, y: 50, w: 10, h: 10 }, base);
    expect(r.y + r.h).toBeGreaterThan(50); // below the baseline at pdf y=50 (canvas y=50)
  });

  it("gives the browser the same answers as the server for every mirrored helper", () => {
    expect(agreeCoverBrowser(["#ff0000", "#ff0000", "#ff0000", "#ff0000"])).toBe("#ff0000");
    expect(inkOnCoverBrowser("#ff0000")).toBe(inkOnCover("#ff0000"));
    expect(showDesignedBrowser("it", "en", true)).toBe(showDesignedPage("it", "en", true));
    expect(showDesignedBrowser("en", "en", false)).toBe(showDesignedPage("en", "en", false));
    expect(toggleBrowser("it", "en")).toBe(slideViewToggleVisible("it", "en"));
    const box = { x: 50, y: 300, w: 100, h: 20 };
    const page = { pageW: 600, pageH: 400, canvasW: 1200, canvasH: 800 };
    expect(rectBrowser(box, page)).toEqual(rowRectOnCanvas(box, page));
    const rows: SlideRow[] = [
      { text: "a", box, kept: true },
      { text: "b", box, kept: false },
    ];
    expect(rowsForTranslationBrowser(rows)).toEqual(rowsForTranslation(rows));
  });
});
