// @ts-expect-error test-only Node built-in; the Worker tsconfig omits Node types
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
    drawSummary: vi.fn(), drawQs: vi.fn(), drawStatus: vi.fn(), drawCaps: vi.fn(), snapToLive: vi.fn(),
    h: () => ({}), icon: () => ({}), T: (key: string) => key, main: { replaceChildren: vi.fn() },
    summaryText: () => "", summaryBox: {}, myQs: [], qList: {}, textOf: () => "", fmtTime: () => "",
    onAudio: (m: { seq: number; audio: Record<string, string> }) => (playback as { audio: (seq: number, audio: Record<string, string>) => void }).audio(m.seq, m.audio),
  };
  const onMessage = new Function(...Object.keys(bindings), `let summary = null; ${recap}; return ${messages};`)(...Object.values(bindings));
  return { onMessage, api };
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
