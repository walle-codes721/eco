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

const id = "stage/test/voice-choice";

function listenerWs(lang: string, voice: string) {
  return {
    deserializeAttachment: () => ({ lang, voice, role: "listener" }),
    send: () => {},
  };
}

async function roomWithListeners(listeners: { lang: string; voice: string }[]) {
  const tasks: Promise<unknown>[] = [];
  const put = vi.fn(async () => {});
  let ready: Promise<unknown>;
  const ctx = {
    storage: { get: async () => new Map(), put: async () => {} },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    getWebSockets: (tag: string) => (tag === "listener" ? listeners.map((x) => listenerWs(x.lang, x.voice)) : []),
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
  };
  const room = new Room(ctx as unknown as DurableObjectState, {
    ECO_LIVE: "0", VOICE_URL: "https://unused.invalid",
    FILES: { get: async () => ({ arrayBuffer: async () => new ArrayBuffer(100) }), put, delete: async () => {}, head: async () => null },
  } as unknown as Env);
  await ready!;
  await room.init(id, { langs: ["en", "es"], presetsEnabled: true, voiceMode: "sample" });
  await room.fetch(new Request("https://room/meta", { headers: { "x-room": id } }));
  room.meta!.speakers = [{ id: "s0", name: "Host", voice: true, key: "" }];
  return { room, tasks, put };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("voice choice at the room boundary", () => {
  it("skips speaker cloning when every listener chose phone", async () => {
    const { room, tasks, put } = await roomWithListeners([{ lang: "en", voice: "phone" }]);
    const voiceSpy = vi.spyOn(voices, "voiceFor");
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello everyone." }),
      }));
      await Promise.all(tasks);
      expect(put).not.toHaveBeenCalled();
      expect(voiceSpy).not.toHaveBeenCalled();
    } finally {
      voiceSpy.mockRestore();
    }
  });

  it("clones Spanish preset audio only for a Morgan Freeman listener", async () => {
    vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
    const { room, tasks, put } = await roomWithListeners([{ lang: "es", voice: "morgan-freeman" }]);
    const voiceSpy = vi.spyOn(voices, "voiceFor").mockResolvedValue(new ArrayBuffer(8));
    try {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "We operate in fifteen countries." }),
      }));
      await Promise.all(tasks);
      expect(voiceSpy).toHaveBeenCalledTimes(1);
      expect(voiceSpy.mock.calls[0][3]).toBe("es");
      expect(put).toHaveBeenCalledWith(expect.stringContaining("-es-morgan-freeman"), expect.any(ArrayBuffer), { httpMetadata: { contentType: "audio/wav" } });
      const field = presetAudioKey("es", "morgan-freeman");
      expect(room.lines[0].audio?.[field]).toBeTruthy();
    } finally {
      voiceSpy.mockRestore();
    }
  });
});
