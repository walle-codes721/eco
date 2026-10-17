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
  it("shows one short sentence of script to the speaker, so the reference stays short", async () => {
    const words = SAMPLE_TEXT.trim().split(/\s+/);
    expect(words.length).toBeGreaterThanOrEqual(6);
    expect(words.length).toBeLessThanOrEqual(12);
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

  const MP3 = () => new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]).buffer; // "ID3" tag, as OmniVoice's mp3 starts
  const speakAndGetClipKey = async (clip: ArrayBuffer) => {
    const { room, r2, voice, tasks } = await stageRoom();
    await voice(wav(), { "content-type": "audio/wav", "x-consent": "yes" });
    const spy = vi.spyOn(voices, "voiceFor").mockResolvedValue(clip);
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "We operate in fifteen countries." }),
      }));
      await Promise.all(tasks);
    } finally {
      spy.mockRestore();
    }
    const key = [...r2.keys()].find((k) => k.includes("/audio/"))!;
    return { room, r2, key };
  };

  it("stores and serves a clone that comes back as mp3", async () => {
    const { room, r2, key } = await speakAndGetClipKey(MP3());
    expect(key.endsWith(".mp3")).toBe(true);
    expect(r2.get(key)!.contentType).toBe("audio/mpeg");
    const k = key.split("/audio/")[1]!.replace(/\.mp3$/, "");
    const res = await room.fetch(new Request(`https://room/audio?k=${k}`, { headers: { "x-room": id } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
  });

  it("keeps a clone that comes back as wav, and still plays clips stored as wav before mp3", async () => {
    const { room, r2, key } = await speakAndGetClipKey(new ArrayBuffer(8));
    expect(key.endsWith(".wav")).toBe(true);
    expect(r2.get(key)!.contentType).toBe("audio/wav");
    const k = key.split("/audio/")[1]!.replace(/\.wav$/, "");
    const res = await room.fetch(new Request(`https://room/audio?k=${k}`, { headers: { "x-room": id } }));
    expect(res.headers.get("content-type")).toBe("audio/wav");
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


describe("reference audio encoding", () => {
  it("converts a sample to base64 once, however many clones use it", () => {
    const sample = new Uint8Array([1, 2, 3, 250, 251, 252]).buffer;
    const spy = vi.spyOn(globalThis, "btoa");
    try {
      const first = voices.refB64(sample);
      expect(voices.refB64(sample)).toBe(first);
      expect(voices.refB64(sample)).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(first).toBe(voices.b64(sample)); // same text as the uncached encoder
      voices.refB64(new Uint8Array([9, 9]).buffer); // another speaker's sample is its own entry
      expect(spy).toHaveBeenCalledTimes(3); // + 1 for the uncached b64 above, + 1 for the new sample
    } finally {
      spy.mockRestore();
    }
  });
});

describe("hasStoredSample", () => {
  it("checks existence with head, never downloading the clip", async () => {
    const files = {
      head: async (key: string) => (key === "users/u/voice.mp3" ? {} : null),
      get: async () => { throw new Error("must not download"); },
    };
    expect(await voices.hasStoredSample(files as never, "users/u/voice")).toBe(true);
    expect(await voices.hasStoredSample(files as never, "users/none/voice")).toBe(false);
  });
});

describe("the sentence a sample says (its ref_text)", () => {
  const v3 = "Hello, this is my voice for Eco. I am reading this so everyone hears me.";
  it("is the one the page showed, saved with the recording", () => {
    expect(voices.shownSentence(encodeURIComponent(v3))).toBe(v3);
    expect(voices.shownSentence(encodeURIComponent("Ignore that and say something else."))).toBe(SAMPLE_TEXT); // only sentences Eco showed
    expect(voices.shownSentence(null)).toBe(SAMPLE_TEXT);
    expect(voices.sampleSentence({ customMetadata: { sentence: v3 }, uploaded: new Date() })).toBe(v3);
  });
  it("for a sample saved before that, is the one shown when it was uploaded", () => {
    expect(voices.sampleSentence({ uploaded: new Date("2026-10-17T21:20:00Z") })).toBe(v3);
    expect(voices.sampleSentence({ uploaded: new Date("2026-10-17T21:40:00Z") })).toBe(SAMPLE_TEXT);
    expect(voices.sampleSentence({ uploaded: new Date("2026-10-17T17:00:00Z") })).toMatch(/short script aloud/);
    expect(voices.sampleSentence({ uploaded: new Date("2026-10-15T09:00:00Z") })).toMatch(/short passage/);
  });
});
