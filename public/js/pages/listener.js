import { h, icon, api, roomId, toast, fmtTime, langName, phoneLang, keepAwake, store, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { voice } from "/js/speak.js";
import { t } from "/js/i18n.js";

const id = roomId();
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`);
} catch {
  notFound();
  throw new Error("no room");
}

const choices = [...meta.langs, "en"];
let lang = store(`eco:lang:${id}`) ?? (choices.includes(phoneLang()) ? phoneLang() : meta.langs[0]);
let lines = [];
const myQs = store(`eco:qs:${id}`) ?? [];
let live = null;
const T = (k) => t(lang, k);
const textOf = (l) => (lang === "en" ? l.src : l.out?.[lang] ?? l.src);

// ---------- shell ----------
const langSel = h("select.lang-select", { "aria-label": "Language" }, ...choices.map((l) => h("option", { value: l, selected: l === lang }, langName(l, l))));
const soundBtn = h("button.btn.icon-btn", { type: "button" });
const titleEl = h("span.title.truncate", {}, meta.title);
const bar = h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), titleEl, h("span.spacer"), langSel, soundBtn));
const statusRow = h("div.status-row");
const caps = h("div.captions", { "aria-live": "polite" });
const qInput = h("input", { type: "text", maxlength: 300, enterkeyhint: "send" });
const qSend = h("button.send", { type: "submit", "aria-label": "Send" }, icon("up"));
const qForm = h("form.ask-box", {}, qInput, qSend);
const qList = h("div");
const askHead = h("h2", { style: { fontSize: "20px" } });
const askSub = h("p.small.muted");
const main = h("main.phone", {},
  statusRow, caps,
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

function drawStatus(conn) {
  const parts = [];
  if (conn === "offline") parts.push(h("span.pill.mock", {}, h("span.dot"), T("reconnecting")));
  else if (meta.status === "live") parts.push(h("span.pill.live", {}, h("span.dot"), "Live"));
  if (meta.status === "live") parts.push(h("span.chip", {}, `${T("slide")} ${meta.slide}`));
  if (meta.demo) parts.push(h("span.pill.replay", {}, h("span.dot"), "Replay"));
  statusRow.replaceChildren(...parts);
}

function drawCaps() {
  if (!lines.length) {
    caps.replaceChildren(h("div.empty", {}, h("p", { style: { fontSize: "20px", fontWeight: 600, color: "var(--ink)" } }, T("waiting")), h("p.small", { style: { marginTop: "6px" } }, T("waitingSub"))));
    return;
  }
  caps.replaceChildren(...lines.slice(-5).map((l) => h("p", {}, textOf(l))));
}

function addLine(l) {
  lines.push(l);
  lines = lines.slice(-50);
  drawCaps();
  caps.lastElementChild?.classList.add("new");
  voice.say(textOf(l), lang === "en" ? "en" : lang, l.audio?.[lang]);
}

function drawQs() {
  qList.replaceChildren(...myQs.slice().reverse().map((q) =>
    h("div.qa", {},
      h("div.q", {}, q.text),
      q.pending ? h("div.a.muted", {}, "…") :
        q.covered ? h("div.a", {}, q.answer) : h("div.a.muted", {}, T("notCovered")),
      h("div.meta", {},
        q.covered && q.cite ? h("span.chip", {}, q.cite) : null,
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
  drawStatus();
};
soundBtn.onclick = () => {
  voice.on ? voice.off() : voice.unlock();
  labels();
  toast(voice.on ? T("soundOn") : T("soundOff"));
};

// ---------- recap ----------
async function recap() {
  const { lines: all } = await api(`/api/rooms/${id}/transcript`).catch(() => ({ lines }));
  const shareBtn = h("button.btn", { type: "button" }, icon("share"), T("share"));
  shareBtn.onclick = () => {
    const text = `${meta.title}\n\n` + all.map((l) => textOf(l)).join("\n");
    navigator.share ? navigator.share({ title: meta.title, text }).catch(() => {}) : navigator.clipboard.writeText(text).then(() => toast("Copied"));
  };
  main.replaceChildren(
    h("section", { style: { padding: "40px 0 24px" } },
      h("p.eyebrow", {}, T("ended")),
      h("h1", { style: { fontSize: "34px", margin: "8px 0 4px" } }, T("recap")),
      h("p.muted", {}, `${meta.title}${meta.speaker ? ` · ${meta.speaker}` : ""}`),
      h("div.row", { style: { marginTop: "18px" } }, shareBtn),
    ),
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
      drawCaps();
      if (meta.status === "ended") return recap();
    }
    if (m.type === "line") addLine(m.line);
    if (m.type === "slide") meta.slide = m.n;
    if (m.type === "reset") (lines = []), drawCaps();
    if (m.type === "status") {
      meta.status = m.status;
      if (m.status === "ended") return recap();
    }
    if (m.type === "answered") {
      let hit = false;
      for (const q of myQs) if (m.qids.includes(q.id)) (q.answeredAt = m.at), (hit = true);
      if (hit) {
        store(`eco:qs:${id}`, myQs);
        drawQs();
        toast(`${T("answeredAt")} ${fmtTime(m.at)}`, 3500);
      }
    }
    drawStatus();
  }, drawStatus);
}
