// @ts-expect-error test-only Node built-in; the Worker tsconfig intentionally omits Node types
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

// Execute the actual page handlers with fake controls, avoiding DOM/network dependencies.
// Parsing only locates the handler; its startup/catch/finally logic is not copied into the test.
function pageHandler(page: string, bindings: Record<string, unknown>) {
  const source = ts.createSourceFile(page, readFileSync(`public/js/pages/${page}.js`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let handler = "";
  source.forEachChild((node) => {
    if (page === "presenter" && ts.isFunctionDeclaration(node) && node.name?.text === "toggleMic") handler = node.getText(source);
    if (page === "join" && ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.left.getText(source) === "micBtn.onclick") {
      handler = `const toggleMic = ${node.expression.right.getText(source)};`;
    }
  });
  if (!handler) throw new Error(`Missing ${page} microphone handler`);
  return new Function(...Object.keys(bindings), `let stopMic = null; ${handler}; return toggleMic;`)(...Object.values(bindings)) as () => Promise<void>;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

describe.each(["presenter", "join"])("%s microphone startup", (page) => {
  it.each(["network", "audio-capture", "language-not-supported"])("recovers controls after %s and allows a successful retry", async (fault) => {
    const instances: FakeRecognition[] = [];
    let nextFailure: string | undefined = fault;
    class FakeRecognition {
      lang = "";
      onstart?: () => void;
      onerror?: (event: { error: string }) => void;
      onend?: () => void;
      onresult?: (event: unknown) => void;
      aborts = 0;
      constructor() { instances.push(this); }
      start() {
        queueMicrotask(() => {
          if (!nextFailure) return this.onstart?.();
          const lateStart = this.onstart;
          const error = this.onerror;
          error?.({ error: nextFailure });
          error?.({ error: nextFailure }); // duplicate browser event
          lateStart?.(); // queued start after failure must not resolve the session
        });
      }
      abort() { this.aborts++; this.onerror?.({ error: "aborted" }); this.onend?.(); }
      stop() { this.onend?.(); }
    }
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    vi.stubGlobal("navigator", { language: "en-US" });
    // @ts-expect-error plain browser module
    const { phraseMic, micErrorMessage } = await import("../public/js/mic.js");
    const micBtn = { disabled: false, classList: { add: vi.fn(), remove: vi.fn() } };
    const spokenLang = { disabled: false, value: "it" };
    const toast = vi.fn();
    const send = vi.fn();
    const toggle = pageHandler(page, {
      micBtn, spokenLang, toast, send, phraseMic, micErrorMessage,
      meta: { status: "live" }, demo: false, hasSpeechRecognition: true,
      level: { style: { width: "0" } }, micState: { textContent: "Off" },
      live: { send: vi.fn() }, keepAwake: vi.fn(), speakingSignal: (_send: unknown, onLevel: unknown) => onLevel,
    });
    const pending = toggle();
    expect(micBtn.disabled).toBe(true);
    expect(spokenLang.disabled).toBe(true);
    await pending;
    expect(micBtn.disabled).toBe(false);
    expect(spokenLang.disabled).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(micErrorMessage({ code: fault }));
    expect(toast.mock.calls[0][0]).toMatch(/retry/i);
    expect(instances[0].aborts).toBe(1);
    expect(instances[0].onresult).toBeNull();
    expect(send).not.toHaveBeenCalled();

    nextFailure = undefined;
    await toggle();
    expect(micBtn.disabled).toBe(false);
    expect(spokenLang.disabled).toBe(true);
    expect(instances[1].lang).toBe("it-IT");
    instances[1].onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Ciao." } }] });
    expect(send).toHaveBeenCalledWith("Ciao.", expect.any(Number));
    await toggle();
    expect(spokenLang.disabled).toBe(false);
    expect(instances).toHaveLength(2); // stop didn't restart recognition

    await toggle();
    instances[2].onerror?.({ error: fault }); // a terminal failure after startup also releases controls
    expect(spokenLang.disabled).toBe(false);
    expect(micBtn.disabled).toBe(false);
    expect(instances[2].aborts).toBe(1);
    expect(toast).toHaveBeenCalledTimes(2);
    await toggle();
    expect(spokenLang.disabled).toBe(true);
    await toggle();
    expect(spokenLang.disabled).toBe(false);
  });
});
