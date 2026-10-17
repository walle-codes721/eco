// Does OmniVoice serialize parallel Clone calls? Pure timing and verdict, so it is unit tested with a fake call.
// The live run (test/voice-bench.live.test.ts) wires it to tfSpeech in src/tf.ts: no other client (token rule 3).
export interface ClipTiming { lang: string; ms: number; ok: boolean }

export type Verdict = "serialized" | "parallel" | "inconclusive" | "failed";

export interface BenchResult {
  single: ClipTiming;
  parallel: ClipTiming[];
  verdict: Verdict;
  note: string;
}

type Call = (lang: string) => Promise<ArrayBuffer | null>;

async function timed(call: Call, lang: string): Promise<ClipTiming> {
  const t0 = Date.now();
  const wav = await call(lang).catch(() => null);
  return { lang, ms: Date.now() - t0, ok: !!wav };
}

/** Finish times of N clips fired together, measured against one clip alone. */
export function verdictFor(single: ClipTiming, parallel: ClipTiming[]): { verdict: Verdict; note: string } {
  const failed = parallel.filter((p) => !p.ok);
  if (!single.ok || failed.length) {
    return { verdict: "failed", note: `${!single.ok ? "the single call failed" : `${failed.map((f) => f.lang).join(", ")} failed`}; a timeout or 503 is itself a result` };
  }
  const t = parallel.map((p) => p.ms).sort((a, b) => a - b);
  const last = t[t.length - 1]!;
  const ratio = last / Math.max(1, single.ms);
  if (ratio >= 2) return { verdict: "serialized", note: `slowest finished at ${ratio.toFixed(1)}x a single call` };
  if (ratio <= 1.5) return { verdict: "parallel", note: `slowest finished at ${ratio.toFixed(1)}x a single call` };
  return { verdict: "inconclusive", note: `slowest finished at ${ratio.toFixed(1)}x a single call: repeat the run` };
}

/** One call alone, a pause for the per-minute window, then every language at once. */
export async function benchSerialization(call: Call, langs: string[], pause: () => Promise<void>): Promise<BenchResult> {
  const single = await timed(call, langs[0]!);
  await pause();
  const parallel = await Promise.all(langs.map((l) => timed(call, l)));
  return { single, parallel, ...verdictFor(single, parallel) };
}
