import { describe, it, expect } from "vitest";
import { chunkPages, selectContext, bm25, normalize, bestSentence } from "../src/retrieve";
import { admit } from "../src/limits";
import { parseJson } from "../src/tf";
import { DEMO_SLIDES, DEMO_SHOP } from "../src/fixtures/demo";
// @ts-expect-error plain browser module, tested in Node
import { Cutter, encodeWav, resample } from "../public/js/vad.js";
// @ts-expect-error plain browser module, tested in Node
import { nearBottom, nextNewCount } from "../public/js/caps.js";

const deck = chunkPages(DEMO_SLIDES);
const shop = chunkPages(DEMO_SHOP.sources);

describe("retrieval", () => {
  it("ranks the slide that answers the question first", () => {
    expect(selectContext(deck, "What is ROCm?").best?.tag).toBe("slide 5");
    expect(selectContext(deck, "who pays for this?").best?.tag).toBe("slide 8");
    expect(selectContext(shop, "Is the pistachio gluten-free?").best?.tag).toBe("menu");
    expect(selectContext(shop, "Do you take Apple Pay?").best?.tag).toBe("payment");
  });
  it("keeps context within the token budget and still sends something for a Hindi question", () => {
    const { picked, best } = selectContext(deck, "यह कैसे काम करता है?", 300);
    expect(best).toBeNull();
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(300 * 4 + 10);
  });
  it("scores zero when nothing matches", () => {
    expect(bm25(deck, "zzzz qqqq").every((s) => s === 0)).toBe(true);
  });
  it("normalizes questions for the cache", () => {
    expect(normalize("What is ROCm??")).toBe(normalize("what  is rocm"));
  });
  it("mock answers quote a matching sentence or say not covered", () => {
    const menu = shop.find((c) => c.tag === "menu")!;
    expect(bestSentence("pistachio gluten", menu)).toMatchObject({ covered: true, cite: "menu" });
    expect(bestSentence("parking", menu).covered).toBe(false);
  });
});

describe("budget admission", () => {
  const base = { today: 0, max: 50, window: 0, inflight: 0, tripped: false, pubHour: 0, pubMax: 30 };
  it("admits under every limit", () => expect(admit(base, "utterance", false)).toBeNull());
  it("enforces the daily ceiling", () => expect(admit({ ...base, today: 50 }, "utterance", false)).toBe("ceiling"));
  it("enforces 12 rpm and keeps the last 2 slots for translation", () => {
    expect(admit({ ...base, window: 10 }, "ask", false)).toBe("rpm");
    expect(admit({ ...base, window: 10 }, "utterance", false)).toBeNull();
    expect(admit({ ...base, window: 12 }, "utterance", false)).toBe("rpm");
  });
  it("caps concurrency at 3", () => expect(admit({ ...base, inflight: 3 }, "turn", false)).toBe("busy"));
  it("stops after a trip", () => expect(admit({ ...base, tripped: true }, "utterance", false)).toBe("tripped"));
  it("caps the public demo per hour", () => {
    expect(admit({ ...base, pubHour: 30 }, "ask", true)).toBe("public-hourly");
    expect(admit({ ...base, pubHour: 30 }, "ask", false)).toBeNull();
  });
});

describe("model output parsing", () => {
  it("accepts fenced JSON", () => expect(parseJson('```json\n{"covered":true}\n```')).toEqual({ covered: true }));
  it("accepts JSON with chatter around it", () => expect(parseJson('Sure! {"a":1} ok')).toEqual({ a: 1 }));
});

describe("phrase cutter", () => {
  const rate = 16000;
  const tone = (ms: number, amp = 0.2) => Float32Array.from({ length: (rate * ms) / 1000 }, (_, i) => amp * Math.sin(i / 5));
  const quiet = (ms: number) => new Float32Array((rate * ms) / 1000);
  const feed = (c: any, ...parts: Float32Array[]) => {
    const out: Float32Array[] = [];
    for (const p of parts) for (let i = 0; i < p.length; i += 2048) {
      const r = c.push(p.subarray(i, i + 2048));
      if (r.phrase) out.push(r.phrase);
    }
    return out;
  };
  it("cuts at a 600 ms pause once 5 s are buffered", () => {
    const phrases = feed(new Cutter(), quiet(500), tone(5500), quiet(800));
    expect(phrases).toHaveLength(1);
    expect(phrases[0].length / rate).toBeGreaterThan(5);
    expect(phrases[0].length / rate).toBeLessThan(6.5);
  });
  it("merges short phrases instead of cutting before 5 s", () => {
    expect(feed(new Cutter(), tone(2000), quiet(700), tone(1000), quiet(300))).toHaveLength(0);
  });
  it("forces a cut at 12 s", () => {
    const phrases = feed(new Cutter(), tone(13000));
    expect(phrases).toHaveLength(1);
    expect(Math.round(phrases[0].length / rate)).toBe(12);
  });
  it("skips leading silence and flushes leftovers", () => {
    const c = new Cutter();
    feed(c, quiet(3000), tone(1500));
    const rest = c.flush();
    expect(rest.length / rate).toBeCloseTo(1.5, 0);
  });
  it("encodes 16-bit mono WAV and resamples 48k → 16k", async () => {
    const wav = encodeWav(new Float32Array(16000));
    expect(wav.size).toBe(44 + 32000);
    expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
  });
});

describe("caption scroll position", () => {
  const view = (scrollTop: number, scrollHeight: number, clientHeight: number) => ({ scrollTop, scrollHeight, clientHeight });
  it("is at the bottom when within the threshold", () => {
    expect(nearBottom(view(960, 2000, 1000))).toBe(true);
  });
  it("is not at the bottom when scrolled well up", () => {
    expect(nearBottom(view(400, 2000, 1000))).toBe(false);
  });
  it("counts as at the bottom exactly at the threshold", () => {
    expect(nearBottom(view(952, 2000, 1000))).toBe(true);
    expect(nearBottom(view(951, 2000, 1000))).toBe(false);
  });
  it("counts a view with nothing to scroll as at the bottom", () => {
    expect(nearBottom(view(0, 800, 1000))).toBe(true);
  });
});

describe("new-lines pill counter", () => {
  it("counts a line that arrives while reading history", () => {
    expect(nextNewCount(0, false)).toBe(1);
    expect(nextNewCount(3, false)).toBe(4);
  });
  it("resets when a line arrives while following live", () => {
    expect(nextNewCount(7, true)).toBe(0);
  });
  it("resets when the listener taps back to live", () => {
    expect(nextNewCount(4, true)).toBe(0);
  });
});
