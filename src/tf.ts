// The ONE Token Factory client (CONTRIBUTING.md, token rule 3). Mock unless ECO_LIVE=1 and a key is set.
import type { Env } from "./env";
import type { Kind, Denied } from "./budget";
import { MODELS } from "./prompts";
import type { TranslationTiming } from "./timing";

const BASE = "https://developer.amd.com.cn/radeon/api/v1";

export interface TfRequest {
  messages: unknown[];
  response_format: unknown;
  max_tokens: number;
}

export type TfResult<T> =
  | { data: T; live: boolean; ms: number }
  | { data: null; live: true; ms: number; fallback: Denied | "error"; why?: string; invalidOutput?: boolean };

// Gemma vanished from Token Factory on 15 Oct. Text jobs try it first and fall back to DeepSeek when it's "not supported",
// then skip it for 10 minutes. When AMD restores it, Eco is back on Gemma with no deploy.
// ponytail: per-isolate memory, so each Worker isolate pays one free 400 per 10 min; move it into Budget if that ever matters.
export const TEXT_FALLBACK = "DeepSeek-V4-Flash";
const GEMMA_RECHECK_MS = 10 * 60_000;
// A live phrase gives Gemma GEMMA_LIVE_MS alone, then DeepSeek races it. If DeepSeek wins, Gemma is skipped for GEMMA_SLOW_MS.
const GEMMA_LIVE_MS = 6_000;
const GEMMA_SLOW_MS = 2 * 60_000;
let gemmaMissingUntil = 0;

type Post = (model: string, signal: AbortSignal) => Promise<Response>;

/** Gemma first; past GEMMA_LIVE_MS the same request also goes to DeepSeek, the first good response wins and the other is aborted.
 *  Only the winner reaches finish(), so a slow Gemma never counts toward the 3-failure stop. */
async function hedged(post: Post, limit: number): Promise<{ res: Response; model: string }> {
  const deadline = AbortSignal.timeout(limit);
  const stopGemma = new AbortController();
  const gemma = post(MODELS.answer, AbortSignal.any([deadline, stopGemma.signal])).then((res) => ({ res, model: MODELS.answer as string }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const early = await Promise.race([gemma, new Promise<null>((r) => (timer = setTimeout(() => r(null), GEMMA_LIVE_MS)))]).finally(() => clearTimeout(timer));
  if (early) return early;
  const stopDs = new AbortController();
  const ds = post(TEXT_FALLBACK, AbortSignal.any([deadline, stopDs.signal])).then((res) => ({ res, model: TEXT_FALLBACK }));
  try {
    // An error response from one side waits for the other.
    const win = await Promise.any([gemma.then((g) => (g.res.ok ? g : ds)), ds.then((d) => (d.res.ok ? d : gemma))]);
    if (win.model === TEXT_FALLBACK) stopGemma.abort(), (gemmaMissingUntil = Date.now() + GEMMA_SLOW_MS);
    else stopDs.abort();
    return win;
  } catch (e) {
    throw (e as AggregateError).errors.at(-1); // both failed: report DeepSeek's (usually the timeout)
  }
}

export const isLive =(env: Env) => env.ECO_LIVE === "1" && !!env.RADEON_API_KEY;

/** Parses model output that should be JSON, tolerating ```json fences. */
export function parseJson<T>(content: string): T {
  const s = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as T;
}

/** OmniVoice on /audio/speech: one clip in the voice of `refB64` (a WAV). Same gate and log as chat; null = phones speak.
 *  Mock returns null too: no recorded clip, so mock rooms hear the phone voice. No retries: a late clip is useless live. */
export async function tfSpeech(env: Env, input: string, lang: string, refB64: string, refText: string): Promise<ArrayBuffer | null> {
  if (!isLive(env)) return null;
  const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
  const gate = await budget.acquire("voice", false);
  if (!gate.ok) return null;
  const t0 = Date.now();
  let status = 0;
  let why = "";
  try {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RADEON_API_KEY}`, "content-type": "application/json" },
      // ref_text skips server-side transcription of the sample (~4 s per clip instead of ~17 s).
      body: JSON.stringify({ model: MODELS.voice, input, language: lang, ref_audio: `data:audio/wav;base64,${refB64}`, ref_text: refText, response_format: "wav" }),
      signal: AbortSignal.timeout(10_000), // later than this the phone voice already spoke
    });
    status = res.status;
    if (status === 200) return await res.arrayBuffer();
    why = `${status}: ${(await res.text().catch(() => "")).slice(0, 160)}`;
    console.warn("tf voice failed", why);
    return null;
  } catch {
    status = status || 599;
    return null;
  } finally {
    await budget.finish({ kind: "voice", model: MODELS.voice, ms: Date.now() - t0, status, tin: 0, tout: 0, pub: false, why });
  }
}

export async function tf<T>(
  env: Env,
  kind: Kind,
  model: string,
  req: TfRequest,
  opts: { pub: boolean; mock: () => T; timing?: TranslationTiming },
): Promise<TfResult<T>> {
  if (!isLive(env)) return { data: opts.mock(), live: false, ms: 0 };
  if (model === MODELS.answer && Date.now() < gemmaMissingUntil) model = TEXT_FALLBACK;

  const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
  const translation = kind === "utterance" || kind === "turn";
  const admissionAt = Date.now();
  const gate = await budget.acquire(kind, opts.pub, translation ? 1500 : 0);
  if (opts.timing) opts.timing.budgetMs = Date.now() - admissionAt;
  if (!gate.ok) return { data: null, live: true, ms: 0, fallback: gate.reason };

  const t0 = Date.now();
  let status = 0;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let content = "";
  let finishReason: string | undefined;
  let why = "";
  try {
    for (let attempt = 0; ; attempt++) {
      const attemptAt = Date.now();
      const measured = { model, status: 0, ms: 0 };
      opts.timing?.attempts.push(measured);
      let retryMs = 0;
      try {
        const post = (m: string, signal: AbortSignal) =>
          fetch(`${BASE}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.RADEON_API_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: m,
              ...req,
              temperature: 0.2,
              ...(m.startsWith("MiMo") ? { reasoning_effort: "none" } : {}), // thinking off (token rule 6)
            }),
            signal,
          });
        const limit = kind === "extract" ? 60_000 : kind === "summary" || kind === "poll" ? 30_000 : 15_000; // a 4-language summary writes ~1,000 tokens
        let res: Response;
        if (translation && model === MODELS.answer) ({ res, model } = await hedged(post, limit));
        else res = await post(model, AbortSignal.timeout(limit));
        measured.model = model;
        status = res.status;
        measured.status = status;
        // Token rule 7: retry 429 and gateway 502/503 only, at most twice, never when the wait would kill the latency target.
        if ([429, 502, 503].includes(status) && attempt < 2) {
          const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 400 * 2 ** attempt;
          if (wait <= (translation ? 1500 : 4000)) {
            const waitAt = Date.now();
            await new Promise((r) => setTimeout(r, wait + Math.random() * 200));
            retryMs = Date.now() - waitAt;
            if (opts.timing) opts.timing.retryMs += retryMs;
            continue;
          }
        }
        if (status === 200) {
          const j = (await res.json()) as { choices: { message: { content: string }; finish_reason?: string }[]; usage?: typeof usage };
          const value = j.choices[0]?.message?.content;
          content = typeof value === "string" ? value : "";
          finishReason = j.choices[0]?.finish_reason;
          usage = j.usage ?? usage;
        } else {
          // Gateway errors are {"error":{...}}, platform errors {"detail":{"error":{...}}}. Never includes the key.
          const body = await res.text().catch(() => "");
          let msg = body;
          try {
            const e = JSON.parse(body);
            msg = (e.error ?? e.detail?.error ?? e.detail)?.message ?? JSON.stringify(e.error ?? e.detail ?? e);
          } catch {}
          why = `${status}: ${String(msg).slice(0, 160)}`;
          // Gemma off the catalog: same request on the fallback, no retry. This 400 never reaches finish(), so it can't trip the stop.
          if (status === 400 && model === MODELS.answer && /not supported/i.test(msg)) {
            gemmaMissingUntil = Date.now() + GEMMA_RECHECK_MS;
            model = TEXT_FALLBACK;
            why = "";
            continue;
          }
        }
        break;
      } finally {
        // Provider round trip and body decoding; excludes explicit retry sleeps.
        measured.ms = Date.now() - attemptAt - retryMs;
      }
    }
  } catch (e) {
    status = status || 599; // timeout or network
    why = why || `${status}: ${(e as Error).name === "TimeoutError" ? "timed out" : "network error"}`;
  } finally {
    const accountingAt = Date.now();
    await budget.finish({
      kind,
      model,
      ms: Date.now() - t0,
      status,
      tin: usage.prompt_tokens,
      tout: usage.completion_tokens,
      pub: opts.pub,
      why,
    });
    if (opts.timing) opts.timing.accountingMs = Date.now() - accountingAt;
  }
  const ms = Date.now() - t0;
  if (status !== 200) {
    console.warn("tf failed", kind, model, why);
    return { data: null, live: true, ms, fallback: "error", why };
  }
  // Even syntactically valid JSON can contain clipped translations at the output limit.
  // Do not repair fragments or retry; Stage may retain its independently supplied browser text.
  if (kind === "utterance" && finishReason && finishReason !== "stop") {
    return { data: null, live: true, ms, fallback: "error", why: `incomplete phrase output (${finishReason})`, invalidOutput: true };
  }
  // Older gateway responses/fixtures can omit completion metadata. Absence is
  // not itself truncation: still require complete JSON and Counter field validation.
  // Explicit non-stop reasons, or an exhausted cap without a reason, fail closed.
  if (kind === "turn" && (finishReason != null ? finishReason !== "stop" : usage.completion_tokens >= req.max_tokens)) {
    return { data: null, live: true, ms, fallback: "error", why: `incomplete Counter output (${finishReason ?? "unknown"})`, invalidOutput: true };
  }
  try {
    // Phrase evidence must be a complete response, not a JSON fragment extracted
    // from a malformed wrapper. Keep the existing parser for other job types.
    const data = kind === "utterance" || kind === "turn"
      ? JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "")) as T
      : parseJson<T>(content);
    if ((kind === "utterance" || kind === "turn") && (!data || typeof data !== "object" || Array.isArray(data))) throw new Error("Expected response object");
    return { data, live: true, ms };
  } catch {
    why = content ? "model didn't return JSON" : "model returned nothing";
    console.warn("tf failed", kind, model, why, content.slice(0, 200));
    return { data: null, live: true, ms, fallback: "error", why, invalidOutput: true };
  }
}
