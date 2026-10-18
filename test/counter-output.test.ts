import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { tf, TEXT_FALLBACK } from "../src/tf";
import { MODELS, customerTurnPrompt } from "../src/prompts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const data = { src: "¿Cuánto cuesta?", lang: "es", to_owner: "Quanto costa?", answer: {
  covered: true, text: "Cuesta €3.00.", text_owner: "Costa €3.00.", cite: "menu",
} };

async function request(content: string, reason: unknown, text = "¿Cuánto cuesta?", opts: { model?: string; tokens?: number; omitUsage?: boolean } = {}) {
  // Real tf parsing, but no network or real credentials/budget service.
  const transport = vi.fn(async () => Response.json({ choices: [{ finish_reason: reason, message: { content } }], ...(opts.omitUsage ? {} : { usage: { prompt_tokens: 80, completion_tokens: opts.tokens ?? 300 } }) }));
  vi.stubGlobal("fetch", transport);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const budget = { acquire: vi.fn(async () => ({ ok: true })), finish: vi.fn(async () => {}) };
  const env = { ECO_LIVE: "1", RADEON_API_KEY: "offline-test", BUDGET: { idFromName: () => "global", get: () => budget } } as unknown as Env;
  const prompt = customerTurnPrompt({ name: "Shop", type: "restaurant", ownerLang: "it" }, [], { text }, "es");
  const result = await tf(env, "turn", opts.model ?? TEXT_FALLBACK, prompt, { pub: false, mock: () => ({}) });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(budget.acquire).toHaveBeenCalledExactlyOnceWith("turn", false, 1500);
  expect(budget.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "turn", status: 200, tout: opts.omitUsage ? 0 : opts.tokens ?? 300 }));
  const body = JSON.parse((transport.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body.max_tokens).toBe(300);
  return result;
}

describe("Counter completion metadata and JSON (offline transport)", () => {
  it.each(["length", "content_filter", "tool_calls", "insufficient_system_resource", ""])("rejects completion reason %s even if JSON parses", async (reason) => {
    expect(await request(JSON.stringify(data), reason)).toMatchObject({ data: null, fallback: "error", invalidOutput: true });
  });

  it.each(["", "{} trailing garbage", '{"src":"question","answer":', "null", "[]", "prefix " + JSON.stringify(data)])("rejects malformed or invalid output %s", async (content) => {
    expect(await request(content, "stop")).toMatchObject({ data: null, fallback: "error", invalidOutput: true });
  });

  it("rejects a long truncated bilingual answer without repair or an extra call", async () => {
    const long = "वनीला और पिस्ता की कीमत और आकार बताइए। ".repeat(12);
    const clipped = JSON.stringify({ ...data, src: long, answer: { ...data.answer, text: long, text_owner: "Vaniglia e pistacchio. ".repeat(12) } }).slice(0, 400);
    expect(await request(clipped, "length", long)).toMatchObject({ data: null, invalidOutput: true });
  });

  it("accepts complete JSON including the existing markdown-fence format", async () => {
    expect(await request("```json\n" + JSON.stringify(data) + "\n```", "stop")).toMatchObject({ data, live: true });
  });
});


it.each([MODELS.answer, TEXT_FALLBACK, MODELS.audio])("accepts the gateway content envelope for %s with or without completion metadata", async (model) => {
  for (const reason of ["stop", undefined, null]) {
    expect(await request(JSON.stringify(data), reason, undefined, { model, tokens: 80 })).toMatchObject({ data, live: true });
  }
});

it("accepts valid structured output without usage/reason, but rejects malformed JSON without metadata", async () => {
  expect(await request(JSON.stringify(data), undefined, undefined, { omitUsage: true })).toMatchObject({ data });
  expect(await request('{"answer":', undefined, undefined, { omitUsage: true })).toMatchObject({ data: null, invalidOutput: true });
});

it.each([undefined, null])("rejects missing reason %s when token usage reaches the cap", async (reason) => {
  expect(await request(JSON.stringify(data), reason)).toMatchObject({ data: null, invalidOutput: true });
});
