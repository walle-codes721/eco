import { describe, it, expect } from "vitest";
import { filterCalls, modelsIn, perMinute, summary, mockCalls, rangeStart } from "../public/js/call-chart-data.js";

const T0 = Date.UTC(2026, 9, 18, 10, 0);
const call = (min: number, model: string, status = 200) => ({ t: T0 + min * 60_000, kind: "utterance", model, ms: 1000, status, tin: 10, tout: 5 });
const rows = [call(0, "A"), call(0.5, "A", 429), call(0.9, "B"), call(2.1, "B"), call(2.2, "A", 599)];

describe("call chart data", () => {
  it("buckets calls per minute by call time, split by worked and failed", () => {
    const b = perMinute(rows, T0, T0 + 3 * 60_000);
    expect(b.map((x) => [x.ok, x.failed])).toEqual([[2, 1], [0, 0], [1, 1]]);
  });

  it("peak per minute and totals match the rows", () => {
    expect(summary(rows, T0, T0 + 3 * 60_000)).toEqual({ total: 5, ok: 3, failed: 2, peak: 3 });
  });

  it("filters by model and range, and the summary follows", () => {
    const b = filterCalls(rows, { models: new Set(["B"]) });
    expect(b).toHaveLength(2);
    expect(summary(b, T0, T0 + 3 * 60_000)).toEqual({ total: 2, ok: 2, failed: 0, peak: 1 });
    expect(filterCalls(rows, { since: T0 + 2 * 60_000 })).toHaveLength(2);
  });

  it("lists the models in the data, most calls first", () => {
    expect(modelsIn(rows)).toEqual(["A", "B"]);
  });

  it("today starts at UTC midnight, like the Budget", () => {
    expect(rangeStart("today", T0)).toBe(Date.UTC(2026, 9, 18));
    expect(rangeStart("15m", T0)).toBe(T0 - 15 * 60_000);
  });

  it("mock calls are the same for the same presentation, and use the code's models", () => {
    const a = mockCalls("stage/seb/demo", T0), b = mockCalls("stage/seb/demo", T0);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(100);
    expect(a.every((r) => r.t <= T0 && r.t > T0 - 2 * 3_600_000)).toBe(true);
    expect(new Set(modelsIn(a))).toEqual(new Set(["MiMo-V2.6-Flash", "Gemma-4-31B-IT", "DeepSeek-V4-Flash", "OmniVoice"]));
    expect(a.some((r) => r.status !== 200)).toBe(true);
  });
});
