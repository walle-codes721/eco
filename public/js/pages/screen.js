// Projector: always dark. Lobby (giant QR) → slides with a QR corner and captions → "Grazie" + recap QR.
import { h, api, roomId, qrSvg, fullUrl, shortUrl, langName, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { deckFor } from "/js/slides.js";

const id = roomId();
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`);
} catch {
  notFound();
  throw new Error("no room");
}
const deck = await deckFor(id, meta);
const url = `/${id}`;
let captions = true;
let capLangI = 0;
let last = null;

const slot = h("div.slot");
const cap = h("div.cap");
const corner = h("div.corner", {}, qrSvg(fullUrl(url)), h("span.url", {}, shortUrl(url)));
const stage = h("div.stage", {}, slot, cap, corner);
const root = h("div.screen", {}, stage,
  h("button.btn.sm.fs", { type: "button", onclick: () => document.documentElement.requestFullscreen?.() }, "Full screen (F)"));
document.body.replaceChildren(root);

const native = (l) => langName(l, l);

async function draw() {
  if (meta.status === "lobby") {
    corner.hidden = true;
    cap.hidden = true;
    slot.replaceChildren(h("div.lobby", {},
      h("span.pill", { style: { background: "rgba(255,255,255,.08)", color: "#f5f5f7", borderColor: "transparent" } }, h("span.dot.live"), "Eco"),
      h("h1", {}, meta.title),
      meta.speaker ? h("p", { style: { color: "#a1a1a6", fontSize: "clamp(16px,1.6vw,28px)" } }, meta.speaker) : null,
      qrSvg(fullUrl(url)),
      h("p.url", {}, shortUrl(url)),
      h("p", { style: { color: "#a1a1a6", fontSize: "clamp(16px,1.5vw,26px)" } }, `Scan to follow in your language · ${meta.langs.map(native).join(" · ")}`),
    ));
    return;
  }
  if (meta.status === "ended") {
    corner.hidden = true;
    cap.hidden = true;
    slot.replaceChildren(h("div.lobby", {},
      h("h1", { style: { fontSize: "clamp(48px,8vw,140px)" } }, "Grazie."),
      qrSvg(fullUrl(url)),
      h("p", { style: { color: "#a1a1a6", fontSize: "clamp(16px,1.5vw,26px)" } }, "Scan for your recap: the whole talk and your answers, in your language."),
    ));
    return;
  }
  corner.hidden = false;
  slot.replaceChildren(await deck.render(meta.slide, stage.clientWidth || innerWidth));
  drawCap();
}

function drawCap() {
  cap.hidden = !captions || !last || meta.status !== "live";
  if (cap.hidden) return;
  const l = meta.langs[capLangI % meta.langs.length];
  cap.replaceChildren(h("span.chip", {}, l.toUpperCase()), last.out[l] ?? last.src);
}

addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") document.documentElement.requestFullscreen?.();
  if (e.key === "c" || e.key === "C") (captions = !captions), drawCap();
});
addEventListener("resize", () => meta.status === "live" && draw());

connect(id, { role: "screen" }, (m) => {
  if (m.type === "hello") Object.assign(meta, m.meta), (last = m.lines?.at(-1) ?? null);
  if (m.type === "slide") meta.slide = m.n;
  if (m.type === "status") Object.assign(meta, { status: m.status });
  if (m.type === "reset") Object.assign(meta, m.meta), (last = null);
  if (m.type === "line") {
    last = m.line;
    capLangI++; // rotate the projector caption through the room's languages
    return drawCap();
  }
  draw();
});
draw();
