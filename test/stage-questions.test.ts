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

async function stage() {
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
    pages: Array.from({ length: 6 }, (_, i) => ({ tag: `slide ${i + 1}`, text: "Unrelated product background. ".repeat(40).slice(0, 1000) })),
  });
  return {
    room,
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
});
