import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import * as client from "../src/tf";

const row = (text: string, kept = false) => ({ text, box: { x: 10, y: 100, w: 50, h: 12 }, kept });
const deckPages = [
  { n: 1, rows: [row("Hello"), row("To be or not to be", true), row("World")] },
  { n: 2, rows: [row("Second")] },
  { n: 3, rows: [row("Third")] },
];

/** A live-looking stage room with a stored PDF, no network: tf is replaced per test. */
async function slideRoom(langs: string[]) {
  const saved = new Map<string, unknown>();
  const background: Promise<unknown>[] = [];
  let ready: Promise<unknown>;
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((key) => [key, saved.get(key)])),
      put: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) saved.set(key, value); },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: () => [],
    waitUntil: (promise: Promise<unknown>) => { background.push(promise); },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "1", RADEON_API_KEY: "test" } as Env);
  await ready!;
  const id = "stage/test/slides";
  await room.init(id, { langs, pages: [1, 2, 3].map((n) => ({ tag: `slide ${n}`, text: `Slide ${n} text` })) });
  room.meta!.deck = true;
  const host = { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" };
  const post = (action: string, body: unknown) =>
    room.fetch(new Request(`https://room/${action}`, { method: "POST", headers: host, body: JSON.stringify(body) }));
  const listenerGet = (path: string) => room.fetch(new Request(`https://room/${path}`, { headers: { "x-room": id } }));
  const settle = async () => { await Promise.all(background.splice(0)); };
  return { room, post, listenerGet, settle };
}

const answer = (langs: string[], rows: number) => ({
  data: { out: Object.fromEntries(langs.map((l) => [l, Array.from({ length: rows }, (_, i) => `${l}-${i + 1}`)])) },
  live: true, ms: 1,
});

describe("slide translation in the room", () => {
  it("makes no call while the talk has not started, and translates the first slide and the next once it is live", async () => {
    const spy = vi.spyOn(client, "tf").mockImplementation((async (_e: Env, kind: string, _m: string, req: { messages: { content: string }[] }) => {
      expect(kind).toBe("slide");
      const rows = String(req.messages[1].content).split("\n").length;
      return answer(["it"], rows);
    }) as never);
    const t = await slideRoom(["it"]);
    await t.post("deckrows", { deckLang: "en", pages: deckPages });
    await t.settle();
    expect(spy).not.toHaveBeenCalled();

    await t.post("status", { status: "live" });
    await t.settle();
    expect(spy).toHaveBeenCalledTimes(2); // slide 1 and slide 2, not slide 3
    await t.post("status", { status: "ended" });
    await t.post("status", { status: "live" });
    await t.settle();
    expect(spy).toHaveBeenCalledTimes(2); // stored, so not asked again
    spy.mockRestore();
  });

  it("sends only the included rows of a slide and lets a listener read the result without a host key", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(client, "tf").mockImplementation((async (_e: Env, _k: string, _m: string, req: { messages: { content: string }[] }) => {
      seen.push(String(req.messages[1].content));
      return answer(["it"], String(req.messages[1].content).split("\n").length);
    }) as never);
    const t = await slideRoom(["it"]);
    await t.post("deckrows", { deckLang: "en", pages: deckPages });
    await t.post("status", { status: "live" });
    await t.settle();
    expect(seen[0]).not.toContain("To be or not to be");
    expect(seen[0]).toContain("Hello");

    const res = await t.listenerGet("slidetr?n=1&lang=it");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paints: { paint: string | null }[] };
    expect(body.paints.map((p) => p.paint)).toEqual(["it-1", null, "it-2"]); // the kept quotation stays as printed
    spy.mockRestore();
  });

  it("translates a deck that is not in English into English as well", async () => {
    const calls: string[] = [];
    const spy = vi.spyOn(client, "tf").mockImplementation((async (_e: Env, _k: string, _m: string, req: { messages: { content: string }[] }) => {
      calls.push(String(req.messages[0].content));
      return answer(["en", "es"], 1);
    }) as never);
    const t = await slideRoom(["it", "es"]);
    await t.post("deckrows", { deckLang: "it", pages: [{ n: 1, rows: [row("Ciao")] }] });
    await t.post("status", { status: "live" });
    await t.settle();
    expect(calls[0]).toMatch(/English/);
    expect(calls[0]).not.toMatch(/into Italian/);
    const en = (await (await t.listenerGet("slidetr?n=1&lang=en")).json()) as { paints: { paint: string | null }[] };
    expect(en.paints.map((p) => p.paint)).toEqual(["en-1"]);
    spy.mockRestore();
  });

  it("keeps the other languages when one language comes back unusable", async () => {
    const spy = vi.spyOn(client, "tf").mockImplementation((async () => ({
      data: { out: { it: ["Ciao"], es: [] } }, live: true, ms: 1,
    })) as never);
    const t = await slideRoom(["it", "es"]);
    await t.post("deckrows", { deckLang: "en", pages: [{ n: 1, rows: [row("Hello")] }] });
    await t.post("status", { status: "live" });
    await t.settle();
    const it = (await (await t.listenerGet("slidetr?n=1&lang=it")).json()) as { paints: { paint: string | null }[] };
    const es = (await (await t.listenerGet("slidetr?n=1&lang=es")).json()) as { paints: { paint: string | null }[] };
    expect(it.paints[0].paint).toBe("Ciao");
    expect(es.paints[0].paint).toBeNull();
    spy.mockRestore();
  });

  it("answers a slide number past the deck with no rows rather than an error", async () => {
    const t = await slideRoom(["it"]);
    await t.post("deckrows", { deckLang: "en", pages: deckPages });
    const res = await t.listenerGet("slidetr?n=99999&lang=it");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: unknown[] }).rows).toEqual([]);
  });
});
