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

async function presetRoom(presetsEnabled = true) {
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
    getWebSockets: (tag: string) => tag === "listener" ? [{
      deserializeAttachment: () => ({ lang: "en" }),
      send: (data: string) => messages.push(JSON.parse(data)),
    }] : [],
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", FILES: files } as unknown as Env);
  await ready!;
  await room.init(id, { langs: ["en"], presetsEnabled, voiceMode: "phone" });
  await room.fetch(new Request("https://room/meta", { headers: { "x-room": id } }));
  return { room, messages, tasks, r2 };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("preset voice at the room boundary", () => {
  it("exposes presets only when the speaker enabled them", async () => {
    const on = await presetRoom(true);
    expect(on.room.publicMeta().presetsEnabled).toBe(true);
    expect(on.room.publicMeta().presets).toEqual([{ id: "morgan-freeman", label: "Morgan Freeman (AI)" }]);
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

  it("dedupes simultaneous transcript fetches into one MiMo call", async () => {
    vi.spyOn(client, "isLive").mockReturnValue(true);
    vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
    let resolves!: (v: { data: { transcript: string }; live: boolean; ms: number }) => void;
    const pending = new Promise<{ data: { transcript: string }; live: boolean; ms: number }>((r) => { resolves = r; });
    const tfSpy = vi.spyOn(client, "tf").mockReturnValue(pending as never);
    const env = { ECO_LIVE: "1", RADEON_API_KEY: "k", FILES: { get: async () => null, put: async () => {} } } as unknown as Env;
    const first = presets.ensurePresetTranscript(env, env.FILES, "morgan-freeman");
    const second = presets.ensurePresetTranscript(env, env.FILES, "morgan-freeman");
    resolves({ data: { transcript: "Stored once." }, live: true, ms: 1 });
    expect(await first).toBe("Stored once.");
    expect(await second).toBe("Stored once.");
    expect(tfSpy).toHaveBeenCalledTimes(1);
  });

  it("skips preset cloning until a transcript exists in live mode", async () => {
    vi.spyOn(client, "isLive").mockReturnValue(true);
    vi.spyOn(presets, "ensurePresetTranscript").mockResolvedValue(null);
    const { room, messages, tasks } = await presetRoom(true);
    const voiceSpy = vi.spyOn(voices, "voiceFor");
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "No preset yet." }),
      }));
      await Promise.all(tasks);
      expect(voiceSpy).not.toHaveBeenCalled();
      expect(messages.filter((m) => m.type === "audio")).toEqual([]);
    } finally {
      voiceSpy.mockRestore();
    }
  });
});
