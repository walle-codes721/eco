import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { lineKey } from "../src/reaction";
import { timeline } from "../src/replay";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room, type Line } from "../src/room";

const line = (seq: number, slide = 1): Line => ({ seq, at: seq, t: seq * 1000, slide, speaker: "s0", ms: 0, live: false, flags: [], src: `Line ${seq}`, out: { it: `Riga ${seq}` } });
const types = (ev: { m: { type: string } }[]) => ev.map((e) => e.m.type);

describe("replay timeline", () => {
  it("merges every log in time order, questions without ids or answers", () => {
    const ev = timeline([line(1), line(3)], [{ t: 2500, lang: "it", text: "Perché?" }], [{ n: 2, t: 2000 }], [{ t: 1500, r: "👍" }], {});
    expect(types(ev)).toEqual(["line", "react", "slide", "question", "line"]);
    expect(ev[3].m).toEqual({ type: "question", q: { lang: "it", text: "Perché?" } });
  });

  it("falls back to where lines were said and to reactions at their line, for talks before the logs", () => {
    const ev = timeline([line(1), line(2, 2), line(3, 2), line(4, 1)], [], [], [], {
      [lineKey(2, 2000)]: { seq: 2, t: 2000, at: 2, slide: 2, by: { a: "😂", b: "❤️" } },
    });
    expect(ev.filter((e) => e.m.type === "slide").map((e) => [e.t, (e.m as { n: number }).n])).toEqual([[1999, 2], [3999, 1]]);
    expect(ev.filter((e) => e.m.type === "react").map((e) => e.t)).toEqual([2000, 2000]);
  });
});

async function testRoom() {
  const saved = new Map<string, unknown>();
  let ready: Promise<unknown>;
  const ctx = {
    storage: {
      get: async (keys: string[]) => new Map(keys.map((k) => [k, saved.get(k)])),
      put: async (v: Record<string, unknown>) => { for (const [k, x] of Object.entries(v)) saved.set(k, x); },
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
    getWebSockets: () => [],
    waitUntil: () => {},
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0" } as Env);
  await ready!;
  const id = "stage/test/replay";
  await room.init(id, { langs: ["it"], pages: [1, 2, 3].map((n) => ({ tag: `slide ${n}`, text: `Slide ${n} text` })) });
  room.lines = [line(1), line(2)];
  const call = (action: string, body?: unknown, host = false) => room.fetch(new Request(`https://room/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-room": id, "x-ip": "test", "content-type": "application/json", ...(host ? { "x-key": room.meta!.hostKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { room, saved, call };
}

describe("Room replay", () => {
  it("logs slides and reactions, and serves the timeline only once the talk has ended", async () => {
    const { room, saved, call } = await testRoom();
    await call("status", { status: "live" }, true);
    await call("slide", { n: 2 }, true);
    await call("react", { voter: "a", seq: 1, t: 1000, r: "👍" });
    await call("react", { voter: "a", seq: 1, t: 1000, r: null }); // a clear is not an event
    expect(room.slideLog.map((x) => x.n)).toEqual([2]);
    expect(room.reactLog.map((x) => x.r)).toEqual(["👍"]);
    expect(saved.get("slideLog")).toBe(room.slideLog);
    expect(saved.get("reactLog")).toBe(room.reactLog);

    expect((await call("timeline")).status).toBe(409);
    await call("status", { status: "ended" }, true);
    const res = await call("timeline");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(types(body.events)).toEqual(["line", "line", "slide", "react"]);
    expect(body.startedAt).toBe(room.meta!.startedAt);
    expect(body.meta.hostKey).toBeUndefined();
  });
});
