// Demo-only preset voices (ADR 0006). One module: id, label, clip, MIME, reference transcript.
import type { VoiceSampleMime } from "./voice";
import { morganFreemanClip } from "./preset-clip";

export interface PresetVoice {
  id: string;
  label: string;
  mime: VoiceSampleMime;
  /** Human-reviewed transcript of the bundled clip, sent as the OmniVoice ref_text. No live transcription call. */
  referenceTranscript: string;
  clip: () => ArrayBuffer;
}

export const PRESET_VOICES: readonly PresetVoice[] = [{
  id: "morgan-freeman",
  label: "Morgan Freeman (AI)",
  mime: "audio/mpeg",
  referenceTranscript: "Hello, this is a test of my cloned voice.",
  clip: morganFreemanClip,
}] as const;

export function presetAudioKey(lang: string, presetId: string) {
  return `${lang}@${presetId}`;
}

export function publicPresets() {
  return PRESET_VOICES.map(({ id, label }) => ({ id, label }));
}
