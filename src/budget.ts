// One global limiter for every live call (CONTRIBUTING.md, token rules 3, 7, 8, 9). Mock calls never reach it.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

import { admit, countsTowardStop, probeDue, PROBE_MS, PRICE, type Kind, type Denied } from "./limits";
export type { Kind, Denied };

export interface CallRecord {
  kind: Kind;
  model: string;
  ms: number;
  status: number;
  tin: number;
  tout: number;
  pub: boolean;
  why?: string; // "401: Invalid token" — Token Factory's message, never the key
}
type LastError = { t: number; kind: Kind; model: string; status: number; why: string };

export class Budget extends DurableObject<Env> {
  private window: number[] = [];
  private inflight = 0;
  private fails = 0;
  private tripped = false;
  private trippedAt = 0; // 0 on trips stored before probes existed: the first call after deploy probes
  private probing = false;
  private lastError: LastError | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS calls (t INTEGER, kind TEXT, model TEXT, ms INTEGER, status INTEGER, tin INTEGER, tout INTEGER, pub INTEGER)",
    );
    ctx.blockConcurrencyWhile(async () => {
      this.tripped = (await ctx.storage.get<boolean>("tripped")) ?? false;
      this.fails = (await ctx.storage.get<number>("fails")) ?? 0;
      this.trippedAt = (await ctx.storage.get<number>("trippedAt")) ?? 0;
      this.lastError = (await ctx.storage.get<LastError>("lastError")) ?? null;
    });
  }

  private count(sinceMs: number, pubOnly = false): number {
    const q = pubOnly ? "SELECT COUNT(*) AS n FROM calls WHERE t >= ? AND pub = 1" : "SELECT COUNT(*) AS n FROM calls WHERE t >= ?";
    return this.ctx.storage.sql.exec<{ n: number }>(q, sinceMs).one().n;
  }

  private dayStart(): number {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  /** Waits up to `waitMs` for a slot. Translation waits; questions don't. */
  async acquire(kind: Kind, pub: boolean, waitMs = 0): Promise<{ ok: true } | { ok: false; reason: Denied }> {
    const until = Date.now() + waitMs;
    for (;;) {
      const now = Date.now();
      this.window = this.window.filter((t) => now - t < 60_000);
      const probe = probeDue(this.tripped, this.trippedAt, this.probing, now);
      const reason = admit(
        {
          today: this.count(this.dayStart()),
          max: Number(this.env.ECO_MAX_CALLS ?? 0),
          window: this.window.length,
          inflight: this.inflight,
          tripped: this.tripped && !probe,
          pubHour: pub ? this.count(now - 3_600_000, true) : 0,
          pubMax: Number(this.env.ECO_PUBLIC_HOURLY ?? 30),
        },
        kind,
        pub,
      );
      if (!reason) {
        this.window.push(now);
        this.inflight++;
        if (probe) this.probing = true;
        return { ok: true };
      }
      if ((reason !== "busy" && reason !== "rpm") || Date.now() + 250 > until) return { ok: false, reason };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async finish(rec: CallRecord): Promise<void> {
    this.inflight = Math.max(0, this.inflight - 1);
    this.ctx.storage.sql.exec(
      "INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      Date.now(), rec.kind, rec.model, rec.ms, rec.status, rec.tin, rec.tout, rec.pub ? 1 : 0,
    );
    const wasProbe = this.probing;
    this.probing = false;
    if (rec.status === 200) {
      this.fails = 0;
      if (this.tripped) (this.tripped = false), await this.ctx.storage.put("tripped", false); // the probe worked: live again
    } else {
      if (countsTowardStop(rec.status)) this.fails++;
      this.lastError = { t: Date.now(), kind: rec.kind, model: rec.model, status: rec.status, why: (rec.why || String(rec.status)).slice(0, 200) };
      await this.ctx.storage.put("lastError", this.lastError);
      if (this.fails >= 3 || wasProbe) {
        // token rule 8: stop after 3 errors that won't fix themselves in a row; a failed probe stops again for another PROBE_MS
        this.tripped = true;
        this.trippedAt = Date.now();
        await this.ctx.storage.put({ tripped: true, trippedAt: this.trippedAt });
      }
    }
    await this.ctx.storage.put("fails", this.fails); // survives the DO being evicted between calls
  }

  async stats() {
    const since = this.dayStart();
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; model: string; ms: number; tin: number; tout: number; status: number }>(
        "SELECT kind, model, ms, tin, tout, status FROM calls WHERE t >= ?",
        since,
      )
      .toArray();
    const ok = rows.filter((r) => r.status === 200);
    const p50 = (k: string) => {
      const v = ok.filter((r) => r.kind === k).map((r) => r.ms).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const points = ok.reduce((s, r) => {
      const [pi, po] = PRICE[r.model] ?? [0, 0];
      return s + (r.tin * pi + r.tout * po) / 1e6;
    }, 0);
    return {
      live: this.env.ECO_LIVE === "1" && !!this.env.RADEON_API_KEY, // same rule as tf.ts isLive
      today: rows.length,
      max: Number(this.env.ECO_MAX_CALLS ?? 0),
      tripped: this.tripped,
      retryAt: this.tripped ? this.trippedAt + PROBE_MS : null,
      lastError: this.lastError,
      p50: { utterance: p50("utterance"), ask: p50("ask"), turn: p50("turn"), summary: p50("summary") },
      tokens: { in: ok.reduce((s, r) => s + r.tin, 0), out: ok.reduce((s, r) => s + r.tout, 0) },
      points: Math.round(points * 1e4) / 1e4,
    };
  }

  async log(): Promise<string> {
    return this.ctx.storage.sql
      .exec("SELECT * FROM calls ORDER BY t")
      .toArray()
      .map((r) => JSON.stringify(r))
      .join("\n");
  }

  async reset(): Promise<void> {
    this.tripped = false;
    this.fails = 0;
    this.probing = false;
    await this.ctx.storage.put({ tripped: false, fails: 0 });
  }
}
