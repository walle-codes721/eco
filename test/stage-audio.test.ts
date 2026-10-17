import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain browser module
import { stageAudio } from "../public/js/stage-audio.js";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const line = (seq: number, extra = {}) => ({ seq, text: `Phrase ${seq}`, lang: "en", speaker: 2, wait: true, enabled: true, ...extra });
function player() {
  const finish: (() => void)[] = [];
  const play = vi.fn((_text: string, _lang: string, _url?: string | null, _speaker?: number) => new Promise<void>((resolve) => finish.push(resolve)));
  const stop = vi.fn();
  return { queue: stageAudio({ play, stop }), play, stop, finish };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe("Stage audio decisions", () => {
  it("plays all eight timely clones during a caption burst without idle-player eviction", async () => {
    const play = vi.fn(async () => {});
    const queue = stageAudio({ play, stop: vi.fn() });
    for (let seq = 1; seq <= 8; seq++) {
      queue.line(line(seq));
      setTimeout(() => queue.audio(seq, { en: `/clip-${seq}.wav` }), 3500);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(play.mock.calls).toEqual(Array.from({ length: 8 }, (_, i) => [`Phrase ${i + 1}`, "en", `/clip-${i + 1}.wav`, 2]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps only ready backlog while protecting an earlier outstanding clone deadline", async () => {
    const { queue, play, finish } = player();
    queue.line(line(1));
    for (let seq = 2; seq <= 6; seq++) queue.line(line(seq, { url: `/clip-${seq}.wav` }));
    await vi.advanceTimersByTimeAsync(3500);
    expect(play).not.toHaveBeenCalled();
    queue.audio(1, { en: "/clip-1.wav" });
    await flush();
    expect(play.mock.calls[0][0]).toBe("Phrase 1");
    finish[0]();
    await flush();
    expect(play.mock.calls[1][0]).toBe("Phrase 4"); // only older ready entries 2 and 3 were discarded
  });

  it("keeps the 4-second deadlines independent when an older phrase falls back", async () => {
    const { queue, play, finish } = player();
    queue.line(line(1));
    await vi.advanceTimersByTimeAsync(1000);
    queue.line(line(2));
    await vi.advanceTimersByTimeAsync(2999);
    expect(play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(play).toHaveBeenCalledWith("Phrase 1", "en", null, 2);
    await vi.advanceTimersByTimeAsync(200);
    queue.audio(2, { en: "/second.wav" }); // 3.2 s after B: formerly lost when A's timer fired
    finish[0]();
    await flush();
    expect(play.mock.calls[1]).toEqual(["Phrase 2", "en", "/second.wav", 2]);
    queue.audio(1, { en: "/late-first.wav" });
    queue.audio(2, { en: "/duplicate.wav" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("plays out-of-order clone arrivals in caption order without interrupting active audio", async () => {
    const { queue, play, finish, stop } = player();
    queue.line(line(1));
    queue.line(line(2));
    queue.audio(2, { en: "/second.wav" });
    await flush();
    expect(play).not.toHaveBeenCalled();
    queue.audio(1, { en: "/first.wav" });
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][2]).toBe("/first.wav");
    finish[0]();
    await flush();
    expect(play.mock.calls[1][2]).toBe("/second.wav");
    expect(stop).not.toHaveBeenCalled();
  });

  it("ignores duplicate captions, other languages, and clips after a delayed deadline callback", async () => {
    const { queue, play } = player();
    queue.line(line(1));
    queue.line(line(1));
    queue.audio(1, { it: "/italian.wav" });
    await flush();
    expect(play).not.toHaveBeenCalled();
    vi.setSystemTime(4500); // background tab: deadline elapsed before the timer got CPU
    queue.audio(1, { en: "/too-late.wav" });
    await flush();
    expect(play).toHaveBeenCalledExactlyOnceWith("Phrase 1", "en", null, 2);
    await vi.runAllTimersAsync();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("does not replay captions received while muted or after reconnect history", async () => {
    const { queue, play } = player();
    queue.line(line(1, { enabled: false }));
    queue.audio(1, { en: "/muted.wav" });
    queue.line(line(1));
    queue.clear(20);
    queue.line(line(19));
    await vi.runAllTimersAsync();
    expect(play).not.toHaveBeenCalled();
  });

  it("clears timers on language/mute/reset transitions and isolates old completion callbacks", async () => {
    const { queue, play, finish, stop } = player();
    queue.line(line(1, { wait: false }));
    queue.line(line(2));
    await flush();
    queue.clear(0); // reset allows a new talk to start at sequence 1
    queue.line(line(1, { lang: "it", text: "Ciao", url: "/new.wav" }));
    await flush();
    finish[0](); // old playback completion must not release the new active item
    queue.line(line(2, { lang: "it", text: "Dopo", wait: false }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(play).toHaveBeenCalledTimes(2);
    finish[1]();
    await flush();
    expect(play.mock.calls[2]).toEqual(["Dopo", "it", undefined, 2]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("uses embedded audio immediately and bounds waiting backlog without cutting active speech", async () => {
    const { queue, play, finish, stop } = player();
    queue.line(line(1, { url: "/first.wav" }));
    await flush();
    for (let seq = 2; seq <= 6; seq++) queue.line(line(seq));
    await vi.advanceTimersByTimeAsync(4000);
    expect(play).toHaveBeenCalledTimes(1);
    finish[0]();
    await flush();
    expect(play.mock.calls[1][0]).toBe("Phrase 4"); // newest three waiting phrases; 2/3 intentionally dropped
    queue.audio(2, { en: "/stale.wav" });
    expect(stop).not.toHaveBeenCalled();
  });
});
