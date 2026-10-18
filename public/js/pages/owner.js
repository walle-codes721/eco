import { h, icon, api, websiteImport, roomId, hostKey, qrSvg, fullUrl, shortUrl, toast, langName, modePill, notFound } from "/js/eco.js";
import { connect } from "/js/live.js";
import { bindHold } from "/js/mic.js";
import { voice } from "/js/speak.js";

const id = roomId();
const key = hostKey(id);
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`, { key });
} catch {
  notFound();
  throw new Error("no room");
}
if (!meta.host && !meta.demo) {
  document.body.replaceChildren(h("main.narrow.center", { style: { paddingTop: "20vh" } },
    h("a.brand", { href: "/" }, "Eco"),
    h("h1", { style: { fontSize: "28px", margin: "24px 0 8px" } }, "This is the owner's counter"),
    h("p.muted", {}, "Open it from the counter link you got at setup."),
    h("p", { style: { marginTop: "24px" } }, h("a.btn.primary", { href: `/${id}` }, "Open the customer view"))));
  throw new Error("not host");
}

const OL = meta.ownerLang;
const it = OL === "it";
const L = {
  needs: it ? "Da rispondere" : "Needs you",
  convos: it ? "Conversazioni" : "Conversations",
  empty: it ? "Quando un cliente scansiona l'adesivo, la conversazione appare qui." : "When a customer scans your sticker, the conversation appears here.",
  reply: it ? "Rispondi in italiano…" : `Reply in ${langName(OL, "en")}…`,
  hold: it ? "Tieni premuto e parla" : "Hold and speak",
  eco: it ? "Eco · dalle tue info" : "Eco · from your info",
  f2f: it ? "Faccia a faccia" : "Face to face",
  sticker: it ? "Adesivo" : "Sticker",
  card: it ? "Scheda settimanale" : "Weekly card",
  pick: it ? "Scegli una conversazione" : "Pick a conversation",
  answered: it ? "Eco ha risposto dalle tue informazioni" : "Eco answered from your info",
  exit: it ? "Esci" : "Exit",
  edit: it ? "Modifica info" : "Edit info",
  editSub: it ? "Eco risponde ai clienti solo da queste informazioni. Le modifiche valgono subito." : "Eco answers customers only from this. Changes apply right away.",
  addSection: it ? "Aggiungi sezione" : "Add section",
  addFile: it ? "Carica file" : "Upload a file",
  addWeb: it ? "Link al sito web" : "Website link",
  cancel: it ? "Annulla" : "Cancel",
  deleteTitle: it ? "Eliminare la conversazione?" : "Delete conversation?",
  deleteText: it ? "La chat e i suoi messaggi verranno eliminati per te e per il cliente. Questa azione non può essere annullata. Il menu e le informazioni insegnate a Eco resteranno invariati." : "This chat and its messages will be deleted for you and the customer. This cannot be undone. Your menu and information taught to Eco will stay unchanged.",
  deleteChat: it ? "Elimina chat" : "Delete chat",
  deleting: it ? "Eliminazione…" : "Deleting…",
  deleteFailed: it ? "Impossibile confermare l'eliminazione. Riprova." : "Couldn't confirm deletion. Try again.",
  close: it ? "Chiudi" : "Close",
  save: it ? "Salva" : "Save",
  saved: it ? "Info salvate" : "Info saved",
  teach: it ? "Insegna a Eco" : "Teach Eco",
  teachTitle: it ? "Insegna questa risposta a Eco" : "Teach Eco this answer",
  teachSub: it ? "Eco userà questo testo per rispondere ai prossimi clienti. Controllalo e correggilo prima di salvare." : "Eco will use this text to answer the next customers. Check it and fix it before you save.",
  teachQ: it ? "Domanda" : "Question",
  teachAsked: it ? "Parole del cliente" : "Customer's words",
  teachA: it ? "Risposta" : "Answer",
  taught: it ? "Eco risponderà da solo la prossima volta ✓" : "Eco will answer this next time ✓",
  allergy: it ? "Allergie o dieta" : "Allergy or diet",
  urgent: it ? "Urgente" : "Urgent",
  medical: it ? "Domanda medica" : "Medical question",
};

let convos = [];
let active = null;
const deletedConvos = new Set();
let deleteDialog = null;
const ago = (t) => new Intl.RelativeTimeFormat(OL, { numeric: "auto" }).format(Math.round((t - Date.now()) / 60000), "minute");

const soundBtn = h("button.btn.icon-btn", { type: "button", "aria-label": "Sound", onclick: () => { voice.on ? voice.off() : voice.unlock(); drawSound(); } });
const drawSound = () => soundBtn.replaceChildren(icon(voice.on ? "sound" : "mute"));
drawSound();

const listEl = h("aside");
const threadEl = h("div.thread");
const threadWrap = h("div.thread-wrap", {}, threadEl);
const replyIn = h("input", { type: "text", placeholder: L.reply, maxlength: 500, enterkeyhint: "send" });
const holdBtn = h("button.hold.sm", { type: "button", "aria-label": L.hold }, icon("mic"));
const replyForm = h("form.ask-box", { style: { flex: 1 } }, replyIn, h("button.send", { type: "submit", "aria-label": "Send" }, icon("up")));
const replyBar = h("div.reply", {}, holdBtn, replyForm);

document.body.replaceChildren(
  h("header.bar", {}, h("div.inner", {},
    h("a.brand", { href: "/" }, "Eco"), h("span.title.truncate", {}, meta.title), modePill(meta),
    h("span.spacer"), soundBtn,
    h("button.btn.sm", { type: "button", onclick: () => faceToFace() }, icon("split"), L.f2f),
    meta.host && !meta.demo ? h("button.btn.sm", { type: "button", onclick: () => editInfo() }, icon("doc"), L.edit) : null,
    h("a.btn.sm", { href: `/${id}/sticker`, target: "_blank" }, icon("qr"), L.sticker),
    h("a.btn.sm", { href: `/${id}/card` }, L.card))),
  h("div.owner", {}, listEl, h("main", {}, threadWrap, replyBar)),
);

function bubble(t, c) {
  if (t.side === "customer")
    return h("div.bubble.them", {}, h("div.who", {}, langName(c.lang, OL)),
      // Pharmacy, clinic, hospital: Eco gave only a fixed line. A person must take over.
      t.health ? h("div", { style: { margin: "2px 0 6px" } }, h("span.chip.red", {}, `⚠ ${t.health === "emergency" ? L.urgent : L.medical}`)) : null,
      t.allergy ? h("div", { style: { margin: "2px 0 6px" } }, h("span.chip.red", {}, `⚠ ${L.allergy}`)) : null, // Eco answered from the owner's own text; a person should know
      t.out, t.out !== t.src ? h("div.orig", {}, t.src) : null);
  if (t.side === "eco")
    return h("div.bubble.eco", {}, h("div.who", {}, `${L.eco}${t.cite ? ` · ${t.cite}` : ""}`), t.out, h("div.orig", {}, t.src));
  const me = h("div.bubble.me", {}, t.src, t.out !== t.src ? h("div.orig", {}, t.out) : null);
  const asked = meta.host && !meta.demo ? askedFor(c, t) : null; // the demo shop can't be edited
  if (!asked && !t.taught) return me;
  return h("div", { style: { alignSelf: "flex-end", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", maxWidth: "100%" } }, me,
    t.taught ? h("span.tiny.muted", {}, L.taught) : h("button.btn.sm.ghost", { type: "button", onclick: () => teachEco(c, t, asked) }, icon("plus"), L.teach));
}

/** The customer's turn this owner reply answered, unless Eco had already answered it. */
function askedFor(c, t) {
  for (let j = c.turns.indexOf(t) - 1; j >= 0; j--) {
    if (c.turns[j].side === "eco") return null;
    if (c.turns[j].side === "customer") return c.turns[j];
  }
  return null;
}

/** Teach Eco: the owner checks the question and the answer, then Eco adds them to the list. Nothing is saved before Save. */
function teachEco(c, t, asked) {
  const qIn = h("textarea", { rows: 2, maxlength: 200 });
  const askedIn = h("input", { type: "text", maxlength: 200 });
  const aIn = h("textarea", { rows: 3, maxlength: 500 });
  qIn.value = asked.out; // the customer's question in the owner's language
  askedIn.value = asked.src !== asked.out ? asked.src : ""; // their own words, which help Eco find this entry in their language
  aIn.value = t.src; // what the owner said
  const save = h("button.btn.primary", { type: "button" }, L.save);
  const wrap = h("div.sheet-wrap", {}, h("div.sheet.stack", { style: { gap: "14px", maxWidth: "560px", width: "100%" } },
    h("h2", {}, L.teachTitle), h("p.small.muted", {}, L.teachSub),
    h("label.field", {}, L.teachQ, qIn),
    h("label.field", {}, L.teachAsked, askedIn),
    h("label.field", {}, L.teachA, aIn),
    h("div.row", {}, h("span.spacer"), h("button.btn", { type: "button", onclick: () => wrap.remove() }, L.cancel), save)));
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api(`/api/rooms/${id}/addanswer`, { method: "POST", key, body: { cid: c.id, tid: t.id, q: qIn.value, asked: askedIn.value, a: aIn.value } });
      t.taught = true;
      toast(L.taught);
      wrap.remove();
      drawThread();
    } catch (err) {
      if (err.data?.error === "Already added") (t.taught = true), wrap.remove(), drawThread();
      else (toast(err.message || "Couldn't save"), (save.disabled = false));
    }
  };
  document.body.append(wrap);
  aIn.focus();
}

function removeConversation(cid) {
  deletedConvos.add(cid);
  convos = convos.filter((c) => c.id !== cid);
  if (active === cid) {
    active = convos.slice().sort((a, b) => Number(b.open) - Number(a.open))[0]?.id ?? null;
    replyIn.value = "";
  }
  drawList();
  drawThread();
  f2fDraw?.();
  if (deleteDialog?.cid === cid) deleteDialog.confirm();
}

async function deleteConversationRequest(cid) {
  const controller = new AbortController();
  let timer;
  try {
    await Promise.race([
      api(`/api/rooms/${id}/convo`, { method: "DELETE", key, body: { cid }, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Deletion timed out"));
          controller.abort();
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deleteChat(c) {
  const previousFocus = document.activeElement;
  let busy = false, closed = false;
  const dialog = { cid: c.id, confirm: () => done(true) };
  const error = h("p.small", { role: "alert", style: { color: "var(--red)" } });
  const cancel = h("button.btn", { type: "button", onclick: () => done() }, L.cancel);
  const close = h("button.btn.ghost.icon-btn", { type: "button", "aria-label": L.close, onclick: () => done() }, icon("x"));
  const remove = h("button.btn.red", { type: "button" }, L.deleteChat);
  const wrap = h("div.sheet-wrap", { onclick: (e) => { if (e.target === wrap) done(); } },
    h("div.sheet.stack", { role: "dialog", "aria-modal": "true", "aria-labelledby": "delete-chat-title", "aria-describedby": "delete-chat-description", style: { gap: "14px", maxWidth: "480px", width: "100%" } },
      h("div.row", {}, h("h2", { id: "delete-chat-title" }, L.deleteTitle), h("span.spacer"), close),
      h("p.small.muted", { id: "delete-chat-description" }, L.deleteText), error,
      h("div.row", {}, h("span.spacer"), cancel, remove)));
  function done(force = false) {
    if (closed || (busy && !force)) return;
    closed = true;
    if (deleteDialog === dialog) deleteDialog = null;
    removeEventListener("keydown", onKey);
    wrap.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    else listEl.querySelector("button")?.focus();
  }
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); done(); }
    if (e.key === "Tab") {
      const buttons = [close, cancel, remove].filter((b) => !b.disabled);
      const i = buttons.indexOf(document.activeElement);
      e.preventDefault();
      buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
    }
  };
  remove.onclick = async () => {
    if (closed || busy) return;
    busy = true;
    remove.disabled = cancel.disabled = close.disabled = true;
    remove.textContent = L.deleting;
    error.textContent = "";
    try {
      await deleteConversationRequest(c.id);
      removeConversation(c.id);
      done(true);
    } catch {
      if (closed) return;
      busy = false;
      remove.disabled = cancel.disabled = close.disabled = false;
      remove.textContent = L.deleteChat;
      error.textContent = L.deleteFailed;
    }
  };
  deleteDialog = dialog;
  addEventListener("keydown", onKey);
  document.body.append(wrap);
  cancel.focus();
}

function drawList() {
  // Waiting conversations first, and among them an emergency before a medical or allergy question before the rest.
  const urgency = (c) => (!c.open ? 0 : c.turns.some((t) => t.health === "emergency") ? 2 : c.turns.some((t) => t.health || t.allergy) ? 1 : 0);
  const sorted = convos.slice().sort((a, b) => Number(b.open) - Number(a.open) || urgency(b) - urgency(a) || (b.turns.at(-1)?.t ?? 0) - (a.turns.at(-1)?.t ?? 0));
  const item = (c) => {
    const last = c.turns.at(-1);
    return h("div", { style: { position: "relative" } },
      h("button.convo-item", { type: "button", style: { paddingRight: meta.host && !meta.demo ? "52px" : null }, "aria-current": String(c.id === active), onclick: () => { active = c.id; drawList(); drawThread(); } },
      h("div.top", {}, c.open ? h("span.needs") : null, h("b", {}, langName(c.lang, OL)),
        c.open && c.turns.some((t) => t.health === "emergency") ? h("span.chip.red", {}, `⚠ ${L.urgent}`)
          : c.turns.some((t) => t.allergy || t.health) ? h("span.chip.red", { title: L.allergy }, "⚠") : null,
        h("span.spacer"), last ? ago(last.t) : ""),
      h("div.last", {}, last ? (last.side === "owner" ? last.src : last.out) : "")),
      meta.host && !meta.demo ? h("button.btn.ghost.icon-btn", { type: "button", "aria-label": L.deleteChat, title: L.deleteChat,
        style: { position: "absolute", top: "8px", right: "10px", width: "30px", height: "30px" },
        onclick: (e) => { e.stopPropagation(); deleteChat(c); } }, icon("trash")) : null);
  };
  const open = sorted.filter((c) => c.open);
  listEl.replaceChildren(...[
    ...(open.length ? [h("p.eyebrow", { style: { padding: "4px 14px" } }, L.needs), ...open.map(item)] : []),
    h("p.eyebrow", { style: { padding: "12px 14px 4px" } }, L.convos),
    ...(sorted.filter((c) => !c.open).map(item)),
    convos.length ? null : h("div.empty", {}, h("p", {}, L.empty), h("div", { style: { width: "140px", margin: "18px auto 6px" } }, qrSvg(fullUrl(`/${id}`))), h("p.url.tiny", {}, shortUrl(`/${id}`))),
  ].filter(Boolean));
}

function drawThread() {
  const c = convos.find((x) => x.id === active);
  replyBar.hidden = !c;
  if (!c) return threadEl.replaceChildren(h("p.empty", {}, convos.length ? L.pick : ""));
  threadEl.replaceChildren(...c.turns.map((t) => bubble(t, c)));
  threadWrap.scrollTop = threadWrap.scrollHeight;
}

function addTurns(m) {
  if (deletedConvos.has(m.cid)) return;
  let c = convos.find((x) => x.id === m.cid);
  if (!c) convos.push((c = { id: m.cid, lang: m.lang, open: m.open, turns: [] }));
  const fresh = m.turns.filter((t) => !c.turns.some((x) => x.id === t.id));
  c.turns.push(...fresh);
  Object.assign(c, { lang: m.lang, open: m.open });
  const cust = fresh.find((t) => t.side === "customer");
  if (cust) {
    if (!active || !convos.find((x) => x.id === active)?.open) active = c.id;
    voice.say(cust.out, OL);
  }
  drawList();
  drawThread();
  f2fDraw?.();
}

async function sendOwner(cid, payload) {
  try {
    const m = payload instanceof Blob
      ? await api(`/api/rooms/${id}/turn`, { method: "POST", key, body: payload, headers: { "content-type": "audio/wav", "x-side": "owner", "x-cid": cid, "x-lang": OL } })
      : await api(`/api/rooms/${id}/turn`, { method: "POST", key, body: { side: "owner", cid, text: payload } });
    addTurns(m);
  } catch (err) {
    if (err.status === 410 && err.data?.deleted) { removeConversation(cid); return; }
    toast(err.status === 503 ? "Eco is busy, try again" : err.message);
  }
}

replyForm.onsubmit = (e) => {
  e.preventDefault();
  const text = replyIn.value.trim();
  if (!text || !active) return;
  replyIn.value = "";
  sendOwner(active, text);
};
function bindOwnerMic(btn) {
  bindHold(btn, {
    onStart: () => active,
    onBlob: (b, cid) => {
      if (cid && !deletedConvos.has(cid) && convos.some((c) => c.id === cid)) sendOwner(cid, b);
    },
    onError: () => toast("Microphone blocked"), lang: () => OL,
  });
}
bindOwnerMic(holdBtn);

// ---------- face to face: one iPad flat on the counter, top half faces the customer ----------
let f2fDraw = null;
function faceToFace() {
  voice.unlock();
  let cid = `f2f-${crypto.randomUUID().slice(0, 8)}`;
  const CUST_LANGS = ["en", "it", "es", "fr", "de", "pt", "zh", "ja", "ko", "ar", "hi", "ru"];
  let custLang = "en";
  const custSel = h("select.lang-select", {}, ...CUST_LANGS.map((l) => h("option", { value: l }, langName(l, l))));
  custSel.onchange = () => (custLang = custSel.value);
  const topSaid = h("div.said-big");
  const botSaid = h("div.said-big");
  const custHold = h("button.hold", { type: "button" }, icon("mic"));
  const ownHold = h("button.hold", { type: "button" }, icon("mic"));
  const busy = (b, on) => b.classList.toggle("busy", on);

  const sendCust = async (blob, targetCid = cid) => {
    if (targetCid !== cid || deletedConvos.has(targetCid)) return;
    busy(custHold, true);
    try {
      const m = await api(`/api/rooms/${id}/turn`, typeof blob === "string"
        ? { method: "POST", key, body: { side: "customer", cid: targetCid, lang: custLang, text: blob } }
        : { method: "POST", key, body: blob, headers: { "content-type": "audio/wav", "x-side": "customer", "x-cid": targetCid, "x-lang": custLang } });
      if (targetCid !== cid || deletedConvos.has(targetCid)) return;
      addTurns(m);
      const c = convos.find((x) => x.id === cid);
      const eco = c?.turns.at(-1);
      if (eco?.side === "eco") voice.say(eco.src, c.lang);
    } catch (err) {
      if (err.status === 410 && err.data?.deleted) removeConversation(targetCid);
      else if (targetCid === cid) toast("Eco is busy, try again");
    } finally { busy(custHold, false); }
  };
  const sendOwn = async (blob, targetCid = cid) => {
    if (targetCid !== cid || deletedConvos.has(targetCid)) return;
    if (!convos.find((x) => x.id === cid)) return toast(it ? "Prima parla il cliente" : "Let the customer speak first");
    busy(ownHold, true);
    await sendOwner(targetCid, blob);
    if (targetCid !== cid || deletedConvos.has(targetCid)) { busy(ownHold, false); return; }
    const c = convos.find((x) => x.id === cid);
    voice.say(c?.turns.at(-1)?.out, c?.lang);
    busy(ownHold, false);
  };
  bindHold(custHold, { onStart: () => cid, onBlob: sendCust, lang: () => custLang });
  bindHold(ownHold, { onStart: () => cid, onBlob: sendOwn, lang: () => OL });

  f2fDraw = () => {
    if (deletedConvos.has(cid)) cid = `f2f-${crypto.randomUUID().slice(0, 8)}`;
    const c = convos.find((x) => x.id === cid);
    const turns = c?.turns.slice(-4) ?? [];
    const forCust = (t) => (t.side === "owner" ? t.out : t.src);
    const forOwner = (t) => (t.side === "owner" ? t.src : t.out);
    topSaid.replaceChildren(...turns.map((t, i) => h(`p${i < turns.length - 1 ? ".dim" : ""}`, {}, forCust(t))));
    botSaid.replaceChildren(...turns.map((t, i) => h(`p${i < turns.length - 1 ? ".dim" : ""}`, {}, forOwner(t))));
    if (!turns.length) {
      topSaid.replaceChildren(h("p.dim", {}, "Hold the button and speak in your language."));
      botSaid.replaceChildren(h("p.dim", {}, it ? "Il cliente parla per primo. Poi tieni premuto e rispondi." : "The customer speaks first. Then hold and reply."));
    }
  };
  const overlay = h("div.f2f", {},
    h("div.half.them", {}, h("div.row", {}, h("span.brand", {}, "Eco"), h("span.spacer"), custSel), topSaid, h("div.controls", { style: { justifyContent: "center" } }, custHold)),
    h("div.half", {}, botSaid, h("div.controls", {},
      h("button.btn.sm", { type: "button", onclick: () => { overlay.remove(); f2fDraw = null; } }, icon("x"), L.exit),
      h("span.spacer"), ownHold, h("span.spacer"), h("span.tiny.muted", { style: { width: "64px" } }, langName(OL, OL)))),
  );
  document.body.append(overlay);
  f2fDraw();
}
if (new URLSearchParams(location.search).has("split")) faceToFace();

connect(id, { role: "owner", ...(key ? { key } : {}) }, (m) => {
  if (m.type === "hello") {
    for (const cid of m.deletedConvos ?? []) deletedConvos.add(cid);
    convos = (m.convos ?? []).filter((c) => !deletedConvos.has(c.id));
    active = convos.slice().sort((a, b) => Number(b.open) - Number(a.open))[0]?.id ?? null;
    drawList();
    drawThread();
    f2fDraw?.();
    if (deleteDialog && deletedConvos.has(deleteDialog.cid)) deleteDialog.confirm();
  }
  if (m.type === "conversationDeleted") removeConversation(m.cid);
  if (m.type === "turns") addTurns(m);
  if (m.type === "taught") {
    const t = convos.find((x) => x.id === m.cid)?.turns.find((x) => x.id === m.tid);
    if (t) (t.taught = true), drawThread(); // another owner device taught this reply
  }
});
drawList();
drawThread();

/** Edit what Eco answers from. One textarea per section; files (PDF, TXT, CSV) become new sections. */
async function editInfo() {
  const { pages } = await api(`/api/rooms/${id}/sources`, { key }).catch(() => ({ pages: null }));
  if (!pages) return toast("Couldn't load your info");
  const list = h("div.stack", { style: { gap: "10px", maxHeight: "55vh", overflow: "auto" } });
  const add = (tag = "info", text = "") => {
    const tagIn = h("input", { type: "text", value: tag, maxlength: 40, style: { fontWeight: 600 } });
    const ta = h("textarea", { rows: 4 });
    ta.value = text;
    const el = h("div.source", {}, h("div.row", {}, tagIn, h("button.btn.ghost.icon-btn", { type: "button", "aria-label": "Remove", onclick: () => el.remove() }, icon("trash"))), ta);
    el._get = () => ({ tag: tagIn.value.trim() || "info", text: ta.value.trim() });
    list.append(el);
  };
  pages.forEach((p) => add(p.tag, p.text));
  const fileIn = h("input", { type: "file", accept: ".pdf,.txt,.csv,.md,text/plain,text/csv,application/pdf", multiple: true, hidden: true });
  fileIn.onchange = async () => {
    for (const f of fileIn.files) {
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        const { openPdf, pdfPages } = await import("/js/slides.js");
        add(f.name.replace(/\.[^.]+$/, ""), (await pdfPages(await openPdf(new Uint8Array(await f.arrayBuffer())))).map((p) => p.text).join("\n"));
      } else add(f.name.replace(/\.[^.]+$/, ""), (await f.text()).slice(0, 8000));
    }
  };
  const web = websiteImport((tag, text) => (add(tag, text), list.lastChild.scrollIntoView({ block: "nearest" })));
  const save = h("button.btn.primary", { type: "button" }, L.save);
  const wrap = h("div.sheet-wrap", {}, h("div.sheet.stack", { style: { gap: "14px", maxWidth: "720px", width: "100%" } },
    h("h2", {}, L.edit), h("p.small.muted", {}, L.editSub), list, web.el,
    h("div.row", { style: { flexWrap: "wrap" } },
      h("button.btn.sm", { type: "button", onclick: () => add() }, icon("plus"), L.addSection),
      h("button.btn.sm", { type: "button", onclick: () => fileIn.click() }, icon("doc"), L.addFile), fileIn,
      h("button.btn.sm", { type: "button", onclick: () => web.open() }, icon("globe"), L.addWeb),
      h("span.spacer"), h("button.btn", { type: "button", onclick: () => wrap.remove() }, L.cancel), save)));
  save.onclick = async () => {
    save.disabled = true;
    try {
      await api(`/api/rooms/${id}/sources`, { method: "POST", key, body: { pages: [...list.children].map((el) => el._get()).filter((p) => p.text) } });
      toast(L.saved);
      wrap.remove();
    } catch {
      toast("Couldn't save");
      save.disabled = false;
    }
  };
  document.body.append(wrap);
}
