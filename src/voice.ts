// Cloned voice: the speaker's consented sample + a translated line → one clip.
// Live: OmniVoice on Token Factory, falling back to the Hugging Face Space in voice/ if VOICE_URL is set. Mock: echo the sample.
import type { Env } from "./env";
import { tfSpeech, isLive, type SpeechStatus } from "./tf";

/** The sentence every speaker reads for their sample, so the model gets the reference transcript for free. */
export const SAMPLE_TEXT =
  "Hello, this is a test of my cloned voice.";

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

/** The format OmniVoice actually returned (we ask for mp3; mock echoes the sample). Sniffed from the bytes, never trusted from a header. */
export function clipFormat(bytes: ArrayBuffer): { ext: "mp3" | "wav"; mime: string } {
  const b = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
  const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;
  const frame = b[0] === 0xff && (b[1]! & 0xe0) === 0xe0; // MPEG frame sync
  return id3 || frame ? { ext: "mp3", mime: "audio/mpeg" } : { ext: "wav", mime: "audio/wav" };
}

export function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// A sample's bytes are cached by the Room and the preset module, so keying on the buffer converts each one once,
// not once per language per phrase. A WeakMap lets a deleted or replaced sample be collected with its string.
const refCache = new WeakMap<ArrayBuffer, string>();
export function refB64(sample: ArrayBuffer): string {
  let s = refCache.get(sample);
  if (s === undefined) refCache.set(sample, (s = b64(sample)));
  return s;
}

export async function voiceFor(
  env: Env,
  sample: ArrayBuffer,
  text: string,
  lang: string,
  mime: VoiceSampleMime = "audio/wav",
  refText: string = SAMPLE_TEXT,
  kind: "voice" | "prep" = "voice",
  out: SpeechStatus = { status: 0, retryAfter: 0 },
): Promise<ArrayBuffer | null> {
  if (isLive(env)) {
    const wav = await tfSpeech(env, text, lang, refB64(sample), refText, mime, kind, out);
    // Not admitted (0) or told to slow down (429): wait for Token Factory. Any other failure falls back to our own Space.
    if (wav || !env.VOICE_URL || out.status === 0 || out.status === 429) return wav;
  } else if (!env.VOICE_URL) return sample; // mock: echo the recorded sample
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

/** The stored sample's R2 etag (head, so nothing is downloaded): it changes when the speaker records again. */
export async function sampleTag(files: Pick<R2Bucket, "head">, prefix: string): Promise<string | null> {
  for (const ext of VOICE_SAMPLE_EXTS) {
    const obj = await files.head(sampleObjectKey(prefix, ext));
    if (obj) return obj.etag;
  }
  return null;
}

/** Existence check only: head, so no clip is downloaded. */
export async function hasStoredSample(files: Pick<R2Bucket, "head">, prefix: string): Promise<boolean> {
  return (await sampleTag(files, prefix)) !== null;
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
