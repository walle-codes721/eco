// Admission rules for live calls, kept free of Workers imports so they can be unit tested.
export type Kind = "utterance" | "turn" | "ask" | "extract" | "summary";
export type Denied = "ceiling" | "rpm" | "busy" | "tripped" | "public-hourly";

const RPM = 12;
const CONCURRENT = 3;
const RESERVED = 2; // last rpm slots are kept for translation (utterance, turn)
// Points per 1M tokens, from the Token Factory guide. Only used for the on-screen estimate.
export const PRICE: Record<string, [number, number]> = { "MiMo-V2.6-Flash": [0.14, 0.28], "Gemma-4-31B-IT": [0.5, 3.0] };

/** Pure admission rule, kept apart from the DO so it can be unit tested. */
export function admit(
  s: { today: number; max: number; window: number; inflight: number; tripped: boolean; pubHour: number; pubMax: number },
  kind: Kind,
  pub: boolean,
): Denied | null {
  if (s.tripped) return "tripped";
  if (s.today >= s.max) return "ceiling";
  if (pub && s.pubHour >= s.pubMax) return "public-hourly";
  const translation = kind === "utterance" || kind === "turn";
  if (s.window >= (translation ? RPM : RPM - RESERVED)) return "rpm";
  if (s.inflight >= CONCURRENT) return "busy";
  return null;
}

