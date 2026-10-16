import { h, icon, api, roomId, who, hostKey, qrSvg, fullUrl, shortUrl, toast, fmtTime, langName, modePill, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { phraseMic, phraseInit, speakingSignal, SPOKEN_LANGUAGES, hasSpeechRecognition } from "/js/mic.js";
import { deckFor, openPdf, pdfPages, saveDeck, uploadDeck } from "/js/slides.js";
import { voiceCard } from "/js/sample.js";

const id = roomId();
const key = hostKey(id);
let meta, deck, stopMic = null, inflight = 0, lastLatency = null, drawSpeakers = () => {};
const speaking = new Set();
let lines = [];
let board = null;

try {
  meta = await api(`/api/rooms/${id}/meta`, { key });
} catch {
  notFound();
  throw new Error("no room");
}
const host = meta.host;
const demo = meta.demo && !host;

if (!host && !meta.demo) {
  document.body.replaceChildren(
    h("main.narrow.center", { style: { paddingTop: "20vh" } },
      h("a.brand", { href: "/" }, "Eco"),
      h("h1", { style: { fontSize: "28px", margin: "24px 0 8px" } }, "This is the speaker's console"),
      h("p.muted", {}, "Open it from the presenter link you got when you created the talk."),
      h("p", { style: { marginTop: "24px" } }, h("a.btn.primary", { href: `/${id}` }, "Join as a listener")),
    ),
  );
  throw new Error("not host");
}

deck = await deckFor(id, meta);

// ---------- top bar ----------
const statusPill = h("span.pill");
const timer = h("span.mono.muted");
const latency = h("span.pill", { title: "Phrase end → translation back, measured on this laptop" });
const calls = h("span.pill", { title: "Token Factory calls today / daily ceiling" });
const endBtn = h("button.btn.sm", { type: "button", onclick: () => setStatus(meta.status === "ended" ? "live" : "ended") });
const bar = h("header.bar", {}, h("div.inner", {},
  h("a.brand", { href: "/" }, "Eco"),
  h("span.title.truncate", {}, meta.title),
  modePill(meta), statusPill, timer,
  h("span.spacer"),
  latency, calls,
  h("a.btn.sm", { href: `/${id}/screen`, target: "eco-screen" }, icon("ext"), "Projector"),
  host ? h("a.btn.sm", { href: `/${id}/card` }, "Card") : null,
  host ? endBtn : null,
));

// ---------- left: slides, QR, mic ----------
const slideNow = h("div.slide-frame");
const slideNext = h("div.slide-frame.slide-next");
const slideLabel = h("span.small.muted");
const prev = h("button.btn.icon-btn", { type: "button", "aria-label": "Previous slide", onclick: () => goSlide(meta.slide - 1), disabled: demo }, icon("prev"));
const next = h("button.btn.icon-btn", { type: "button", "aria-label": "Next slide", onclick: () => goSlide(meta.slide + 1), disabled: demo }, icon("next"));

const level = h("i");
const spokenLang = h("select", { disabled: !hasSpeechRecognition },
  h("option", { value: "" }, `Browser default (${navigator.language})`),
  ...SPOKEN_LANGUAGES.map((l) => h("option", { value: l }, langName(l, "en"))),
);
const micState = h("div.small.muted", {}, "Off");
const micBtn = h("button.mic-btn", { type: "button", onclick: () => toggleMic() },
  h("span.ico", {}, icon("mic")),
  h("div", { style: { flex: 1 } }, h("div", { style: { fontWeight: 600 } }, demo ? "Try with your voice" : "Microphone"), micState),
);

const left = h("div.col-left", {},
  h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Slides"), h("span.spacer"), slideLabel, prev, next),
    slideNow,
    h("p.tiny.muted", { style: { margin: "12px 0 6px" } }, "Next"),
    slideNext,
    deck.pdf || meta.demo ? null : h("p.tiny.faint", { style: { marginTop: "10px" } }, "Showing text slides: no PDF was uploaded for this talk."),
    host && !meta.demo ? replaceSlides() : null,
  ),
  h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, demo ? "Your turn" : "Stage input")),
    h("label.field", {}, "Spoken Language", spokenLang),
    h("p.tiny.muted", {}, hasSpeechRecognition ? "Choose before starting. Stop the mic to change languages." : "This browser uses audio upload. The language selector only applies to browser speech recognition."),
    micBtn,
    h("div.level", { style: { marginTop: "12px" } }, level),
    h("p.tiny.muted", { style: { marginTop: "10px" } }, demo ? "30 seconds of live mic. The replay pauses while you talk." : "Eco cuts at your natural pauses. Space toggles the mic."),
  ),
  h("div.card.center", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Audience link")),
    h("div", { style: { width: "70%", margin: "0 auto" } }, qrSvg(fullUrl(`/${id}`))),
    h("p.url", { style: { marginTop: "10px", fontSize: "14px" } }, shortUrl(`/${id}`)),
  ),
  speakersCard(),
  host && !demo ? voiceCard(id, meta, key ? { "x-key": key } : {}) : null,
);

// ---------- middle: what you said ----------
const now = h("div.said");
const mid = h("div.col-mid", {},
  h("div.card", { style: { minHeight: "60vh" } },
    h("div.card-head", {}, h("span.eyebrow", {}, "You said"), h("span.spacer"), h("span.chip", {}, "Original")),
    now,
  ),
);

// ---------- right: the board ----------
const listenersEl = h("div");
const topicsEl = h("div");
const barsEl = h("div");
const queueEl = h("div");
const right = h("div.col-right", {},
  h("div.card", {}, h("div.card-head", {}, h("span.eyebrow", {}, "In the room")), listenersEl),
  h("div.card", {}, h("div.card-head", {}, h("span.eyebrow", {}, "What they asked")), topicsEl),
  h("div.card", {}, h("div.card-head", {}, h("span.eyebrow", {}, "Questions per slide")), barsEl),
  h("div.card", {}, h("div.card-head", {}, h("span.eyebrow", {}, "Not in your slides"), h("span.spacer"), h("span.tiny.muted", {}, "answer out loud, then tap")), queueEl),
);

document.body.replaceChildren(...[bar, demo ? h("div.wrap", { style: { maxWidth: "1840px", paddingTop: "16px" } },
  h("div.banner", {}, icon("play"), h("div", {}, h("b", {}, "Demo talk, replaying. "), "Open the audience link on your phone to follow it, ask it a question, and watch the board update. Or press “Try with your voice”."))) : null,
  h("main.console", {}, left, mid, right)].filter(Boolean));

// ---------- rendering ----------
async function drawSlides() {
  slideLabel.textContent = `${meta.slide} / ${deck.count}`;
  const w = slideNow.clientWidth || 280;
  slideNow.replaceChildren(await deck.render(meta.slide, w));
  slideNext.replaceChildren(meta.slide < deck.count ? await deck.render(meta.slide + 1, w) : h("p.small.faint", {}, "End of deck"));
  prev.disabled = demo || meta.slide <= 1;
  next.disabled = demo || meta.slide >= deck.count;
}

function drawStatus() {
  const s = meta.status;
  statusPill.className = `pill ${s === "live" ? "live" : ""}`;
  statusPill.replaceChildren(h("span.dot"), s === "live" ? "Live" : s === "ended" ? "Ended" : "Lobby");
  endBtn.textContent = s === "ended" ? "Reopen" : "End talk";
}
setInterval(() => (timer.textContent = meta.startedAt && meta.status === "live" ? fmtTime((Date.now() - meta.startedAt) / 1000) : ""), 1000);

function drawLines() {
  const last = lines.at(-1);
  if (!last) return now.replaceChildren(h("p.empty", {}, demo ? "Waiting for the replay…" : "Turn the mic on and start talking. Your words and their translations appear here."));
  now.replaceChildren(
    ...lines.slice(-4, -1).map((l) => h("p.past", {}, who(meta, l), l.src)),
    h("p.now", {}, who(meta, last), last.src),
    ...meta.langs.map((l) => h("div.tr", {}, h("span.chip", { title: langName(l) }, l.toUpperCase()), h("span", {}, last.out[l] ?? "", last.flags?.includes(l) ? h("span.tiny.muted", {}, "  · literal") : null))),
  );
}

function drawBoard() {
  if (!board) return;
  const total = Object.values(board.listeners).reduce((a, b) => a + b, 0);
  listenersEl.replaceChildren(
    h("div.row", { style: { alignItems: "baseline" } }, h("span.stat", {}, String(total)), h("span.muted.small", {}, `listening now · peak ${board.peak}`)),
    ...Object.entries(board.listeners).sort((a, b) => b[1] - a[1]).map(([l, n]) =>
      h("div", { style: { marginTop: "12px" } },
        h("div.kv", { style: { padding: "0 0 4px" } }, h("span", {}, langName(l)), h("span.muted.mono", {}, `${n}`)),
        h("div.meter", {}, h("i", { style: { width: `${total ? (n / total) * 100 : 0}%` } })))),
  );
  topicsEl.replaceChildren(...(board.topics.length
    ? board.topics.map((t) => h("div.topic", {}, h("span.n", {}, String(t.count)), h("div", {}, h("div", { style: { fontWeight: 600 } }, t.title), h("div.small.muted", {}, `“${t.sample}” · ${t.topic}`))))
    : [h("p.empty", {}, "Questions from the audience show up here, grouped by the slide that answers them.")]));
  const n = Math.max(deck.count, ...Object.keys(board.bySlide).map(Number));
  const max = Math.max(1, ...Object.values(board.bySlide));
  const hot = Object.entries(board.bySlide).sort((a, b) => b[1] - a[1])[0]?.[0];
  barsEl.replaceChildren(
    h("div.bars", {}, ...Array.from({ length: n }, (_, i) => {
      const c = board.bySlide[i + 1] ?? 0;
      return h(`div${String(i + 1) === hot && c ? ".hot" : ""}${i + 1 === meta.slide ? ".cur" : ""}`, { style: { height: `${(c / max) * 100}%` }, title: `Slide ${i + 1}: ${c}` });
    })),
    h("p.tiny.muted", { style: { marginTop: "8px" } }, hot ? `Slide ${hot} raised the most questions.` : "No questions yet."),
  );
  queueEl.replaceChildren(...(board.queue.length
    ? board.queue.map((g) => h(`div.q-item${g.answeredAt != null ? ".done" : ""}`, {},
        h("span.chip" + (g.count > 1 ? ".red" : ""), {}, String(g.count)),
        h("div", { style: { flex: 1 } }, h("div", {}, g.q), h("div.tiny.muted", {}, g.langs.map((l) => langName(l)).join(", "))),
        h("div.row", { style: { gap: "6px", flexShrink: 0 } },
          g.taught ? h("span.tiny.muted", {}, "Eco learned this ✓")
            : g.answeredAt != null ? h("span.tiny.muted", {}, `answered ${fmtTime(g.answeredAt)}`) : null,
          host && !g.taught ? h("button.btn.sm", { type: "button", onclick: () => teachSheet(g) }, icon("plus"), "Answer it") : null,
          g.answeredAt == null ? h("button.btn.sm", { type: "button", onclick: () => answered(g.qids) }, icon("check"), "Answered") : null)))
    : [h("p.empty", {}, "When Eco can't answer from your slides, the question lands here.")]));
}

// ---------- actions ----------
async function goSlide(n) {
  if (demo || n < 1 || n > deck.count) return;
  meta.slide = n;
  drawSlides();
  api(`/api/rooms/${id}/slide`, { method: "POST", key, body: { n } }).catch(() => toast("Slide not synced"));
}
async function setStatus(status) {
  const r = await api(`/api/rooms/${id}/status`, { method: "POST", key, body: { status } }).catch(() => null);
  if (r && status === "ended") stopMic?.();
}
async function answered(qids) {
  await api(`/api/rooms/${id}/answered`, { method: "POST", key, body: { qids } }).catch(() => toast("Couldn't update"));
}

/** Teach Eco: type a short answer. Eco keeps it as a source and sends it to the listeners who asked. Nothing is saved before Save. */
function teachSheet(g) {
  const qIn = h("textarea", { rows: 2, maxlength: 200 });
  const askedIn = h("input", { type: "text", maxlength: 200 });
  const aIn = h("textarea", { rows: 3, maxlength: 500, placeholder: "One or two sentences, as you would say it" });
  qIn.value = g.q;
  askedIn.value = g.asked; // the listener's own words, if they asked in another language
  const save = h("button.btn.primary", { type: "button" }, "Save");
  const wrap = h("div.sheet-wrap", {}, h("div.sheet.stack", { style: { gap: "14px", maxWidth: "560px", width: "100%" } },
    h("h2", {}, "Teach Eco this answer"),
    h("p.small.muted", {}, `Eco will use this to answer the next listeners, and ${g.count > 1 ? `the ${g.count} listeners who asked` : "the listener who asked"} will see it now. Check it before you save.`),
    h("label.field", {}, "Question", qIn),
    h("label.field", {}, "Listener's words", askedIn),
    h("label.field", {}, "Your answer", aIn),
    h("div.row", {}, h("span.spacer"), h("button.btn", { type: "button", onclick: () => wrap.remove() }, "Cancel"), save)));
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api(`/api/rooms/${id}/addanswer`, { method: "POST", key, body: { qids: g.qids, q: qIn.value, asked: askedIn.value, a: aIn.value } });
      toast("Eco will answer this from now on ✓");
      wrap.remove();
    } catch (err) {
      if (err.data?.error === "Already added") wrap.remove();
      else (toast(err.message || "Couldn't save"), (save.disabled = false));
    }
  };
  document.body.append(wrap);
  aIn.focus();
}

async function toggleMic() {
  if (micBtn.disabled) return;
  if (stopMic) {
    stopMic();
    return;
  }
  if (meta.status === "ended") return toast("The talk has ended");
  micBtn.disabled = spokenLang.disabled = true;
  try {
    const end = await phraseMic({
      lang: spokenLang.value || undefined,
      maxTotalMs: demo ? 30000 : Infinity,
      onLevel: speakingSignal(live.send, (l) => (level.style.width = `${Math.round(l * 100)}%`)),
      onPhrase: send,
    });
    stopMic = () => {
      end();
      live.send({ type: "speaking", on: false });
      stopMic = null;
      spokenLang.disabled = !hasSpeechRecognition;
      micBtn.classList.remove("on");
      micState.textContent = "Off";
      level.style.width = "0";
    };
    micBtn.classList.add("on");
    micState.textContent = "Listening…";
    if (demo) setTimeout(() => stopMic?.(), 30500);
  } catch (err) {
    toast(err.name === "NotAllowedError" ? "Microphone blocked: allow it in the address bar" : "Couldn't open the microphone");
  } finally {
    micBtn.disabled = false;
    spokenLang.disabled = !hasSpeechRecognition || !!stopMic;
  }
}

async function send(blob, cutAt) {
  inflight++;
  micState.textContent = "Translating…";
  try {
    const [ct, body] = phraseInit(blob);
    const r = await fetch(`/api/rooms/${id}/utterance`, { method: "POST", headers: { ...ct, ...(key ? { "x-key": key } : {}) }, body });
    const data = await r.json().catch(() => ({}));
    if (r.status === 403 && demo) toast("You've used your live minutes for now");
    else if (!r.ok) toast(data.fallback ? `Translation paused (${data.fallback})` : data.error || "Translation failed");
    else if (data.line) {
      lastLatency = performance.now() - cutAt;
      latency.replaceChildren(h("span.dot"), `${(lastLatency / 1000).toFixed(1)} s`);
    }
  } catch {
    toast("Network problem: phrase dropped");
  } finally {
    inflight--;
    if (stopMic) micState.textContent = inflight ? "Translating…" : "Listening…";
  }
}

addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  if (["ArrowRight", "PageDown", "ArrowDown"].includes(e.key)) goSlide(meta.slide + 1);
  if (["ArrowLeft", "PageUp", "ArrowUp"].includes(e.key)) goSlide(meta.slide - 1);
  if (e.code === "Space" && !e.repeat) (e.preventDefault(), toggleMic());
});

async function refreshCalls() {
  const s = await api("/api/stats").catch(() => null);
  if (!s) return;
  calls.replaceChildren(h("span.dot"), s.live ? `${s.today}/${s.max} calls` : "0 calls (mock)");
  calls.className = `pill ${s.tripped ? "mock" : ""}`;
}
refreshCalls();
setInterval(refreshCalls, 15000);
latency.replaceChildren(h("span.dot"), "— s");

/** Swap the deck before (or between) talks: new PDF to R2, new slide text for answers; notes are kept. */
function replaceSlides() {
  const file = h("input", { type: "file", accept: "application/pdf", hidden: true });
  const btn = h("button.btn.sm", { type: "button", onclick: () => file.click() }, icon("doc"), deck.pdf ? "Replace slides" : "Upload slides (PDF)");
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    btn.disabled = true;
    btn.lastChild.textContent = "Uploading…";
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const pages = await pdfPages(await openPdf(bytes));
      const { pages: old } = await api(`/api/rooms/${id}/sources`, { key });
      await api(`/api/rooms/${id}/sources`, { method: "POST", key, body: { pages: [...pages, ...old.filter((p) => p.tag === "notes")] } });
      await saveDeck(id, bytes);
      if (!(await uploadDeck(id, bytes, key))) throw new Error("upload");
    } catch {
      toast("Couldn't replace the slides");
      btn.disabled = false;
      btn.lastChild.textContent = "Replace slides";
    }
  };
  return h("div", { style: { marginTop: "10px" } }, btn, file);
}

/** Who is talking, and (host) a QR for a co-speaker to join from their own phone. */
function speakersCard() {
  const list = h("div.row", { style: { flexWrap: "wrap", gap: "8px" } });
  drawSpeakers = () => list.replaceChildren(...meta.speakers.map((s) =>
    h(`span.chip${speaking.has(s.id) ? ".speaking" : ""}`, {}, speaking.has(s.id) ? h("span.dot.live") : null, s.name, s.voice ? h("span.faint", { title: "Voice sample saved" }, " · voice") : null)));
  drawSpeakers();
  const joinUrl = meta.joinKey ? fullUrl(`/${id}/join#j=${meta.joinKey}`) : null;
  const qr = h("div", { hidden: true, style: { width: "60%", margin: "12px auto 0" } }, joinUrl ? qrSvg(joinUrl) : null);
  return h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Speakers"), h("span.spacer"),
      joinUrl ? h("button.btn.sm", { type: "button", onclick: () => (qr.hidden = !qr.hidden) }, icon("plus"), "Add a speaker") : null),
    list,
    joinUrl ? h("div", {}, qr, h("p.tiny.muted", { style: { marginTop: "8px" } }, "Each co-speaker scans this with their own phone and uses its mic. Eco shows who is talking.")) : null,
  );
}

// ---------- live ----------
const live = connect(id, { role: "host", ...(key ? { key } : {}) }, (m) => {
  if (m.type === "deck" || m.type === "slides") return location.reload(); // new slides: simplest to start fresh
  if (m.type === "hello") {
    Object.assign(meta, m.meta);
    lines = m.lines ?? [];
    board = m.board ?? board;
  }
  if (m.type === "line") lines.push(m.line), (lines = lines.slice(-50));
  if (m.type === "slide") meta.slide = m.n;
  if (m.type === "status") Object.assign(meta, { status: m.status, startedAt: m.startedAt, endedAt: m.endedAt });
  if (m.type === "board") board = m.board;
  if (m.type === "notice") toast(m.text, 4000);
  if (m.type === "reset") (Object.assign(meta, m.meta), (lines = []));
  if (m.type === "speakers") meta.speakers = m.speakers;
  if (m.type === "speaking") m.on ? speaking.add(m.speaker) : speaking.delete(m.speaker);
  if (["hello", "speakers", "speaking", "reset"].includes(m.type)) drawSpeakers();
  if (["hello", "slide", "reset"].includes(m.type)) drawSlides();
  if (["hello", "status", "reset"].includes(m.type)) drawStatus();
  if (["hello", "line", "reset"].includes(m.type)) drawLines();
  if (["hello", "board", "slide"].includes(m.type)) drawBoard();
}, (s) => s === "offline" && toast("Connection lost, reconnecting…"));

drawStatus();
drawLines();
drawSlides();
if (!board && meta.demo) api(`/api/rooms/${id}/board`).then((b) => ((board = b), drawBoard())).catch(() => {});
