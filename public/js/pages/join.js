// Co-speaker: joins from their own device via the host's QR. Their mic, their name, their voice.
import { h, icon, api, roomId, toast, store, notFound, keepAwake, langName } from "/js/eco.js";
import { connect } from "/js/live.js";
import { phraseMic, phraseInit, speakingSignal, micErrorMessage, SPOKEN_LANGUAGES, hasSpeechRecognition } from "/js/mic.js";
import { voiceCard } from "/js/sample.js";

const id = roomId();
const join = location.hash.match(/j=([a-f0-9]+)/)?.[1];
if (join) history.replaceState(null, "", location.pathname);
let key = store(`eco:speaker:${id}`);
const main = h("main.phone.stack", { style: { paddingTop: "24px", paddingBottom: "48px", gap: "16px" } });
document.body.replaceChildren(h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.muted", {}, "Co-speaker"))), main);

if (!key) {
  if (!join) {
    notFound("Ask the main speaker for the co-speaker QR code.");
    throw new Error("no join key");
  }
  const name = h("input", { type: "text", placeholder: "Your name", maxlength: 60, autocomplete: "name", required: true });
  const form = h("form.stack", {}, h("h1", { style: { fontSize: "28px" } }, "Join as a speaker"),
    h("p.muted", {}, "Your name appears next to everything you say. Use this device's microphone while you speak."),
    h("label.field", {}, "Name", name), h("button.btn.primary.big", { type: "submit" }, "Join", icon("right")));
  main.append(form);
  key = await new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/api/rooms/${id}/join`, { method: "POST", body: { name: name.value }, headers: { "x-join": join } });
        store(`eco:speaker:${id}`, r.key);
        form.remove();
        resolve(r.key);
      } catch (err) {
        toast(err.message || "Couldn't join");
      }
    };
  });
}

const headers = { "x-speaker-key": key };
let meta;
try {
  meta = await api(`/api/rooms/${id}/meta`, { headers });
  if (!meta.me) throw new Error("not a speaker");
} catch {
  store(`eco:speaker:${id}`, null);
  notFound("This speaker link has expired. Scan the co-speaker QR again.");
  throw new Error("no speaker");
}

const speaking = new Set();
const people = h("div.row", { style: { flexWrap: "wrap", gap: "8px" } });
const drawPeople = () => people.replaceChildren(...meta.speakers.map((s) =>
  h(`span.chip${speaking.has(s.id) ? ".speaking" : ""}`, {}, speaking.has(s.id) ? h("span.dot.live") : null, s.id === meta.me ? `${s.name} (you)` : s.name)));

const level = h("div", { style: { height: "100%", width: "0", background: "var(--red)", transition: "width .1s" } });
const spokenLang = h("select", { disabled: !hasSpeechRecognition },
  h("option", { value: "" }, `Browser default (${navigator.language})`),
  ...SPOKEN_LANGUAGES.map((l) => h("option", { value: l }, langName(l, "en"))),
);
const micState = h("div.small.muted", {}, "Off");
const micBtn = h("button.mic-btn", { type: "button" }, h("span.ico", {}, icon("mic")), h("div", { style: { flex: 1 } }, h("div", { style: { fontWeight: 600 } }, "Microphone"), micState));
let stopMic = null;
micBtn.onclick = async () => {
  if (micBtn.disabled) return;
  if (stopMic) return stopMic();
  micBtn.disabled = spokenLang.disabled = true;
  try {
    const end = await phraseMic({ lang: spokenLang.value || undefined, onLevel: speakingSignal(live.send, (l) => (level.style.width = `${Math.round(l * 100)}%`)), onPhrase: send, onError: (err) => { stopMic?.(); toast(micErrorMessage(err)); } });
    stopMic = () => (end(), (stopMic = null), (spokenLang.disabled = !hasSpeechRecognition), micBtn.classList.remove("on"), (micState.textContent = "Off"), (level.style.width = "0"), live.send({ type: "speaking", on: false }));
    micBtn.classList.add("on");
    micState.textContent = "Listening…";
    keepAwake();
  } catch (err) {
    toast(micErrorMessage(err));
  } finally {
    micBtn.disabled = false;
    spokenLang.disabled = !hasSpeechRecognition || !!stopMic;
  }
};
async function send(blob) {
  const [ct, body] = phraseInit(blob);
  const r = await fetch(`/api/rooms/${id}/utterance`, { method: "POST", headers: { ...headers, ...ct }, body }).catch(() => null);
  if (!r?.ok) toast("Phrase dropped");
}

main.append(
  h("p.eyebrow", {}, "Speaking in"), h("h1", { style: { fontSize: "28px", margin: "4px 0 16px" } }, meta.title),
  h("div.card", {}, h("div.card-head", {}, h("span.eyebrow", {}, "Speakers")), people),
  h("div.card", {},
    h("label.field", {}, "Spoken Language", spokenLang),
    h("p.tiny.muted", {}, hasSpeechRecognition ? "Choose before starting. Stop the mic to change languages." : "This browser uses audio upload. The language selector only applies to browser speech recognition."),
    micBtn, h("div.level", { style: { marginTop: "12px" } }, level),
    h("p.tiny.muted", { style: { marginTop: "10px" } }, "Turn the mic on while it's your turn. Eco tags everything this device hears with your name.")),
  meta.voiceMode === "phone" ? null : voiceCard(id, meta, headers),
);
drawPeople();

const live = connect(id, { role: "speaker", sk: key }, (m) => {
  if (m.type === "notice") toast(m.text);
  if (m.type === "hello") Object.assign(meta, m.meta, { me: meta.me });
  if (m.type === "speakers") meta.speakers = m.speakers;
  if (m.type === "speaking") m.on ? speaking.add(m.speaker) : speaking.delete(m.speaker);
  drawPeople();
});
