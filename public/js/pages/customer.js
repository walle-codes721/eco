import { h, icon, api, roomId, toast, langName, phoneLang, store, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { bindHold } from "/js/mic.js";
import { voice } from "/js/speak.js";
import { t, UI_LANGS } from "/js/i18n.js";

const id = roomId();
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`);
} catch {
  notFound();
  throw new Error("no room");
}

let cid = store(`eco:cid:${id}`) ?? (store(`eco:cid:${id}`, `c${crypto.randomUUID().slice(0, 10)}`), store(`eco:cid:${id}`));
let live = null;
let lang = store(`eco:clang:${id}`) ?? phoneLang();
let turns = [];
let open = false;
let sendError = null; // keep recoverable failure feedback visible until the next send
const T = (k) => t(lang, k);

const langSel = h("select.lang-select", { "aria-label": "Language" },
  ...[...new Set([lang, ...UI_LANGS, "pt", "zh", "ja", "ko", "ar", "ru"])].map((l) => h("option", { value: l, selected: l === lang }, langName(l, l))));
const thread = h("div.thread", { "aria-live": "polite" });
const status = h("p.tiny.muted", { role: "status", style: { textAlign: "right", minHeight: "16px" } });
const input = h("input", { type: "text", maxlength: 500, enterkeyhint: "send" });
const form = h("form.ask-box", {}, input, h("button.send", { type: "submit", "aria-label": "Send" }, icon("up")));
const hold = h("button.hold", { type: "button" }, icon("mic"));
const holdLabel = h("p.hold-label");
const intro = h("div.empty");
// Pharmacy, clinic, hospital: a permanent note, in the customer's language, with the shop's own emergency number.
const isHealth = ["pharmacy", "clinic", "hospital"].includes(meta.bizType);
const healthEl = h("div.banner", { role: "note", style: { marginBottom: "14px" } });

document.body.replaceChildren(
  h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.truncate", {}, meta.title), h("span.spacer"), langSel)),
  h("main.phone", { style: { minHeight: "calc(100dvh - 53px)", display: "flex", flexDirection: "column" } },
    h("div", { style: { flex: 1, padding: "20px 0" } }, isHealth ? healthEl : null, intro, thread, status),
    h("div.composer", {}, hold, holdLabel, form),
  ),
);

function labels() {
  document.documentElement.lang = lang;
  input.placeholder = T("orType");
  holdLabel.textContent = T("holdToTalk");
  hold.setAttribute("aria-label", T("holdToTalk"));
  intro.replaceChildren(h("h1", { style: { fontSize: "26px", color: "var(--ink)", marginBottom: "8px" } }, T("hello")), h("p.small", {}, T("customerIntro")));
  intro.hidden = turns.length > 0;
  if (isHealth) healthEl.replaceChildren(icon("flag"), h("div", {}, T("healthNotice").replace("{n}", meta.emergency || "112")));
}

function draw() {
  intro.hidden = turns.length > 0;
  thread.replaceChildren(...turns.map((x) => {
    if (x.side === "customer") return h(`div.bubble.me${x.pending ? ".pending" : ""}`, {}, x.src || T("typing"));
    if (x.side === "eco") return h("div.bubble.eco", {}, h("div.who", {}, `Eco · ${T("fromList")}${x.cite ? ` · ${x.cite}` : ""}`), x.src);
    return h("div.bubble.them", {}, h("div.who", {}, T("staff")), x.out, x.out !== x.src ? h("div.orig", {}, x.src) : null);
  }));
  status.textContent = sendError ? T(sendError) : open && turns.at(-1)?.side === "customer" && !turns.at(-1).pending ? `${T("sentToStaff")} ✓` : "";
  scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function merge(m, pending) {
  if (m.cid && m.cid !== cid) return; // an old HTTP reply must not restore a deleted chat
  // Only the HTTP response knows which local request completed. WebSocket
  // delivery must not discard placeholders belonging to other in-flight sends.
  turns = turns.filter((x) => x !== pending);
  const fresh = m.turns.filter((x) => !turns.some((y) => y.id === x.id));
  const at = turns.findIndex((x) => x.pending);
  turns.splice(at < 0 ? turns.length : at, 0, ...fresh);
  open = m.open;
  draw();
  for (const x of fresh) {
    if (x.side === "owner") voice.say(x.out, m.lang);
    if (x.side === "eco") voice.say(x.src, m.lang);
  }
}

async function send(payload) {
  const sendingCid = cid;
  sendError = null;
  const pending = { side: "customer", src: payload instanceof Blob ? "" : payload, pending: true };
  turns.push(pending);
  draw();
  try {
    const m = payload instanceof Blob
      ? await api(`/api/rooms/${id}/turn`, { method: "POST", body: payload, headers: { "content-type": "audio/wav", "x-side": "customer", "x-cid": cid, "x-lang": lang } })
      : await api(`/api/rooms/${id}/turn`, { method: "POST", body: { side: "customer", cid, lang, text: payload } });
    if (sendingCid !== cid) return;
    merge(m, pending);
  } catch (err) {
    if (sendingCid !== cid) return;
    if (err.status === 410 && err.data?.deleted) { resetConversation(sendingCid); return; }
    turns = turns.filter((x) => x !== pending);
    if (typeof payload === "string" && !input.value) input.value = payload;
    sendError = err.status === 429 ? "limit" : "busy";
    draw();
    toast(T(sendError));
  }
}

form.onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send(text);
};
bindHold(hold, { onBlob: send, onError: () => toast(T("micDenied"), 4000), lang: () => lang });
langSel.onchange = () => {
  lang = langSel.value;
  store(`eco:clang:${id}`, lang);
  labels();
  draw();
};

function welcome() {
  return new Promise((resolve) => {
    const start = h("button.btn.primary.big.block", { type: "button" }, T("start"));
    const wrap = h("div.sheet-wrap", {}, h("div.sheet.stack.center", { style: { gap: "16px" } },
      h("span.brand", { style: { justifyContent: "center" } }, "Eco"),
      h("h1", { style: { fontSize: "30px" } }, meta.title),
      h("p.muted", {}, T("hello")),
      start,
      h("p.tiny.muted", {}, T("customerIntro"))));
    start.onclick = () => {
      voice.unlock();
      sessionStorage.setItem(`eco:cjoined:${id}`, "1");
      wrap.remove();
      resolve();
    };
    document.body.append(wrap);
  });
}

labels();
draw();
if (!sessionStorage.getItem(`eco:cjoined:${id}`)) await welcome();
function resetConversation(deletedCid) {
  if (deletedCid !== cid) return;
  live?.close();
  cid = `c${crypto.randomUUID().slice(0, 10)}`;
  store(`eco:cid:${id}`, cid);
  turns = [];
  open = false;
  sendError = null;
  input.value = "";
  globalThis.speechSynthesis?.cancel();
  draw();
  connectCustomer();
}

function connectCustomer() {
  const connectedCid = cid;
  live = connect(id, { role: "customer", cid, lang }, (m) => {
    if (connectedCid !== cid) return;
    if ((m.type === "conversationDeleted" && m.cid === cid) || (m.type === "hello" && m.deleted)) {
      resetConversation(connectedCid);
      return;
    }
    if (m.type === "hello" && m.convo) {
      turns = m.convo.turns;
      open = m.convo.open;
      draw();
    }
    if (m.type === "turns") merge(m);
  });
}
connectCustomer();
