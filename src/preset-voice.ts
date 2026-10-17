// Demo-only preset voices (ADR 0006). One module: id, label, clip, MIME, reference transcript.
import type { Env } from "./env";
import { tf, isLive } from "./tf";
import { MODELS, presetTranscriptPrompt } from "./prompts";
import { b64, sampleTooLargeForAmd, type VoiceSampleMime } from "./voice";
import { morganFreemanClip } from "./preset-clip";

export interface PresetVoice {
  id: string;
  label: string;
  mime: VoiceSampleMime;
  /** Human-reviewed reference transcript; live MiMo output is stored in R2 and reused. */
  referenceTranscript: string;
  clip: () => ArrayBuffer;
}

export const PRESET_VOICES: readonly PresetVoice[] = [{
  id: "morgan-freeman",
  label: "Morgan Freeman (AI)",
  mime: "audio/mpeg",
  referenceTranscript:
    "Do you listen to your inner voice? That quiet voice that tells you what you already know, " +
    "what you truly need, and who you really are when you stop pretending otherwise.",
  clip: morganFreemanClip,
}] as const;

export const presetTranscriptKey = (id: string) => `presets/${id}/transcript.txt`;

export function presetAudioKey(lang: string, presetId: string) {
  return `${lang}@${presetId}`;
}

const pending = new Map<string, Promise<string | null>>();

/** Lazy MiMo transcript, stored in R2. Mock returns the bundled transcript with no call. */
export async function ensurePresetTranscript(env: Env, files: Pick<R2Bucket, "get" | "put">, presetId: string): Promise<string | null> {
  const preset = PRESET_VOICES.find((p) => p.id === presetId);
  if (!preset) return null;
  if (!isLive(env)) return preset.referenceTranscript;

  const inflight = pending.get(presetId);
  if (inflight) return inflight;

  const job = (async () => {
    const stored = await files.get(presetTranscriptKey(presetId));
    if (stored) return (await stored.text()).trim() || null;

    const bytes = preset.clip();
    if (sampleTooLargeForAmd(bytes.byteLength, preset.referenceTranscript)) return null;

    const r = await tf<{ transcript: string }>(env, "extract", MODELS.audio, presetTranscriptPrompt(b64(bytes), "mp3"), {
      pub: false,
      mock: () => ({ transcript: preset.referenceTranscript }),
    });
    if (!r.data?.transcript) return null;
    const text = String(r.data.transcript).trim();
    if (!text) return null;
    await files.put(presetTranscriptKey(presetId), text);
    return text;
  })();

  pending.set(presetId, job);
  try {
    return await job;
  } finally {
    pending.delete(presetId);
  }
}

export function publicPresets() {
  return PRESET_VOICES.map(({ id, label }) => ({ id, label }));
}
