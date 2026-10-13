// Slides never leave the speaker's laptop: the PDF lives in IndexedDB, rendered with pdf.js.
// Other devices (or a missing PDF) fall back to text slides built from the room's page text.
import { h } from "/js/eco.js";

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
  canvas.style.width = "100%";
  canvas.style.height = "auto";
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
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

/** A deck abstraction used by presenter and projector: PDF if this browser has it, text otherwise. */
export async function deckFor(id, meta) {
  const bytes = await loadDeck(id);
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
