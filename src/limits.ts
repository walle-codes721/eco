// Admission rules for live calls, kept free of Workers imports so they can be unit tested.
export type Kind = "utterance" | "turn" | "ask" | "extract" | "summary" | "voice" | "poll" | "slide";
export type Denied = "ceiling" | "rpm" | "busy" | "tripped" | "public-hourly";

const RPM = 12;
const CONCURRENT = 3;
const RESERVED = 2; // last rpm slots are kept for translation (utterance, turn)
/** Voice lane: cloned clips in one room, separate from translation concurrency. */
export const VOICE_CLIPS_IN_FLIGHT = 2;
/** Voice lane rpm — higher than pre-pair cloning; still capped so translation keeps the shared 12 rpm headroom. */
export const VOICE_RPM = 10;

// Points per 1M tokens, from the Token Factory guide. Only used for the on-screen estimate.
export const PRICE: Record<string, [number, number]> = { "MiMo-V2.6-Flash": [0.14, 0.28], "Gemma-4-31B-IT": [0.5, 3.0], "DeepSeek-V4-Flash": [0.14, 0.28] };

/** After a trip, one probe call may go out every PROBE_MS: a success reopens live calls, a failure waits again. */
export const PROBE_MS = 30_000;
export const probeDue = (tripped: boolean, trippedAt: number, probing: boolean, now: number) => tripped && !probing && now - trippedAt >= PROBE_MS;

/** Errors that won't fix themselves (bad key, banned account, bad request). Only these count toward the 3-failure stop;
 *  timeouts (599), 429 and 5xx pass on their own, so they fail that one phrase and nothing else (Seb, 17 Oct). */
export const countsTowardStop = (status: number) => status >= 400 && status < 500 && status !== 429;

/** Translation jobs keep the reserved last rpm slots and the tighter latency budget. One definition for tf.ts and admit(). */
export const isTranslationKind = (kind: Kind) => kind === "utterance" || kind === "turn" || kind === "slide";
export const isVoiceKind = (kind: Kind) => kind === "voice";

export type AdmitState = {
  today: number;
  max: number;
  window: number;
  inflight: number;
  voiceInflight?: number;
  voiceWindow?: number;
  tripped: boolean;
  pubHour: number;
  pubMax: number;
};

/** Pure admission rule, kept apart from the DO so it can be unit tested. */
export function admit(s: AdmitState, kind: Kind, pub: boolean): Denied | null {
  if (s.tripped) return "tripped";
  if (s.max > 0 && s.today >= s.max) return "ceiling"; // max 0 = no daily ceiling
  if (pub && s.pubHour >= s.pubMax) return "public-hourly";
  const voiceInflight = s.voiceInflight ?? 0;
  const voiceWindow = s.voiceWindow ?? 0;
  if (isVoiceKind(kind)) {
    if (voiceWindow >= VOICE_RPM) return "rpm";
    if (voiceInflight >= VOICE_CLIPS_IN_FLIGHT) return "busy";
    return null;
  }
  if (s.window >= (isTranslationKind(kind) ? RPM : RPM - RESERVED)) return "rpm";
  if (s.inflight >= CONCURRENT) return "busy";
  return null;
}
