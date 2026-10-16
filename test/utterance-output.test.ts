import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { utterancePrompt, MODELS } from "../src/prompts";
import { tf } from "../src/tf";
import { phraseEvidence } from "../src/utterance";

const langs = ["en", "it", "es", "hi"];
const original = ("We operate in 15 countries and employ 50 people. ".repeat(12)).slice(0, 500);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded phrase output", () => {
  it("keeps lengthy browser speech as evidence without requesting a redundant source copy", () => {
    const prompt = utterancePrompt({ text: original }, langs, []);
    expect(prompt.max_tokens).toBe(300);
    expect(String(prompt.messages[0].content)).not.toContain('"src": string');
    for (const lang of langs) expect(String(prompt.messages[0].content)).toContain(`"${lang}": string`);
    expect(JSON.stringify(prompt.messages[1])).toContain(original);
    expect(phraseEvidence({ src: "We operate in 50 countries.", out: {} }, original, langs).src).toBe(original);
    expect(String(utterancePrompt({ wavB64: "fake-audio" }, langs, []).messages[0].content)).toContain('"src": string');
  });

  it.each([
    ["length", '{"out":{"en":"We operate in 15'],
    ["length", '{"out":{"en":"We operate in"},"flags":[]}'],
    ["stop", '{"out":{"en": broken json}}'],
    ["stop", '{"out":{"en":"15 countries"}} trailing broken output'],
    ["stop", ""],
    ["stop", 42],
    ["stop", "null"],
    ["stop", '[{"out":{"en":"15 countries"}}]'],
  ])("rejects incomplete/malformed output (%s) without retrying or salvaging captions", async (reason, content) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json({
      choices: [{ finish_reason: reason, message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 300 },
    }));
    vi.stubGlobal("fetch", fetch);
    const budget = { acquire: vi.fn(async () => ({ ok: true })), finish: vi.fn(async () => {}) };
    const env = { ECO_LIVE: "1", RADEON_API_KEY: "offline-test", BUDGET: { idFromName: () => "test", get: () => budget } } as unknown as Env;
    const result = await tf(env, "utterance", MODELS.answer, utterancePrompt({ text: original }, langs, []), { pub: false, mock: () => ({}) });
    expect(result).toMatchObject({ data: null, invalidOutput: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.acquire).toHaveBeenCalledTimes(1);
    expect(budget.finish).toHaveBeenCalledWith(expect.objectContaining({ tout: 300, status: 200 }));
    expect(phraseEvidence(result.data, original, langs)).toMatchObject({ src: original, out: {}, incomplete: true, flags: langs });
    expect(phraseEvidence(result.data, undefined, langs).src).toBe(""); // no invented WAV transcript
  });

  it("accepts a complete fenced phrase response without changing its evidence", async () => {
    const data = { out: { en: "15 countries", it: "15 paesi", es: "15 países", hi: "15 देश" }, flags: [] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: "```json\n" + JSON.stringify(data) + "\n```" } }] })));
    const budget = { acquire: async () => ({ ok: true }), finish: async () => {} };
    const env = { ECO_LIVE: "1", RADEON_API_KEY: "offline-test", BUDGET: { idFromName: () => "test", get: () => budget } } as unknown as Env;
    expect(await tf(env, "utterance", MODELS.answer, utterancePrompt({ text: original }, langs, []), { pub: false, mock: () => ({}) }))
      .toMatchObject({ data, live: true });
  });

  it("keeps complete translations only, marks missing languages, and ignores unrelated fields", () => {
    expect(phraseEvidence({ out: { en: "15 countries", it: 15, es: " ", hi: null, fr: "invented" }, flags: ["en", 5] }, original, langs))
      .toEqual({ src: original, out: { en: "15 countries" }, flags: langs, incomplete: true });
    expect(phraseEvidence({ src: 42, out: {} }, undefined, langs).src).toBe("");
  });
});
