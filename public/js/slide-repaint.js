/** Keep in sync with src/slide-repaint.ts: test/slide-repaint.test.ts checks every exported helper against it. */

const langBase = (code) => code.toLowerCase().split("-")[0];

export function showDesignedPage(listenerLang, deckLang, viewDesigned) {
  return langBase(listenerLang) === langBase(deckLang) || viewDesigned;
}

export function slideViewToggleVisible(listenerLang, deckLang) {
  return langBase(listenerLang) !== langBase(deckLang);
}

export function rowRectOnCanvas(box, page) {
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

const normHex = (s) => {
  const m = s.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toLowerCase()}` : null;
};

export function agreeCoverColor(samples) {
  if (samples.length < 4) return null;
  const norm = samples.map(normHex);
  if (norm.some((c) => !c)) return null;
  return norm.every((c) => c === norm[0]) ? norm[0] : null;
}

export function inkOnCover(hex) {
  const m = normHex(hex)?.slice(1);
  if (!m) return "black";
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.62 ? "black" : "white";
}

/** Paint translated row text onto a rendered PDF canvas. `canvas._pdfBaseW/_pdfBaseH` are the page size in PDF units. */
export function paintSlideRows(canvas, pageRows, paints) {
  const ctx = canvas.getContext("2d");
  const pageW = canvas._pdfBaseW;
  const pageH = canvas._pdfBaseH;
  if (!ctx || !pageW || !pageH) return;
  const page = { pageW, pageH, canvasW: canvas.width, canvasH: canvas.height };
  const pad = 2 * Math.min(canvas.width / pageW, canvas.height / pageH);
  const font = (size) => `${size}px system-ui, sans-serif`; // the type the phone already uses, so Hindi renders
  for (let i = 0; i < pageRows.length; i++) {
    const text = paints[i]?.paint;
    if (!text) continue;
    const { x, y, w, h } = rowRectOnCanvas(pageRows[i].box, page);
    const samples = [
      sample(ctx, x - pad, y + h / 2),
      sample(ctx, x + w + pad, y + h / 2),
      sample(ctx, x + w / 2, y - pad),
      sample(ctx, x + w / 2, y + h + pad),
    ];
    const fill = agreeCoverColor(samples);
    if (!fill) continue;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = inkOnCover(fill);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = h * 0.8;
    ctx.font = font(size);
    while (size > 6 && ctx.measureText(text).width > w * 0.95) {
      size -= 1;
      ctx.font = font(size);
    }
    ctx.fillText(text, x + w / 2, y + h / 2, w * 0.95);
  }
}

function sample(ctx, px, py) {
  const x = Math.max(0, Math.min(ctx.canvas.width - 1, Math.floor(px)));
  const y = Math.max(0, Math.min(ctx.canvas.height - 1, Math.floor(py)));
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
