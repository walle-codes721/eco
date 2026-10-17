import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import { presetAudioKey } from "../src/preset-voice";
import * as presets from "../src/preset-voice";
import * as voices from "../src/voice";
import * as client from "../src/tf";

const id = "stage/test/preset-room";

async function presetRoom(presetsEnabled = true, speakerClone = false) {
  const r2 = new Map<string, { body: ArrayBuffer | string; contentType?: string }>();
  const files = {
    get: async (key: string) => {
      const hit = r2.get(key);
      if (!hit) return null;
      const body = hit.body;
      return {
        arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body).buffer : body),
        text: async () => (typeof body === "string" ? body : ""),
        httpMetadata: { contentType: hit.contentType },
      };
    },
    put: async (key: string, body: ArrayBuffer | string, meta?: { httpMetadata?: { contentType?: string } }) => {
      r2.set(key, { body, contentType: meta?.httpMetadata?.contentType });
    },
    delete: async (key: string) => { r2.delete(key); },
    head: async (key: string) => (r2.has(key) ? {} : null),
  };
  const messages: { type: string; audio?: Record<string, string> }[] = [];
  let ready: Promise<unknown>;
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    storage: { get: async () => new Map(), put: async () => {} },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    getWebSockets: (tag: string) => tag === "listener" ? [
      { deserializeAttachment: () => ({ lang: "en", voice: "morgan-freeman" }), send: (data: string) => messages.push(JSON.parse(data)) },
      ...(speakerClone ? [{ deserializeAttachment: () => ({ lang: "en", voice: "speaker" }), send: () => {} }] : []),
    ] : [],
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", FILES: files } as unknown as Env);
  await ready!;
  await room.init(id, { langs: ["en"], presetsEnabled, voiceMode: speakerClone ? "sample" : "phone" });
  await room.fetch(new Request("https://room/meta", { headers: { "x-room": id } }));
  return { room, messages, tasks, r2 };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("preset voice at the room boundary", () => {
  it("exposes presets only when the speaker enabled them", async () => {
    const on = await presetRoom(true);
    expect(on.room.publicMeta().presetsEnabled).toBe(true);
    expect(on.room.publicMeta().presets).toEqual([
      { id: "morgan-freeman", label: "Morgan Freeman (AI)" },
      { id: "jack-sparrow", label: "Jack Sparrow (AI)" },
      { id: "spongebob", label: "SpongeBob (AI)" },
    ]);
    const off = await presetRoom(false);
    expect(off.room.publicMeta().presets).toEqual([]);
  });

  it("generates preset audio in mock mode without a live transcript call", async () => {
    const tfSpy = vi.spyOn(client, "tf");
    vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
    const { room, messages, tasks } = await presetRoom(true);
    room.meta!.speakers![0].voice = false;
    const voiceSpy = vi.spyOn(voices, "voiceFor");
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello from the stage." }),
      }));
      await Promise.all(tasks);
      expect(tfSpy.mock.calls.some((c) => c[1] === "extract")).toBe(false);
      expect(voiceSpy).toHaveBeenCalled();
      const field = presetAudioKey("en", "morgan-freeman");
      expect(messages.some((m) => m.type === "audio" && m.audio?.[field])).toBe(true);
    } finally {
      voiceSpy.mockRestore();
    }
  });

  it("does not hold preset clips behind a slow speaker clone", async () => {
    vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
    const { room, messages, tasks } = await presetRoom(true, true);
    room.meta!.speakers![0].voice = true;
    (room as any).samples.set("s0", new ArrayBuffer(25_000));
    const spy = vi.spyOn(voices, "voiceFor").mockImplementation(async (_e, sample) =>
      sample.byteLength === 25_000 ? new Promise<ArrayBuffer>(() => {}) : new ArrayBuffer(8));
    await room.fetch(new Request("https://room/utterance", {
      method: "POST",
      headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello." }),
    }));
    await new Promise((r) => setTimeout(r, 50)); // speaker clip never resolves; do not await tasks
    expect(messages.some((m) => m.type === "audio" && m.audio?.[presetAudioKey("en", "morgan-freeman")])).toBe(true);
    expect(spy.mock.calls.some((c) => c[1].byteLength === 25_000)).toBe(true); // the slow speaker clone really started
    void tasks;
  });

  it("uses the reviewed bundled transcript live, with no extra MiMo call", async () => {
    vi.spyOn(client, "isLive").mockReturnValue(true);
    const tfSpy = vi.spyOn(client, "tf");
    vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
    const { room, tasks } = await presetRoom(true);
    room.meta!.speakers![0].voice = false;
    const voiceSpy = vi.spyOn(voices, "voiceFor").mockResolvedValue(new ArrayBuffer(8));
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello live." }),
      }));
      await Promise.all(tasks);
      expect(tfSpy.mock.calls.some((c) => c[1] === "extract")).toBe(false);
      expect(voiceSpy).toHaveBeenCalled();
      expect(voiceSpy.mock.calls[0]![5]).toBe(presets.PRESET_VOICES[0]!.referenceTranscript);
    } finally {
      voiceSpy.mockRestore();
    }
  });
});
