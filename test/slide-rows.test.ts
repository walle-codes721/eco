import { describe, it, expect } from "vitest";
import {
  groupRows,
  rowsForTranslation,
  deckLang,
  sanitizeDeckPages,
  type SlideGlyph,
} from "../src/slide-rows";
// @ts-expect-error browser module tested for parity with src/slide-rows.ts
import { groupRows as groupRowsBrowser } from "../public/js/slide-rows.js";

const g = (text: string, x: number, y: number, w: number, h = 12): SlideGlyph => ({ text, x, y, w, h });

const groupingFixtures: SlideGlyph[][] = [
  [g("Hello", 10, 100, 40), g("world", 55, 100, 42)],
  [g("Stage", 10, 100, 50), g("Counter", 200, 100, 60)],
  [g("BIG", 10, 200, 80, 48), g("small", 95, 200, 40, 12)],
  [],
];

describe("slide rows", () => {
  it("keeps words on one baseline with ordinary spaces as one row", () => {
    const rows = groupRows([g("Hello", 10, 100, 40), g("world", 55, 100, 42)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Hello world");
    expect(rows[0].kept).toBe(false);
    expect(rows[0].box).toMatchObject({ x: 10, y: 100, w: 87 });
  });

  it("starts another row when a baseline has a wide gap", () => {
    const rows = groupRows([g("Stage", 10, 100, 50), g("Counter", 200, 100, 60)]);
    expect(rows.map((r) => r.text)).toEqual(["Stage", "Counter"]);
  });

  it("keeps different font sizes on the same pdf.js baseline as one row", () => {
    const rows = groupRows([g("BIG", 10, 200, 80, 48), g("small", 95, 200, 40, 12)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("BIG small");
  });

  it("returns no rows when a page has no glyphs", () => {
    expect(groupRows([])).toEqual([]);
  });

  it("omits a kept row from what would be translated", () => {
    const rows = [
      { text: "To be or not to be", box: { x: 0, y: 0, w: 10, h: 10 }, kept: true },
      { text: "Our product", box: { x: 0, y: 20, w: 10, h: 10 }, kept: false },
    ];
    expect(rowsForTranslation(rows)).toEqual(["Our product"]);
  });

  it("accepts BCP47 deck language tags the speaker may choose", () => {
    expect(deckLang("zh-Hans")).toBe("zh-Hans");
    expect(deckLang("en")).toBe("en");
    expect(deckLang("not-a-lang")).toBe("en");
  });

  it("stores sanitized deck pages from the preview POST body", () => {
    const pages = sanitizeDeckPages([{
      n: 1,
      rows: [{ text: "Hello", box: { x: 1, y: 2, w: 3, h: 4 }, kept: true }, { text: "", box: { x: 0, y: 0, w: 0, h: 0 }, kept: false }],
    }]);
    expect(pages).toEqual([{ n: 1, rows: [{ text: "Hello", box: { x: 1, y: 2, w: 3, h: 4 }, kept: true }] }]);
  });

  it("groups glyphs the same in the browser module as on the server", () => {
    for (const glyphs of groupingFixtures) {
      expect(groupRowsBrowser(glyphs)).toEqual(groupRows(glyphs));
    }
  });
});
