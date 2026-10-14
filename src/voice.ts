// Cloned voice: the speaker's consented sample + a translated line → one clip, from the voice service.
// The service is OmniVoice (backup Chatterbox) on a Hugging Face Space for now (voice/ in this repo);
// pointing VOICE_URL at AMD later is the only change. Without VOICE_URL, phones speak the text themselves.
import type { Env } from "./env";

/** The sentence every speaker reads for their sample, so the model gets the reference transcript for free. */
export const SAMPLE_TEXT =
  "Hello, this is my voice for Eco. I'm reading this short passage so that people who speak other languages can hear my talk in my own voice.";

export async function voiceFor(env: Env, sample: ArrayBuffer, text: string, lang: string): Promise<ArrayBuffer | null> {
  if (!env.VOICE_URL) return null;
  const form = new FormData();
  form.append("text", text);
  form.append("lang", lang);
  form.append("ref_text", SAMPLE_TEXT);
  form.append("ref", new Blob([sample], { type: "audio/wav" }), "ref.wav");
  try {
    const res = await fetch(`${env.VOICE_URL.replace(/\/$/, "")}/tts`, {
      method: "POST",
      headers: env.VOICE_TOKEN ? { authorization: `Bearer ${env.VOICE_TOKEN}` } : {},
      body: form,
      signal: AbortSignal.timeout(10_000), // a clip later than this is useless live: the phone voice already spoke
    });
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}
