import { h, icon, api, roomId, who, hostKey, qrSvg, fullUrl, shortUrl, toast, fmtTime, langName, modePill, notFound, phoneLang, store, me, STAGE_LANGS, MAX_STAGE_LANGS } from "/js/eco.js";
import { connect } from "/js/live.js";
import { phraseMic, levelMic, phraseInit, speakingSignal, micErrorMessage, SPOKEN_LANGUAGES } from "/js/mic.js";
import { deckFor, openPdf, pdfPages, pdfDeckRows, saveDeck, uploadDeck, scriptFileText } from "/js/slides.js";
import { parseScript, scriptSummary } from "/js/script.js";
import { openDeckRowCarousel } from "/js/deck-preview.js";
import { voiceCard } from "/js/sample.js";
import { t } from "/js/i18n.js";
import { pollQ, pollResults } from "/js/polls.js";
import { nearBottom, setFocus } from "/js/caps.js";

const id = roomId();
const key = hostKey(id);
let meta, deck, stopMic = null, inflight = 0, lastLatency = null, drawSpeakers = () => {};
const speaking = new Set();
let lines = [];
let board = null;
let polls = [];

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
// One language for the whole console: what the mic listens for, and what you write and read polls in.
const spokenLang = h("select.lang-select", { "aria-label": "Your language", title: "Your language: what the mic listens for, and the language you write and read questions in. Stop the mic to change it." },
  ...[...new Set([...SPOKEN_LANGUAGES, "en", ...meta.langs])].map((l) => h("option", { value: l }, `${l.toUpperCase()} · ${langName(l, "en")}`)));
spokenLang.value = store(`eco:plang:${id}`) ?? phoneLang();
if (!spokenLang.value) spokenLang.value = "en";
spokenLang.onchange = () => (store(`eco:plang:${id}`, spokenLang.value), drawPolls());
const bar = h("header.bar", {}, h("div.inner", {},
  h("a.brand", { href: "/" }, "Eco"),
  h("span.title.truncate", {}, meta.title),
  meta.live && !meta.demo ? null : modePill(meta), statusPill, timer,
  h("span.spacer"),
  spokenLang, latency, calls,
  h("a.btn.sm", { href: `/${id}/screen`, target: "eco-screen" }, icon("ext"), "Projector"),
  host ? h("a.btn.sm", { href: `/${id}/card` }, "Card") : null,
  host && !meta.demo ? h("button.btn.sm", { type: "button", onclick: () => setupSheet() }, icon("doc"), "Slides & voice") : null,
  host ? endBtn : null,
));

// ---------- slide: as big as the column allows; arrows and counter on hover ----------
const slideNow = h("div.slide-frame");
const slideLabel = h("span.slide-count");
const prev = h("button.btn.icon-btn", { type: "button", "aria-label": "Previous slide", onclick: () => goSlide(meta.slide - 1), disabled: demo }, icon("prev"));
const next = h("button.btn.icon-btn", { type: "button", "aria-label": "Next slide", onclick: () => goSlide(meta.slide + 1), disabled: demo }, icon("next"));
const slideStage = h("div.slide-stage", {}, h("div.slide-box", {}, slideNow, h("div.slide-nav", {}, prev, slideLabel, next)));

// ---------- mic (bottom-left) ----------
const level = h("i");
const micState = h("div.tiny.muted", {}, "Off");
const micBtn = h("button.mic-btn", { type: "button", onclick: () => toggleMic(), title: demo ? "30 seconds of live mic. The replay pauses while you talk." : "Eco cuts at your natural pauses. Space toggles the mic." },
  h("span.ico", {}, icon("mic")),
  h("div", {}, h("div", { style: { fontWeight: 600 } }, demo ? "Try with your voice" : "Microphone"), micState),
);

// QR box: the audience link, or (+ Co-speaker) the co-speaker join link.
const joinUrl = meta.joinKey ? fullUrl(`/${id}/join#j=${meta.joinKey}`) : null;
const qrBox = h("div.card.qr-card");
const drawQr = (join) => qrBox.replaceChildren(
  ...(join ? [h("button.btn.sm.qr-back", { type: "button", onclick: () => drawQr(false) }, "Back")] : []),
  h("div.qr-fit", {}, qrSvg(join ? joinUrl : fullUrl(`/${id}`))),
  join ? h("p.tiny.muted.truncate", {}, "Co-speakers scan this with their own phone")
    : h("a.url.truncate", { href: fullUrl(`/${id}`), target: "_blank", rel: "noopener", title: fullUrl(`/${id}`) }, shortUrl(`/${id}`)),
);
drawQr(false);

const speakersList = h("div.row", { style: { flexWrap: "wrap", gap: "6px" } });
drawSpeakers = () => speakersList.replaceChildren(...(meta.speakers.length > 1 ? meta.speakers.map((s) =>
  h(`span.chip${speaking.has(s.id) ? ".speaking" : ""}`, {}, speaking.has(s.id) ? h("span.dot.live") : null, s.name)) : []));

const micBox = h("div.card.mic-box", {},
  h("div.row", { style: { gap: "10px" } }, micBtn, h("span.spacer"),
    joinUrl ? h("button.link-btn.tiny", { type: "button", onclick: () => drawQr(true) }, "+ Co-speaker") : null),
  h("div.level", {}, level),
  speakersList,
);

// ---------- transcript ----------
// Scrollable history: the big bold line (and its translations) follows the scroll; at the bottom it follows the talk.
const now = h("div.said");
const trBox = h("div.said-tr");
let atBottom = true, focused = null; // focused: the line shown big, with its translations below
const jumpBtn = h("button.caps-jump", { type: "button", "aria-label": "Back to latest", onclick: () => ((now.scrollTop = now.scrollHeight), followed()) }, icon("down"));
const saidCard = h("div.card.said-card", {},
  h("div.card-head", {}, h("span.eyebrow", {}, "You said"), h("span.spacer"), h("span.chip", {}, "Original")),
  h("div.caps-wrap", {}, now, jumpBtn),
  trBox,
);
now.onscroll = followed;
// The translation rows below (and the slide above) resize the scroller: stay pinned while following.
new ResizeObserver(() => atBottom && (now.scrollTop = now.scrollHeight)).observe(now);
function followed() {
  atBottom = nearBottom(now);
  jumpBtn.classList.toggle("show", !atBottom);
  const i = lines.length ? setFocus(now, atBottom) : -1;
  const l = lines[i];
  if (l === focused) return;
  focused = l;
  trBox.replaceChildren(...(l ? meta.langs.map((g) => h("div.tr", {}, h("span.chip", { title: langName(g) }, g.toUpperCase()), h("span", {}, l.out[g] ?? "", l.flags?.includes(g) ? h("span.tiny.muted", {}, "  · literal") : null))) : []));
}

// ---------- teleprompter: the speaker's own script, one line at a time (host only) ----------
// Lines carry the slide their cue set: stepping across a cue changes the slide, changing the slide jumps here.
let script = host && !meta.demo ? meta.script ?? "" : "";
let promptLines = parseScript(script).lines;
let line = Math.min(Number(store(`eco:prompt:${id}`)) || 0, Math.max(promptLines.length - 1, 0));
const promptText = h("div.prompter-text");
const promptCount = h("span.slide-count");
const lineUp = h("button.btn.icon-btn", { type: "button", "aria-label": "Previous line", onclick: () => stepLine(-1) }, icon("up"));
const lineDown = h("button.btn.icon-btn", { type: "button", "aria-label": "Next line", onclick: () => stepLine(1) }, icon("down"));
const scriptBtn = h("button.btn.icon-btn.ghost", { type: "button", "aria-label": "Edit script", title: "Edit script", onclick: () => scriptSheet() }, icon("text"));
const prepPill = h("button.pill", { type: "button", hidden: true, title: "HACKATHON mode: your script, translated and voiced before the talk", onclick: () => prep({ retry: true }) });
const langAdd = h("select.pill", { hidden: true, "aria-label": "Add a language", title: "Add a language: your script is translated and voiced in it", onchange: () => addLang(langAdd.value) });
const promptNav = h("div.prompter-nav", {}, lineUp, promptCount, lineDown, prepPill, langAdd, scriptBtn);
const prompter = host && !meta.demo ? h("div.card.prompter-card", {}, promptText, promptNav) : null;
function goLine(n, step = false) {
  if (!promptLines.length) {
    promptNav.hidden = true;
    return promptText.replaceChildren(h("button.btn.prompter-add", { type: "button", onclick: () => scriptSheet() }, icon("plus"), "Add your script"));
  }
  promptNav.hidden = false;
  const from = promptLines[line]?.slide;
  line = Math.max(0, Math.min(n, promptLines.length - 1));
  store(`eco:prompt:${id}`, String(line));
  const cur = promptLines[line], prev = promptLines[line - 1], next = promptLines[line + 1];
  promptText.replaceChildren(
    cur.note ? h("div.past.note", {}, icon("flag"), cur.note) : h("div.past", {}, prev?.text ?? "\u00a0"),
    h("div.now", {}, cur.text),
    h("div.past", {}, next?.slide && next.slide !== cur.slide ? h("span.chip", {}, `Slide ${next.slide}`) : null, next?.text ?? "\u00a0"),
  );
  promptCount.textContent = `${line + 1} / ${promptLines.length}`;
  lineUp.disabled = line <= 0;
  lineDown.disabled = line >= promptLines.length - 1;
  // Only a step across a cue moves the slide; loading or saving the script never does.
  if (step && cur.slide && cur.slide !== from && cur.slide !== meta.slide && cur.slide <= deck.count) goSlide(cur.slide, true);
}
/** The slide changed some other way (keys, clicker, co-speaker): jump to that slide's first line. */
function followSlide(n) {
  if (!promptLines.length || promptLines[line].slide === n) return;
  const i = promptLines.findIndex((l) => l.slide === n);
  if (i >= 0) goLine(i), (cueFrom = line - 1);
}
if (prompter) goLine(line);

// ---------- HACKATHON mode (profile toggle, on by default) ----------
// Every script line is translated and voiced once, before the talk (the room's prep). Live, ↓ plays the next line's
// ready clips to the room: you read from the teleprompter, so the key is the timing. The mic only moves the level bar.
const hack = host && !meta.demo && ((await me()).user?.hackathon ?? true);
let cueFrom = line - 1; // the last line played; the first ↓ with the mic on plays the big line
function drawPrep(p) {
  drawLangAdd(p);
  prepPill.hidden = !hack || !p?.lines;
  if (prepPill.hidden) return;
  const working = p.translated < p.lines ? `Translating ${p.translated}/${p.lines}` : p.done < p.total ? `Voices ${p.done}/${p.total}` : "";
  prepPill.textContent = (working || `Ready · ${p.lines} lines`) + (p.failed ? ` · ${p.failed} failed, retry` : "");
  prepPill.disabled = !p.failed;
}
/** "+ Language": adds a language to the talk; prep then translates and voices only that one. */
function drawLangAdd(p) {
  const left = STAGE_LANGS.filter((l) => !meta.langs.includes(l));
  langAdd.hidden = !hack || !p?.lines || meta.langs.length >= MAX_STAGE_LANGS || !left.length;
  langAdd.replaceChildren(h("option", { value: "" }, "+ Language"), ...left.map((l) => h("option", { value: l }, langName(l, "en"))));
}
async function addLang(l) {
  if (!l) return;
  langAdd.disabled = true;
  try {
    const r = await api(`/api/rooms/${id}/langs`, { method: "POST", key, body: { add: l } });
    meta.langs = r.langs;
    drawPrep(r.prep);
    toast(`${langName(l, "en")} added: translating and voicing your script`);
  } catch (err) {
    toast(err.message || "Couldn't add that language");
    langAdd.value = "";
  } finally {
    langAdd.disabled = false;
  }
}
/** Sends the teleprompter lines to prep: the room translates and voices whatever isn't made yet. */
async function prep(extra = {}) {
  if (!hack || !promptLines.length) return;
  try {
    drawPrep(await api(`/api/rooms/${id}/prep`, { method: "POST", key, body: { lines: promptLines.map((l) => l.text), ...extra } }));
  } catch {
    toast("Couldn't prepare your script");
  }
}
/** Plays line i to the room from prep, and moves the teleprompter (and the slide, at a cue) with you. */
function fire(i) {
  if (i < 0 || i >= promptLines.length) return;
  live.send({ type: "cue", text: promptLines[i].text });
  goLine(i, true);
}
/** ↓/↑ and the teleprompter arrows. With the mic on in HACKATHON mode, ↓ plays the next line to the room. */
function stepLine(d) {
  if (hack && stopMic && d > 0 && cueFrom + 1 < promptLines.length) return fire(++cueFrom);
  goLine(line + d, true);
  cueFrom = line - 1;
}
prep();

/** Paste, type or upload the script; saving re-parses it and keeps the current slide. */
function scriptSheet() {
  const box = h("textarea", { rows: 12, placeholder: "Paste or type what you plan to say. Mark slide changes with \"Slide 2:\" lines or [next slide]; other [notes] show as reminders." }, script);
  const count = h("span.small.muted.truncate");
  const recount = () => (count.textContent = scriptSummary(box.value, deck.count));
  box.oninput = recount;
  recount();
  const file = h("input", { type: "file", accept: ".txt,.md,.pdf,.docx", hidden: true });
  file.onchange = async () => {
    const f = file.files[0];
    file.value = "";
    if (!f) return;
    try {
      box.value = await scriptFileText(f);
      recount();
    } catch (err) {
      toast(err.message.startsWith("Save") ? err.message : "Couldn't read that file");
    }
  };
  const save = h("button.btn.primary.sm", { type: "button" }, icon("check"), "Save");
  save.onclick = async () => {
    save.disabled = true;
    try {
      ({ script } = await api(`/api/rooms/${id}/script`, { method: "POST", key, body: { script: box.value } }));
      promptLines = parseScript(script).lines;
      goLine(Math.max(0, promptLines.findIndex((l) => l.slide === meta.slide)));
      cueFrom = line - 1;
      prep();
      wrap.remove();
    } catch {
      toast("Couldn't save the script");
      save.disabled = false;
    }
  };
  const wrap = h("div.sheet-wrap", { onclick: (e) => e.target === wrap && wrap.remove() }, h("div.sheet.stack", { style: { gap: "14px", maxWidth: "560px", width: "100%" } },
    h("div.row", {}, h("h2", {}, "Teleprompter"), h("span.spacer"), h("button.btn.icon-btn", { type: "button", "aria-label": "Close", onclick: () => wrap.remove() }, icon("x"))),
    box,
    h("div.row", { style: { gap: "10px" } },
      h("button.btn.icon-btn", { type: "button", "aria-label": "Upload Word, PDF or text", title: "Upload Word, PDF or text", onclick: () => file.click() }, icon("doc")), file,
      count, h("span.spacer"), save)));
  document.body.append(wrap);
  box.focus();
}

// ---------- the board ----------
const listenersEl = h("div");
const askedEl = h("div");
const pollsEl = h("div");

document.body.classList.add("console-page");
document.body.replaceChildren(...[bar, demo ? h("div.wrap", { style: { maxWidth: "1840px", paddingTop: "12px" } },
  h("div.banner", {}, icon("play"), h("div", {}, h("b", {}, "Demo talk, replaying. "), "Open the audience link on your phone to follow it, ask it a question, and watch the board update. Or press “Try with your voice”."))) : null,
  h("main.console", {},
    h("div.col.col-left", {},
      h("div.card.room-card", {}, h("div.card-head", {}, h("span.eyebrow", {}, "Who's in the room")), listenersEl),
      h("div.card.grow", {}, h("div.card-head", {}, h("span.eyebrow", {}, "What the audience asked")), askedEl),
      micBox),
    h("div.col.col-mid", {}, prompter, slideStage, saidCard),
    h("div.col.col-right", {},
      host ? askCard() : h("div.card.grow", {}, h("div.card-head", {}, h("span.eyebrow", {}, "Ask")), h("p.empty", {}, "Open the presenter link to ask the room.")),
      qrBox),
  )].filter(Boolean));

// ---------- rendering ----------
async function drawSlides() {
  slideLabel.textContent = `${meta.slide} / ${deck.count}`;
  const w = slideNow.clientWidth || 280;
  slideNow.replaceChildren(await deck.render(meta.slide, w));
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
  // Keep the big line on the same phrase across redraws, so a new phrase never resizes what you're reading.
  if (!lines.length) now.replaceChildren(h("p.empty", {}, demo ? "Waiting for the replay…" : "Turn the mic on and start talking. Your words and their translations appear here."));
  else now.replaceChildren(...lines.map((l, i) => h(`p${i === lines.length - 1 ? ".now" : ""}${focused && l.seq === focused.seq ? ".focus" : ""}`, {}, who(meta, l), l.src)));
  if (atBottom) now.scrollTop = now.scrollHeight;
  followed();
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
  // Needs you first (not in the slides, unanswered), then what the slides answered, then what you already answered.
  const qItem = (g) => h(`div.q-item${g.answeredAt != null ? ".done" : ""}`, {},
    h("span.chip" + (g.count > 1 ? ".red" : ""), {}, String(g.count)),
    h("div", { style: { flex: 1, minWidth: 0 } }, h("div", {}, g.q), h("div.tiny.muted", {}, g.langs.map((l) => langName(l)).join(", "))),
    h("div.row", { style: { gap: "6px", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" } },
      g.taught ? h("span.tiny.muted", {}, "Eco learned this ✓")
        : g.answeredAt != null ? h("span.tiny.muted", {}, `answered ${fmtTime(g.answeredAt)}`) : null,
      host && !g.taught ? h("button.btn.icon-btn.q-act", { type: "button", "aria-label": "Answer it", title: "Answer it: teach Eco the answer", onclick: () => teachSheet(g) }, "Aa") : null,
      g.answeredAt == null ? h("button.btn.icon-btn.q-act", { type: "button", "aria-label": "Answered", title: "Mark answered", onclick: () => answered(g.qids) }, icon("check")) : null));
  const open = board.queue.filter((g) => g.answeredAt == null);
  const done = board.queue.filter((g) => g.answeredAt != null);
  askedEl.replaceChildren(...(board.queue.length || board.topics.length ? [
    open.length ? h("p.tiny.muted.asked-label", {}, "Not in your slides · answer out loud, then tap") : null,
    ...open.map(qItem),
    board.topics.length ? h("p.tiny.muted.asked-label", {}, "Answered from your slides") : null,
    ...board.topics.map((t) => h("div.topic", {}, h("span.n", {}, String(t.count)), h("div", {}, h("div", { style: { fontWeight: 600 } }, t.title), h("div.small.muted", {}, `“${t.sample}” · ${t.topic}`)))),
    ...done.map(qItem),
  ].filter(Boolean) : [h("p.empty", {}, "Questions from the audience show up here. The ones your slides don't answer come first.")]));
}

// ---------- actions ----------
// Slide changes this console sent, oldest first. Sends go one at a time and only the latest, so their ws echoes
// come back in order and are skipped: fast stepping never bounces back to an old slide.
const sentSlides = [];
let syncing = false;
async function syncSlide() {
  if (syncing) return;
  syncing = true;
  for (let n; n !== meta.slide; ) {
    n = meta.slide;
    sentSlides.push(n);
    await api(`/api/rooms/${id}/slide`, { method: "POST", key, body: { n } }).catch(() => (sentSlides.splice(sentSlides.lastIndexOf(n), 1), toast("Slide not synced")));
  }
  syncing = false;
}
async function goSlide(n, fromPrompter = false) {
  if (demo || n < 1 || n > deck.count) return;
  meta.slide = n;
  if (!fromPrompter) followSlide(n);
  drawSlides();
  syncSlide();
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
  const scripted = hack && promptLines.length > 0; // HACKATHON: ↓ plays the lines, the mic is only the level bar
  if (scripted) cueFrom = line - 1;
  try {
    const onLevel = speakingSignal(live.send, (l) => (level.style.width = `${Math.round(l * 100)}%`));
    const end = scripted ? await levelMic(onLevel) : await phraseMic({
      lang: spokenLang.value,
      maxTotalMs: demo ? 30000 : Infinity,
      onLevel,
      onPhrase: send,
      onError: (err) => { stopMic?.(); toast(micErrorMessage(err)); },
    });
    stopMic = () => {
      end();
      live.send({ type: "speaking", on: false });
      stopMic = null;
      spokenLang.disabled = false;
      micBtn.classList.remove("on");
      micState.textContent = "Off";
      level.style.width = "0";
    };
    micBtn.classList.add("on");
    micState.textContent = "Listening…";
    if (demo) setTimeout(() => stopMic?.(), 30500);
  } catch (err) {
    toast(micErrorMessage(err));
  } finally {
    micBtn.disabled = false;
    spokenLang.disabled = !!stopMic;
  }
}

async function send(blob, cutAt) {
  inflight++;
  micState.textContent = "Translating…";
  try {
    const [ct, body] = phraseInit(blob);
    const timing = new URLSearchParams(location.search).get("timing") === "1";
    if (timing) ct["x-eco-timing"] = "1";
    const r = await fetch(`/api/rooms/${id}/utterance`, { method: "POST", headers: { ...ct, ...(key ? { "x-key": key } : {}) }, body });
    const data = await r.json().catch(() => ({}));
    if (timing) console.info("eco translation timing", { seq: data.line?.seq, status: r.status, finalToResponseMs: performance.now() - cutAt, serverTiming: r.headers.get("server-timing") });
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
  if (promptLines.length && ["ArrowDown", "ArrowUp"].includes(e.key)) return (e.preventDefault(), stepLine(e.key === "ArrowDown" ? 1 : -1));
  if (["ArrowRight", "PageDown", "ArrowDown"].includes(e.key)) goSlide(meta.slide + 1);
  if (["ArrowLeft", "PageUp", "ArrowUp"].includes(e.key)) goSlide(meta.slide - 1);
  if (e.code === "Space" && !e.repeat) (e.preventDefault(), toggleMic());
});

async function refreshCalls() {
  const s = await api("/api/stats").catch(() => null);
  if (!s) return;
  calls.replaceChildren(h("span.dot"), s.live ? (s.max ? `${s.today}/${s.max} calls` : `${s.today} calls`) : "0 calls (mock)");
  calls.className = `pill ${s.tripped ? "mock" : ""}`;
  // Stopped after 3 failed calls: say why and when Eco tries again, instead of a bare "tripped".
  if (s.tripped) calls.replaceChildren(h("span.dot"), `Paused · retry ${s.retryAt ? new Date(Math.max(s.retryAt, Date.now())).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "soon"}`);
  calls.title = s.lastError ? `Last failed call: ${s.lastError.why} (${s.lastError.kind}, ${s.lastError.model})` : "Token Factory calls today";
}
refreshCalls();
setInterval(refreshCalls, 15000);
latency.replaceChildren(h("span.dot"), "— s");

function presetToggle() {
  const box = h("input", { type: "checkbox", checked: !!meta.presetsEnabled });
  const status = h("p.small.muted", {}, meta.presetsEnabled ? "Listeners hear the preset voice and see it labelled as AI." : "Preset voice is off for this talk.");
  box.onchange = async () => {
    box.disabled = true;
    try {
      const r = await api(`/api/rooms/${id}/presets`, { method: "POST", key, body: { enabled: box.checked } });
      meta.presetsEnabled = r.presetsEnabled;
      meta.presets = r.presets ?? [];
      status.textContent = meta.presetsEnabled ? "Listeners hear the preset voice and see it labelled as AI." : "Preset voice is off for this talk.";
    } catch {
      box.checked = !!meta.presetsEnabled;
      toast("Couldn't update preset voice");
    } finally {
      box.disabled = false;
    }
  };
  return h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Preset voice (demo)")),
    h("p.small", {}, "Morgan Freeman, Jack Sparrow and SpongeBob (all AI) are bundled demo voices (ADR 0006). Never offered in Counter."),
    h("label.check", {}, box, h("span.small", {}, "Enable AI preset voices for listeners")),
    status,
  );
}

/** Setup that doesn't belong on the live console: swap the deck, record or check the voice. */
function setupSheet() {
  const wrap = h("div.sheet-wrap", { onclick: (e) => e.target === wrap && wrap.remove() }, h("div.sheet.stack", { style: { gap: "14px", maxWidth: "560px", width: "100%" } },
    h("div.row", {}, h("h2", {}, "Slides & voice"), h("span.spacer"), h("button.btn.icon-btn", { type: "button", "aria-label": "Close", onclick: () => wrap.remove() }, icon("x"))),
    replaceSlides(),
    meta.voiceMode === "sample" ? voiceCard(id, meta, key ? { "x-key": key } : {}) : null,
    meta.voiceMode === "saved" ? h("p.small", {}, "This talk uses your saved voice. ", h("a", { href: "/me" }, "Hear or re-record it"), ".") : null,
    presetToggle()));
  document.body.append(wrap);
}

/** Swap the deck before (or between) talks: new PDF to R2, new slide text for answers; notes are kept. */
function replaceSlides() {
  const file = h("input", { type: "file", accept: "application/pdf", hidden: true });
  const btn = h("button.btn.sm", { type: "button", onclick: () => file.click() }, icon("doc"), deck.pdf ? "Replace slides" : "Upload slides (PDF)");
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    btn.disabled = true;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const pdf = await openPdf(bytes);
      const pages = await pdfPages(pdf);
      const deckPages = await pdfDeckRows(pdf);
      let deckLang = meta.deckLang || "en";
      const ok = await openDeckRowCarousel(pdf, deckPages, {
        deckLang,
        onLang: (l) => { deckLang = l; },
        onChange: () => {},
        confirmLabel: "Store slides",
        withLang: true,
      });
      if (!ok) {
        btn.disabled = false;
        return;
      }
      btn.lastChild.textContent = "Uploading…";
      await api(`/api/rooms/${id}/deckrows`, { method: "POST", key, body: { deckLang, pages: deckPages } });
      const { pages: old } = await api(`/api/rooms/${id}/sources`, { key });
      await api(`/api/rooms/${id}/sources`, { method: "POST", key, body: { pages: [...pages, ...old.filter((p) => p.tag === "notes")] } });
      await saveDeck(id, bytes);
      if (!(await uploadDeck(id, bytes, key))) throw new Error("upload");
    } catch {
      toast("Couldn't replace the slides");
      btn.disabled = false;
      btn.lastChild.textContent = deck.pdf ? "Replace slides" : "Upload slides (PDF)";
    }
  };
  return h("div", { style: { marginTop: "10px" } }, btn, file);
}

/** Ask: the speaker polls the room. They write and read in their own language; listeners in theirs. */
function askCard() {
  return h("div.card.grow", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Ask the room"), h("span.spacer"),
      h("button.btn.sm", { type: "button", disabled: meta.demo, onclick: () => pollSheet(spokenLang.value) }, icon("plus"), "New question")),
    pollsEl,
  );
}

function drawPolls() {
  if (!host) return;
  const lang = spokenLang.value;
  pollsEl.replaceChildren(...(polls.length
    ? polls.slice().reverse().map((p) => {
        const L = p.q[lang] && (p.kind !== "free" || p.share) ? lang : p.lang; // picked after it went out: private free answers exist only in the language it was written in
        const missing = p.kind === "free" && !p.open && p.tally.texts?.some((x) => !x.out[p.lang]);
        return h("div", { style: { padding: "14px 0", borderTop: "1px solid var(--line)" } },
          h("div.row", { style: { gap: "6px", flexWrap: "wrap" } },
            h(`span.pill${p.open ? ".live" : ""}`, {}, h("span.dot"), p.open ? "Open" : "Closed"),
            h("span.chip", {}, KIND_NAMES[p.kind]),
            h("span.chip", {}, p.share ? "Results shared" : "Private"),
            h("span.spacer"),
            p.open ? h("button.btn.sm", { type: "button", onclick: (e) => closePoll(p, e.currentTarget) }, "Close")
              : missing ? h("button.btn.sm", { type: "button", onclick: (e) => closePoll(p, e.currentTarget) }, "Translate answers") : null),
          h("div", { style: { fontWeight: 600, marginTop: "8px" } }, pollQ(p, L)),
          p.kind === "free" && p.open ? h("p.tiny.muted", { style: { marginTop: "8px" } }, `${p.tally.n} ${t(L, "votes")} · translated when you close`) : pollResults(p, L));
      })
    : [h("p.empty", {}, "Ask the room a question. Listeners answer on their phones, each in their own language.")]));
}

const KIND_NAMES = { free: "Free response", choice: "Multiple choice", tf: "True / False", rating: "Rating", rank: "Ranking" };

async function closePoll(p, btn) {
  btn.disabled = true;
  try {
    await api(`/api/rooms/${id}/pollclose`, { method: "POST", key, body: { pid: p.id } });
  } catch (err) {
    toast(err.data?.fallback ? `Closed, but the answers weren't translated (${err.data.fallback}). Try again.` : "Couldn't close the poll", 4000);
    btn.disabled = false;
  }
}

/** Write a poll in your language. Nothing reaches the room before Send. */
function pollSheet(lang) {
  let kind = "choice";
  const qIn = h("textarea", { rows: 2, maxlength: 200, placeholder: "Your question" });
  const optsEl = h("div.stack", { style: { gap: "8px" } });
  const optRow = (v = "") => {
    const inp = h("input", { type: "text", maxlength: 80, placeholder: `Option ${optsEl.children.length + 1}` });
    inp.value = v;
    const row = h("div.row", { style: { gap: "6px" } }, inp, h("button.btn.icon-btn", { type: "button", "aria-label": "Remove option", onclick: () => optsEl.children.length > 2 && row.remove() }, icon("x")));
    optsEl.append(row);
    return inp;
  };
  optRow(); optRow();
  const addOpt = h("button.btn.sm", { type: "button", onclick: () => optsEl.children.length < 10 && optRow().focus() }, icon("plus"), "Add option");
  const minIn = h("input", { type: "number", value: 1, step: 1 });
  const maxIn = h("input", { type: "number", value: 5, step: 1 });
  const tfNote = h("p.small.muted", {}, `Listeners pick “${t(lang, "true")}” or “${t(lang, "false")}”.`);
  const share = h("input", { type: "checkbox" });
  const choiceBox = h("div.stack", { style: { gap: "8px" } }, optsEl, h("div", {}, addOpt));
  const ratingBox = h("div.row", { style: { gap: "12px" } }, h("label.field", {}, "From", minIn), h("label.field", {}, "To", maxIn));
  const types = h("div.lang-grid");
  const drawTypes = () => {
    types.replaceChildren(...Object.entries(KIND_NAMES).map(([k, name]) =>
      h("button.toggle", { type: "button", "aria-pressed": String(k === kind), onclick: () => ((kind = k), drawTypes()) }, name)));
    choiceBox.hidden = !["choice", "rank"].includes(kind);
    ratingBox.hidden = kind !== "rating";
    tfNote.hidden = kind !== "tf";
  };
  drawTypes();
  const send = h("button.btn.primary", { type: "button" }, "Send to the room");
  const wrap = h("div.sheet-wrap", {}, h("div.sheet.stack", { style: { gap: "14px", maxWidth: "560px", width: "100%" } },
    h("h2", {}, "Ask the room"),
    h("p.small.muted", {}, `Write in ${langName(lang, "en")}. Eco sends it in every listener's language, and you read the answers in yours.`),
    types,
    h("label.field", {}, "Question", qIn),
    choiceBox, ratingBox, tfNote,
    h("label.row", { style: { gap: "8px", alignItems: "center" } }, share, h("span.small", {}, "Show results to the audience")),
    h("div.row", {}, h("span.spacer"), h("button.btn", { type: "button", onclick: () => wrap.remove() }, "Cancel"), send)));
  send.onclick = async () => {
    const options = kind === "tf" ? [t(lang, "true"), t(lang, "false")] : [...optsEl.querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
    if (!qIn.value.trim()) return toast("Write the question");
    if (["choice", "rank"].includes(kind) && options.length < 2) return toast("Add at least two options");
    send.disabled = true;
    try {
      await api(`/api/rooms/${id}/poll`, { method: "POST", key, body: { kind, lang, q: qIn.value, options, min: Number(minIn.value), max: Number(maxIn.value), share: share.checked } });
      toast("Sent to the room ✓");
      wrap.remove();
    } catch (err) {
      toast(err.data?.fallback ? `Not sent (${err.data.fallback})` : err.message || "Couldn't send");
      send.disabled = false;
    }
  };
  document.body.append(wrap);
  qIn.focus();
}

// ---------- live ----------
const live = connect(id, { role: "host", ...(key ? { key } : {}) }, (m) => {
  if (m.type === "deck" || m.type === "slides") return location.reload(); // new slides: simplest to start fresh
  if (m.type === "hello") {
    Object.assign(meta, m.meta);
    lines = m.lines ?? [];
    board = m.board ?? board;
    polls = m.polls ?? polls;
  }
  if (m.type === "polls") polls = m.polls;
  if (m.type === "line") (atBottom = nearBottom(now)), lines.push(m.line), (lines = lines.slice(-50));
  if (m.type === "slide") {
    const mine = sentSlides.indexOf(m.n);
    if (mine >= 0) sentSlides.splice(0, mine + 1); // our own change coming back: we're already past it
    else (meta.slide = m.n, followSlide(m.n));
  }
  if (m.type === "status") Object.assign(meta, { status: m.status, startedAt: m.startedAt, endedAt: m.endedAt });
  if (m.type === "board") board = m.board;
  if (m.type === "notice") toast(m.text, 4000);
  if (m.type === "prep") drawPrep(m);
  if (m.type === "reset") (Object.assign(meta, m.meta), (lines = []));
  if (m.type === "speakers") meta.speakers = m.speakers;
  if (m.type === "speaking") m.on ? speaking.add(m.speaker) : speaking.delete(m.speaker);
  if (["hello", "speakers", "speaking", "reset"].includes(m.type)) drawSpeakers();
  if (["hello", "slide", "reset"].includes(m.type)) drawSlides();
  if (["hello", "status", "reset"].includes(m.type)) drawStatus();
  if (["hello", "line", "reset"].includes(m.type)) drawLines();
  if (["hello", "board", "slide"].includes(m.type)) drawBoard();
  if (["hello", "polls"].includes(m.type)) drawPolls();
}, (s) => s === "offline" && toast("Connection lost, reconnecting…"));

drawStatus();
drawLines();
drawSlides();
if (!board && meta.demo) api(`/api/rooms/${id}/board`).then((b) => ((board = b), drawBoard())).catch(() => {});
