import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { translationTiming, timingHeader } from "../src/timing";
import { MODELS, utterancePrompt } from "../src/prompts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const request = utterancePrompt({ text: "15 countries" }, ["en", "it", "es", "hi"], []);
const success = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"out":{"en":"15 countries"},"flags":[]}' } }], usage: { prompt_tokens: 20, completion_tokens: 30 } });
function environment(budgetMs = 0, accountingMs = 0) {
  const budget = { acquire: vi.fn(async () => { await delay(budgetMs); return { ok: true }; }), finish: vi.fn(async () => { await delay(accountingMs); }) };
  return { budget, env: { ECO_LIVE: "1", RADEON_API_KEY: "offline", BUDGET: { idFromName: () => "global", get: () => budget } } as unknown as Env };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe("translation timing (all transport mocked)", () => {
  it("separates admission, full provider response and accounting without changing the request", async () => {
    const { tf } = await import("../src/tf");
    const { budget, env } = environment(750, 50);
    const transport = vi.fn(async () => {
      await delay(2500);
      const response = success();
      const json = response.json.bind(response);
      response.json = async () => { await delay(500); return json(); };
      return response;
    });
    vi.stubGlobal("fetch", transport);
    const timing = translationTiming();
    const result = tf(env, "utterance", MODELS.answer, request, { pub: false, mock: () => ({}), timing });
    await vi.runAllTimersAsync();
    expect((await result).live).toBe(true);
    expect(timing).toEqual({ budgetMs: 750, retryMs: 0, accountingMs: 50, attempts: [{ model: MODELS.answer, status: 200, ms: 3000 }] });
    expect(timingHeader(timing, 4000)).toContain("processing;dur=200, server;dur=4000");
    expect(budget.acquire).toHaveBeenCalledExactlyOnceWith("utterance", false, 1500);
    expect(budget.finish).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse((transport.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(300);
    expect(body.model).toBe(MODELS.answer);
    expect(body).not.toHaveProperty("timing");
  });

  it("reports retry sleeps separately and preserves the two-retry maximum", async () => {
    const { tf } = await import("../src/tf");
    const { env, budget } = environment();
    let calls = 0;
    const transport = vi.fn(async () => { await delay(100); return ++calls < 3 ? new Response("busy", { status: 503 }) : success(); });
    vi.stubGlobal("fetch", transport);
    const timing = translationTiming();
    const result = tf(env, "utterance", MODELS.answer, request, { pub: false, mock: () => ({}), timing });
    await vi.runAllTimersAsync();
    await result;
    expect(timing.retryMs).toBe(1200);
    expect(timing.attempts.map((a) => [a.status, a.ms])).toEqual([[503, 100], [503, 100], [200, 100]]);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(budget.acquire).toHaveBeenCalledTimes(1);
    expect(budget.finish).toHaveBeenCalledTimes(1);
  });

  it("identifies the existing Gemma fallback separately from retry backoff", async () => {
    const { tf, TEXT_FALLBACK } = await import("../src/tf");
    const { env, budget } = environment();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { await delay(100); return ++calls === 1 ? Response.json({ error: { message: "not supported" } }, { status: 400 }) : success(); }));
    const timing = translationTiming();
    const result = tf(env, "utterance", MODELS.answer, request, { pub: false, mock: () => ({}), timing });
    await vi.runAllTimersAsync();
    await result;
    expect(timing.attempts).toEqual([{ model: MODELS.answer, status: 400, ms: 100 }, { model: TEXT_FALLBACK, status: 200, ms: 100 }]);
    expect(timing.retryMs).toBe(0);
    expect(budget.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 200, model: TEXT_FALLBACK }));
  });

  it("records denied admission without invoking the provider or finishing an unadmitted call", async () => {
    const { tf } = await import("../src/tf");
    const { env, budget } = environment();
    budget.acquire.mockImplementationOnce(async () => { await delay(1250); return { ok: false, reason: "busy" } as never; });
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const timing = translationTiming();
    const result = tf(env, "utterance", MODELS.answer, request, { pub: false, mock: () => ({}), timing });
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ fallback: "busy" });
    expect(timing.budgetMs).toBe(1250);
    expect(timing.attempts).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(budget.finish).not.toHaveBeenCalled();
  });
});


it.each([false, true])("preserves upstream poll timeout and budget with diagnostics enabled=%s", async (enabled) => {
  const { tf } = await import("../src/tf");
  const { pollPrompt } = await import("../src/prompts");
  const { env, budget } = environment();
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const transport = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"q":{"en":"Which?"},"options":{"en":["A","B"]}}' } }] }));
  vi.stubGlobal("fetch", transport);
  const timing = enabled ? translationTiming() : undefined;
  const req = pollPrompt("Quale?", ["A", "B"], "it", ["en"]);
  const pending = tf(env, "poll", MODELS.answer, req, { pub: false, mock: () => ({}), timing });
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ data: { q: { en: "Which?" } }, live: true });
  expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
  expect(budget.acquire).toHaveBeenCalledExactlyOnceWith("poll", false, 0);
  expect(budget.finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "poll", model: MODELS.answer, status: 200 }));
  expect(transport).toHaveBeenCalledTimes(1);
  const body = JSON.parse((transport.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body).toEqual({ model: MODELS.answer, ...req, temperature: 0.2 });
  if (timing) expect(timing.attempts).toEqual([{ model: MODELS.answer, status: 200, ms: 0 }]);
});
