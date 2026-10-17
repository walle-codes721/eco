import { rowsForTranslation, type SlideRow } from "./slide-rows";

const langBase = (code: string) => code.toLowerCase().split("-")[0];

/** Listener chose the PDF as designed (switch on), or already reads in the deck language. */
export function showDesignedPage(listenerLang: string, deckLang: string, viewDesigned: boolean): boolean {
  return langBase(listenerLang) === langBase(deckLang) || viewDesigned;
}

/** Whether translated row text should be painted on the canvas. */
export function shouldPaintSlide(listenerLang: string, deckLang: string, viewDesigned: boolean): boolean {
  return !showDesignedPage(listenerLang, deckLang, viewDesigned);
}

/** Hide the designed ↔ translated switch when the listener already sees the designed page. */
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

/** Room languages to translate into, excluding the deck's language. */
export function slideTargetLangs(roomLangs: string[], deckLang: string): string[] {
  const deck = deckLang.toLowerCase().split("-")[0];
  return [...new Set(roomLangs)].filter((l) => l.toLowerCase().split("-")[0] !== deck);
}

/** Validates slide translation JSON: one non-empty string per included row, per language. */
export function parseSlideTranslation(raw: unknown, langs: string[], rowCount: number): Record<string, string[]> | null {
  if (!raw || typeof raw !== "object" || rowCount < 1) return null;
  const out = (raw as { out?: unknown }).out;
  if (!out || typeof out !== "object") return null;
  const parsed: Record<string, string[]> = {};
  for (const lang of langs) {
    const v = (out as Record<string, unknown>)[lang];
    if (!Array.isArray(v) || v.length !== rowCount) return null;
    const rows = v.map((s) => String(s ?? "").trim()).filter(Boolean);
    if (rows.length !== rowCount) return null;
    parsed[lang] = rows;
  }
  return parsed;
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
  const included = rowsForTranslation(rows);
  const tr = byLang?.[listenerLang];
  let i = 0;
  return rows.map((row) => {
    if (row.kept) return { paint: null };
    const text = tr?.[i];
    i++;
    return { paint: text ?? null };
  });
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
