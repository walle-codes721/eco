// The speaker's voice sample for their cloned voice: ~10 s reading a fixed passage, only with consent.
import { h, icon, toast } from "/js/eco.js";
import { holdMic } from "/js/mic.js";

/** A card for the speaker's own device. `headers` authorise this speaker (host key or speaker key). */
export function voiceCard(id, meta, headers) {
  const mine = () => meta.speakers.find((s) => s.id === meta.me);
  const consent = h("input", { type: "checkbox" });
  const status = h("p.small.muted");
  const btn = h("button.btn.primary", { type: "button" }, icon("mic"), "Record 10 seconds");
  const del = h("button.btn.sm", { type: "button" }, icon("trash"), "Delete my sample");
  const card = h("div.card", {},
    h("div.card-head", {}, h("span.eyebrow", {}, "Your voice")),
    h("p.small", {}, meta.voice ? "Listeners can hear you in your own voice, in their language. Record yourself reading this aloud:" : "Record a sample now; listeners hear your cloned voice once the voice model is switched on. Read this aloud:"),
    h("blockquote.small", { style: { margin: "10px 0", padding: "10px 14px", borderLeft: "3px solid var(--red)", background: "var(--bg-2)", borderRadius: "8px" } }, meta.sampleText),
    h("label.check", {}, consent, h("span.small", {}, "I agree that Eco stores this sample and uses it to speak my talk in other languages. I can delete it at any time.")),
    h("div.row", { style: { flexWrap: "wrap", marginTop: "10px" } }, btn, del),
    status,
  );
  const draw = () => {
    const has = mine()?.voice;
    status.textContent = has ? "Sample saved." : "No sample yet: listeners hear the phone's voice.";
    del.hidden = !has;
  };
  let rec = null;
  btn.onclick = async () => {
    if (rec) return stop();
    if (!consent.checked) return toast("Tick the consent box first");
    try {
      rec = await holdMic({ maxMs: 12000 });
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
    if (!blob || blob.size < 20000) return toast("Too short: read the whole passage");
    status.textContent = "Saving…";
    const res = await fetch(`/api/rooms/${id}/voice`, { method: "PUT", headers: { ...headers, "content-type": "audio/wav", "x-consent": "yes" }, body: blob });
    if (!res.ok) return (status.textContent = "Couldn't save the sample"), undefined;
    mine().voice = true;
    draw();
  }
  del.onclick = async () => {
    await fetch(`/api/rooms/${id}/voice`, { method: "DELETE", headers });
    mine().voice = false;
    draw();
    toast("Sample deleted");
  };
  draw();
  return card;
}
