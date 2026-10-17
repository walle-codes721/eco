import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));
vi.mock("../src/auth", () => ({ sessionSub: async () => "sub-seb", authRoute: async () => null }));

import worker from "../src/worker";
import { Room } from "../src/room";
import * as voices from "../src/voice";
import * as presets from "../src/preset-voice";

// Saved presentations through the real routes: duplicate starts the same talk again with every prepared clip; delete keeps
// the clips a duplicate still plays. Rooms are real Room objects; the account and R2 are in memory.
const LINES = ["Good afternoon, everyone.", "My name is Sebastian.", "Gold is booming right now."];

function world() {
  const files = new Map<string, ArrayBuffer>();
  const file = (b: ArrayBuffer) => ({ body: new Uint8Array(b), arrayBuffer: async () => b, httpMetadata: {} });
  const FILES = {
    get: async (k: string) => (files.has(k) ? file(files.get(k)!) : null),
    put: async (k: string, v: ArrayBuffer) => { files.set(k, v); },
    delete: async (k: string | string[]) => { for (const x of [k].flat()) files.delete(x); },
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
    head: async () => null,
  };
  const mine: { kind: "stage"; slug: string; title: string; created: number }[] = [];
  const account = {
    me: async () => ({ handle: "seb", name: "Seb", email: "", picture: "", rooms: mine.slice().reverse(), hackathon: true }),
    addRoom: async (kind: "stage", want: string, title: string) => {
      let slug = want;
      for (let i = 2; mine.some((r) => r.slug === slug); i++) slug = `${want}-${i}`;
      mine.push({ kind, slug, title, created: 2 });
      return slug;
    },
    dropRoom: async (_kind: string, slug: string) => void mine.splice(mine.findIndex((r) => r.slug === slug), 1),
  };
  const rooms = new Map<string, { room: Room; alarm: () => Promise<void> }>();
  const env = { ECO_LIVE: "0", VOICE_URL: "https://space.test", FILES } as unknown as Env & Record<string, unknown>;
  const open = (id: string) => {
    if (rooms.has(id)) return rooms.get(id)!;
    const store = new Map<string, unknown>();
    let alarm: number | null = null;
    let ready: Promise<unknown>;
    const room = new Room({
      storage: {
        get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => store.has(x)).map((x) => [x, store.get(x)])) : store.get(k)),
        put: async (k: string | Record<string, unknown>, v?: unknown) => { for (const [a, b] of typeof k === "string" ? [[k, v] as const] : Object.entries(k)) store.set(a, b); },
        getAlarm: async () => alarm,
        setAlarm: async (t: number) => { alarm = t; },
        deleteAlarm: async () => { alarm = null; },
        deleteAll: async () => store.clear(),
      },
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
      getWebSockets: () => [],
      waitUntil: () => {},
    } as unknown as DurableObjectState, env);
    const drain = async () => {
      await ready;
      for (let n = 0; alarm !== null && n < 50; n++) (alarm = null), await room.alarm();
    };
    rooms.set(id, { room, alarm: drain });
    return rooms.get(id)!;
  };
  Object.assign(env, {
    ROOM: { idFromName: (n: string) => n, get: (n: string) => open(n).room },
    ACCOUNT: { idFromName: (n: string) => n, get: () => account },
  });
  const api = (path: string, body?: unknown) => worker.fetch(new Request(`https://eco.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  return { files, mine, open, api };
}

describe("saved presentations (routes)", () => {
  it("duplicates a prepared presentation to start again, then deletes the original without breaking the copy", async () => {
    vi.spyOn(voices, "voiceFor").mockResolvedValue(new ArrayBuffer(8));
    vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
    const w = world();
    const made = await w.api("/api/rooms", { mode: "stage", slug: "gold", title: "Gold", langs: ["es", "it"], voice: "sample", presetsEnabled: true, script: LINES.join("\n") });
    expect(made.status).toBe(200);
    expect((await w.api("/api/rooms/stage/seb/gold/prep", { lines: LINES })).status).toBe(200);
    await w.open("stage/seb/gold").alarm();
    w.files.set("stage/seb/gold/deck.pdf", new ArrayBuffer(3)); // what PUT deck stores
    w.open("stage/seb/gold").room.meta!.deck = true;

    const dup = await w.api("/api/rooms/stage/seb/gold/duplicate", {});
    expect(await dup.json()).toEqual({ id: "stage/seb/gold-2" });
    expect(w.mine.map((r) => r.slug)).toEqual(["gold", "gold-2"]);
    const copy = w.open("stage/seb/gold-2").room;
    expect(copy.meta).toMatchObject({ title: "Gold", status: "lobby", slide: 1, deck: true, langs: ["es", "it"], presetsEnabled: true });
    expect(copy.script).toBe(LINES.join("\n"));
    expect(copy.lines).toEqual([]);
    expect(copy.prepStatus()).toMatchObject({ lines: 3, translated: 3, done: copy.prepStatus().total });
    expect(w.files.has("stage/seb/gold-2/deck.pdf")).toBe(true);

    expect((await w.api("/api/rooms/stage/seb/gold/delete", {})).status).toBe(200);
    expect(w.mine.map((r) => r.slug)).toEqual(["gold-2"]);
    expect(w.open("stage/seb/gold").room.meta).toBeNull();
    expect(w.files.has("stage/seb/gold/deck.pdf")).toBe(false);
    const k = Object.keys(copy.prepClips)[0]!;
    expect((await w.api(`/api/rooms/stage/seb/gold-2/audio?k=${k}`)).status).toBe(200); // the copy still plays the shared clip
  });

  it("only the owner can duplicate or delete, and a browser can't call the internal actions", async () => {
    const w = world();
    expect((await w.api("/api/rooms/stage/someone/gold/duplicate", {})).status).toBe(403);
    expect((await w.api("/api/rooms/stage/someone/gold/delete", {})).status).toBe(403);
    await w.api("/api/rooms", { mode: "stage", slug: "gold", title: "Gold", langs: ["es"], voice: "phone" });
    const sneaky = await worker.fetch(new Request("https://eco.test/api/rooms/stage/seb/gold/import", {
      method: "POST", headers: { "content-type": "application/json", "x-internal": "1" }, body: JSON.stringify({ prepClips: { "p-x": "stage/other/talk/voice/s0" } }),
    }), (w.open("stage/seb/gold").room as unknown as { env: Env }).env);
    expect(sneaky.status).toBe(403);
    expect(w.open("stage/seb/gold").room.prepClips).toEqual({});
  });
});
