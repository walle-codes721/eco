// Cloned voice: the speaker's consented sample + a translated line → one clip.
// Live: OmniVoice on Token Factory. Otherwise the Hugging Face Space in voice/ if VOICE_URL is set. Mock: echo the sample.
import type { Env } from "./env";
import { tfSpeech, isLive } from "./tf";

/** The sentence every speaker reads for their sample, so the model gets the reference transcript for free. */
export const SAMPLE_TEXT =
  "Hello, this is my voice for Eco. I am reading this short script aloud so that people who speak other languages can hear my talk in my own voice today.";

/** What listeners hear: the account's saved voice, a sample recorded for this talk, or the phone's own voice. */
export type VoiceMode = "saved" | "sample" | "phone";

export const SAMPLE_MIN_BYTES = 20_000;
/** Raw audio ceiling derived from a 5 MB OmniVoice JSON body (base64 + fields). */
export const SAMPLE_MAX_RAW_BYTES = 3_500_000;

const EXT = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" } as const;
export type VoiceSampleExt = keyof typeof EXT;
export type VoiceSampleMime = (typeof EXT)[VoiceSampleExt];

export const VOICE_SAMPLE_EXTS: VoiceSampleExt[] = ["wav", "mp3", "ogg"];

export function voiceExt(mime: string): VoiceSampleExt | null {
  const m = mime.split(";")[0]!.trim().toLowerCase();
  if (m === "audio/wav" || m === "audio/x-wav") return "wav";
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/ogg") return "ogg";
  return null;
}

export function voiceMime(ext: VoiceSampleExt): VoiceSampleMime {
  return EXT[ext];
}

/** Reject uploads whose encoded OmniVoice body would reach 5 MB. */
export function sampleTooLargeForAmd(rawBytes: number, refText = SAMPLE_TEXT, inputLen = 240): boolean {
  const b64Len = Math.ceil(rawBytes / 3) * 4;
  const refAudio = 40 + b64Len; // data:audio/…;base64,
  const bodyLen = 480 + refText.length + inputLen + refAudio;
  return bodyLen >= 5_000_000;
}

/** Mock rooms and live OmniVoice both clone; only a missing backend blocks cloning. */
export const canClone = (_env: Env) => true;

/** R2 key prefix (no extension). Saved voice uses the account; each talk keeps per-speaker samples. */
export const sampleKey = (room: { id: string; owner: string; voiceMode?: VoiceMode }, speaker: string) =>
  room.voiceMode === "saved" && speaker === "s0" && room.owner ? savedKey(room.owner) : `${room.id}/voice/${speaker}`;
export const savedKey = (sub: string) => `users/${sub}/voice`;

export function sampleObjectKey(prefix: string, ext: VoiceSampleExt): string {
  return `${prefix}.${ext}`;
}

export function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function voiceFor(
  env: Env,
  sample: ArrayBuffer,
  text: string,
  lang: string,
  mime: VoiceSampleMime = "audio/wav",
  refText: string = SAMPLE_TEXT,
): Promise<ArrayBuffer | null> {
  if (!isLive(env)) return sample;
  if (isLive(env)) return tfSpeech(env, text, lang, b64(sample), refText, mime);
  if (!env.VOICE_URL) return null;
  const form = new FormData();
  form.append("text", text);
  form.append("lang", lang);
  form.append("ref_text", refText);
  const ext = voiceExt(mime) ?? "wav";
  form.append("ref", new Blob([sample], { type: mime }), `ref.${ext}`);
  try {
    const res = await fetch(`${env.VOICE_URL.replace(/\/$/, "")}/tts`, {
      method: "POST",
      headers: env.VOICE_TOKEN ? { authorization: `Bearer ${env.VOICE_TOKEN}` } : {},
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export type ParsedVoiceUpload =
  | { ok: true; bytes: ArrayBuffer; mime: VoiceSampleMime; ext: VoiceSampleExt }
  | { ok: false; error: string; status: number };

export async function loadStoredSample(
  files: Pick<R2Bucket, "get">,
  prefix: string,
): Promise<{ bytes: ArrayBuffer; mime: VoiceSampleMime } | null> {
  for (const ext of VOICE_SAMPLE_EXTS) {
    const obj = await files.get(sampleObjectKey(prefix, ext));
    if (!obj) continue;
    const ct = obj.httpMetadata?.contentType ?? voiceMime(ext);
    const parsed = voiceExt(ct);
    return { bytes: await obj.arrayBuffer(), mime: parsed ? voiceMime(parsed) : voiceMime(ext) };
  }
  return null;
}

export async function deleteStoredSample(files: Pick<R2Bucket, "delete">, prefix: string): Promise<void> {
  await Promise.all(VOICE_SAMPLE_EXTS.map((ext) => files.delete(sampleObjectKey(prefix, ext))));
}

/** Validates a voice upload on the Worker (and mirrors device rules). */
export function parseVoiceUpload(contentType: string, bytes: ArrayBuffer): ParsedVoiceUpload {
  const ext = voiceExt(contentType);
  if (!ext) return { ok: false, error: "Use an MP3, OGG or WAV file", status: 415 };
  if (bytes.byteLength < SAMPLE_MIN_BYTES) return { ok: false, error: "Too short: read the whole script aloud", status: 413 };
  if (bytes.byteLength > SAMPLE_MAX_RAW_BYTES || sampleTooLargeForAmd(bytes.byteLength)) {
    return { ok: false, error: "File too large: use a shorter recording", status: 413 };
  }
  return { ok: true, bytes, mime: voiceMime(ext), ext };
}
