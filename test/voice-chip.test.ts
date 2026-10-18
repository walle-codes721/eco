// @ts-nocheck — imports a browser module.
import { describe, expect, it } from "vitest";
import { voiceChip } from "../public/js/voice-chip.js";

const presets = [{ id: "morgan-freeman", label: "Morgan Freeman (AI)" }];

describe("voice chip (ADR 0006)", () => {
  it("labels a line that has the preset clip", () => {
    expect(voiceChip(presets, "morgan-freeman", { audio: { "es@morgan-freeman": "/a" } }, "es")).toBe("Morgan Freeman (AI)");
  });

  it("does not label a line that fell back to the phone voice", () => {
    expect(voiceChip(presets, "morgan-freeman", { audio: { es: "/speaker" } }, "es")).toBeNull();
    expect(voiceChip(presets, "morgan-freeman", {}, "es")).toBeNull();
  });

  it("never labels the speaker or phone choices", () => {
    expect(voiceChip(presets, "speaker", { audio: { es: "/a" } }, "es")).toBeNull();
    expect(voiceChip(presets, "phone", {}, "es")).toBeNull();
  });
});
