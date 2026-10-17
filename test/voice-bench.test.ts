import { describe, expect, it } from "vitest";
import { benchSerialization, verdictFor } from "../src/voice-bench";

const wav = () => new ArrayBuffer(8);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("voice serialization bench", () => {
  it("reads three clips queued one after another as serialized", async () => {
    let free = 0;
    const call = async () => { // a server that handles one request at a time, 40 ms each
      const start = Math.max(Date.now(), free);
      free = start + 40;
      await wait(free - Date.now());
      return wav();
    };
    const r = await benchSerialization(call, ["it", "es", "hi"], async () => { free = 0; });
    expect(r.verdict).toBe("serialized");
  });

  it("reads three clips that finish together as parallel", async () => {
    const r = await benchSerialization(async () => { await wait(40); return wav(); }, ["it", "es", "hi"], async () => {});
    expect(r.verdict).toBe("parallel");
  });

  it("reports a failed or timed-out call instead of a speed verdict", () => {
    const ok = { lang: "it", ms: 100, ok: true };
    expect(verdictFor(ok, [ok, { lang: "es", ms: 12_000, ok: false }]).verdict).toBe("failed");
    expect(verdictFor({ ...ok, ok: false }, [ok]).verdict).toBe("failed");
  });
});
