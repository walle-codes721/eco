// @ts-nocheck — reads the bundled mp3 from disk in Node tests only.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRESET_VOICES } from "../src/preset-voice";
import { sampleTooLargeForAmd } from "../src/voice";

const clipBytes = readFileSync(fileURLToPath(new URL("../src/assets/preset-morgan-freeman.mp3", import.meta.url)));

describe("preset voice definitions", () => {
  it("ships a reviewed transcript, known MIME and a clip under the AMD body limit", () => {
    for (const preset of PRESET_VOICES) {
      expect(preset.referenceTranscript.trim().length).toBeGreaterThan(20);
      expect(preset.mime).toBe("audio/mpeg");
      expect(preset.label).toMatch(/\(AI\)/);
      expect(clipBytes.byteLength).toBeGreaterThan(10_000);
      expect(clipBytes.byteLength).toBeLessThan(5_000_000);
      expect(sampleTooLargeForAmd(clipBytes.byteLength, preset.referenceTranscript)).toBe(false);
    }
  });
});
