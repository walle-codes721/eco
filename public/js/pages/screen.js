// Projector: always dark. Lobby (giant QR) → slides with a QR corner and captions → "Grazie" + recap QR.
// At /replay the same screen plays back an ended Stage from its timeline: no socket, no API calls, stored clips only.
import { h, api, roomId, who, qrSvg, fullUrl, shortUrl, langName, notFound, fmtTime } from "/js/eco.js";
import { connect } from "/js/live.js";
import { deckFor } from "/js/slides.js";
import { voice } from "/js/speak.js";
import { stageAudio } from "/js/stage-audio.js";

const id = roomId();
const replay = location.pathname.endsWith("/replay");
let meta, tl;
try {
  meta = await api(`/api/rooms/${id}/meta`);
  if (replay) tl = await api(`/api/rooms/${id}/timeline`);
} catch (err) {
  notFound(err.status === 409 ? "This talk can be replayed once it has ended." : undefined);
  throw new Error("no room");
}
const deck = await deckFor(id, meta);
const url = `/${id}`;
let captions = true;
let capLangI = 0;
let capLang = null; // replay: the viewer's language ("" = as spoken); live: rotate
let last = null;

const slot = h("div.slot");
const cap = h("div.cap");
const ticker = h("div.qticker", { hidden: true });
const corner = h("div.corner", {}, qrSvg(fullUrl(url)), h("span.url", {}, shortUrl(url)));
const stage = h("div.stage", {}, slot, cap, ticker, corner);
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
    ticker.hidden = true;
    slot.replaceChildren(h("div.lobby", {},
      h("h1", { style: { fontSize: "clamp(48px,8vw,140px)" } }, "Grazie."),
      replay ? h("button.btn.primary", { type: "button", onclick: () => play() }, "Replay again") : qrSvg(fullUrl(url)),
      replay ? null : h("p", { style: { color: "#a1a1a6", fontSize: "clamp(16px,1.5vw,26px)" } }, "Scan for your recap: the whole talk and your answers, in your language."),
    ));
    return;
  }
  corner.hidden = replay;
  slot.replaceChildren(await deck.render(meta.slide, stage.clientWidth || innerWidth));
  drawCap();
}

function drawCap() {
  cap.hidden = !captions || !last || meta.status !== "live";
  if (cap.hidden) return;
  const l = capLang ?? meta.langs[capLangI % meta.langs.length];
  cap.replaceChildren(...[l ? h("span.chip", {}, l.toUpperCase()) : null, who(meta, last), (l && last.out[l]) || last.src].filter(Boolean)); // replaceChildren prints a null
}

addEventListener("keydown", (e) => {
  if (e.key === "f" || e.key === "F") document.documentElement.requestFullscreen?.();
  if (e.key === "c" || e.key === "C") (captions = !captions), drawCap();
});
addEventListener("resize", () => meta.status === "live" && draw());

/** One message from the room, live or replayed. `quiet` = fast-forwarding a seek: state only, nothing floats or speaks. */
function onMsg(m, quiet = false) {
  if (m.type === "deck" || m.type === "slides") return location.reload(); // new slides: simplest to start fresh
  if (m.type === "hello") Object.assign(meta, m.meta), (last = m.lines?.at(-1) ?? null);
  if (m.type === "slide") {
    meta.slide = m.n;
    if (quiet) return;
  }
  if (m.type === "status") Object.assign(meta, { status: m.status });
  if (m.type === "reset") Object.assign(meta, m.meta), (last = null);
  if (m.type === "speakers") return void (meta.speakers = m.speakers);
  if (m.type === "speaking") return;
  if (m.type === "react") return void (quiet || floatReaction(m.r));
  if (m.type === "question") return void (quiet || showQuestion(m.q));
  if (m.type === "line") {
    last = m.line;
    if (quiet) return;
    capLangI++; // rotate the projector caption through the room's languages
    if (replay) speak(m.line);
    return drawCap();
  }
  draw();
}
if (!replay) connect(id, { role: "screen" }, onMsg), draw();

// Listeners' reactions drift up the right edge, anonymously.
// ponytail: client-side cap only; throttle on the server if rooms get huge
function floatReaction(r) {
  if (document.querySelectorAll(".emo-float").length >= 15) return;
  const el = h("span.emo.emo-float", { style: { right: `${2 + Math.random() * 8}vw` } }, r);
  el.addEventListener("animationend", () => el.remove());
  document.body.append(el);
}

// A listener's question, anonymously, for a few seconds (replay only: live questions stay with the speaker).
let tickerTimer;
function showQuestion(q) {
  ticker.replaceChildren(h("span.chip", {}, q.lang.toUpperCase()), q.text);
  ticker.hidden = false;
  clearTimeout(tickerTimer);
  tickerTimer = setTimeout(() => (ticker.hidden = true), 8000);
}

// ---------- replay ----------
const events = tl?.events ?? [], start = tl?.startedAt ?? events[0]?.t ?? 0;
const total = Math.max(0, (tl?.endedAt ?? events.at(-1)?.t ?? start) - start);
const offset = (e) => e.t - start;
let playing = false, at = 0, from = 0, i = 0, timer;
const playback = stageAudio({ play: (...args) => voice.playStage(...args), stop: () => voice.stopStage() });
const btn = h("button.btn.sm.primary", { type: "button", onclick: () => (playing ? pause() : play()) });
const bar = h("input", { type: "range", min: 0, max: total, step: 1000, value: 0, "aria-label": "Position", oninput: () => seek(Number(bar.value)) });
const clock = h("span.tiny");
const langSel = h("select", { "aria-label": "Language", onchange: () => ((capLang = langSel.value), playback.clear(0), drawCap()) },
  h("option", { value: "" }, "As spoken"), ...meta.langs.map((l) => h("option", { value: l }, native(l))));
const sound = h("button.btn.sm", { type: "button", onclick: () => (voice.on ? voice.off() : voice.unlock(), drawBar()) });

/** Stored clips only (wait: false): a line without one is read by the device voice, never cloned again. */
function speak(l) {
  if (!capLang) return; // as spoken: the speaker's own words, no clip
  const idx = Math.max(0, meta.speakers?.findIndex((s) => s.id === (l.speaker ?? "s0")) ?? 0);
  playback.line({ seq: l.seq, text: l.out[capLang] ?? l.src, lang: capLang, speaker: idx, url: l.audio?.[capLang] ?? null, wait: false, enabled: voice.on });
}

function drawBar() {
  btn.textContent = playing ? "Pause" : "Play";
  sound.textContent = voice.on ? "Sound on" : "Sound off";
  bar.value = String(at);
  clock.textContent = `${fmtTime(at / 1000)} / ${fmtTime(total / 1000)}`;
}

function tick() {
  at = Math.min(total, performance.now() - from);
  while (i < events.length && offset(events[i]) <= at) onMsg(events[i++].m);
  drawBar();
  if (at < total) return void (timer = setTimeout(tick, 250));
  pause();
  meta.status = "ended";
  draw();
}

function play() {
  if (!voice.on) voice.unlock(); // the Play tap is the gesture iOS needs for sound
  if (meta.status === "ended") seek(0);
  playing = true;
  from = performance.now() - at;
  clearTimeout(timer);
  tick();
}

function pause() {
  playing = false;
  clearTimeout(timer);
  drawBar();
}

/** Jump anywhere: rebuild the slide and caption from the start, quietly, so nothing plays twice. */
function seek(ms) {
  at = ms;
  from = performance.now() - at;
  playback.clear(0);
  Object.assign(meta, { status: "live", slide: 1 });
  last = null;
  ticker.hidden = true;
  for (i = 0; i < events.length && offset(events[i]) <= at; i++) onMsg(events[i].m, true);
  draw();
  drawBar();
}

if (replay) {
  capLang = meta.langs[0] ?? "";
  langSel.value = capLang;
  root.classList.add("replay");
  root.append(h("span.pill.replay.replay-pill", {}, h("span.dot"), "Replay"), h("div.replay-bar", {}, btn, bar, clock, langSel, sound));
  addEventListener("keydown", (e) => e.key === " " && e.target === document.body && (e.preventDefault(), playing ? pause() : play()));
  seek(0);
}
