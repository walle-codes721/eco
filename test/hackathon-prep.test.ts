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
import { admit, ACCOUNT_RPM, PREP_IN_FLIGHT } from "../src/limits";

// HACKATHON mode: the script is translated and voiced once (prep), then each line plays from what prep saved (cue).
const id = "stage/test/hackathon";
const LINES = ["Good afternoon, everyone.", "My name is Sebastian.", "Gold is booming right now."];
const host = { send: vi.fn(), deserializeAttachment: () => ({ role: "host" }) };

async function prepRoom(clip: (text: string, lang: string) => ArrayBuffer | null = () => new ArrayBuffer(8)) {
  let ready: Promise<unknown>;
  let alarm: number | null = null;
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => store.has(x)).map((x) => [x, store.get(x)])) : store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => { for (const [a, b] of typeof k === "string" ? [[k, v] as const] : Object.entries(k)) store.set(a, b); },
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => { alarm = t; },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    getWebSockets: (tag: string) => (tag === "host" ? [host] : []),
    waitUntil: () => {},
  };
  const files = new Set<string>();
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", VOICE_URL: "https://space.test", FILES: {
    get: async () => ({ arrayBuffer: async () => new ArrayBuffer(100) }),
    put: async (k: string) => { files.add(k); },
    delete: async () => {},
    head: async () => null,
  } } as unknown as Env);
  await ready!;
  await room.init(id, { langs: ["es", "it"], presetsEnabled: true, voice: "sample" });
  await room.fetch(new Request("https://room/meta", { headers: { "x-room": id } }));
  room.meta!.speakers![0]!.voice = true;
  vi.spyOn(presets.PRESET_VOICES[0]!, "clip").mockReturnValue(new ArrayBuffer(30_000));
  const voice = vi.spyOn(voices, "voiceFor").mockImplementation(async (_env, _ref, text, lang) => clip(text, lang));
  const prep = (body: object) => room.fetch(new Request("https://room/prep", {
    method: "POST",
    headers: { "x-room": id, "x-key": room.meta!.hostKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  })).then((r) => r.json() as Promise<{ lines: number; translated: number; total: number; done: number; failed: number }>);
  /** Runs the alarm until prep stops scheduling it. */
  const drain = async () => {
    for (let n = 0; alarm !== null && n < 50; n++) (alarm = null), await room.alarm();
    return room.prepStatus();
  };
  return { room, store, files, voice, prep, drain };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("HACKATHON prep", () => {
  it("translates and voices every line × language × voice once, saving each clip", async () => {
    const { room, store, files, voice, prep, drain } = await prepRoom();
    expect((await prep({ lines: LINES })).total).toBe(3 * 2 * 2); // lines × es,it × speaker,Morgan
    expect(await drain()).toEqual({ lines: 3, translated: 3, total: 12, done: 12, failed: 0 });
    expect(files.size).toBe(12);
    expect(Object.keys(store.get("prepClips") as object)).toHaveLength(12);
    // Preparing again (page reload, same script) redoes nothing.
    await prep({ lines: LINES });
    await drain();
    expect(voice).toHaveBeenCalledTimes(12);
    expect(room.prepStatus().done).toBe(12);
  });

  it("retries a failing clip, keeps the ones that worked, and retries again on request", async () => {
    let broken = true;
    const { voice, prep, drain } = await prepRoom((text, lang) => (broken && text === LINES[2] && lang === "it" ? null : new ArrayBuffer(8)));
    await prep({ lines: LINES });
    expect(await drain()).toMatchObject({ total: 12, done: 10, failed: 2 }); // speaker + Morgan for that line in Italian
    const tries = voice.mock.calls.filter(([, , text, lang]) => text === LINES[2] && lang === "it").length;
    expect(tries).toBe(2 * 3);
    broken = false;
    await prep({ retry: true });
    expect(await drain()).toMatchObject({ done: 12, failed: 0 });
    expect(voice).toHaveBeenCalledTimes(10 + 6 + 2); // the ten good clips were never redone
  });

  it("plays a cued line from prep: translations and every clip, no call", async () => {
    const { room, prep, drain } = await prepRoom();
    await prep({ lines: LINES });
    await drain();
    const tf = vi.spyOn(client, "tf");
    const voice = vi.mocked(voices.voiceFor);
    voice.mockClear();
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[1] }));
    const line = room.lines.at(-1)!;
    expect(line).toMatchObject({ src: LINES[1], cue: true, out: { es: LINES[1], it: LINES[1] }, flags: [] });
    expect(Object.keys(line.audio!).sort()).toEqual(["es", "es@morgan-freeman", "it", "it@morgan-freeman"]);
    expect(room.meta!.status).toBe("live");
    expect(tf).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
    // Only the host can cue.
    await room.webSocketMessage({ send: vi.fn(), deserializeAttachment: () => ({ role: "listener" }) } as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[2] }));
    expect(room.lines.at(-1)!.src).toBe(LINES[1]);
  });
});

describe("prep without a voice model", () => {
  it("makes no clips (mock would only echo the reference), so cued lines fall to the phone voice", async () => {
    const { room, prep, drain, voice } = await prepRoom();
    delete (room as unknown as { env: Env }).env.VOICE_URL;
    expect((await prep({ lines: LINES })).total).toBe(0);
    expect(await drain()).toMatchObject({ translated: 3, total: 0, done: 0 });
    expect(voice).not.toHaveBeenCalled();
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[0] }));
    expect(room.lines.at(-1)).toMatchObject({ cue: true, audio: {} });
  });
});

describe("prep admission", () => {
  const base = { today: 0, max: 0, window: 0, inflight: 0, tripped: false, pubHour: 0, pubMax: 30 };
  it("has no cap of its own: only Token Factory's 20/min per account and 8 in flight per key", () => {
    expect(admit({ ...base, voiceWindow: 15 }, "prep", false)).toBeNull();
    expect(admit({ ...base, window: 8, voiceWindow: ACCOUNT_RPM - 8 }, "prep", false)).toBe("rpm");
    expect(admit({ ...base, voiceInflight: PREP_IN_FLIGHT }, "prep", false)).toBe("busy");
    expect(admit({ ...base, tripped: true }, "prep", false)).toBe("tripped");
  });
});
