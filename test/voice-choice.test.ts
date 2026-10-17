import { describe, expect, it } from "vitest";
import { audioField, cloneDemand, parseListenerVoice } from "../src/voice-choice";
import { presetAudioKey } from "../src/preset-voice";

describe("listener voice choice", () => {
  it("parses speaker, phone and known presets", () => {
    expect(parseListenerVoice(undefined)).toBe("speaker");
    expect(parseListenerVoice("phone")).toBe("phone");
    expect(parseListenerVoice("morgan-freeman")).toBe("morgan-freeman");
    expect(parseListenerVoice("unknown")).toBe("speaker");
  });

  it("maps choices to line.audio keys", () => {
    expect(audioField("es", "speaker")).toBe("es");
    expect(audioField("es", "phone")).toBeNull();
    expect(audioField("es", "morgan-freeman")).toBe(presetAudioKey("es", "morgan-freeman"));
  });

  it("requests clones only for language and voice pairs in the room", () => {
    const out = { en: "Hello", es: "Hola" };
    expect(cloneDemand([{ lang: "en", voice: "phone" }], out)).toEqual({ speakerLangs: [], presetLangs: {} });
    expect(cloneDemand([{ lang: "es", voice: "morgan-freeman" }], out)).toEqual({
      speakerLangs: [],
      presetLangs: { "morgan-freeman": ["es"] },
    });
    expect(cloneDemand([
      { lang: "en", voice: "speaker" },
      { lang: "es", voice: "morgan-freeman" },
    ], out)).toEqual({
      speakerLangs: ["en"],
      presetLangs: { "morgan-freeman": ["es"] },
    });
  });
});
