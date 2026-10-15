import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Exercise the real room question handler and mock AI path without a Workers runtime or API key.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room, type Line } from "../src/room";
import * as client from "../src/tf";

const question = "यह कंपनी कितने देशों में काम करती है?";
const line = (seq: number, countries: number): Line => ({
  seq, at: seq * 10, t: seq * 10000, slide: 7, speaker: "s0", ms: 0, live: false, flags: [],
  src: `We operate in ${countries} countries.`, out: { hi: `हम ${countries} देशों में काम करते हैं।` },
});

async function stage(pages = Array.from({ length: 6 }, (_, i) => ({
  tag: `slide ${i + 1}`, text: "Unrelated product background. ".repeat(40).slice(0, 1000),
}))) {
  const saved = new Map<string, unknown>();
  let ready: Promise<unknown>;
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((key) => [key, saved.get(key)])),
      put: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) saved.set(key, value); },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: () => [],
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready!;
  const id = "stage/test/multilingual";
  await room.init(id, {
    langs: ["hi"],
    pages,
  });
  return {
    room,
    update: async (action: string, body: unknown) => {
      const response = await room.fetch(new Request(`https://room/${action}`, {
        method: "POST", headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
    },
    ask: async (text = question, lang = "hi") => {
      const response = await room.fetch(new Request("https://room/ask", {
        method: "POST", headers: { "x-room": id, "x-ip": "test", "content-type": "application/json" },
        body: JSON.stringify({ text, lang }),
      }));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ covered: boolean; answer: string; cite: string; cached: boolean }>;
    },
  };
}

describe("Stage question flow", () => {
  it("answers in Hindi from stored captions and caches an unchanged transcript with one model operation", async () => {
    const { room, ask } = await stage();
    room.lines = [line(1, 15)];
    const spy = vi.spyOn(client, "tf");
    try {
      expect(await ask()).toMatchObject({ covered: true, answer: "हम 15 देशों में काम करते हैं।", cite: "said at 0:10", cached: false });
      expect(await ask()).toMatchObject({ cached: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain("We operate in 15 countries.");
    } finally {
      spy.mockRestore();
    }
  });

  it("reconsiders a previously uncovered question after new speech arrives", async () => {
    const { room, ask } = await stage();
    expect(await ask()).toMatchObject({ covered: false, cached: false });
    expect(await ask()).toMatchObject({ covered: false, cached: true });
    room.lines.push(line(1, 15));
    expect(await ask()).toMatchObject({ covered: true, answer: "हम 15 देशों में काम करते हैं।", cached: false });
  });

  it("does not reuse an old answer after the retained transcript changes", async () => {
    const { room, ask } = await stage();
    room.lines = [line(1, 15)];
    expect((await ask()).answer).toContain("15");
    room.lines = [line(2, 20)];
    expect(await ask()).toMatchObject({ cached: false, answer: "हम 20 देशों में काम करते हैं।" });
  });

  it.each([
    ["hi", question, "Hindi"],
    ["it", "In quanti paesi lavora questa azienda?", "Italian"],
    ["es", "¿En cuántos países trabaja esta empresa?", "Spanish"],
    ["en", "How many countries does this company work in?", "English"],
  ])("passes useful English-only slide evidence to the existing %s answer call", async (lang, text, language) => {
    const pages = Array.from({ length: 20 }, (_, i) => ({
      tag: `slide ${i + 1}`,
      text: ((i === 11 ? "Our reach\nWe operate in 15 countries.\n" : "Our team\nWe employ 50 people.\n") +
        "Product background. ".repeat(100)).slice(0, 1000),
    }));
    const { room, ask, update } = await stage(pages);
    await update("slide", { n: 12 });
    expect(room.lines).toHaveLength(0); // no captions or translated source text
    const spy = vi.spyOn(client, "tf");
    try {
      const response = await ask(text, lang);
      expect(response.cached).toBe(false);
      expect(await ask(text, lang)).toMatchObject({ cached: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe("ask");
      const messages = JSON.stringify(spy.mock.calls[0][3].messages);
      expect(messages).toContain("[slide 12] Our reach\\nWe operate in 15 countries.");
      expect(messages).toContain(`Write the answer in ${language}`);
      if (lang === "en") expect(response).toMatchObject({ covered: true, answer: "We operate in 15 countries.", cite: "slide 12" });
      else expect(response).toMatchObject({ covered: false, answer: "", cite: "" }); // mock cannot translate English-only text
    } finally {
      spy.mockRestore();
    }
  });

  it("rechecks after slide navigation and source edits, while reusing unchanged context", async () => {
    const { ask, update } = await stage([
      { tag: "slide 1", text: "Welcome." }, { tag: "slide 2", text: "We operate in 15 countries." },
    ]);
    expect((await ask()).cached).toBe(false);
    expect((await ask()).cached).toBe(true);
    await update("slide", { n: 2 });
    expect((await ask()).cached).toBe(false);
    expect((await ask()).cached).toBe(true);
    await update("sources", { pages: [{ tag: "slide 2", text: "We operate in 20 countries." }] });
    expect((await ask()).cached).toBe(false);
  });

  it("does not repeat an answer call after navigation when the selected evidence is identical", async () => {
    const { ask, update } = await stage([
      { tag: "slide 1", text: "Welcome." }, { tag: "slide 2", text: "We operate in 15 countries." },
    ]);
    const spy = vi.spyOn(client, "tf");
    try {
      const text = "How many countries do we operate in?";
      expect(await ask(text, "en")).toMatchObject({ cached: false, answer: "We operate in 15 countries.", cite: "slide 2" });
      await update("slide", { n: 2 });
      expect(await ask(text, "en")).toMatchObject({ cached: true, answer: "We operate in 15 countries.", cite: "slide 2" });
      await update("slide", { n: 1 });
      expect((await ask(text, "en")).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("rechecks a cached miss when navigation supplies new evidence and when that source is edited", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({
      tag: `slide ${i + 1}`,
      text: ((i === 11 ? "We operate in 15 countries. " : "Background. ") + "Product details. ".repeat(100)).slice(0, 1000),
    }));
    const { ask, update } = await stage(pages);
    const spy = vi.spyOn(client, "tf");
    try {
      expect(await ask()).toMatchObject({ cached: false, covered: false });
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).not.toContain("15 countries");
      await update("slide", { n: 12 });
      expect((await ask()).cached).toBe(false);
      expect((await ask()).cached).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(spy.mock.calls[1][3].messages)).toContain("15 countries");
      await update("sources", { pages: pages.map((p) => ({ ...p, text: p.text.replace("15 countries", "20 countries") })) });
      expect((await ask()).cached).toBe(false);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(spy.mock.calls[2][3].messages)).toContain("20 countries");
      expect(JSON.stringify(spy.mock.calls[2][3].messages)).not.toContain("15 countries");
    } finally {
      spy.mockRestore();
    }
  });

  it("includes recent English speech even without translated captions or a usable current slide", async () => {
    const { room, ask } = await stage();
    room.meta!.slide = 99; // e.g. slide text was not extracted
    room.lines = [{ ...line(1, 15), out: {} }];
    const spy = vi.spyOn(client, "tf");
    try {
      expect(await ask()).toMatchObject({ covered: false, answer: "", cite: "" });
      expect(JSON.stringify(spy.mock.calls[0][3].messages)).toContain("[said at 0:10] We operate in 15 countries.");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
