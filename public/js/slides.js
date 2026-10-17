// Slides: the speaker's PDF, uploaded to Eco (R2) and cached in IndexedDB, rendered with pdf.js.
// Rooms without an uploaded PDF fall back to text slides built from the room's page text.
import { h } from "/js/eco.js";
import { groupRows } from "/js/slide-rows.js";
import { docxText } from "/js/script.js";

let pdfjs;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import("/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  }
  return pdfjs;
}

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("eco", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("decks");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveDeck(id, bytes) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const tx = d.transaction("decks", "readwrite");
      tx.objectStore("decks").put(bytes, id);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  } catch {}
}
export async function loadDeck(id) {
  try {
    const d = await db();
    return await new Promise((res) => {
      const r = d.transaction("decks").objectStore("decks").get(id);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export async function openPdf(bytes) {
  const { getDocument } = await lib();
  return getDocument({ data: bytes.slice(0) }).promise;
}

/** Glyphs and grouped rows per page for the upload preview (no translation call). */
export async function pdfDeckRows(pdf) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const glyphs = [];
    for (const it of tc.items) {
      const text = it.str ?? "";
      if (!text.trim()) continue;
      const x = it.transform?.[4] ?? 0;
      const y = it.transform?.[5] ?? 0;
      const w = it.width ?? Math.abs(it.transform?.[0] ?? 0) * Math.max(1, text.length);
      const h = it.height ?? Math.abs(it.transform?.[3] ?? 12);
      glyphs.push({ text, x, y, w, h });
    }
    pages.push({ n, rows: groupRows(glyphs) });
  }
  return pages;
}

/** [{tag: "slide N", text}] from every page. */
export async function pdfPages(pdf) {
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    let text = "", lastY = null;
    for (const it of tc.items) {
      const y = it.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 4) text += "\n";
      text += it.str + (it.hasEOL ? "\n" : "");
      lastY = y;
    }
    out.push({ tag: `slide ${n}`, text: text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim() });
  }
  return out;
}

/** Renders page n into a canvas sized for `width` CSS pixels. */
export async function renderPage(pdf, n, width) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = (width / base.width) * Math.min(2, devicePixelRatio || 1);
  const vp = page.getViewport({ scale });
  const canvas = h("canvas", { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  // Match CSS size to the pixels we rendered so a wide parent does not upscale a small bitmap.
  canvas.style.width = `${width}px`;
  canvas.style.maxWidth = "100%";
  canvas.style.height = "auto";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  canvas._pdfBaseH = base.height;
  canvas._pdfBaseW = base.width;
  return canvas;
}

/** Keynote-like text slide: first line is the title. */
export function textSlide(page, n) {
  const [title, ...rest] = (page?.text ?? "").split("\n");
  return h("div.tslide", {},
    h("div.tslide-n", {}, String(n)),
    h("h2", {}, title || `Slide ${n}`),
    rest.length ? h("p", {}, rest.join(" ")) : null,
  );
}

/** Uploads the PDF so the projector and other devices show it. Host only. */
export const uploadDeck = (id, bytes, key) =>
  fetch(`/api/rooms/${id}/deck`, { method: "PUT", headers: { "content-type": "application/pdf", ...(key ? { "x-key": key } : {}) }, body: bytes }).then((r) => r.ok);

/** A deck abstraction used by presenter and projector: the uploaded PDF if there is one, text otherwise. */
export async function deckFor(id, meta, { fresh = false } = {}) {
  let bytes = fresh ? null : await loadDeck(id);
  if (!bytes && meta.deck) {
    bytes = await fetch(`/api/rooms/${id}/deck`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && new Uint8Array(b)).catch(() => null);
    if (bytes) saveDeck(id, bytes);
  }
  const pdf = bytes ? await openPdf(bytes).catch(() => null) : null;
  const count = pdf ? pdf.numPages : Math.max(1, meta.slides.length);
  return {
    count,
    pdf: !!pdf,
    async render(n, width) {
      return pdf ? renderPage(pdf, n, width) : textSlide(meta.slides[n - 1], n);
    },
  };
}

/** Teleprompter script text from a .docx, .pdf, .txt or .md file. Throws on anything else. */
export async function scriptFileText(f) {
  if (/\.docx$/i.test(f.name)) return docxText(await f.arrayBuffer());
  if (/\.pdf$/i.test(f.name)) return (await pdfPages(await openPdf(new Uint8Array(await f.arrayBuffer())))).map((p) => p.text).join("\n");
  if (/\.(txt|md)$/i.test(f.name)) return f.text();
  throw new Error("Save it as .docx, PDF or .txt");
}
