/** One text run from the PDF layer, in page coordinates (pdf.js). `y` is the baseline. */
export type SlideGlyph = { text: string; x: number; y: number; w: number; h: number };

export type SlideRow = { text: string; box: { x: number; y: number; w: number; h: number }; kept: boolean };

/** pdf.js puts the baseline in `y`; tolerance scales with the larger of the two glyphs. */
function baseline(g: SlideGlyph) {
  return g.y;
}

function yTol(a: SlideGlyph, b: SlideGlyph) {
  return Math.max(2, Math.max(a.h, b.h) * 0.15);
}

function unionBox(a: SlideRow["box"], b: SlideGlyph): SlideRow["box"] {
  const x2 = b.x + b.w;
  const y2 = b.y + b.h;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(ax2, x2) - x, h: Math.max(ay2, y2) - y };
}

function wideGapThreshold(line: SlideGlyph[], gaps: number[]) {
  const minH = Math.min(...line.map((g) => g.h));
  const fromHeight = minH * 0.35 * 4;
  if (!gaps.length) return fromHeight;
  if (gaps.length === 1) return fromHeight;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(fromHeight, median * 2.5);
}

/** Groups glyphs into rows: one baseline, split when the horizontal gap is clearly wider than word spacing. */
export function groupRows(glyphs: SlideGlyph[]): SlideRow[] {
  const items = glyphs.map((g) => ({ ...g, text: g.text.replace(/\s+/g, " ").trim() })).filter((g) => g.text);
  if (!items.length) return [];
  items.sort((a, b) => baseline(b) - baseline(a) || a.x - b.x);

  const lines: SlideGlyph[][] = [];
  for (const g of items) {
    const line = lines.find((row) => Math.abs(baseline(row[0]) - baseline(g)) <= yTol(row[0], g));
    if (line) line.push(g);
    else lines.push([g]);
  }

  const rows: SlideRow[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    const gaps = line.slice(1).map((glyph, i) => glyph.x - (line[i].x + line[i].w));
    const wide = wideGapThreshold(line, gaps.filter((d) => d > 0));

    let chunk: SlideGlyph[] = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const gap = line[i].x - (line[i - 1].x + line[i - 1].w);
      if (gap > wide) {
        rows.push(finish(chunk));
        chunk = [line[i]];
      } else chunk.push(line[i]);
    }
    rows.push(finish(chunk));
  }
  return rows;
}

function finish(chunk: SlideGlyph[]): SlideRow {
  let box = { x: chunk[0].x, y: chunk[0].y, w: chunk[0].w, h: chunk[0].h };
  const parts = [chunk[0].text];
  for (let i = 1; i < chunk.length; i++) {
    parts.push(chunk[i].text);
    box = unionBox(box, chunk[i]);
  }
  return { text: parts.join(" "), box, kept: false };
}

/** Included rows only — kept rows stay in the deck's language and are not sent for translation. */
export function rowsForTranslation(rows: SlideRow[]): string[] {
  return rows.filter((r) => !r.kept).map((r) => r.text);
}

/** `skip`: the speaker chose to leave this whole slide untranslated. The rows stay stored so the choice can be undone. */
export type DeckPageRows = { n: number; rows: SlideRow[]; skip?: boolean };

export const DEFAULT_DECK_LANG = "en";

export function deckLang(code: unknown): string {
  const s = String(code ?? DEFAULT_DECK_LANG).trim().slice(0, 20);
  return /^[a-z]{2}(-[A-Za-z]{4})?(-[A-Za-z]{2})?$/.test(s) ? s : DEFAULT_DECK_LANG;
}

function sanitizeRow(raw: unknown): SlideRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = String(r.text ?? "").slice(0, 4000).trim();
  if (!text) return null;
  const b = r.box as Record<string, unknown> | undefined;
  const box = {
    x: Number(b?.x) || 0,
    y: Number(b?.y) || 0,
    w: Math.max(0, Number(b?.w) || 0),
    h: Math.max(0, Number(b?.h) || 0),
  };
  return { text, box, kept: !!r.kept };
}

/** Host POST body: cap size and drop empty rows. */
export function sanitizeDeckPages(input: unknown): DeckPageRows[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 200).map((p, i) => {
    const n = Math.max(1, Math.min(200, Number((p as { n?: number })?.n) || i + 1));
    const rows = (Array.isArray((p as { rows?: unknown[] })?.rows) ? (p as { rows: unknown[] }).rows : [])
      .slice(0, 400)
      .map(sanitizeRow)
      .filter((r): r is SlideRow => !!r);
    return (p as { skip?: unknown })?.skip ? { n, rows, skip: true } : { n, rows };
  });
}
