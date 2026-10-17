// A voice sample for the cloned voice: a few seconds reading one fixed sentence, only with consent.
import { h, icon, toast } from "/js/eco.js";
import { holdMic } from "/js/mic.js";

const MIN = 20_000;
const MAX = 3_500_000;
const OK = new Set(["audio/wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/x-wav"]);

function pickMime(file) {
  const name = (file.name || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const fromExt = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" }[ext];
  const type = (file.type || fromExt || "").split(";")[0].trim().toLowerCase();
  return OK.has(type) ? (type === "audio/mp3" ? "audio/mpeg" : type) : null;
}

/** The room's sample card for this speaker's own device. `headers` authorise this speaker (host key or speaker key). */
export function voiceCard(id, meta, headers) {
  const mine = () => meta.speakers.find((s) => s.id === meta.me);
  return sampleCard({
    url: `/api/rooms/${id}/voice`, headers, sampleText: meta.sampleText, has: !!mine()?.voice,
    intro: meta.voice ? "Listeners can hear you in your own voice, in their language. Record yourself reading this aloud:" : "Record a sample now; listeners hear your cloned voice once the voice model is switched on. Read this aloud:",
    onChange: (has) => (mine().voice = has),
  });
}

/** `url` takes PUT (the WAV) and DELETE; `playUrl` (optional) plays back what's saved. */
export function sampleCard({ url, headers = {}, sampleText, has, intro, onChange = () => {}, playUrl, title = "Your voice" }) {
  const consent = h("input", { type: "checkbox" });
  const status = h("p.small.muted");
  const btn = h("button.btn.primary", { type: "button" }, icon("mic"), "Record this sentence");
  const upload = h("input", { type: "file", accept: ".mp3,.ogg,.wav,audio/mpeg,audio/ogg,audio/wav", hidden: true });
  const uploadBtn = h("button.btn", { type: "button" }, icon("doc"), "Upload MP3, OGG or WAV");
  const play = h("button.btn.sm", { type: "button" }, icon("sound"), "Play it back");
  const del = h("button.btn.sm", { type: "button" }, icon("trash"), "Delete my sample");
  const card = h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, title)),
    h("p.small", {}, intro),
    h("blockquote.small", { style: { margin: "10px 0", padding: "10px 14px", borderLeft: "3px solid var(--red)", background: "var(--bg-2)", borderRadius: "8px" } }, sampleText),
    h("label.check", {}, consent, h("span.small", {}, "I agree that Eco stores this sample and uses it to speak my talk in other languages. I can delete it at any time.")),
    h("div.row", { style: { flexWrap: "wrap", marginTop: "10px" } }, btn, uploadBtn, upload, playUrl ? play : null, del),
    status,
  );
  const draw = () => {
    status.textContent = has ? "Sample saved." : "No sample yet: listeners hear the phone's voice.";
    del.hidden = play.hidden = !has;
  };
  const set = (v) => ((has = v), onChange(v), draw());
  play.onclick = () => new Audio(`${playUrl}?t=${Date.now()}`).play().catch(() => toast("Couldn't play it"));
  let rec = null;
  btn.onclick = async () => {
    if (rec) return stop();
    if (!consent.checked) return toast("Tick the consent box first");
    try {
      rec = await holdMic({ maxMs: 12000, wav: true });
    } catch {
      return toast("Couldn't open the microphone");
    }
    btn.lastChild.textContent = "Stop (or wait 12 s)";
    btn.classList.add("on");
    setTimeout(() => rec && stop(), 12000);
  };
  uploadBtn.onclick = () => upload.click();
  upload.onchange = async () => {
    const file = upload.files?.[0];
    upload.value = "";
    if (!file) return;
    if (!consent.checked) return toast("Tick the consent box first");
    const mime = pickMime(file);
    if (!mime) return toast("Use an MP3, OGG or WAV file");
    if (file.size < MIN) return toast("Too short: read the whole script aloud");
    if (file.size > MAX) return toast("File too large: use a shorter recording");
    status.textContent = "Saving…";
    const res = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": mime, "x-consent": "yes" }, body: file });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status.textContent = err.error || "Couldn't save the sample";
      return;
    }
    set(true);
  };
  async function stop() {
    const r = rec;
    rec = null;
    btn.classList.remove("on");
    btn.lastChild.textContent = "Record again";
    const blob = await r.stop();
    if (!(blob instanceof Blob) || blob.size < MIN) return toast("Too short: read the whole passage");
    if (blob.size > MAX) return toast("File too large: use a shorter recording");
    status.textContent = "Saving…";
    const res = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "audio/wav", "x-consent": "yes" }, body: blob });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      status.textContent = err.error || "Couldn't save the sample";
      return;
    }
    set(true);
  }
  del.onclick = async () => {
    await fetch(url, { method: "DELETE", headers });
    set(false);
    toast("Sample deleted");
  };
  draw();
  return card;
}
