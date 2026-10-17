import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { validReaction, tallyReactions, topLines, lineKey, type LineReactions } from "../src/reaction";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room, type Line } from "../src/room";

describe("reaction rules", () => {
  it("accepts the six reactions and null, nothing else", () => {
    expect(validReaction("👍")).toBe("👍");
    expect(validReaction("❤️")).toBe("❤️");
    expect(validReaction(null)).toBeNull();
    expect(validReaction("❤")).toBeUndefined(); // without U+FE0F
    expect(validReaction("💩")).toBeUndefined();
    expect(validReaction(undefined)).toBeUndefined();
  });

  it("tallies anonymously in talk order and ranks the top Lines", () => {
    const map: Record<string, LineReactions> = {
      [lineKey(2, 20)]: { seq: 2, t: 20, at: 2, slide: 1, by: { a: "😂", b: "😂", c: "👍" } },
      [lineKey(1, 10)]: { seq: 1, t: 10, at: 1, slide: 1, by: { a: "👎" } },
      [lineKey(3, 30)]: { seq: 3, t: 30, at: 3, slide: 2, by: {} },
    };
    const t = tallyReactions(map);
    expect(t.map((x) => x.seq)).toEqual([1, 2]);
    expect(t[1]).toMatchObject({ n: 3, counts: { "😂": 2, "👍": 1 } });
    expect(JSON.stringify(t)).not.toContain('"a"');
    expect(topLines(t, 1).map((x) => x.seq)).toEqual([2]);
  });
});

const line = (seq: number): Line => ({ seq, at: seq * 10, t: seq * 1000, slide: 1, speaker: "s0", ms: 0, live: false, flags: [], src: `Line ${seq}`, out: {} });

async function testRoom() {
  const saved = new Map<string, unknown>();
  const sent: Record<string, unknown[]> = { listener: [], screen: [], host: [] };
  let ready: Promise<unknown>;
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((k) => [k, saved.get(k)])),
      put: async (v: Record<string, unknown>) => { for (const [k, x] of Object.entries(v)) saved.set(k, x); },
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: (tag?: string) => (tag && sent[tag] ? [{ deserializeAttachment: () => ({ lang: "en" }), send: (m: string) => sent[tag].push(JSON.parse(m)) }] : []),
    waitUntil: () => {},
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready!;
  const id = "stage/test/reactions";
  await room.init(id, { langs: ["it"], pages: [] });
  room.lines = [line(1), line(2), line(3), line(4)];
  const call = (action: string, body?: unknown, host = false) => room.fetch(new Request(`https://room/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-room": id, "x-ip": "test", "content-type": "application/json", ...(host ? { "x-key": room.meta!.hostKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const react = (voter: string, seq: number, r: unknown) => call("react", { voter, seq, t: seq * 1000, r });
  return { room, saved, sent, call, react };
}

describe("Room reactions", () => {
  it("keeps one reaction per Listener per Line, which they can change or clear", async () => {
    const { room, saved, react } = await testRoom();
    expect((await react("a", 1, "👍")).status).toBe(200);
    expect((await react("a", 1, "😂")).status).toBe(200);
    expect((await react("b", 1, "😂")).status).toBe(200);
    expect(room.reactions[lineKey(1, 1000)].by).toEqual({ a: "😂", b: "😂" });
    expect(saved.get("reactions")).toBe(room.reactions);
    await react("a", 1, null);
    await react("b", 1, null);
    expect(room.reactions).toEqual({});
  });

  it("rejects unknown Lines and reactions", async () => {
    const { react, call } = await testRoom();
    expect((await react("a", 9, "👍")).status).toBe(404);
    expect((await call("react", { voter: "a", seq: 1, t: 999, r: "👍" })).status).toBe(404); // same seq, other loop
    expect((await react("a", 1, "💩")).status).toBe(400);
    expect((await react("", 1, "👍")).status).toBe(400);
  });

  it("tells only the Screen, anonymously, and only when a reaction is set", async () => {
    const { sent, react } = await testRoom();
    await react("a", 1, "🤯");
    await react("a", 1, null);
    expect(sent.screen).toEqual([{ type: "react", r: "🤯" }]);
    expect(sent.host).toEqual([]);
    expect(sent.listener).toEqual([]);
  });

  it("puts the series and the top 3 Lines on the Post-talk card", async () => {
    const { react, call } = await testRoom();
    for (const v of ["a", "b", "c"]) await react(v, 2, "❤️");
    for (const v of ["a", "b"]) await react(v, 3, "👍");
    await react("a", 1, "👎");
    await react("a", 4, "🤔");
    const card = await (await call("card", undefined, true)).json() as any;
    expect(card.reactions.total).toBe(7);
    expect(card.reactions.byKind).toEqual({ "❤️": 3, "👍": 2, "👎": 1, "🤔": 1 });
    expect(card.reactions.series.map((x: any) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(card.reactions.top.map((x: any) => [x.seq, x.text])).toEqual([[2, "Line 2"], [3, "Line 3"], [1, "Line 1"]]);
  });

  it("clears them when the Demo room's Replay loops", async () => {
    const { room, saved, react } = await testRoom();
    await react("a", 1, "👍");
    room.meta!.demo = true;
    (room as any).replayI = 1e9;
    await room.alarm();
    expect(room.reactions).toEqual({});
    expect(saved.get("reactions")).toEqual({});
  });
});
