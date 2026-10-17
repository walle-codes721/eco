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
import { dropListNumber } from "../src/prompts";

// HACKATHON mode: the script is translated and voiced once (prep), then each line plays from what prep saved (cue).
const id = "stage/test/hackathon";
const LINES = ["Good afternoon, everyone.", "My name is Sebastian.", "Gold is booming right now."];
const host = { send: vi.fn(), close: vi.fn(), deserializeAttachment: () => ({ role: "host" }) };
type Files = Map<string, ArrayBuffer>;

async function prepRoom(clip: (text: string, lang: string) => ArrayBuffer | null = () => new ArrayBuffer(8), roomId = id, files: Files = new Map()) {
  let ready: Promise<unknown>;
  const voiceTag = { etag: "first-recording" }; // R2 etag of the speaker's sample: a new recording changes it
  let alarm: number | null = null;
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string | string[]) => (Array.isArray(k) ? new Map(k.filter((x) => store.has(x)).map((x) => [x, store.get(x)])) : store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => { for (const [a, b] of typeof k === "string" ? [[k, v] as const] : Object.entries(k)) store.set(a, b); },
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => { alarm = t; },
      deleteAlarm: async () => { alarm = null; },
      deleteAll: async () => store.clear(),
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
    getWebSockets: (tag?: string) => (tag === "host" || tag === undefined ? [host] : []),
    waitUntil: () => {},
  };
  const file = (b: ArrayBuffer) => ({ body: new Uint8Array(b), arrayBuffer: async () => b });
  const room = new Room(ctx as unknown as DurableObjectState, { ECO_LIVE: "0", VOICE_URL: "https://space.test", FILES: {
    get: async (k: string) => (files.has(k) ? file(files.get(k)!) : k.includes("/voice/") ? file(new ArrayBuffer(100)) : null),
    put: async (k: string, v: ArrayBuffer) => { files.set(k, v); },
    delete: async (k: string | string[]) => { for (const x of [k].flat()) files.delete(x); },
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
    head: async (k: string) => (k.includes("/voice/") && k.endsWith(".wav") ? { ...voiceTag } : null),
  } } as unknown as Env);
  await ready!;
  await room.init(roomId, { langs: ["es", "it"], presetsEnabled: true, voice: "sample" });
  await room.fetch(new Request("https://room/meta", { headers: { "x-room": roomId } }));
  room.meta!.speakers![0]!.voice = true;
  for (const p of presets.PRESET_VOICES) vi.spyOn(p, "clip").mockReturnValue(new ArrayBuffer(30_000));
  const voice = vi.spyOn(voices, "voiceFor").mockImplementation(async (_env, _ref, text, lang) => clip(text, lang));
  const prep = (body: object) => room.fetch(new Request("https://room/prep", {
    method: "POST",
    headers: { "x-room": roomId, "x-key": room.meta!.hostKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  })).then((r) => r.json() as Promise<{ lines: number; translated: number; total: number; done: number; failed: number }>);
  /** A host request; `internal` adds the header only worker.ts sets. */
  const call = (action: string, body?: unknown, internal = false) => room.fetch(new Request(`https://room/${action}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-room": roomId, "x-key": room.meta!.hostKey, "content-type": "application/json", ...(internal ? { "x-internal": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  /** Runs the alarm until prep stops scheduling it. */
  const drain = async () => {
    for (let n = 0; alarm !== null && n < 50; n++) (alarm = null), await room.alarm();
    return room.prepStatus();
  };
  return { room, store, files, voice, prep, drain, call, voiceTag };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const V = 1 + presets.PRESET_VOICES.length; // speaker + every preset
describe("HACKATHON prep", () => {
  it("translates and voices every line × language × voice once, saving each clip", async () => {
    const { room, store, files, voice, prep, drain } = await prepRoom();
    const tf = vi.spyOn(client, "tf");
    expect((await prep({ lines: LINES })).total).toBe(3 * 3 * V); // lines × es,it,en × speaker,Morgan
    expect(await drain()).toEqual({ lines: 3, translated: 3, total: 3 * 3 * V, done: 3 * 3 * V, failed: 0 });
    expect([...files.keys()].filter((k) => k.includes("/audio/p-"))).toHaveLength(3 * 3 * V);
    expect(Object.keys(store.get("prepClips") as object)).toHaveLength(3 * 3 * V);
    // English is the script as written: voiced from the line itself, never translated.
    expect(voice.mock.calls.filter(([, , , lang]) => lang === "en").map(([, , text]) => text).sort()).toEqual(Array.from({ length: V }, () => LINES).flat().sort());
    expect(tf).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tf.mock.calls[0]![3])).not.toContain("English");
    // Preparing again (page reload, same script) redoes nothing.
    await prep({ lines: LINES });
    await drain();
    expect(voice).toHaveBeenCalledTimes(3 * 3 * V);
    expect(room.prepStatus().done).toBe(3 * 3 * V);
  });

  it("retries a failing clip, keeps the ones that worked, and retries again on request", async () => {
    let broken = true;
    const { voice, prep, drain } = await prepRoom((text, lang) => (broken && text === LINES[2] && lang === "it" ? null : new ArrayBuffer(8)));
    await prep({ lines: LINES });
    expect(await drain()).toMatchObject({ total: 3 * 3 * V, done: 3 * 3 * V - V, failed: V }); // speaker + Morgan for that line in Italian
    const tries = voice.mock.calls.filter(([, , text, lang]) => text === LINES[2] && lang === "it").length;
    expect(tries).toBe(V * 3);
    broken = false;
    await prep({ retry: true });
    expect(await drain()).toMatchObject({ done: 3 * 3 * V, failed: 0 });
    expect(voice).toHaveBeenCalledTimes(3 * 3 * V - V + V * 3 + V); // the sixteen good clips were never redone
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
    expect(Object.keys(line.audio!).sort()).toEqual(["en", "es", "it"].flatMap((l) => [l, ...presets.PRESET_VOICES.map((p) => `${l}@${p.id}`)]).sort());
    for (const url of Object.values(line.audio!)) expect(url).toMatch(/[?&]v=\d+$/); // a remade clip gets a new URL, never a cached old one
    expect(room.meta!.status).toBe("live");
    expect(tf).not.toHaveBeenCalled();
    expect(voice).not.toHaveBeenCalled();
    // Only the host can cue.
    await room.webSocketMessage({ send: vi.fn(), deserializeAttachment: () => ({ role: "listener" }) } as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[2] }));
    expect(room.lines.at(-1)!.src).toBe(LINES[1]);
  });
});

describe("fixing a prepared talk without redoing it", () => {
  const audioKey = (url: string) => new URL(url, "https://x").searchParams.get("k")!;
  const lastAudio = (room: Room) => room.lines.at(-1)!.audio!;
  /** What Token Factory answered before the fix: every line numbered as the prompt numbered them. */
  const numbered = (langs: string[], texts: string[]) =>
    ({ data: { out: Object.fromEntries(langs.map((g) => [g, texts.map((t, i) => `${i + 1}. ${t} (${g})`)])) }, live: true, ms: 1 });

  it("drops a list number the model copied, but keeps one the script line starts with", async () => {
    expect(dropListNumber("Gold is booming.", "10. L'oro è in crescita.")).toBe("L'oro è in crescita.");
    expect(dropListNumber("One: open a link.", "Uno: apri un link.")).toBe("Uno: apri un link.");
    expect(dropListNumber("3. Gold, silver, copper.", "3. Oro, argento, rame.")).toBe("3. Oro, argento, rame.");
    const { room, prep, drain, voice } = await prepRoom();
    vi.spyOn(client, "tf").mockImplementation((async (_e: Env, _k: string, _m: string, req: { messages: { content: string }[] }) =>
      numbered(["es", "it"], JSON.parse(req.messages[1]!.content))) as never);
    await prep({ lines: LINES });
    await drain();
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[1] }));
    expect(room.lines.at(-1)!.out).toEqual({ es: `${LINES[1]} (es)`, it: `${LINES[1]} (it)` });
    expect(voice.mock.calls.filter(([, , text]) => /^\d/.test(text))).toEqual([]); // no clip says a number
  });

  it("repairs translations saved with numbers, with no call, and remakes only those clips", async () => {
    const { room, prep, drain, voice } = await prepRoom();
    await prep({ lines: LINES });
    await drain();
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[1] }));
    const before = lastAudio(room);
    // What a talk prepped before the fix has: "2. …" saved, and clips that say it.
    const h = Object.keys(room.prepTr).find((k) => room.prepTr[k]!.es === LINES[1])!;
    room.prepTr[h]!.es = `2. ${LINES[1]}`;
    const tf = vi.spyOn(client, "tf");
    voice.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000); // the fix runs later than the first prep
    await prep({ lines: LINES }); // the speaker page opens
    expect(room.prepTr[h]!.es).toBe(LINES[1]);
    expect(await drain()).toMatchObject({ done: 3 * 3 * V, failed: 0 });
    expect(tf).not.toHaveBeenCalled();
    expect(voice.mock.calls.map(([, , text, lang]) => `${lang} ${text}`)).toEqual(Array(V).fill(`es ${LINES[1]}`)); // speaker + every preset
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[1] }));
    const after = lastAudio(room);
    expect(after.es).not.toBe(before.es); // new version: a phone that cached the numbered clip fetches the new one
    expect(after["es@morgan-freeman"]).not.toBe(before["es@morgan-freeman"]);
    expect(after.it).toBe(before.it);
    expect(audioKey(after.es!)).toBe(audioKey(before.es!));
  });

  it("adds a language: translates and voices only that one, and stops at five", async () => {
    const { room, prep, drain, voice, call } = await prepRoom();
    await prep({ lines: LINES });
    await drain();
    const tf = vi.spyOn(client, "tf");
    voice.mockClear();
    const added = await call("langs", { add: "pl" });
    expect(await added.json()).toMatchObject({ langs: ["es", "it", "pl"], prep: { translated: 0, total: 3 * 4 * V } });
    expect(await drain()).toMatchObject({ translated: 3, done: 3 * 4 * V, failed: 0 });
    expect(tf).toHaveBeenCalledTimes(1);
    const system = JSON.stringify(tf.mock.calls[0]![3]);
    expect(system).toContain("Polish");
    expect(system).not.toContain("Spanish");
    expect(voice.mock.calls.map(([, , , lang]) => lang)).toEqual(Array(3 * V).fill("pl")); // 3 lines � every voice, nothing else redone
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[0] }));
    expect(Object.keys(lastAudio(room))).toEqual(expect.arrayContaining(["pl", "pl@morgan-freeman"]));
    expect((await call("langs", { add: "en" })).status).toBe(400);
    expect((await call("langs", { add: "pl" })).status).toBe(400);
    expect((await call("langs", { add: "de" })).status).toBe(200);
    expect((await call("langs", { add: "fr" })).status).toBe(200);
    expect((await call("langs", { add: "pt" })).status).toBe(409);
  });

  it("a new recording of the speaker's voice remakes only their clips", async () => {
    const { room, prep, drain, voice, voiceTag } = await prepRoom();
    await prep({ lines: LINES });
    await drain();
    voice.mockClear();
    await prep({ lines: LINES });
    await drain();
    expect(voice).not.toHaveBeenCalled(); // same recording: nothing to do
    voiceTag.etag = "second-recording";
    await prep({ lines: LINES });
    expect(await drain()).toMatchObject({ done: 3 * 3 * V });
    expect(voice).toHaveBeenCalledTimes(3 * 3); // 3 lines × es,it,en in the speaker's voice; Morgan's stay
    expect(voice.mock.calls.every(([, sample]) => (sample as ArrayBuffer).byteLength === 100)).toBe(true); // the speaker's sample
    expect(room.meta!.voiceTag).toBe("second-recording");
  });
});

describe("saved presentations", () => {
  const copyId = "stage/test/hackathon-2";
  const audioKey = (url: string) => new URL(url, "https://x").searchParams.get("k")!;

  it("a duplicate starts from the beginning with every prepared clip, and makes no call", async () => {
    const a = await prepRoom();
    await a.prep({ lines: LINES });
    await a.drain();
    const copy = await (await a.call("export")).json();
    const b = await prepRoom(undefined, copyId, a.files);
    expect((await b.call("import", copy)).status).toBe(403); // a browser can't point clips at other files
    expect((await b.call("import", copy, true)).status).toBe(200);
    expect(b.room.prepStatus()).toMatchObject({ translated: 3, total: 3 * 3 * V, done: 3 * 3 * V });
    const calls = b.voice.mock.calls.length;
    await b.prep({ lines: LINES }); // the speaker page sends the same script on load
    await b.drain();
    expect(b.voice.mock.calls.length).toBe(calls); // the duplicate made no clip of its own
    await b.room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[0] }));
    const line = b.room.lines.at(-1)!;
    expect(b.room.lines).toHaveLength(1);
    expect(Object.keys(line.audio!)).toHaveLength(3 * V);
    for (const url of Object.values(line.audio!)) expect((await b.call(`audio?k=${audioKey(url)}`)).status).toBe(200);
  });

  it("deleting keeps the clips a duplicate plays and removes everything else", async () => {
    const a = await prepRoom();
    await a.prep({ lines: LINES });
    await a.drain();
    const b = await prepRoom(undefined, copyId, a.files);
    await b.call("import", await (await a.call("export")).json(), true);
    a.files.set(`${id}/deck.pdf`, new ArrayBuffer(5));
    a.files.set(`${id}/audio/7-123-es.wav`, new ArrayBuffer(5)); // a live clip only the original had
    const { refs } = await (await b.call("cliprefs")).json() as { refs: string[] };
    expect((await a.call("destroy", { keep: refs })).status).toBe(403);
    expect((await a.call("destroy", { keep: refs }, true)).status).toBe(200);
    expect(a.room.meta).toBeNull();
    expect(a.store.size).toBe(0);
    expect(a.files.has(`${id}/deck.pdf`)).toBe(false);
    expect(a.files.has(`${id}/audio/7-123-es.wav`)).toBe(false);
    expect([...a.files.keys()].filter((k) => k.startsWith(`${id}/audio/p-`))).toHaveLength(3 * 3 * V);
    await b.room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "cue", text: LINES[1] }));
    for (const url of Object.values(b.room.lines.at(-1)!.audio!)) expect((await b.call(`audio?k=${audioKey(url)}`)).status).toBe(200);
    // Deleting the duplicate too, with nothing left to keep, removes the shared clips.
    expect((await b.call("destroy", { keep: [] }, true)).status).toBe(200);
    expect([...a.files.keys()].filter((k) => k.includes("/audio/p-"))).toHaveLength(0);
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
