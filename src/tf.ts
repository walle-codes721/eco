// The ONE Token Factory client (CONTRIBUTING.md, token rule 3). Mock unless ECO_LIVE=1 and a key is set.
import type { Env } from "./env";
import type { Kind, Denied } from "./budget";

const BASE = "https://developer.amd.com.cn/radeon/api/v1";

export interface TfRequest {
  messages: unknown[];
  response_format: unknown;
  max_tokens: number;
}

export type TfResult<T> =
  | { data: T; live: boolean; ms: number }
  | { data: null; live: true; ms: number; fallback: Denied | "error" };

export const isLive = (env: Env) => env.ECO_LIVE === "1" && !!env.RADEON_API_KEY;

/** Parses model output that should be JSON, tolerating ```json fences. */
export function parseJson<T>(content: string): T {
  const s = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as T;
}

export async function tf<T>(
  env: Env,
  kind: Kind,
  model: string,
  req: TfRequest,
  opts: { pub: boolean; mock: () => T },
): Promise<TfResult<T>> {
  if (!isLive(env)) return { data: opts.mock(), live: false, ms: 0 };

  const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
  const translation = kind === "utterance" || kind === "turn";
  const gate = await budget.acquire(kind, opts.pub, translation ? 1500 : 0);
  if (!gate.ok) return { data: null, live: true, ms: 0, fallback: gate.reason };

  const t0 = Date.now();
  let status = 0;
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let content = "";
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.RADEON_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          ...req,
          temperature: 0.2,
          ...(model.startsWith("MiMo") ? { reasoning_effort: "none" } : {}), // thinking off (token rule 6)
        }),
        signal: AbortSignal.timeout(kind === "extract" ? 60_000 : 15_000),
      });
      status = res.status;
      // Token rule 7: retry 429 and gateway 502/503 only, at most twice, never when the wait would kill the latency target.
      if ([429, 502, 503].includes(status) && attempt < 2) {
        const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 400 * 2 ** attempt;
        if (wait <= (translation ? 1500 : 4000)) {
          await new Promise((r) => setTimeout(r, wait + Math.random() * 200));
          continue;
        }
      }
      if (status === 200) {
        const j = (await res.json()) as { choices: { message: { content: string } }[]; usage?: typeof usage };
        content = j.choices[0]?.message?.content ?? "";
        usage = j.usage ?? usage;
      }
      break;
    }
  } catch {
    status = status || 599; // timeout or network
  } finally {
    await budget.finish({
      kind,
      model,
      ms: Date.now() - t0,
      status,
      tin: usage.prompt_tokens,
      tout: usage.completion_tokens,
      pub: opts.pub,
    });
  }
  const ms = Date.now() - t0;
  if (status !== 200) return { data: null, live: true, ms, fallback: "error" };
  try {
    return { data: parseJson<T>(content), live: true, ms };
  } catch {
    return { data: null, live: true, ms, fallback: "error" };
  }
}
