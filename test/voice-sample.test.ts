import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import { SAMPLE_TEXT, sampleKey, sampleObjectKey } from "../src/voice";
import * as voices from "../src/voice";

const id = "stage/test/voice-sample";
const wav = () => new ArrayBuffer(25_000);

async function stageRoom() {
  const r2 = new Map<string, { body: ArrayBuffer; contentType: string }>();
  const files = {
    get: async (key: string) => {
      const hit = r2.get(key);
      if (!hit) return null;
      return { arrayBuffer: async () => hit.body, httpMetadata: { contentType: hit.contentType } };
    },
    put: async (key: string, body: ArrayBuffer, meta?: { httpMetadata?: { contentType?: string } }) => {
      r2.set(key, { body, contentType: meta?.httpMetadata?.contentType ?? "application/octet-stream" });
    },
    delete: async (key: string) => { r2.delete(key); },
    head: async (key: string) => (r2.has(key) ? {} : null),
  };
  let ready: Promise<unknown>;
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      get: async () => new Map(),
      put: async () => {},
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    getWebSockets: () => [{ deserializeAttachment: () => ({ lang: "en" }), send: () => {} }],
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", FILES: files } as unknown as Env);
  await ready!;
  await room.init(id, { langs: ["en"], voiceMode: "sample" });
  const voice = (body: ArrayBuffer, headers: Record<string, string>) =>
    room.fetch(new Request("https://room/voice", {
      method: "PUT",
      headers: { "x-room": id, "x-key": room.meta!.hostKey, ...headers },
      body,
    }));
  return { room, r2, voice, tasks };
}

describe("voice sample intake at the room boundary", () => {
  it("shows about thirty words of script to the speaker", async () => {
    const words = SAMPLE_TEXT.trim().split(/\s+/);
    expect(words.length).toBeGreaterThanOrEqual(28);
    expect(words.length).toBeLessThanOrEqual(32);
  });

  it("accepts recorded WAV and uploaded MP3 when consent is ticked", async () => {
    const { room, r2, voice } = await stageRoom();
    expect((await voice(wav(), { "content-type": "audio/wav", "x-consent": "yes" })).status).toBe(200);
    expect(r2.has(sampleObjectKey(sampleKey(room.meta!, "s0"), "wav"))).toBe(true);
    await room.fetch(new Request("https://room/voice", { method: "DELETE", headers: { "x-room": id, "x-key": room.meta!.hostKey } }));
    expect((await voice(wav(), { "content-type": "audio/mpeg", "x-consent": "yes" })).status).toBe(200);
    expect(r2.has(sampleObjectKey(sampleKey(room.meta!, "s0"), "mp3"))).toBe(true);
  });

  it("rejects wrong type, oversize and empty samples with clear errors", async () => {
    const { voice } = await stageRoom();
    const badType = await voice(wav(), { "content-type": "audio/webm", "x-consent": "yes" });
    expect(badType.status).toBe(415);
    expect((await badType.json() as { error: string }).error).toMatch(/MP3, OGG or WAV/i);
    const tiny = await voice(new ArrayBuffer(100), { "content-type": "audio/wav", "x-consent": "yes" });
    expect(tiny.status).toBe(413);
    expect((await tiny.json() as { error: string }).error).toMatch(/too short/i);
    const huge = await voice(new ArrayBuffer(4_000_000), { "content-type": "audio/wav", "x-consent": "yes" });
    expect(huge.status).toBe(413);
    expect((await huge.json() as { error: string }).error).toMatch(/too large/i);
  });

  it("rejects samples without consent", async () => {
    const { voice } = await stageRoom();
    const res = await voice(wav(), { "content-type": "audio/wav" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/consent/i);
  });

  it("stores MIME type and sends it when cloning", async () => {
    const { room, voice, tasks } = await stageRoom();
    await voice(wav(), { "content-type": "audio/ogg", "x-consent": "yes" });
    const spy = vi.spyOn(voices, "voiceFor").mockResolvedValue(new ArrayBuffer(8));
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "We operate in fifteen countries." }),
      }));
      await Promise.all(tasks);
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][4]).toBe("audio/ogg");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the recorded sample in mock mode", async () => {
    const { room, voice } = await stageRoom();
    const body = wav();
    await voice(body, { "content-type": "audio/wav", "x-consent": "yes" });
    const clip = await voices.voiceFor({ ECO_LIVE: "0" } as Env, body, "Hello", "en", "audio/wav");
    expect(clip).toBe(body);
  });

  it("uses the VOICE_URL Space when set and not live", async () => {
    const out = new ArrayBuffer(4);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(out));
    try {
      const clip = await voices.voiceFor({ ECO_LIVE: "0", VOICE_URL: "https://space.test" } as Env, wav(), "Hello", "en", "audio/mpeg");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe("https://space.test/tts");
      expect(clip!.byteLength).toBe(4);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lets the speaker delete the sample", async () => {
    const { room, r2, voice } = await stageRoom();
    await voice(wav(), { "content-type": "audio/wav", "x-consent": "yes" });
    expect(room.meta!.speakers![0].voice).toBe(true);
    const del = await room.fetch(new Request("https://room/voice", { method: "DELETE", headers: { "x-room": id, "x-key": room.meta!.hostKey } }));
    expect(del.status).toBe(200);
    expect(room.meta!.speakers![0].voice).toBe(false);
    expect(r2.size).toBe(0);
  });
});

