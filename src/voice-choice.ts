import { PRESET_VOICES, presetAudioKey } from "./preset-voice";

/** Listener setting: speaker clone (default), a preset id, or the phone's voice. */
export type ListenerVoice = "speaker" | "phone" | string;

export const DEFAULT_LISTENER_VOICE: ListenerVoice = "speaker";

export function parseListenerVoice(raw: unknown): ListenerVoice {
  const v = String(raw ?? DEFAULT_LISTENER_VOICE);
  if (v === "speaker" || v === "phone") return v;
  return PRESET_VOICES.some((p) => p.id === v) ? v : DEFAULT_LISTENER_VOICE;
}

/** Key on `line.audio`, or null when the phone speaks (no clip). */
export function audioField(lang: string, voice: ListenerVoice): string | null {
  if (voice === "phone") return null;
  if (voice === "speaker") return lang;
  return presetAudioKey(lang, voice);
}

export interface CloneDemand {
  speakerLangs: string[];
  presetLangs: Record<string, string[]>;
}

/** Languages to clone for each voice kind, given who is connected right now. */
export function cloneDemand(
  listeners: { lang: string; voice: ListenerVoice }[],
  lineOut: Record<string, string>,
): CloneDemand {
  const speakerLangs = new Set<string>();
  const presetLangs: Record<string, Set<string>> = {};
  for (const { lang, voice } of listeners) {
    if (!lineOut[lang]) continue;
    if (voice === "phone") continue;
    if (voice === "speaker") speakerLangs.add(lang);
    else {
      if (!presetLangs[voice]) presetLangs[voice] = new Set();
      presetLangs[voice].add(lang);
    }
  }
  return {
    speakerLangs: [...speakerLangs],
    presetLangs: Object.fromEntries(Object.entries(presetLangs).map(([id, set]) => [id, [...set]])),
  };
}
