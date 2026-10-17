import type { SlideRow } from "./slide-rows";

const langBase = (code: string) => code.toLowerCase().split("-")[0];

/** Listener chose the PDF as designed (switch on), or already reads in the deck language. */
export function showDesignedPage(listenerLang: string, deckLang: string, viewDesigned: boolean): boolean {
  return langBase(listenerLang) === langBase(deckLang) || viewDesigned;
}

/** Hide the designed <-> translated switch when the listener already sees the designed page. */
export function slideViewToggleVisible(listenerLang: string, deckLang: string): boolean {
  return langBase(listenerLang) !== langBase(deckLang);
}

/** Slides that still need a translation call: current, next, with included rows, not already stored. */
export function slidesToTranslate(
  currentSlide: number,
  deckCount: number,
  stored: ReadonlySet<number>,
  includedRowCount: (slideN: number) => number,
): number[] {
  return [currentSlide, currentSlide + 1]
    .filter((n) => n >= 1 && n <= deckCount && !stored.has(n) && includedRowCount(n) > 0);
}

/** Languages to translate into: every room language and English (always offered to listeners), minus the deck's own. */
export function slideTargetLangs(roomLangs: string[], deckLang: string): string[] {
  const deck = langBase(deckLang);
  return [...new Set(["en", ...roomLangs])].filter((l) => langBase(l) !== deck);
}

/** Keeps each language whose result has one non-empty string per included row; a bad language falls back alone. */
export function parseSlideTranslation(raw: unknown, langs: string[], rowCount: number): Record<string, string[]> | null {
  if (!raw || typeof raw !== "object" || rowCount < 1) return null;
  const out = (raw as { out?: unknown }).out;
  if (!out || typeof out !== "object") return null;
  const parsed: Record<string, string[]> = {};
  for (const lang of langs) {
    const v = (out as Record<string, unknown>)[lang];
    if (!Array.isArray(v) || v.length !== rowCount) continue;
    const rows = v.map((s) => String(s ?? "").trim());
    if (rows.some((s) => !s)) continue;
    parsed[lang] = rows;
  }
  return Object.keys(parsed).length ? parsed : null;
}

export type RowPaint = { paint: string | null };

/** Per row: translated text to paint, or null to leave the PDF words (kept, deck language, or missing). */
export function rowTranslationTexts(
  rows: SlideRow[],
  byLang: Record<string, string[]> | undefined,
  listenerLang: string,
  deckLang: string,
): RowPaint[] {
  if (langBase(listenerLang) === langBase(deckLang)) {
    return rows.map(() => ({ paint: null }));
  }
  const tr = byLang?.[listenerLang];
  let i = 0;
  return rows.map((row) => {
    if (row.kept) return { paint: null };
    const text = tr?.[i];
    i++;
    return { paint: text ?? null };
  });
}

/** Where a row sits on the canvas. pdf.js box: `y` is the baseline from the page bottom, `h` the glyph height. */
export function rowRectOnCanvas(
  box: { x: number; y: number; w: number; h: number },
  page: { pageW: number; pageH: number; canvasW: number; canvasH: number },
): { x: number; y: number; w: number; h: number } {
  const sx = page.canvasW / page.pageW;
  const sy = page.canvasH / page.pageH;
  const descent = box.h * 0.25;
  return {
    x: box.x * sx,
    y: (page.pageH - (box.y + box.h)) * sy,
    w: box.w * sx,
    h: (box.h + descent) * sy,
  };
}

const normHex = (s: string) => {
  const m = s.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toLowerCase()}` : null;
};

/** Flat cover color from samples just outside the row box, or null when they disagree. */
export function agreeCoverColor(samples: string[]): string | null {
  if (samples.length < 4) return null;
  const norm = samples.map(normHex);
  if (norm.some((c) => !c)) return null;
  return norm.every((c) => c === norm[0]) ? norm[0]! : null;
}

/** Black or white ink that reads on a flat cover fill. */
export function inkOnCover(hex: string): "black" | "white" {
  const m = normHex(hex)?.slice(1);
  if (!m) return "black";
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "black" : "white";
}
