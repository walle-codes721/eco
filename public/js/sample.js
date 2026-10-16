// A voice sample for the cloned voice: ~10 s reading a fixed passage, only with consent.
import { h, icon, toast } from "/js/eco.js";
import { holdMic } from "/js/mic.js";

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
  const btn = h("button.btn.primary", { type: "button" }, icon("mic"), "Record 10 seconds");
  const play = h("button.btn.sm", { type: "button" }, icon("sound"), "Play it back");
  const del = h("button.btn.sm", { type: "button" }, icon("trash"), "Delete my sample");
  const card = h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, title)),
    h("p.small", {}, intro),
    h("blockquote.small", { style: { margin: "10px 0", padding: "10px 14px", borderLeft: "3px solid var(--red)", background: "var(--bg-2)", borderRadius: "8px" } }, sampleText),
    h("label.check", {}, consent, h("span.small", {}, "I agree that Eco stores this sample and uses it to speak my talk in other languages. I can delete it at any time.")),
    h("div.row", { style: { flexWrap: "wrap", marginTop: "10px" } }, btn, playUrl ? play : null, del),
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
  async function stop() {
    const r = rec;
    rec = null;
    btn.classList.remove("on");
    btn.lastChild.textContent = "Record again";
    const blob = await r.stop();
    if (!(blob instanceof Blob) || blob.size < 20000) return toast("Too short: read the whole passage");
    status.textContent = "Saving…";
    const res = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "audio/wav", "x-consent": "yes" }, body: blob });
    if (!res.ok) return (status.textContent = "Couldn't save the sample"), undefined;
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
