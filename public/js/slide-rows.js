/** Keep in sync with src/slide-rows.ts — parity checked in test/slide-rows.test.ts */

function baseline(g) {
  return g.y;
}

function yTol(a, b) {
  return Math.max(2, Math.max(a.h, b.h) * 0.15);
}

function unionBox(a, b) {
  const x2 = b.x + b.w;
  const y2 = b.y + b.h;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(ax2, x2) - x, h: Math.max(ay2, y2) - y };
}

function wideGapThreshold(line, gaps) {
  const minH = Math.min(...line.map((g) => g.h));
  const fromHeight = minH * 0.35 * 4;
  if (!gaps.length) return fromHeight;
  if (gaps.length === 1) return fromHeight;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.max(fromHeight, median * 2.5);
}

export function groupRows(glyphs) {
  const items = glyphs.map((g) => ({ ...g, text: g.text.replace(/\s+/g, " ").trim() })).filter((g) => g.text);
  if (!items.length) return [];
  items.sort((a, b) => baseline(b) - baseline(a) || a.x - b.x);

  const lines = [];
  for (const g of items) {
    const line = lines.find((row) => Math.abs(baseline(row[0]) - baseline(g)) <= yTol(row[0], g));
    if (line) line.push(g);
    else lines.push([g]);
  }

  const rows = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    const gaps = line.slice(1).map((glyph, i) => glyph.x - (line[i].x + line[i].w));
    const wide = wideGapThreshold(line, gaps.filter((d) => d > 0));

    let chunk = [line[0]];
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

function finish(chunk) {
  let box = { x: chunk[0].x, y: chunk[0].y, w: chunk[0].w, h: chunk[0].h };
  const parts = [chunk[0].text];
  for (let i = 1; i < chunk.length; i++) {
    parts.push(chunk[i].text);
    box = unionBox(box, chunk[i]);
  }
  return { text: parts.join(" "), box, kept: false };
}

export function rowsForTranslation(rows) {
  return rows.filter((r) => !r.kept).map((r) => r.text);
}
