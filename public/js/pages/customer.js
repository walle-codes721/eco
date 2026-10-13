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
if (meta.mode !== "counter") location.replace(`/r/${id}`);

const cid = store(`eco:cid:${id}`) ?? (store(`eco:cid:${id}`, `c${crypto.randomUUID().slice(0, 10)}`), store(`eco:cid:${id}`));
let lang = store(`eco:clang:${id}`) ?? phoneLang();
let turns = [];
let open = false;
const T = (k) => t(lang, k);

const langSel = h("select.lang-select", { "aria-label": "Language" },
  ...[...new Set([lang, ...UI_LANGS, "pt", "zh", "ja", "ko", "ar", "ru"])].map((l) => h("option", { value: l, selected: l === lang }, langName(l, l))));
const thread = h("div.thread", { "aria-live": "polite" });
const status = h("p.tiny.muted", { style: { textAlign: "right", minHeight: "16px" } });
const input = h("input", { type: "text", maxlength: 500, enterkeyhint: "send" });
const form = h("form.ask-box", {}, input, h("button.send", { type: "submit", "aria-label": "Send" }, icon("up")));
const hold = h("button.hold", { type: "button" }, icon("mic"));
const holdLabel = h("p.hold-label");
const intro = h("div.empty");

document.body.replaceChildren(
  h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.truncate", {}, meta.title), h("span.spacer"), langSel)),
  h("main.phone", { style: { minHeight: "calc(100dvh - 53px)", display: "flex", flexDirection: "column" } },
    h("div", { style: { flex: 1, padding: "20px 0" } }, intro, thread, status),
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
}

function draw() {
  intro.hidden = turns.length > 0;
  thread.replaceChildren(...turns.map((x) => {
    if (x.side === "customer") return h(`div.bubble.me${x.pending ? ".pending" : ""}`, {}, x.src || T("typing"));
    if (x.side === "eco") return h("div.bubble.eco", {}, h("div.who", {}, `Eco · ${T("fromList")}${x.cite ? ` · ${x.cite}` : ""}`), x.src);
    return h("div.bubble.them", {}, h("div.who", {}, T("staff")), x.out, x.out !== x.src ? h("div.orig", {}, x.src) : null);
  }));
  status.textContent = open && turns.at(-1)?.side === "customer" && !turns.at(-1).pending ? `${T("sentToStaff")} ✓` : "";
  scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

function merge(m) {
  turns = turns.filter((x) => !x.pending);
  const fresh = m.turns.filter((x) => !turns.some((y) => y.id === x.id));
  turns.push(...fresh);
  open = m.open;
  draw();
  for (const x of fresh) {
    if (x.side === "owner") voice.say(x.out, m.lang);
    if (x.side === "eco") voice.say(x.src, m.lang);
  }
}

async function send(payload) {
  const pending = { side: "customer", src: payload instanceof Blob ? "" : payload, pending: true };
  turns.push(pending);
  draw();
  try {
    const m = payload instanceof Blob
      ? await api(`/api/rooms/${id}/turn`, { method: "POST", body: payload, headers: { "content-type": "audio/wav", "x-side": "customer", "x-cid": cid, "x-lang": lang } })
      : await api(`/api/rooms/${id}/turn`, { method: "POST", body: { side: "customer", cid, lang, text: payload } });
    merge(m);
  } catch (err) {
    turns.splice(turns.indexOf(pending), 1);
    draw();
    toast(err.status === 429 ? T("limit") : T("busy"));
  }
}

form.onsubmit = (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  send(text);
};
bindHold(hold, { onBlob: send, onError: () => toast(T("micDenied"), 4000) });
langSel.onchange = () => {
  lang = langSel.value;
  store(`eco:clang:${id}`, lang);
  labels();
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
connect(id, { role: "customer", cid, lang }, (m) => {
  if (m.type === "hello" && m.convo) {
    turns = m.convo.turns;
    open = m.convo.open;
    draw();
  }
  if (m.type === "turns") merge(m);
});
