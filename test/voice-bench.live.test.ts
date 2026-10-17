// LIVE: 4 OmniVoice calls (1 alone, then 3 at once). Skipped unless BENCH_LIVE=1, so `npm test` stays mock-only.
// Run (Seb states the budget first, token rule 2):
//   $env:BENCH_LIVE="1"; $env:BENCH_SAMPLE="C:\path\to\your-own-voice.wav"; npx vitest run test/voice-bench.live.test.ts
// The sample must be the runner's own voice, read aloud as SAMPLE_TEXT (or set BENCH_REF_TEXT to what was said).
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { tfSpeech } from "../src/tf";
import { b64, clipFormat, SAMPLE_TEXT, voiceMime, type VoiceSampleExt } from "../src/voice";
import { benchSerialization } from "../src/voice-bench";

// About ten words each, same meaning; the key is read here and never printed.
const TEXT: Record<string, string> = {
  it: "Oggi vi mostro come funziona la traduzione dal vivo con la mia voce.",
  es: "Hoy les muestro cómo funciona la traducción en vivo con mi propia voz.",
  hi: "आज मैं दिखाता हूँ कि मेरी आवाज़ में लाइव अनुवाद कैसे काम करता है।",
};

describe.runIf(process.env.BENCH_LIVE === "1")("live: does OmniVoice serialize parallel clones?", () => {
  it("times 1 call alone, then 3 at once", async () => {
    const samplePath = process.env.BENCH_SAMPLE;
    if (!samplePath) throw new Error("Set BENCH_SAMPLE to a recording of your own voice (wav, mp3 or ogg).");
    const ext = extname(samplePath).slice(1).toLowerCase() as VoiceSampleExt;
    const mime = voiceMime(ext);
    if (!mime) throw new Error("BENCH_SAMPLE must be .wav, .mp3 or .ogg");
    const ref = b64(readFileSync(samplePath).buffer.slice(0) as ArrayBuffer);
    const refText = process.env.BENCH_REF_TEXT ?? SAMPLE_TEXT;
    const key = /^RADEON_API_KEY=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"))?.[1]?.trim();
    if (!key) throw new Error("RADEON_API_KEY is not set in .dev.vars");

    const finished: { status: number; ms: number; why: string }[] = [];
    const env = {
      ECO_LIVE: "1",
      RADEON_API_KEY: key,
      BUDGET: {
        idFromName: () => "global",
        get: () => ({
          acquire: async () => ({ ok: true }),
          finish: async (e: { status: number; ms: number; why: string }) => { finished.push({ status: e.status, ms: e.ms, why: e.why }); },
        }),
      },
    } as unknown as Env;

    const langs = (process.env.BENCH_LANGS ?? Object.keys(TEXT).join(",")).split(",").filter((l) => TEXT[l]); // e.g. BENCH_LANGS=it for 2 calls
    const got: { lang: string; bytes: number; format: string }[] = [];
    const r = await benchSerialization(
      async (lang) => {
        const clip = await tfSpeech(env, TEXT[lang]!, lang, ref, refText, mime);
        if (clip) got.push({ lang, bytes: clip.byteLength, format: clipFormat(clip).ext });
        return clip;
      },
      langs,
      () => new Promise((ok) => setTimeout(ok, 62_000)), // let the 6-per-minute window clear
    );
    console.log("OmniVoice bench", JSON.stringify({ ...r, got, finished }, null, 2));
    expect(finished).toHaveLength(langs.length + 1);
  }, 180_000);
});
