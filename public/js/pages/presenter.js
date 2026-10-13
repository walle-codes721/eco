import { h, icon, api, roomId, hostKey, qrSvg, fullUrl, shortUrl, toast, fmtTime, langName, modePill, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { phraseMic } from "/js/mic.js";
import { deckFor } from "/js/slides.js";

const id = roomId();
const key = hostKey(id);
let meta, deck, stopMic = null, inflight = 0, lastLatency = null;
let lines = [];
let board = null;

try {
  meta = await api(`/api/rooms/${id}/meta`, { key });
} catch {
  notFound();
  throw new Error("no room");
}
if (meta.mode !== "stage") location.replace(`/o/${id}`);
const host = meta.host;
const demo = meta.demo && !host;

if (!host && !meta.demo) {
  document.body.replaceChildren(
    h("main.narrow.center", { style: { paddingTop: "20vh" } },
      h("a.brand", { href: "/" }, "Eco"),
      h("h1", { style: { fontSize: "28px", margin: "24px 0 8px" } }, "This is the speaker's console"),
      h("p.muted", {}, "Open it from the presenter link you got when you created the talk."),
      h("p", { style: { marginTop: "24px" } }, h("a.btn.primary", { href: `/r/${id}` }, "Join as a listener")),
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
  h("a.btn.sm", { href: `/s/${id}/screen`, target: "eco-screen" }, icon("ext"), "Projector"),
  host ? h("a.btn.sm", { href: `/s/${id}/card` }, "Card") : null,
  host ? endBtn : null,
));

// ---------- left: slides, QR, mic ----------
const slideNow = h("div.slide-frame");
const slideNext = h("div.slide-frame.slide-next");
const slideLabel = h("span.small.muted");
const prev = h("button.btn.icon-btn", { type: "button", "aria-label": "Previous slide", onclick: () => goSlide(meta.slide - 1), disabled: demo }, icon("prev"));
const next = h("button.btn.icon-btn", { type: "button", "aria-label": "Next slide", onclick: () => goSlide(meta.slide + 1), disabled: demo }, icon("next"));

const level = h("i");
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
    deck.pdf || meta.demo ? null : h("p.tiny.faint", { style: { marginTop: "10px" } }, "Showing text slides: the PDF is on the laptop that created this talk."),
  ),
  h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, demo ? "Your turn" : "Stage input")),
    micBtn,
    h("div.level", { style: { marginTop: "12px" } }, level),
    h("p.tiny.muted", { style: { marginTop: "10px" } }, demo ? "30 seconds of live mic. The replay pauses while you talk." : "Eco cuts at your natural pauses. Space toggles the mic."),
  ),
  h("div.card.center", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Audience link")),
    h("div", { style: { width: "70%", margin: "0 auto" } }, qrSvg(fullUrl(`/r/${id}`))),
    h("p.url", { style: { marginTop: "10px", fontSize: "14px" } }, shortUrl(`/r/${id}`)),
  ),
);

// ---------- middle: what you said ----------
const now = h("div.said");
const mid = h("div.col-mid", {},
  h("div.card", { style: { minHeight: "60vh" } },
    h("div.card-head", {}, h("span.eyebrow", {}, "You said"), h("span.spacer"), h("span.chip", {}, "EN")),
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
    ...lines.slice(-4, -1).map((l) => h("p.past", {}, l.src)),
    h("p.now", {}, last.src),
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
        g.answeredAt != null ? h("span.tiny.muted", {}, `answered ${fmtTime(g.answeredAt)}`) :
          h("button.btn.sm", { type: "button", onclick: () => answered(g.qids) }, icon("check"), "Answered")))
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

async function toggleMic() {
  if (stopMic) {
    stopMic();
    return;
  }
  if (meta.status === "ended") return toast("The talk has ended");
  try {
    const end = await phraseMic({
      maxTotalMs: demo ? 30000 : Infinity,
      onLevel: (l) => (level.style.width = `${Math.round(l * 100)}%`),
      onPhrase: send,
    });
    stopMic = () => {
      end();
      stopMic = null;
      micBtn.classList.remove("on");
      micState.textContent = "Off";
      level.style.width = "0";
    };
    micBtn.classList.add("on");
    micState.textContent = "Listening…";
    if (demo) setTimeout(() => stopMic?.(), 30500);
  } catch (err) {
    toast(err.name === "NotAllowedError" ? "Microphone blocked: allow it in the address bar" : "Couldn't open the microphone");
  }
}

async function send(blob, cutAt) {
  inflight++;
  micState.textContent = "Translating…";
  try {
    const r = await fetch(`/api/rooms/${id}/utterance`, { method: "POST", headers: { "content-type": "audio/wav", ...(key ? { "x-key": key } : {}) }, body: blob });
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
  if (e.target.closest("input, textarea")) return;
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

// ---------- live ----------
connect(id, { role: "host", ...(key ? { key } : {}) }, (m) => {
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
  if (["hello", "slide", "reset"].includes(m.type)) drawSlides();
  if (["hello", "status", "reset"].includes(m.type)) drawStatus();
  if (["hello", "line", "reset"].includes(m.type)) drawLines();
  if (["hello", "board", "slide"].includes(m.type)) drawBoard();
}, (s) => s === "offline" && toast("Connection lost, reconnecting…"));

drawStatus();
drawLines();
drawSlides();
if (!board && meta.demo) api(`/api/rooms/${id}/board`).then((b) => ((board = b), drawBoard())).catch(() => {});
