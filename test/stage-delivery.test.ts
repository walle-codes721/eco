import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
} }));
import { Room } from "../src/room";
import * as voices from "../src/voice";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function roomFixture() {
  let ready!: Promise<unknown>;
  const tasks: Promise<unknown>[] = [];
  const messages: { type: string; seq?: number; audio?: Record<string, string> }[] = [];
  const saved = new Map<string, unknown>();
  const put = vi.fn(async (_key: string, _data: ArrayBuffer) => {});
  const get = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(100) }));
  const ctx = {
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    storage: { get: async () => new Map(), put: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) saved.set(key, structuredClone(value));
    } },
    waitUntil: (promise: Promise<unknown>) => tasks.push(promise),
    getWebSockets: (tag: string) => tag === "listener" ? ["en", "it"].map((lang) => ({
      deserializeAttachment: () => ({ lang }),
      send: (data: string) => { if (lang === "en") messages.push(JSON.parse(data)); },
    })) : [],
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", VOICE_URL: "https://unused.invalid", FILES: { get, put } } as unknown as Env);
  await ready;
  await room.init("stage/test/delivery", { langs: ["en", "it"] });
  room.meta!.speakers = [{ id: "s0", name: "Host", voice: true, key: "" }];
  const submit = (timing = false) => room.fetch(new Request("https://room/utterance", {
    method: "POST", headers: { "content-type": "application/json", "x-room": room.meta!.id, "x-key": room.meta!.hostKey,
      ...(timing ? { "x-eco-timing": "1" } : {}) },
    body: JSON.stringify({ text: "We operate in 15 countries." }),
  }));
  return { room, messages, tasks, saved, put, get, submit };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("per-language cloned audio delivery", () => {
  it("publishes a ready uploaded clip before the other language finishes, then persists both", async () => {
    const { room, messages, tasks, submit, put, saved } = await roomFixture();
    const english = deferred<ArrayBuffer | null>(), italian = deferred<ArrayBuffer | null>(), uploaded = deferred<void>();
    put.mockImplementationOnce(() => uploaded.promise);
    const generate = vi.spyOn(voices, "voiceFor").mockImplementation((_env, _sample, _text, lang) => lang === "en" ? english.promise : italian.promise);
    const response = await submit();
    expect(response.status).toBe(200);
    expect(messages.map((m) => m.type)).toContain("line");
    expect(messages.filter((m) => m.type === "audio")).toEqual([]);
    english.resolve(new ArrayBuffer(10));
    await flush();
    expect(messages.filter((m) => m.type === "audio")).toEqual([]); // URL isn't playable until R2 upload completes
    uploaded.resolve();
    await flush();
    expect(messages.filter((m) => m.type === "audio")).toEqual([{ type: "audio", seq: 1, audio: { en: expect.any(String) } }]);
    expect(room.lines[0].audio?.en).toBeTruthy(); // reconnect snapshot can already use it
    italian.resolve(new ArrayBuffer(10));
    await Promise.all(tasks);
    expect(messages.filter((m) => m.type === "audio")).toEqual([
      { type: "audio", seq: 1, audio: { en: expect.any(String) } },
      { type: "audio", seq: 1, audio: { it: expect.any(String) } },
    ]);
    expect(saved.get("lines")).toEqual([expect.objectContaining({ audio: { en: expect.any(String), it: expect.any(String) } })]);
    expect(generate).toHaveBeenCalledTimes(2); // same one call per listener language
    expect(put).toHaveBeenCalledTimes(2);
  });

  it.each(["generation", "upload"])("keeps the successful clip when the other language fails at %s", async (failure) => {
    const { messages, tasks, submit, put, saved } = await roomFixture();
    vi.spyOn(voices, "voiceFor").mockImplementation(async (_env, _sample, _text, lang) => {
      if (lang === "it" && failure === "generation") throw new Error("offline simulated failure");
      return new ArrayBuffer(10);
    });
    put.mockImplementation(async (key) => { if (key.endsWith("-it.wav")) throw new Error("upload failed"); });
    await submit();
    await Promise.all(tasks);
    expect(messages.filter((m) => m.type === "audio")).toEqual([{ type: "audio", seq: 1, audio: { en: expect.any(String) } }]);
    expect(saved.get("lines")).toEqual([expect.objectContaining({ audio: { en: expect.any(String) } })]);
  });

  it("suppresses stale generated clips after lines have been reset", async () => {
    const { room, messages, tasks, submit } = await roomFixture();
    const clip = deferred<ArrayBuffer | null>();
    vi.spyOn(voices, "voiceFor").mockReturnValue(clip.promise);
    await submit();
    room.lines = [];
    clip.resolve(new ArrayBuffer(10));
    await Promise.all(tasks);
    expect(messages.filter((m) => m.type === "audio")).toEqual([]);
  });

  it("preserves phone mode and the two-inflight-clone limit", async () => {
    const { room, tasks, submit } = await roomFixture();
    const clip = deferred<ArrayBuffer | null>();
    const generate = vi.spyOn(voices, "voiceFor").mockReturnValue(clip.promise);
    room.meta!.voiceMode = "phone";
    await submit();
    expect(generate).not.toHaveBeenCalled();
    room.meta!.voiceMode = "sample";
    await submit();
    await submit();
    await submit();
    expect(generate).toHaveBeenCalledTimes(2); // at most two clips in flight; extra pairs wait for phone voice
    clip.resolve(null);
    await Promise.all(tasks);
    await submit();
    await Promise.all(tasks);
    expect(generate.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("exposes timings only when requested and never stores diagnostics in source evidence", async () => {
    const { room, submit } = await roomFixture();
    room.meta!.voiceMode = "phone";
    const normal = await submit();
    expect(normal.headers.get("server-timing")).toBeNull();
    const timed = await submit(true);
    expect(timed.headers.get("server-timing")).toMatch(/budget;dur=0, ai;dur=0, retry;dur=0, accounting;dur=0, processing;dur=\d+, server;dur=\d+/);
    const result = await timed.json() as { line: Record<string, unknown> };
    expect(result.line).not.toHaveProperty("timing");
    expect(timed.headers.get("server-timing")).not.toContain("15 countries");
  });
});
