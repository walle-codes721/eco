import { afterEach, describe, expect, it, vi } from "vitest";

async function browser() {
  const clips: FakeAudio[] = [];
  class FakeAudio {
    src = "";
    currentTime = 0;
    ended = false;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onplaying: (() => void) | null = null;
    play = vi.fn(async () => {});
    pause = vi.fn();
    removeAttribute = vi.fn(() => { this.src = ""; });
    load = vi.fn(() => { this.currentTime = 0; this.ended = false; });
    constructor() { clips.push(this); }
  }
  class Utterance {
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }
  const synth = { getVoices: () => [], speak: vi.fn(), cancel: vi.fn() };
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  // @ts-expect-error browser module
  const { voice } = await import("../public/js/speak.js");
  voice.unlock();
  synth.speak.mockClear();
  return { voice, clip: clips[0], synth };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe("Stage playback completion", () => {
  it("bounds a stalled clip startup, falls back once and ignores late clip callbacks", async () => {
    vi.useFakeTimers();
    const { voice, clip, synth } = await browser();
    clip.play.mockImplementationOnce(() => new Promise<void>(() => {}));
    const done = vi.fn();
    const playing = voice.playStage("One", "en", "/one.wav").then(done);
    const lateEnded = clip.onended!, latePlaying = clip.onplaying!, lateError = clip.onerror!;
    await vi.advanceTimersByTimeAsync(9999);
    expect(synth.speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    latePlaying(); lateEnded(); lateError();
    expect(done).not.toHaveBeenCalled();
    const utterance = synth.speak.mock.calls[0][0];
    utterance.onstart();
    utterance.onend();
    await playing;
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers when both clone startup and phone startup stall and plays a later caption", async () => {
    vi.useFakeTimers();
    const { voice, clip, synth } = await browser();
    // @ts-expect-error browser module
    const { stageAudio } = await import("../public/js/stage-audio.js");
    const queue = stageAudio({ play: (...args: unknown[]) => voice.playStage(...args), stop: () => voice.stopStage() });
    queue.line({ seq: 1, text: "One", lang: "en", enabled: true, url: "/one.wav" });
    queue.line({ seq: 2, text: "Two", lang: "en", enabled: true, url: "/two.wav" });
    await vi.advanceTimersByTimeAsync(20000);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(clip.src).toBe("/two.wav");
    clip.onplaying!(); clip.onended!();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers after 15 seconds without media progress, without replaying partial audio", async () => {
    vi.useFakeTimers();
    const { voice, clip, synth } = await browser();
    // @ts-expect-error browser module
    const { stageAudio } = await import("../public/js/stage-audio.js");
    const queue = stageAudio({ play: (...args: unknown[]) => voice.playStage(...args), stop: () => voice.stopStage() });
    queue.line({ seq: 1, text: "One", lang: "en", enabled: true, url: "/one.wav" });
    queue.line({ seq: 2, text: "Two", lang: "en", enabled: true, url: "/two.wav" });
    await vi.advanceTimersByTimeAsync(0);
    clip.onplaying!();
    const lateEnded = clip.onended!;
    await vi.advanceTimersByTimeAsync(14999);
    expect(clip.src).toBe("/one.wav");
    await vi.advanceTimersByTimeAsync(1);
    expect(clip.src).toBe("/two.wav");
    lateEnded(); // must not cancel or finish phrase 2
    expect(clip.src).toBe("/two.wav");
    expect(synth.speak).not.toHaveBeenCalled();
    clip.onplaying!(); clip.onended!();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a long progressing clip run without a fixed duration cutoff", async () => {
    vi.useFakeTimers();
    const { voice, clip } = await browser();
    const done = vi.fn();
    const playing = voice.playStage("A long phrase", "en", "/long.wav").then(done);
    clip.onplaying!();
    for (let second = 1; second <= 180; second++) {
      clip.currentTime = second;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(done).not.toHaveBeenCalled();
    clip.onended!();
    await playing;
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recognizes media progress without a playing event and ignores repeated playing signals when stalled", async () => {
    vi.useFakeTimers();
    const { voice, clip, synth } = await browser();
    const done = vi.fn();
    const playing = voice.playStage("One", "en", "/one.wav").then(done);
    clip.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1000); // progress cancels the startup watchdog even without onplaying
    for (let i = 0; i < 2; i++) {
      clip.onplaying!();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(synth.speak).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    clip.onplaying!();
    await vi.advanceTimersByTimeAsync(5000);
    await playing;
    expect(done).toHaveBeenCalledTimes(1);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues the queue after started phone speech stops reporting progress", async () => {
    vi.useFakeTimers();
    const { voice, clip, synth } = await browser();
    // @ts-expect-error browser module
    const { stageAudio } = await import("../public/js/stage-audio.js");
    const queue = stageAudio({ play: (...args: unknown[]) => voice.playStage(...args), stop: () => voice.stopStage() });
    queue.line({ seq: 1, text: "One", lang: "en", enabled: true, wait: false });
    queue.line({ seq: 2, text: "Two", lang: "en", enabled: true, url: "/two.wav" });
    await vi.advanceTimersByTimeAsync(0);
    synth.speak.mock.calls[0][0].onstart();
    await vi.advanceTimersByTimeAsync(31000); // 3 code points / 3 per second + 30 seconds slack
    expect(clip.src).toBe("/two.wav");
    expect(synth.speak).toHaveBeenCalledTimes(1); // never repeat the partial phone utterance
    clip.onplaying!(); clip.onended!();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a text-sized phone playback allowance when no boundary events are available", async () => {
    vi.useFakeTimers();
    const { voice, synth } = await browser();
    const done = vi.fn();
    const playing = voice.playStage("a".repeat(600), "en", null).then(done);
    synth.speak.mock.calls[0][0].onstart();
    await vi.advanceTimersByTimeAsync(180000);
    expect(done).not.toHaveBeenCalled(); // a legitimate three-minute utterance isn't cut at 15 seconds
    await vi.advanceTimersByTimeAsync(50000); // 600 / 3 seconds + 30 seconds slack
    await playing;
    expect(done).toHaveBeenCalledTimes(1);
    expect(synth.cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("extends phone playback only for advancing boundaries and cleans up on cancellation", async () => {
    vi.useFakeTimers();
    const { voice, synth } = await browser();
    const done = vi.fn();
    const playing = voice.playStage("a".repeat(60), "en", null).then(done); // 50-second allowance
    const utterance = synth.speak.mock.calls[0][0];
    utterance.onstart();
    const boundary = utterance.onboundary;
    await vi.advanceTimersByTimeAsync(40000);
    boundary({ charIndex: 20 });
    await vi.advanceTimersByTimeAsync(40000);
    expect(done).not.toHaveBeenCalled();
    boundary({ charIndex: 20 }); // duplicate progress cannot postpone recovery indefinitely
    await vi.advanceTimersByTimeAsync(10000);
    await playing;
    expect(done).toHaveBeenCalledTimes(1);
    boundary({ charIndex: 40 });
    voice.stopStage(); voice.stopStage();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes two ready clones and following phone speech through the real scheduler", async () => {
    const { voice, clip, synth } = await browser();
    // @ts-expect-error browser module
    const { stageAudio } = await import("../public/js/stage-audio.js");
    const queue = stageAudio({ play: (...args: unknown[]) => voice.playStage(...args), stop: () => voice.stopStage() });
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    for (const seq of [1, 2, 3]) queue.line({ seq, text: `Phrase ${seq}`, lang: "en", speaker: 0, enabled: true, wait: false, url: seq < 3 ? `/${seq}.wav` : null });
    await flush();
    expect(clip.src).toBe("/1.wav");
    expect(synth.speak).not.toHaveBeenCalled();
    clip.onplaying!();
    clip.onended!();
    await flush();
    expect(clip.src).toBe("/2.wav");
    expect(synth.speak).not.toHaveBeenCalled();
    clip.onplaying!();
    clip.onended!();
    await flush();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.speak.mock.calls[0][0].text).toBe("Phrase 3");
    synth.speak.mock.calls[0][0].onend();
    await flush();
    expect(clip.play).toHaveBeenCalledTimes(3); // initial unlock + two clips
  });

  it("waits for audio ended, not just play() acceptance", async () => {
    const { voice, clip } = await browser();
    const done = vi.fn();
    const playing = voice.playStage("One", "en", "/one.wav").then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    clip.onplaying!();
    expect(done).not.toHaveBeenCalled();
    clip.onended!();
    await playing;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("retries a clip that fails before playing once, and plays it", async () => {
    const { voice, clip, synth } = await browser();
    clip.play.mockClear();
    clip.play.mockRejectedValueOnce(new Error("download failed"));
    const playing = voice.playStage("One", "en", "/one.wav");
    await Promise.resolve();
    await Promise.resolve();
    expect(clip.play).toHaveBeenCalledTimes(2);
    expect(clip.src).toBe("/one.wav");
    clip.onplaying!();
    clip.onended!();
    await playing;
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("falls back once if a clip fails twice before playing, including duplicate failure signals", async () => {
    const { voice, clip, synth } = await browser();
    clip.play.mockRejectedValueOnce(new Error("download failed")).mockRejectedValueOnce(new Error("download failed"));
    const playing = voice.playStage("One", "en", "/one.wav", 2);
    clip.onerror!();
    clip.onerror!();
    await Promise.resolve();
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.speak.mock.calls[0][0]).toMatchObject({ text: "One", lang: "en-US", rate: 1.04 });
    synth.speak.mock.calls[0][0].onend();
    await playing;
  });

  it("does not repeat a partially played clip as phone speech", async () => {
    const { voice, clip, synth } = await browser();
    const playing = voice.playStage("One", "en", "/one.wav");
    clip.onplaying!();
    clip.onerror!();
    await playing;
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it("settles cancelled playback and ignores a late rejected play promise", async () => {
    const { voice, clip, synth } = await browser();
    let reject!: (error: Error) => void;
    clip.play.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    const playing = voice.playStage("One", "en", "/one.wav");
    voice.off();
    await playing;
    reject(new Error("cancelled"));
    await Promise.resolve();
    expect(synth.speak).not.toHaveBeenCalled();
    expect(clip.onended).toBeNull();
    expect(clip.pause).toHaveBeenCalled();
  });

  it("settles phone speech on end/error so the scheduler can continue", async () => {
    const { voice, synth } = await browser();
    const playing = voice.playStage("Ciao", "it", null);
    expect(synth.speak.mock.calls[0][0].lang).toBe("it-IT");
    synth.speak.mock.calls[0][0].onerror();
    await playing;
  });

  it("unlocks by playing a real (silent) sound in the tap, which iOS needs before later clips", async () => {
    const { clip } = await browser();
    expect(clip.src).toMatch(/^blob:/);
    expect(clip.play).toHaveBeenCalledTimes(1);
  });

  it("plays preset clips from a language-and-voice audio key", async () => {
    vi.useFakeTimers();
    const { voice, clip } = await browser();
    // @ts-expect-error browser module
    const { stageAudio } = await import("../public/js/stage-audio.js");
    const queue = stageAudio({ play: (...args: unknown[]) => voice.playStage(...args), stop: () => voice.stopStage() });
    const key = "es@morgan-freeman";
    queue.line({ seq: 1, text: "Hola", lang: "es", audioKey: key, enabled: true, wait: true });
    queue.audio(1, { [key]: "/preset-es.wav" });
    await vi.advanceTimersByTimeAsync(0);
    expect(clip.src).toBe("/preset-es.wav");
    vi.useRealTimers();
  });

  it("falls back to phone speech when a preset clip never arrives", async () => {
    vi.useFakeTimers();
    const { voice, clip, synth } = await browser();
    // @ts-expect-error browser module
    const { stageAudio } = await import("../public/js/stage-audio.js");
    const queue = stageAudio({ play: (...args: unknown[]) => voice.playStage(...args), stop: () => voice.stopStage() });
    queue.line({ seq: 1, text: "Hola", lang: "es", audioKey: "es@morgan-freeman", enabled: true, wait: true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(clip.src).toMatch(/^blob:/); // only the unlock's silence was ever loaded
    expect(synth.speak).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
