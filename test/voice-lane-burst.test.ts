import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));

import { Room } from "../src/room";
import * as presets from "../src/preset-voice";
import * as voices from "../src/voice";
import * as client from "../src/tf";

const id = "stage/test/voice-lane-burst";

function listener(lang: string, voice: string) {
  return { deserializeAttachment: () => ({ lang, voice, role: "listener" }), send: () => {} };
}

async function burstRoom() {
  const tasks: Promise<unknown>[] = [];
  let ready: Promise<unknown>;
  const stats = { peak: 0, inflight: 0 };
  const ctx = {
    storage: { get: async () => new Map(), put: async () => {} },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    getWebSockets: (tag: string) => (tag === "listener" ? [
      listener("en", "speaker"),
      listener("es", "morgan-freeman"),
      listener("it", "speaker"),
    ] : []),
    waitUntil: (p: Promise<unknown>) => { tasks.push(p); },
  };
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", FILES: {
    get: async () => ({ arrayBuffer: async () => new ArrayBuffer(100) }),
    put: async () => {},
    delete: async () => {},
    head: async () => null,
  } } as unknown as Env);
  await ready!;
  await room.init(id, { langs: ["en", "es", "it"], presetsEnabled: true, voiceMode: "sample" });
  await room.fetch(new Request("https://room/meta", { headers: { "x-room": id } }));
  room.meta!.speakers = [{ id: "s0", name: "Host", voice: true, key: "" }];
  vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
  vi.spyOn(voices, "voiceFor").mockImplementation(async () => {
    stats.inflight++;
    stats.peak = Math.max(stats.peak, stats.inflight);
    await new Promise((r) => setTimeout(r, 5));
    stats.inflight--;
    return new ArrayBuffer(8);
  });
  const utter = vi.spyOn(client, "tf");
  return { room, tasks, stats, utter };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("voice lane under burst", () => {
  it("never runs more than two cloned clips at once across pairs", async () => {
    const { room, tasks, stats } = await burstRoom();
    for (let i = 0; i < 4; i++) {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: `Burst line number ${i}.` }),
      }));
    }
    await Promise.all(tasks);
    expect(stats.peak).toBeLessThanOrEqual(2);
  });

  it("still completes every utterance while voice clips contend", async () => {
    const { room, tasks, utter } = await burstRoom();
    for (let i = 0; i < 3; i++) {
      await room.fetch(new Request("https://room/utterance", {
        method: "POST",
        headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
        body: JSON.stringify({ text: `Phrase ${i} for translation.` }),
      }));
    }
    await Promise.all(tasks);
    expect(utter).toHaveBeenCalledTimes(3);
    expect(room.lines.length).toBe(3);
  });
});
