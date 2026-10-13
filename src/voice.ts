// Voice seam. Phase A: phones speak the text themselves (speechSynthesis), so this returns nothing.
// Phase B: if AMD hosts OmniVoice (or Chatterbox) on Token Factory, return one audio URL per language.
import type { Env } from "./env";

export async function voiceFor(_env: Env, _out: Record<string, string>): Promise<Record<string, string> | undefined> {
  return undefined;
}
