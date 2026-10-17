import { h, icon, api, roomId, who, toast, fmtTime, langName, phoneLang, keepAwake, store, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { voice } from "/js/speak.js";
import { t } from "/js/i18n.js";
import { captionFor, nearBottom, nextNewCount } from "/js/caps.js";

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
let live = null;
let atBottom = true; // smart follow: pinned to live unless the listener scrolls up
let newCount = 0; // lines that arrived while reading history
const T = (k) => t(lang, k);
const textOf = (l) => captionFor(l, lang).text;

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
const askSub = h("p.small.muted");
const main = h("main.phone", {},
  statusRow, capsWrap,
  h("section", { style: { padding: "28px 0 48px" } },
    h("div.divider"),
    h("div.row", { style: { alignItems: "baseline", marginBottom: "4px" } }, askHead),
    askSub,
    h("div", { style: { margin: "14px 0" } }, qForm),
    qList,
  ),
);
document.body.replaceChildren(bar, main);

function labels() {
  document.documentElement.lang = lang;
  qInput.placeholder = T("askPh");
  askHead.textContent = T("ask");
  askSub.textContent = T("fromTalk");
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
  if (meta.voice && sp?.voice && !l.audio?.[lang]) {
    pendingVoice = { seq: l.seq, timer: setTimeout(() => ((pendingVoice = null), voice.say(textOf(l), lang, null, idx)), 4000) };
  } else voice.say(textOf(l), lang === "en" ? "en" : lang, l.audio?.[lang], idx);
}
let pendingVoice = null;
function onAudio(m) {
  const l = lines.find((x) => x.seq === m.seq);
  if (l) l.audio = { ...l.audio, ...m.audio };
  if (pendingVoice?.seq === m.seq && m.audio[lang]) {
    clearTimeout(pendingVoice.timer);
    pendingVoice = null;
    voice.say(textOf(l ?? {}), lang, m.audio[lang]);
  }
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
  lang = langSel.value;
  store(`eco:lang:${id}`, lang);
  live?.send({ type: "lang", lang });
  labels();
  drawCaps();
  drawQs();
  drawSummary();
  drawJump();
  drawStatus();
};
soundBtn.onclick = () => {
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
  const { lines: all } = await api(`/api/rooms/${id}/transcript`).catch(() => ({ lines }));
  summary = (await api(`/api/rooms/${id}/summary`).catch(() => ({}))).summary ?? null;
  drawSummary();
  const shareBtn = h("button.btn", { type: "button" }, icon("share"), T("share"));
  shareBtn.onclick = () => {
    const text = `${meta.title}\n\n` + (summaryText() ? `${summaryText()}\n\n` : "") + all.map((l) => textOf(l)).join("\n");
    navigator.share ? navigator.share({ title: meta.title, text }).catch(() => {}) : navigator.clipboard.writeText(text).then(() => toast("Copied"));
  };
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
  live = connect(id, { role: "listener", lang }, (m) => {
    if (m.type === "hello") {
      Object.assign(meta, m.meta);
      lines = m.lines ?? [];
      snapToLive(); // (re)connect: anchor on the newest line, clear any stale pill
      drawCaps();
      if (meta.status === "ended") return recap();
    }
    if (m.type === "line") addLine(m.line);
    if (m.type === "audio") onAudio(m);
    if (m.type === "speakers") (meta.speakers = m.speakers), drawCaps();
    if (m.type === "speaking") m.on ? speakingNow.add(m.speaker) : speakingNow.delete(m.speaker);
    if (m.type === "slide") meta.slide = m.n;
    if (m.type === "reset") { lines = []; summary = null; drawCaps(); drawSummary(); snapToLive(); }
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
