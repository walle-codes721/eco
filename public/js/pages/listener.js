import { h, icon, api, roomId, who, toast, fmtTime, langName, phoneLang, keepAwake, store, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { voice } from "/js/speak.js";
import { stageAudio } from "/js/stage-audio.js";
import { t } from "/js/i18n.js";
import { captionFor, nearBottom, nextNewCount } from "/js/caps.js";
import { pollQ, pollOpts, pollResults } from "/js/polls.js";
import { deckFor } from "/js/slides.js";

const id = roomId();
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`);
} catch {
  notFound();
  throw new Error("no room");
}

const choices = [...new Set([...meta.langs, "en"])];
let lang = store(`eco:lang:${id}`) ?? (choices.includes(phoneLang()) ? phoneLang() : meta.langs[0]);
let lines = [];
let summary = null; // { text: { en, it, ... } } once the speaker has made one
const myQs = store(`eco:qs:${id}`) ?? [];
let polls = []; // what the speaker asked: open polls, plus closed ones whose results they shared
const votes = store(`eco:votes:${id}`) ?? {}; // poll id -> my answer
const rankDraft = {}; // poll id -> option order, before Send
const voter = store("eco:voter") ?? ((v) => (store("eco:voter", v), v))(crypto.randomUUID()); // one answer per phone per poll
let live = null;
let atBottom = true; // smart follow: pinned to live unless the listener scrolls up
let newCount = 0; // lines that arrived while reading history
const T = (k) => t(lang, k);
const textOf = (l) => captionFor(l, lang).text;
const playback = stageAudio({ play: (...args) => voice.playStage(...args), stop: () => voice.stopStage() });
addEventListener("pagehide", () => playback.clear());

// ---------- shell ----------
const langSel = h("select.lang-select", { "aria-label": "Language" }, ...choices.map((l) => h("option", { value: l, selected: l === lang }, langName(l, l))));
const soundBtn = h("button.btn.icon-btn", { type: "button" });
const titleEl = h("span.title.truncate", {}, meta.title);
const bar = h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), titleEl, h("span.spacer"), langSel, soundBtn));
const statusRow = h("div.status-row");
const caps = h("div.captions", { "aria-live": "polite" });
const summaryBox = h("section", { hidden: true });
const jumpBtn = h("button.caps-jump", { type: "button" });
const capsWrap = h("div.caps-wrap", {}, caps, jumpBtn);
const qInput = h("input", { type: "text", maxlength: 300, enterkeyhint: "send" });
const qSend = h("button.send", { type: "submit", "aria-label": "Send" }, icon("up"));
const qForm = h("form.ask-box", {}, qInput, qSend);
const qList = h("div");
const askHead = h("h2", { style: { fontSize: "20px" } });
const pollHead = h("h2", { style: { fontSize: "20px" } });
const pollPrev = h("button.btn.icon-btn", { type: "button", "aria-label": "Previous question", onclick: () => showPoll(at - 1) }, icon("prev"));
const pollNext = h("button.btn.icon-btn", { type: "button", "aria-label": "Next question", onclick: () => showPoll(at + 1) }, icon("next"));
const pollSlot = h("div.poll-slot");
const pollDots = h("div.poll-dots");
const newQBtn = h("button.btn.sm.primary", { type: "button", hidden: true, onclick: () => showPoll(polls.findIndex((p) => unseen.has(p.id))) });
const pollBox = h("section.lst-panel.lst-polls", { hidden: true },
  h("div.row", { style: { alignItems: "center", marginBottom: "10px" } }, pollHead, h("span.spacer"), newQBtn),
  h("div.poll-carousel", {}, pollPrev, pollSlot, pollNext), pollDots);
// The deck: the live slide by default; listeners can page back, never ahead of the speaker.
const slideHead = h("h2", { style: { fontSize: "20px" } });
const slideFrame = h("div.slide-frame");
const slideLabel = h("span.small.muted.mono");
const slidePrev = h("button.btn.icon-btn", { type: "button", "aria-label": "Previous slide", onclick: () => goSlide(view - 1) }, icon("prev"));
const slideNext = h("button.btn.icon-btn", { type: "button", "aria-label": "Next slide", onclick: () => goSlide(view + 1) }, icon("next"));
const currentBtn = h("button.btn.sm", { type: "button", hidden: true, onclick: () => goSlide(Infinity) });
// Expand: the slide at ~80% of the screen over the dimmed page; Esc or a tap outside closes it.
const zoomBtn = h("button.btn.icon-btn", { type: "button", onclick: () => zoom(true) }, icon("expand"));
const slideBox = h("section.lst-panel.lst-slides", { hidden: true }, h("div.divider"),
  h("div.row", { style: { alignItems: "center", marginBottom: "10px" } }, slideHead, h("span.spacer"), currentBtn, zoomBtn),
  slideFrame,
  h("div.row", { style: { justifyContent: "center", gap: "12px", marginTop: "10px" } }, slidePrev, slideLabel, slideNext),
  h("div.zoom-back", { onclick: () => zoom(false) }));
const askSub = h("p.small.muted");
const askBox = h("section.lst-panel.lst-ask", {},
  h("div.row", { style: { alignItems: "baseline", marginBottom: "4px" } }, askHead),
  askSub,
  h("div", { style: { margin: "14px 0" } }, qForm),
  qList,
);
// Phones: polls + questions live in a sheet that peeks from the bottom. Laptops: the handle is hidden and both panels sit under the slides.
const sheetLabel = h("span");
const sheetDot = h("span.needs", { hidden: true });
const sheet = h("div.qsheet", {},
  h("button.qsheet-handle", { type: "button", onclick: () => sheet.classList.toggle("open") }, sheetLabel, sheetDot),
  h("div.qsheet-body", {}, pollBox, askBox));
const main = h("main.phone.listen", {},
  h("div.lst-panel.lst-caps", {}, statusRow, capsWrap), slideBox, sheet,
);
document.body.replaceChildren(bar, main);

function labels() {
  document.documentElement.lang = lang;
  qInput.placeholder = T("askPh");
  askHead.textContent = T("ask");
  pollHead.textContent = T("poll");
  slideHead.textContent = T("slides");
  currentBtn.textContent = T("current");
  newQBtn.textContent = T("newQuestion");
  askSub.textContent = T("fromTalk");
  sheetLabel.textContent = T("questions");
  zoomBtn.setAttribute("aria-label", T("expand"));
  soundBtn.replaceChildren(icon(voice.on ? "sound" : "mute"));
  soundBtn.setAttribute("aria-label", voice.on ? T("soundOn") : T("soundOff"));
}

const speakingNow = new Set();
function drawStatus(conn) {
  const parts = [];
  if (conn === "offline") parts.push(h("span.pill.mock", {}, h("span.dot"), T("reconnecting")));
  else if (meta.status === "live") parts.push(h("span.pill.live", {}, h("span.dot"), "Live"));
  if (meta.status === "live") parts.push(h("span.chip", {}, `${T("slide")} ${meta.slide}`));
  if (meta.demo) parts.push(h("span.pill.replay", {}, h("span.dot"), "Replay"));
  if ((meta.speakers?.length ?? 0) > 1)
    for (const s of meta.speakers) if (speakingNow.has(s.id)) parts.push(h("span.chip.speaking", {}, h("span.dot.live"), s.name));
  statusRow.replaceChildren(...parts);
}

function drawCaps() {
  if (!lines.length) {
    caps.replaceChildren(h("div.empty", {}, h("p", { style: { fontSize: "20px", fontWeight: 600, color: "var(--ink)" } }, T("waiting")), h("p.small", { style: { marginTop: "6px" } }, T("waitingSub"))));
    return;
  }
  caps.replaceChildren(...lines.slice(-50).map((l) => h("p", { onclick: () => showMsg(l) }, who(meta, l), h("span.when", {}, fmtTime(l.at)),
    !captionFor(l, lang).lang ? h("span.chip", {}, T("original")) : null, textOf(l))));
  if (atBottom) caps.scrollTop = caps.scrollHeight;
}

// Tap a caption to read it comfortably: same overlay as the welcome sheet, centered.
function showMsg(l) {
  const textLang = captionFor(l, lang).lang;
  const close = h("button.btn.ghost", { type: "button" }, icon("x"), T("close"));
  const wrap = h("div.sheet-wrap.msg-wrap", { onclick: (e) => { if (e.target === wrap) done(); } },
    h("div.msg-modal", {},
      h("p.msg-meta", {}, who(meta, l), h("span.when", {}, fmtTime(l.at)), h("span.msg-lang", {}, textLang ? langName(textLang, textLang) : T("original"))),
      h("p.msg-text", {}, textOf(l)),
      h("div.msg-end", {}, close),
    ));
  const onKey = (e) => { if (e.key === "Escape") done(); };
  function done() { wrap.remove(); removeEventListener("keydown", onKey); }
  close.onclick = done;
  addEventListener("keydown", onKey);
  document.body.append(wrap);
}

function drawJump() {
  jumpBtn.replaceChildren(`${newCount} ${T("newLines")}`, icon("down"));
  jumpBtn.classList.toggle("show", !atBottom && newCount > 0);
}

function snapToLive() {
  atBottom = true;
  newCount = 0;
  drawJump();
  if (caps.scrollTo) caps.scrollTo({ top: caps.scrollHeight, behavior: "smooth" });
  else caps.scrollTop = caps.scrollHeight;
}

caps.onscroll = () => {
  const was = atBottom;
  atBottom = nearBottom(caps);
  // Scrolling only ever clears the pill (the reset half of nextNewCount);
  // counting up is addLine's job, so mere scrolling never bumps the count.
  if (atBottom) newCount = 0;
  if (atBottom !== was) drawJump();
};

jumpBtn.onclick = snapToLive;

function addLine(l) {
  atBottom = nearBottom(caps); // re-derive: programmatic scrollTop changes also fire onscroll
  lines.push(l);
  lines = lines.slice(-50);
  drawCaps();
  newCount = nextNewCount(newCount, atBottom);
  drawJump();
  caps.lastElementChild?.classList.add("new");
  // A speaker with a voice sample: wait briefly for their cloned clip, else the phone speaks.
  const sp = meta.speakers?.find((s) => s.id === (l.speaker ?? "s0"));
  const idx = Math.max(0, meta.speakers?.indexOf(sp) ?? 0);
  playback.line({ seq: l.seq, text: textOf(l), lang, speaker: idx, url: l.audio?.[lang], wait: meta.voice && sp?.voice, enabled: voice.on });
}
function onAudio(m) {
  const l = lines.find((x) => x.seq === m.seq);
  if (l) l.audio = { ...l.audio, ...m.audio };
  playback.audio(m.seq, m.audio);
}

// The speaker's typed answer in the listener's language once it is translated, otherwise exactly as the speaker typed it.
const spoken = (q) => q.speakerAnswers?.[lang] ?? q.speakerAnswer;

function drawQs() {
  qList.replaceChildren(...myQs.slice().reverse().map((q) =>
    h("div.qa", {},
      h("div.q", {}, q.text),
      q.pending ? h("div.a.muted", {}, "…") :
        q.speakerAnswer ? h("div.a", {}, spoken(q)) : // the speaker typed an answer to a question the talk didn't cover
        q.covered ? h("div.a", {}, q.answer) : h("div.a.muted", {}, T("notCovered")),
      h("div.meta", {},
        q.speakerAnswer ? h("span.chip", {}, T("fromSpeaker")) : null,
        q.covered && q.cite ? h("span.chip", {}, q.cite === "answers" ? T("fromSpeaker") : q.cite) : null, // "answers" is what a speaker taught Eco
        q.answeredAt != null ? h("span", {}, icon("check"), ` ${T("answeredAt")} ${fmtTime(q.answeredAt)}`) : null,
      ),
    )));
}

// ---------- polls from the speaker ----------
// One poll at a time, oldest to newest. `curId` keeps the same poll on screen when the list changes.
let at = 0, curId = null;
const unseen = new Set(); // polls that arrived while the listener was looking at another one
const todo = (p) => p.open && votes[p.id] === undefined;

function showPoll(i) {
  if (i < 0 || i >= polls.length) return;
  at = i;
  curId = polls[i].id;
  drawPolls();
}

function drawPolls() {
  pollBox.hidden = !polls.length;
  sheetDot.hidden = !polls.some(todo);
  if (!polls.length) return;
  const i = polls.findIndex((p) => p.id === curId);
  at = Math.max(0, Math.min(i >= 0 ? i : at, polls.length - 1));
  const p = polls[at];
  curId = p.id;
  unseen.delete(p.id);
  pollSlot.replaceChildren(pollCard(p));
  pollPrev.disabled = at === 0;
  pollNext.disabled = at === polls.length - 1;
  pollPrev.classList.toggle("todo", polls.slice(0, at).some(todo)); // something unanswered that way
  pollNext.classList.toggle("todo", polls.slice(at + 1).some(todo));
  pollDots.hidden = polls.length < 2;
  pollDots.replaceChildren(...polls.map((x, j) =>
    h(`button.poll-dot${j === at ? ".on" : ""}${todo(x) ? ".todo" : ""}`, { type: "button", "aria-label": `${j + 1} / ${polls.length}`, onclick: () => showPoll(j) })));
  newQBtn.hidden = !unseen.size;
}

let touchX = null;
pollSlot.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
pollSlot.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - (touchX ?? e.changedTouches[0].clientX);
  touchX = null;
  if (Math.abs(dx) > 60 && !e.target.closest("input, button")) showPoll(at + (dx < 0 ? 1 : -1));
});

// ---------- slides ----------
let deck = null, view = 1, following = true;
let drawn = 0; // newest render wins when taps outrun pdf.js

function goSlide(n) {
  const top = Math.min(meta.slide, deck?.count ?? 1);
  view = Math.max(1, Math.min(n, top));
  following = view === top;
  drawSlide();
}

async function drawSlide() {
  if (!deck) return;
  const top = Math.min(meta.slide, deck.count);
  view = following ? top : Math.min(view, top);
  slideBox.hidden = false;
  slideLabel.textContent = `${view} / ${deck.count}`;
  slidePrev.disabled = view <= 1;
  slideNext.disabled = view >= top;
  currentBtn.hidden = view === top;
  const n = ++drawn;
  const el = await deck.render(view, slideFrame.clientWidth || 360);
  if (n === drawn) slideFrame.replaceChildren(el);
}

function zoom(on) {
  slideBox.style.minHeight = on ? `${slideBox.offsetHeight}px` : ""; // the page behind stays put
  slideBox.classList.toggle("zoom", on);
  drawSlide(); // re-render at the new frame width
}

addEventListener("keydown", (e) => {
  if (!slideBox.classList.contains("zoom")) return void (e.key === "Escape" && sheet.classList.remove("open"));
  if (e.key === "Escape") zoom(false);
  if (e.key === "ArrowLeft") goSlide(view - 1);
  if (e.key === "ArrowRight") goSlide(view + 1);
});

/** Never blocks the captions: the section appears once the deck is ready. `fresh` skips the cached copy after a new upload. */
async function loadSlides(fresh = false) {
  if (!meta.deck && !meta.slides?.length) return void (slideBox.hidden = true);
  deck = await deckFor(id, meta, { fresh }).catch(() => null);
  drawSlide();
}

function pollCard(p) {
  const mine = votes[p.id];
  const opts = pollOpts(p, lang);
  const pick = (label, a) => h("button.toggle", { type: "button", "aria-pressed": String(mine === a), onclick: () => vote(p, a) }, label);
  let input = null;
  if (p.open && (p.kind === "choice" || p.kind === "tf")) input = h("div.lang-grid", {}, ...opts.map((o, i) => pick(o, i)));
  if (p.open && p.kind === "rating") input = h("div.lang-grid", {}, ...Array.from({ length: p.max - p.min + 1 }, (_, i) => pick(String(p.min + i), p.min + i)));
  if (p.open && p.kind === "rank") {
    const order = (rankDraft[p.id] ??= mine ?? opts.map((_, i) => i));
    const move = (i, d) => { [order[i], order[i + d]] = [order[i + d], order[i]]; drawPolls(); };
    input = h("div.stack", { style: { gap: "6px" } },
      ...order.map((o, i) => h("div.row", { style: { gap: "6px" } },
        h("span.chip", {}, String(i + 1)), h("span", { style: { flex: 1 } }, opts[o]),
        h("button.btn.icon-btn", { type: "button", "aria-label": "Up", disabled: i === 0, onclick: () => move(i, -1) }, icon("up")),
        h("button.btn.icon-btn", { type: "button", "aria-label": "Down", disabled: i === order.length - 1, onclick: () => move(i, 1) }, icon("down")))),
      h("div", {}, h("button.btn.sm", { type: "button", onclick: () => vote(p, order.slice()) }, T("send"))));
  }
  if (p.open && p.kind === "free") {
    const inp = h("input", { type: "text", maxlength: 200, placeholder: T("typeAnswer"), enterkeyhint: "send" });
    if (typeof mine === "string") inp.value = mine;
    const form = h("form.ask-box", {}, inp, h("button.send", { type: "submit", "aria-label": T("send") }, icon("up")));
    form.onsubmit = (e) => (e.preventDefault(), inp.value.trim() && vote(p, inp.value.trim()));
    input = form;
  }
  return h(`div.qa${todo(p) ? ".todo" : ""}`, {},
    h("div.q", {}, pollQ(p, lang)),
    input,
    h("div.meta", {}, !p.open ? h("span.chip", {}, T("closed")) : mine !== undefined ? h("span", {}, T("sent")) : null),
    p.tally && (mine !== undefined || !p.open) ? pollResults(p, lang) : null,
  );
}

async function vote(p, a) {
  const before = votes[p.id];
  votes[p.id] = a;
  drawPolls();
  try {
    await api(`/api/rooms/${id}/vote`, { method: "POST", body: { pid: p.id, voter, lang, a } });
    store(`eco:votes:${id}`, votes);
  } catch (err) {
    before === undefined ? delete votes[p.id] : (votes[p.id] = before);
    drawPolls();
    toast(err.status === 409 ? T("closed") : T("busy"));
  }
}

qForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = qInput.value.trim();
  if (!text) return;
  qInput.value = "";
  const q = { text, pending: true };
  myQs.push(q);
  drawQs();
  try {
    const r = await api(`/api/rooms/${id}/ask`, { method: "POST", body: { text, lang } });
    Object.assign(q, { id: r.id, covered: r.covered, answer: r.answer, cite: r.cite, pending: false, answeredAt: null });
  } catch (err) {
    myQs.splice(myQs.indexOf(q), 1);
    qInput.value = text;
    toast(err.status === 429 ? T("limit") : T("busy"));
  }
  store(`eco:qs:${id}`, myQs);
  drawQs();
};

langSel.onchange = () => {
  playback.clear();
  lang = langSel.value;
  store(`eco:lang:${id}`, lang);
  live?.send({ type: "lang", lang });
  labels();
  drawCaps();
  drawQs();
  drawSummary();
  drawJump();
  drawStatus();
  drawPolls();
};
soundBtn.onclick = () => {
  playback.clear();
  voice.on ? voice.off() : voice.unlock();
  labels();
  toast(voice.on ? T("soundOn") : T("soundOff"));
};

// ---------- recap ----------
const summaryText = () => summary?.text[lang] ?? summary?.text.en ?? "";

function drawSummary() {
  const text = summaryText();
  summaryBox.hidden = !text;
  summaryBox.replaceChildren(
    h("h2", { style: { fontSize: "20px", margin: "12px 0" } }, T("summary")),
    ...text.split("\n").filter(Boolean).map((p) => h("p", { style: { margin: "6px 0" } }, p.replace(/^-\s*/, "• "))),
  );
}

async function recap() {
  // Normal completion keeps accepted final phrases alive, including clone timers.
  // Explicit mute, language change, reset and page exit still cancel immediately.
  const { lines: all } = await api(`/api/rooms/${id}/transcript`).catch(() => ({ lines }));
  summary = (await api(`/api/rooms/${id}/summary`).catch(() => ({}))).summary ?? null;
  drawSummary();
  const shareBtn = h("button.btn", { type: "button" }, icon("share"), T("share"));
  shareBtn.onclick = () => {
    const text = `${meta.title}\n\n` + (summaryText() ? `${summaryText()}\n\n` : "") + all.map((l) => textOf(l)).join("\n");
    navigator.share ? navigator.share({ title: meta.title, text }).catch(() => {}) : navigator.clipboard.writeText(text).then(() => toast("Copied"));
  };
  main.className = "phone"; // recap is the single column, not the live layout
  main.replaceChildren(
    h("section", { style: { padding: "40px 0 24px" } },
      h("p.eyebrow", {}, T("ended")),
      h("h1", { style: { fontSize: "34px", margin: "8px 0 4px" } }, T("recap")),
      h("p.muted", {}, `${meta.title}${meta.speaker ? ` · ${meta.speaker}` : ""}`),
      h("div.row", { style: { marginTop: "18px" } }, shareBtn),
    ),
    summaryBox,
    h("section", { hidden: !myQs.length }, h("h2", { style: { fontSize: "20px", margin: "12px 0" } }, T("yourQs")), qList),
    h("section", { style: { padding: "12px 0 64px" } },
      h("h2", { style: { fontSize: "20px", margin: "12px 0" } }, T("transcript")),
      ...all.map((l) => h("p", { style: { padding: "8px 0", borderTop: "1px solid var(--line)" } }, h("span.tiny.faint", {}, `${fmtTime(l.at)}  `), textOf(l))),
    ),
  );
  drawQs();
}

// ---------- welcome sheet ----------
function welcome() {
  return new Promise((resolve) => {
    const sel = h("div.lang-grid", { style: { justifyContent: "center" } });
    const draw = () => sel.replaceChildren(...choices.map((l) =>
      h("button.toggle", { type: "button", "aria-pressed": String(l === lang), onclick: () => ((lang = l), (langSel.value = l), draw(), redo()) }, langName(l, l))));
    const listenBtn = h("button.btn.primary.big.block", { type: "button" });
    const textBtn = h("button.btn.ghost.block", { type: "button" });
    const note = h("p.tiny.muted.center");
    const redo = () => {
      listenBtn.replaceChildren(icon("sound"), T("listen"));
      textBtn.textContent = T("textOnly");
      note.textContent = T("joinNote");
    };
    draw();
    redo();
    const wrap = h("div.sheet-wrap", {}, h("div.sheet.stack", { style: { gap: "18px" } },
      h("div.center", {}, h("span.brand", {}, "Eco")),
      h("div.center", {}, h("h1", { style: { fontSize: "30px", textWrap: "balance" } }, meta.title), meta.speaker ? h("p.muted", { style: { marginTop: "6px" } }, meta.speaker) : null),
      sel, listenBtn, textBtn, note,
    ));
    const go = (withSound) => {
      if (withSound) voice.unlock();
      store(`eco:lang:${id}`, lang);
      sessionStorage.setItem(`eco:joined:${id}`, "1");
      wrap.remove();
      resolve();
    };
    listenBtn.onclick = () => go(true);
    textBtn.onclick = () => go(false);
    document.body.append(wrap);
  });
}

labels();
drawCaps();
drawQs();
drawStatus();
if (meta.status === "ended") {
  recap();
} else {
  if (!sessionStorage.getItem(`eco:joined:${id}`)) await welcome();
  labels();
  keepAwake();
  loadSlides();
  live = connect(id, { role: "listener", lang }, (m) => {
    if (m.type === "hello") {
      Object.assign(meta, m.meta);
      lines = m.lines ?? [];
      playback.clear(lines.at(-1)?.seq ?? 0);
      polls = m.polls ?? [];
      const first = polls.findIndex(todo); // (re)join: land on the first poll still waiting for an answer, else the newest
      curId = polls[first >= 0 ? first : polls.length - 1]?.id ?? null;
      drawPolls();
      drawSlide();
      snapToLive(); // (re)connect: anchor on the newest line, clear any stale pill
      drawCaps();
      if (meta.status === "ended") return recap();
    }
    if (m.type === "line") addLine(m.line);
    if (m.type === "audio") onAudio(m);
    if (m.type === "poll") {
      polls.push(m.poll);
      if (polls.length === 1) curId = m.poll.id;
      else unseen.add(m.poll.id);
      drawPolls();
    }
    if (m.type === "tally") { const p = polls.find((x) => x.id === m.pid); if (p) (p.tally = m.tally), drawPolls(); }
    if (m.type === "pollclose") (polls = m.poll ? polls.map((x) => (x.id === m.pid ? m.poll : x)) : polls.filter((x) => x.id !== m.pid)), drawPolls();
    if (m.type === "speakers") (meta.speakers = m.speakers), drawCaps();
    if (m.type === "speaking") m.on ? speakingNow.add(m.speaker) : speakingNow.delete(m.speaker);
    if (m.type === "slide") (meta.slide = m.n), drawSlide();
    if (m.type === "slides") (meta.slides = m.slides), loadSlides();
    if (m.type === "deck") (meta.deck = true), loadSlides(true);
    if (m.type === "reset") { playback.clear(0); Object.assign(meta, m.meta); lines = []; summary = null; drawCaps(); drawSummary(); snapToLive(); drawSlide(); }
    if (m.type === "summary") (summary = m.summary), drawSummary();
    if (m.type === "status") {
      meta.status = m.status;
      if (m.status === "ended") return recap();
    }
    if (m.type === "answered") {
      let hit = false;
      for (const q of myQs) if (m.qids.includes(q.id)) (q.answeredAt = m.at), m.answer && (q.speakerAnswer = m.answer), (hit = true);
      if (hit) {
        store(`eco:qs:${id}`, myQs);
        drawQs();
        toast(m.answer ? T("fromSpeaker") : `${T("answeredAt")} ${fmtTime(m.at)}`, 3500); // the text itself is on the card, in the listener's language
      }
    }
    if (m.type === "answerTranslated") {
      // A moment after the speaker's own text: the same answer in every language of the room.
      let hit = false;
      for (const q of myQs) if (m.qids.includes(q.id)) (q.speakerAnswers = m.answers), (hit = true);
      if (hit) {
        store(`eco:qs:${id}`, myQs);
        drawQs();
      }
    }
    drawStatus();
  }, drawStatus);
}
