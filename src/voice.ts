// Cloned voice: the speaker's consented sample + a translated line → one clip.
// Live: OmniVoice on Token Factory. Otherwise the Hugging Face Space in voice/ if VOICE_URL is set. Neither: phones speak.
import type { Env } from "./env";
import { tfSpeech, isLive } from "./tf";

/** The sentence every speaker reads for their sample, so the model gets the reference transcript for free. */
export const SAMPLE_TEXT =
  "Hello, this is my voice for Eco. I'm reading this short passage so that people who speak other languages can hear my talk in my own voice.";

/** What listeners hear: the account's saved voice, a sample recorded for this talk, or the phone's own voice. */
export type VoiceMode = "saved" | "sample" | "phone";

export const canClone = (env: Env) => isLive(env) || !!env.VOICE_URL;

/** Where a speaker's sample lives. Only the host (s0) of a signed-in room can use the account's saved voice. */
export const sampleKey = (room: { id: string; owner: string; voiceMode?: VoiceMode }, speaker: string) =>
  room.voiceMode === "saved" && speaker === "s0" && room.owner ? savedKey(room.owner) : `${room.id}/voice/${speaker}.wav`;
export const savedKey = (sub: string) => `users/${sub}/voice.wav`;

export function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function voiceFor(env: Env, sample: ArrayBuffer, text: string, lang: string): Promise<ArrayBuffer | null> {
  if (isLive(env)) return tfSpeech(env, text, lang, b64(sample), SAMPLE_TEXT);
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
