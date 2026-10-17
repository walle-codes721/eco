import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain browser module
import { stageAudio } from "../public/js/stage-audio.js";

// Execute the real listener recap and WebSocket callback, not a copy of their
// lifecycle decisions. DOM rendering and existing recap reads are offline fakes.
function listener(playback: unknown) {
  const source = ts.createSourceFile("listener.js", readFileSync("public/js/pages/listener.js", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let recap = "", messages = "";
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "recap") recap = node.getText(source);
    if (ts.isCallExpression(node) && node.expression.getText(source) === "connect") messages = node.arguments[2].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!recap || !messages) throw new Error("Missing listener lifecycle handlers");
  const api = vi.fn(async () => ({ lines: [], summary: null }));
  const bindings = {
    playback, api, id: "stage/test/end", lines: [], meta: { title: "Talk", status: "live" },
    drawPolls: vi.fn(), drawSummary: vi.fn(), drawQs: vi.fn(), drawStatus: vi.fn(), drawCaps: vi.fn(), snapToLive: vi.fn(),
    normalizeVoice: () => {}, drawVoiceSel: () => {}, voiceChoice: "speaker", store: () => null, live: { send: vi.fn() },
    voiceSel: { replaceChildren: vi.fn() },
    // Helpers the listener's handlers now call for slides and polls (added on main); offline stand-ins.
    drawSlide: vi.fn(), loadSlides: vi.fn(), todo: (p: { open?: boolean }) => !!p.open, unseen: new Set<string>(),
    h: () => ({}), icon: () => ({}), T: (key: string) => key, main: { replaceChildren: vi.fn() },
    summaryText: () => "", summaryBox: {}, myQs: [], qList: {}, textOf: () => "", fmtTime: () => "",
    onAudio: (m: { seq: number; audio: Record<string, string> }) => (playback as { audio: (seq: number, audio: Record<string, string>) => void }).audio(m.seq, m.audio),
  };
  const handlers = new Function(...Object.keys(bindings), `let summary = null, polls = []; ${recap}; return { onMessage: ${messages}, getPolls: () => polls };`)(...Object.values(bindings));
  return { ...handlers, api, drawPolls: bindings.drawPolls };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("listener normal presentation completion", () => {
  it("keeps the final clone deadline and accepts its audio after the ended status", async () => {
    const play = vi.fn(async () => {}), stop = vi.fn();
    const queue = stageAudio({ play, stop });
    const { onMessage } = listener(queue);
    queue.line({ seq: 1, text: "Thank you", lang: "en", speaker: 0, enabled: true, wait: true });
    await vi.advanceTimersByTimeAsync(1000);
    await onMessage({ type: "status", status: "ended" });
    await vi.advanceTimersByTimeAsync(2500);
    onMessage({ type: "audio", seq: 1, audio: { en: "/final.wav" } });
    await flush();
    expect(play).toHaveBeenCalledExactlyOnceWith("Thank you", "en", "/final.wav", 0);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still falls back at four seconds after completion if the final clone never arrives", async () => {
    const play = vi.fn(async () => {}), stop = vi.fn();
    const queue = stageAudio({ play, stop });
    const { onMessage } = listener(queue);
    queue.line({ seq: 1, text: "Thank you", lang: "en", speaker: 0, enabled: true, wait: true });
    await onMessage({ type: "status", status: "ended" });
    await vi.advanceTimersByTimeAsync(3999);
    expect(play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(play).toHaveBeenCalledExactlyOnceWith("Thank you", "en", null, 0);
    onMessage({ type: "audio", seq: 1, audio: { en: "/late.wav" } });
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("lets active final audio finish but keeps explicit reset cancellation immediate", async () => {
    let finish!: () => void;
    const play = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), stop = vi.fn();
    const queue = stageAudio({ play, stop });
    const { onMessage } = listener(queue);
    queue.line({ seq: 1, text: "Thank you", lang: "en", speaker: 0, enabled: true, url: "/final.wav" });
    await flush();
    await onMessage({ type: "status", status: "ended" });
    expect(stop).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    queue.line({ seq: 2, text: "Pending", lang: "en", speaker: 0, enabled: true, wait: true });
    await onMessage({ type: "reset" });
    expect(stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(play).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe("listener polling and audio integration", () => {
  it("initializes polls on hello while cancelling stale audio and suppressing snapshot replay", async () => {
    const play = vi.fn(async () => {}), stop = vi.fn();
    const queue = stageAudio({ play, stop });
    const { onMessage, getPolls, drawPolls } = listener(queue);
    queue.line({ seq: 1, text: "Stale", lang: "en", enabled: true, wait: true });
    const poll = { id: "p1", open: true };
    onMessage({ type: "hello", meta: { status: "live" }, lines: [{ seq: 8 }], polls: [poll] });
    expect(getPolls()).toEqual([poll]);
    expect(drawPolls).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    queue.line({ seq: 8, text: "Snapshot", lang: "en", enabled: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(play).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    onMessage({ type: "hello", meta: {}, lines: [] });
    expect(getPolls()).toEqual([]);
  });

  it("updates and closes polls without interrupting pending or active audio", async () => {
    let finish!: () => void;
    const play = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), stop = vi.fn();
    const queue = stageAudio({ play, stop });
    const { onMessage, getPolls, drawPolls } = listener(queue);
    queue.line({ seq: 1, text: "Final phrase", lang: "en", speaker: 0, enabled: true, wait: true });
    onMessage({ type: "poll", poll: { id: "p1", open: true } });
    onMessage({ type: "tally", pid: "p1", tally: { n: 1 } });
    expect(getPolls()[0].tally).toEqual({ n: 1 });
    await vi.advanceTimersByTimeAsync(3500);
    onMessage({ type: "audio", seq: 1, audio: { en: "/final.wav" } });
    await flush();
    onMessage({ type: "pollclose", pid: "p1", poll: { id: "p1", open: false, tally: { n: 1 } } });
    expect(getPolls()[0].open).toBe(false);
    onMessage({ type: "pollclose", pid: "p1", poll: null });
    expect(getPolls()).toEqual([]);
    expect(drawPolls).toHaveBeenCalledTimes(4);
    expect(stop).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(play).toHaveBeenCalledExactlyOnceWith("Final phrase", "en", "/final.wav", 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
