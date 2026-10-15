// One Durable Object per room: state, WebSocket fan-out, and every call the room makes.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { tf, isLive } from "./tf";
import { MODELS, turnModel, utterancePrompt, answerPrompt, customerTurnPrompt, ownerTurnPrompt, summaryPrompt, transcriptText, mockSummary } from "./prompts";
import { bestSentence, chunkPages, isEcho, normalize, oneLine, selectContext, slidePages, teach, terms, type Chunk } from "./retrieve";
import { voiceFor, SAMPLE_TEXT } from "./voice";
import { DEMO_SLIDES, DEMO_TALK, DEMO_SHOP, DEMO_CONVOS, DEMO_SPEAKERS } from "./fixtures/demo";

type Status = "lobby" | "live" | "ended";

export interface Meta {
  id: string;
  mode: "stage" | "counter";
  title: string;
  speaker: string;
  hostKey: string;
  owner: string; // Google sub of the signed-in creator, "" for guest rooms
  langs: string[]; // stage: target languages
  created: number;
  status: Status;
  startedAt: number | null;
  endedAt: number | null;
  slide: number;
  demo: boolean;
  bizType: string; // counter
  ownerLang: string; // counter
  deck?: boolean; // stage: the speaker's PDF is in R2, so every screen can show it
  speakers?: Speaker[]; // stage: s0 is the host; co-speakers join from their own device
  joinKey?: string; // stage: in the host's "add a speaker" QR
}
/** One device = one speaker. `key` authorises that device; `voice` = a consented sample is stored. */
export interface Speaker { id: string; name: string; key: string; voice: boolean }
export interface Line { speaker?: string; seq: number; t: number; at: number; slide: number; src: string; out: Record<string, string>; flags: string[]; ms: number; live: boolean; audio?: Record<string, string> }
export interface Question { id: string; t: number; at: number; slide: number; lang: string; text: string; q_en: string; covered: boolean; answer: string; cite: string; answeredAt: number | null; taught?: string /* the speaker's typed answer (Teach Eco) */ }
export interface Turn { id: string; t: number; side: "customer" | "owner" | "eco"; lang: string; src: string; out: string; cite?: string; live: boolean; taught?: boolean /* owner turn already added to the list (Teach Eco) */ }
export interface Convo { id: string; lang: string; started: number; open: boolean; turns: Turn[] }
/** The talk's summary. `n` is the seq of the last line it covers: a newer line makes it stale. */
export interface Summary { n: number; text: Record<string, string>; live: boolean; at: number }
type Answer = { covered: boolean; answer: string; cite: string; q_en: string };
type CustomerTurn = { src: string; lang: string; to_owner: string; answer: { covered: boolean; text: string; text_owner: string; cite: string } };

export const DEMOS: Record<string, "stage" | "counter"> = { "stage/eco/demo": "stage", "counter/eco/gelato": "counter" };
const LIMITS = { ask: [3, 10], voice: [4, 40], turn: [8, 60] } as const; // per visitor per hour: [demo, normal]

const rid = () => crypto.randomUUID().replaceAll("-", "");
const MOCK_LINE = "(Mock mode: Eco heard you. Real transcripts and translations need live mode.)";
const json = (data: unknown, status = 200) => Response.json(data, { status });
const uid = () => crypto.randomUUID().slice(0, 8);

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Room extends DurableObject<Env> {
  meta: Meta | null = null;
  pages: { tag: string; text: string }[] = [];
  chunks: Chunk[] = [];
  lines: Line[] = [];
  questions: Question[] = [];
  convos: Convo[] = [];
  cache: Record<string, Answer> = {};
  peak = 0;
  summary: Summary | null = null;
  private summarizing = false;
  private visitors = new Map<string, number>();
  private mockI = 0;
  private cloning = 0;
  private samples = new Map<string, ArrayBuffer>();
  private replayI = 0;
  private replayPausedUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(["meta", "pages", "chunks", "lines", "questions", "convos", "cache", "peak", "summary"]);
      this.meta = (s.get("meta") as Meta) ?? null;
      this.pages = (s.get("pages") as typeof this.pages) ?? [];
      this.chunks = (s.get("chunks") as Chunk[]) ?? [];
      this.lines = (s.get("lines") as Line[]) ?? [];
      this.questions = (s.get("questions") as Question[]) ?? [];
      this.convos = (s.get("convos") as Convo[]) ?? [];
      this.cache = (s.get("cache") as Record<string, Answer>) ?? {};
      this.peak = (s.get("peak") as number) ?? 0;
      this.summary = (s.get("summary") as Summary) ?? null;
    });
  }

  private save(...keys: ("meta" | "pages" | "chunks" | "lines" | "questions" | "convos" | "cache" | "peak" | "summary")[]) {
    const entries: Record<string, unknown> = {};
    for (const k of keys) entries[k] = this[k];
    return this.ctx.storage.put(entries);
  }

  // ---------- creation ----------

  async init(id: string, body: any, owner = ""): Promise<{ id: string; hostKey: string } | null> {
    if (this.meta) return null;
    const mode = id.startsWith("counter/") ? "counter" : "stage";
    const s = (v: unknown, n: number) => String(v ?? "").slice(0, n).trim();
    this.meta = {
      id,
      mode,
      title: s(body.title, 120) || (mode === "stage" ? "Untitled talk" : "My business"),
      speaker: s(body.speaker, 80),
      hostKey: crypto.randomUUID().replaceAll("-", ""),
      owner,
      langs: (Array.isArray(body.langs) ? body.langs : ["it", "es", "hi"]).map((l: string) => s(l, 5)).slice(0, 3),
      created: Date.now(),
      status: "lobby",
      startedAt: null,
      endedAt: null,
      slide: 1,
      demo: !!body.demo,
      bizType: s(body.bizType, 30) || "shop",
      ownerLang: s(body.ownerLang, 5) || "it",
    };
    const pages: { tag: string; text: string }[] = (Array.isArray(body.pages) ? body.pages : [])
      .slice(0, 200)
      .map((p: any) => ({ tag: s(p.tag, 40), text: s(p.text, 8000) }))
      .filter((p: { text: string }) => p.text);
    if (body.notes) pages.push({ tag: "notes", text: s(body.notes, 20000) });
    this.pages = pages;
    this.chunks = chunkPages(pages);
    await this.save("meta", "pages", "chunks");
    return { id, hostKey: this.meta.hostKey };
  }

  private async ensureDemo(id: string) {
    if (this.meta || !DEMOS[id]) return;
    if (DEMOS[id] === "stage") {
      await this.init(id, { mode: "stage", title: "Eco: one engine, two rooms", speaker: "Seb", langs: ["it", "es", "hi"], pages: DEMO_SLIDES, demo: true });
    } else {
      await this.init(id, { mode: "counter", title: DEMO_SHOP.name, bizType: DEMO_SHOP.type, ownerLang: DEMO_SHOP.ownerLang, pages: DEMO_SHOP.sources, demo: true });
      const t0 = Date.now() - 20 * 60_000;
      this.convos = DEMO_CONVOS.map((c, i) => {
        const t = t0 + i * 6 * 60_000;
        const turns: Turn[] = [{ id: uid(), t, side: "customer", lang: c.lang, src: c.customer, out: c.to_owner, live: false }];
        if (c.answer.covered) turns.push({ id: uid(), t: t + 2500, side: "eco", lang: c.lang, src: c.answer.text, out: c.answer.text_owner, cite: c.answer.cite, live: false });
        return { id: `seed${i}`, lang: c.lang, started: t, open: !c.answer.covered, turns };
      });
      await this.save("convos");
    }
  }

  publicMeta() {
    const m = this.meta!;
    return {
      id: m.id, mode: m.mode, title: m.title, speaker: m.speaker, langs: m.langs, status: m.status,
      startedAt: m.startedAt, endedAt: m.endedAt, slide: m.slide, demo: m.demo, bizType: m.bizType, ownerLang: m.ownerLang,
      live: isLive(this.env),
      slides: m.mode === "stage" ? slidePages(this.pages) : [],
      deck: !!m.deck,
      speakers: (m.speakers ?? []).map(({ id, name, voice }) => ({ id, name, voice })),
      voice: !!this.env.VOICE_URL,
    };
  }

  // ---------- HTTP ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = req.headers.get("x-room") ?? "";
    const action = url.pathname.slice(1);
    if (action === "init") {
      const made = await this.init(id, await req.json(), req.headers.get("x-user") ?? "");
      return made ? json(made) : json({ error: "exists" }, 409);
    }
    await this.ensureDemo(id);
    if (!this.meta) return json({ error: "Room not found" }, 404);

    const m = this.meta;
    if (m.mode === "stage" && !m.speakers) {
      // Also runs once on rooms made before speakers existed, including the live demo room.
      m.speakers = m.demo ? DEMO_SPEAKERS.map((name, i) => ({ id: `s${i}`, name, key: "", voice: false })) : [{ id: "s0", name: m.speaker || "Speaker", key: "", voice: false }];
      if (!m.demo) m.joinKey = rid();
      await this.save("meta");
    }
    const user = req.headers.get("x-user");
    const isHost = req.headers.get("x-key") === m.hostKey || url.searchParams.get("key") === m.hostKey || (!!user && user === m.owner);
    const ip = req.headers.get("x-ip") ?? "?";
    const sk = req.headers.get("x-speaker-key") ?? url.searchParams.get("sk");
    const me = isHost ? m.speakers?.[0] : m.speakers?.find((s) => s.key && s.key === sk);

    switch (`${req.method} ${action}`) {
      case "GET meta":
        return json({ ...this.publicMeta(), host: isHost, me: me?.id ?? null, ...(me ? { sampleText: SAMPLE_TEXT } : {}), ...(isHost ? { joinKey: m.joinKey } : {}) });
      case "GET ws":
        return this.openSocket(url, isHost, me);
      case "GET transcript":
        return json({ meta: this.publicMeta(), lines: this.lines });
      case "GET summary":
        return json({ summary: this.summary });
      case "POST summary":
        return this.summarize(isHost || !!me, ip);
      case "POST utterance": {
        if (!me && !(m.demo && this.allow(ip, "voice"))) return json({ error: "Not allowed" }, 403);
        return this.utterance(req, m.demo && !isHost, me?.id ?? "s0");
      }
      case "POST ask":
        return this.ask(await req.json(), ip);
      case "POST turn":
        return this.turn(req, isHost, ip);
      case "GET board":
        return isHost || m.demo ? json(this.board()) : json({ error: "Not allowed" }, 403);
      case "GET card":
        return isHost || m.demo ? json(m.mode === "stage" ? this.stageCard() : this.counterCard()) : json({ error: "Not allowed" }, 403);
      case "GET deck": {
        const obj = m.deck ? await this.env.FILES.get(`${m.id}/deck.pdf`) : null;
        return obj ? new Response(obj.body, { headers: { "content-type": "application/pdf", "cache-control": "private, max-age=300" } }) : json({ error: "No slides" }, 404);
      }
      case "GET audio": {
        const obj = await this.env.FILES.get(`${m.id}/audio/${(url.searchParams.get("k") ?? "").replace(/[^a-z0-9-]/g, "")}.wav`);
        return obj ? new Response(obj.body, { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" } }) : json({ error: "No clip" }, 404);
      }
      case "POST join": {
        // A co-speaker: anyone holding the host's join QR, on their own device.
        if (m.mode !== "stage" || m.demo || !m.joinKey || req.headers.get("x-join") !== m.joinKey) return json({ error: "Not allowed" }, 403);
        const body: any = await req.json().catch(() => ({}));
        if (m.speakers!.length >= 6) return json({ error: "Up to 6 speakers" }, 409);
        const sp: Speaker = { id: `s${m.speakers!.length}`, name: String(body.name ?? "").trim().slice(0, 60) || `Speaker ${m.speakers!.length + 1}`, key: rid(), voice: false };
        m.speakers!.push(sp);
        await this.save("meta");
        this.sendSpeakers();
        return json({ id: sp.id, name: sp.name, key: sp.key });
      }
      case "PUT voice": {
        // The speaker's own sample, only with their consent. Stored in R2; deleted with DELETE voice.
        if (!me || m.demo) return json({ error: "Not allowed" }, 403);
        if (req.headers.get("x-consent") !== "yes") return json({ error: "Consent needed" }, 400);
        const wav = await req.arrayBuffer();
        if (wav.byteLength < 20_000 || wav.byteLength > 1_500_000) return json({ error: "Record about 10 seconds" }, 413);
        await this.env.FILES.put(`${m.id}/voice/${me.id}.wav`, wav, { httpMetadata: { contentType: "audio/wav" } });
        this.samples.set(me.id, wav);
        me.voice = true;
        await this.save("meta");
        this.sendSpeakers();
        return json({ ok: true });
      }
      case "DELETE voice": {
        if (!me) return json({ error: "Not allowed" }, 403);
        await this.env.FILES.delete(`${m.id}/voice/${me.id}.wav`);
        this.samples.delete(me.id);
        me.voice = false;
        await this.save("meta");
        this.sendSpeakers();
        return json({ ok: true });
      }
      case "GET convos":
        return isHost || m.demo ? json({ convos: this.convos }) : json({ error: "Not allowed" }, 403);
    }
    if (!isHost) return json({ error: "Not allowed" }, 403);
    if (`${req.method} ${action}` === "PUT deck") {
      if (m.mode !== "stage" || m.demo) return json({ error: "Not here" }, 400);
      const len = Number(req.headers.get("content-length") ?? 0);
      if (!len || len > 25_000_000) return json({ error: "Send a PDF under 25 MB" }, 413);
      await this.env.FILES.put(`${m.id}/deck.pdf`, req.body, { httpMetadata: { contentType: "application/pdf" } });
      m.deck = true;
      await this.save("meta");
      this.send(["listener", "screen", "host"], { type: "deck" });
      return json({ ok: true });
    }
    if (`${req.method} ${action}` === "GET sources") return json({ pages: this.pages });
    const body: any = await req.json().catch(() => ({}));
    switch (`${req.method} ${action}`) {
      case "POST slide": {
        m.slide = Math.max(1, Math.min(Number(body.n) || 1, Math.max(1, slidePages(this.pages).length)));
        await this.save("meta");
        this.send(["listener", "screen", "host"], { type: "slide", n: m.slide });
        return json({ slide: m.slide });
      }
      case "POST status":
        return json(await this.setStatus(body.status));
      case "POST answered": {
        const qids: string[] = Array.isArray(body.qids) ? body.qids : [];
        const at = this.elapsed();
        for (const q of this.questions) if (qids.includes(q.id)) q.answeredAt = at;
        await this.save("questions");
        this.send(["listener"], { type: "answered", qids, at });
        this.pushBoard();
        return json({ ok: true });
      }
      case "POST sources": {
        if (m.demo) return json({ error: "The demo can't be edited" }, 400);
        this.pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 200).map((p: any) => ({ tag: String(p.tag ?? "info").slice(0, 40), text: String(p.text ?? "").slice(0, p.tag === "notes" ? 20000 : 8000) })).filter((p: { text: string }) => p.text.trim());
        this.chunks = chunkPages(this.pages);
        this.cache = {}; // answers came from the old info
        await this.save("pages", "chunks", "cache");
        if (m.mode === "stage") this.send(["listener", "screen", "host"], { type: "slides", slides: this.publicMeta().slides });
        return json({ ok: true, chunks: this.chunks.length });
      }
      case "POST addanswer":
        return m.mode === "stage" ? this.teachQuestion(body) : this.teachAnswer(body);
    }
    return json({ error: "Unknown action" }, 404);
  }

  /** Per-visitor hourly limits; cached and mock-free paths don't call this. */
  private allow(ip: string, kind: keyof typeof LIMITS): boolean {
    const key = `${ip}:${kind}:${Math.floor(Date.now() / 3_600_000)}`;
    const n = this.visitors.get(key) ?? 0;
    if (n >= LIMITS[kind][this.meta!.demo ? 0 : 1]) return false;
    this.visitors.set(key, n + 1);
    if (this.visitors.size > 5000) this.visitors.clear();
    return true;
  }

  private elapsed(): number {
    const m = this.meta!;
    return m.startedAt ? Math.round((Date.now() - m.startedAt) / 1000) : 0;
  }

  private async setStatus(status: Status) {
    const m = this.meta!;
    if (!["lobby", "live", "ended"].includes(status)) return { status: m.status };
    m.status = status;
    if (status === "live" && !m.startedAt) m.startedAt = Date.now();
    if (status === "ended") m.endedAt = Date.now();
    if (status === "live") m.endedAt = null;
    await this.save("meta");
    this.send(["listener", "screen", "host"], { type: "status", status, startedAt: m.startedAt, endedAt: m.endedAt });
    // The talk is over: write the summary now, in the background, so listeners find it on their recap without anyone asking.
    // A second End with nothing new said is a cache hit (no call), and a failure just leaves the speaker's button.
    if (status === "ended" && m.mode === "stage") this.ctx.waitUntil(this.summarize(true, "").catch(() => {}));
    return { status };
  }

  // ---------- WebSockets (hibernation API) ----------

  private openSocket(url: URL, isHost: boolean, me?: Speaker): Response {
    const role = url.searchParams.get("role") ?? "listener";
    if ((role === "host" || role === "owner") && !isHost && !this.meta!.demo) return json({ error: "Not allowed" }, 403);
    if (role === "speaker" && !me) return json({ error: "Not allowed" }, 403);
    const lang = (url.searchParams.get("lang") ?? "en").slice(0, 5);
    const cid = (url.searchParams.get("cid") ?? "").slice(0, 40);
    const pair = new WebSocketPair();
    const tags = [role, `lang:${lang}`, ...(cid ? [`c:${cid}`] : [])];
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment({ role, lang, cid, speaker: role === "host" || role === "speaker" ? me?.id ?? "s0" : null });

    const m = this.meta!;
    const hello: Record<string, unknown> = { type: "hello", meta: this.publicMeta() };
    // 50 = the client's line buffer (public/js/pages/listener.js); the two must stay in lockstep,
    // otherwise a late joiner can't scroll back through everything a long-time listener has.
    if (m.mode === "stage") hello.lines = this.lines.slice(-50);
    if (role === "host") hello.board = this.board();
    if (role === "owner") hello.convos = this.convos;
    if (role === "customer") hello.convo = this.convos.find((c) => c.id === cid) ?? null;
    pair[1].send(JSON.stringify(hello));

    if (role === "listener") this.presence();
    if (m.demo && m.mode === "stage") this.ctx.storage.getAlarm().then((a) => { if (!a) this.ctx.storage.setAlarm(Date.now() + 1500); });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== "string") return;
    let d: any;
    try {
      d = JSON.parse(msg);
    } catch {
      return;
    }
    if (d.type === "ping") ws.send('{"type":"pong"}');
    // "Now speaking": the speaker's own mic level decides, sent by their device. No API call.
    const sid = ws.deserializeAttachment()?.speaker;
    if (d.type === "speaking" && sid) this.send(["listener", "screen", "host", "speaker"], { type: "speaking", speaker: sid, on: !!d.on });
    if (d.type === "lang" && typeof d.lang === "string") {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), lang: d.lang.slice(0, 5) });
      this.presence();
    }
  }

  async webSocketClose(ws: WebSocket) {
    if (ws.deserializeAttachment()?.role === "listener") this.presence();
  }

  private send(roles: string[], msg: unknown, extraTags: string[] = []) {
    const s = JSON.stringify(msg);
    for (const tag of [...roles, ...extraTags])
      for (const ws of this.ctx.getWebSockets(tag)) {
        try {
          ws.send(s);
        } catch {}
      }
  }

  private sendSpeakers() {
    this.send(["listener", "screen", "host", "speaker"], { type: "speakers", speakers: this.publicMeta().speakers });
  }

  private listenerLangs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const ws of this.ctx.getWebSockets("listener")) {
      const l = ws.deserializeAttachment()?.lang ?? "en";
      out[l] = (out[l] ?? 0) + 1;
    }
    return out;
  }

  private presence() {
    const n = this.ctx.getWebSockets("listener").length;
    if (n > this.peak) {
      this.peak = n;
      this.save("peak");
    }
    this.pushBoard();
  }

  private pushBoard() {
    if (this.ctx.getWebSockets("host").length) this.send(["host"], { type: "board", board: this.board() });
  }

  // ---------- Stage ----------

  private async utterance(req: Request, tryVoice: boolean, speaker: string): Promise<Response> {
    const m = this.meta!;
    if (m.status === "ended") return json({ error: "Talk ended" }, 409);
    // Text from the browser's speech recognition (JSON), or a WAV for MiMo.
    let input: { text?: string; wavB64?: string };
    if (req.headers.get("content-type")?.startsWith("application/json")) {
      const text = String(((await req.json().catch(() => ({}))) as { text?: unknown }).text ?? "").trim().slice(0, 500);
      if (!text) return json({ empty: true });
      input = { text };
    } else {
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 1000 || buf.byteLength > 800_000) return json({ error: "Bad audio" }, 413);
      input = { wavB64: b64(buf) };
    }
    const t0 = Date.now();
    if (tryVoice) this.replayPausedUntil = Date.now() + 45_000;

    const prev = this.lines.slice(-2).map((l) => l.src);
    const r = await tf(this.env, "utterance", turnModel(input), utterancePrompt(input, m.langs, prev), {
      pub: m.demo,
      mock: () => {
        if (!m.demo) return { src: input.text ?? MOCK_LINE, out: Object.fromEntries(m.langs.map((l) => [l, MOCK_LINE])), flags: ["mock"] };
        const d = DEMO_TALK[this.mockI++ % DEMO_TALK.length];
        return { src: d.src, out: Object.fromEntries(m.langs.map((l) => [l, d.out[l] ?? d.src])), flags: [] as string[] };
      },
    });
    if (r.data === null) {
      const why = "why" in r && r.why ? `${r.fallback}, ${r.why}` : r.fallback;
      this.send(["host"], { type: "notice", level: "warn", text: `Translation paused (${why}).` });
      return json({ fallback: why }, 503);
    }
    if (!r.data.src?.trim()) return json({ empty: true });
    if (r.live && isEcho(this.lines, speaker, r.data.src, Date.now())) return json({ dup: true });
    if (m.status === "lobby") await this.setStatus("live");
    const line = await this.addLine({ speaker, src: r.data.src, out: r.data.out ?? {}, flags: r.data.flags ?? [], ms: Date.now() - t0, live: r.live });
    return json({ line });
  }

  private async addLine(p: Pick<Line, "speaker" | "src" | "out" | "flags" | "ms" | "live">): Promise<Line> {
    const line: Line = { seq: (this.lines.at(-1)?.seq ?? 0) + 1, t: Date.now(), at: this.elapsed(), slide: this.meta!.slide, ...p };
    this.lines.push(line);
    if (this.lines.length > 600) this.lines.splice(0, this.lines.length - 600);
    await this.save("lines");
    this.send(["listener", "screen", "host", "speaker"], { type: "line", line });
    this.ctx.waitUntil(this.clone(line));
    return line;
  }

  /** The line in its speaker's cloned voice, one clip per language that has listeners right now. */
  private async clone(line: Line) {
    const sp = this.meta!.speakers?.find((s) => s.id === line.speaker);
    if (!this.env.VOICE_URL || !sp?.voice || this.cloning >= 2) return; // busy: phones fall back to their own voice
    const langs = Object.keys(this.listenerLangs()).filter((l) => line.out[l]);
    if (!langs.length) return;
    this.cloning++;
    try {
      let sample = this.samples.get(sp.id);
      if (!sample) {
        sample = await (await this.env.FILES.get(`${this.meta!.id}/voice/${sp.id}.wav`))?.arrayBuffer();
        if (!sample) return;
        this.samples.set(sp.id, sample);
      }
      const audio: Record<string, string> = {};
      await Promise.all(langs.map(async (lang) => {
        const wav = await voiceFor(this.env, sample!, line.out[lang], lang);
        if (!wav) return;
        const k = `${line.seq}-${lang}`;
        await this.env.FILES.put(`${this.meta!.id}/audio/${k}.wav`, wav);
        audio[lang] = `/api/rooms/${this.meta!.id}/audio?k=${k}`;
      }));
      if (!Object.keys(audio).length) return;
      const stored = this.lines.find((l) => l.seq === line.seq);
      if (stored) (stored.audio = { ...stored.audio, ...audio }), await this.save("lines");
      this.send(["listener"], { type: "audio", seq: line.seq, audio });
    } finally {
      this.cloning--;
    }
  }

  /** Deck chunks plus what the speaker has said so far, ~150 words per transcript chunk. */
  private sourceChunks(): Chunk[] {
    const said: Chunk[] = [];
    let buf: Line[] = [];
    const flush = () => {
      if (!buf.length) return;
      const at = buf[0].at;
      said.push({ tag: `said at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`, title: `Slide ${buf[0].slide}`, text: buf.map((l) => l.src).join(" ") });
      buf = [];
    };
    for (const l of this.lines) {
      buf.push(l);
      if (buf.reduce((n, x) => n + x.src.split(" ").length, 0) > 150) flush();
    }
    flush();
    return [...this.chunks, ...said];
  }

  private async ask(body: any, ip: string): Promise<Response> {
    const m = this.meta!;
    const text = String(body.text ?? "").trim().slice(0, 300);
    const lang = String(body.lang ?? "en").slice(0, 5);
    if (!text) return json({ error: "Empty question" }, 400);
    const key = `${normalize(text)}|${lang}`;
    let a = this.cache[key];
    let fromCache = !!a;
    if (!a) {
      if (!this.allow(ip, "ask")) return json({ error: "limit" }, 429);
      const chunks = m.mode === "stage" ? this.sourceChunks() : this.chunks;
      const { picked, best } = selectContext(chunks, text);
      const r = await tf<Answer>(this.env, "ask", MODELS.answer, answerPrompt(picked, text, lang), {
        pub: m.demo,
        mock: () => {
          const b = bestSentence(text, best);
          return { covered: b.covered, answer: b.text, cite: b.cite, q_en: text };
        },
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const tags = new Set(chunks.map((c) => c.tag));
      const cite = tags.has(r.data.cite) ? r.data.cite : r.data.covered ? best?.tag ?? "" : "";
      a = { covered: !!r.data.covered && !!r.data.answer, answer: String(r.data.answer ?? ""), cite, q_en: String(r.data.q_en || text) };
      this.cache[key] = a;
      fromCache = false;
    }
    const q: Question = { id: uid(), t: Date.now(), at: this.elapsed(), slide: m.slide, lang, text, q_en: a.q_en, covered: a.covered, answer: a.answer, cite: a.cite, answeredAt: null };
    this.questions.push(q);
    await this.save("questions", "cache");
    this.pushBoard();
    return json({ id: q.id, covered: q.covered, answer: q.answer, cite: q.cite, cached: fromCache });
  }

  /**
   * One call: what the speakers said, summarised in every language of the room.
   * Speakers only (the public demo room allows visitors, within its per-visitor limit).
   * Cached until a new line arrives, so a second tap costs nothing.
   */
  private async summarize(isSpeaker: boolean, ip: string): Promise<Response> {
    const m = this.meta!;
    if (m.mode !== "stage") return json({ error: "Not a stage" }, 400);
    if (this.lines.length < 3) return json({ error: "Too short" }, 400);
    const n = this.lines.at(-1)!.seq;
    if (this.summary?.n === n) return json({ summary: this.summary, cached: true });
    if (!isSpeaker && !m.demo) return json({ error: "Not allowed" }, 403);
    if (!isSpeaker && !this.allow(ip, "ask")) return json({ error: "limit" }, 429);
    if (this.summarizing) return json({ error: "busy" }, 409); // one at a time: two taps must not make two calls
    this.summarizing = true;
    try {
      const langs = ["en", ...m.langs.filter((l) => l !== "en")];
      const lines = this.lines.slice();
      const r = await tf<Record<string, string>>(this.env, "summary", MODELS.answer, summaryPrompt(m.title, transcriptText(lines), langs), {
        pub: m.demo,
        mock: () => mockSummary(lines, langs),
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const text: Record<string, string> = {};
      for (const l of langs) {
        const v = r.data[l];
        if (typeof v !== "string" || !v.trim()) return json({ error: "busy", fallback: "error" }, 503); // a language is missing: don't save half a summary
        text[l] = v.trim().slice(0, 1500);
      }
      this.summary = { n, text, live: r.live, at: Date.now() };
      await this.save("summary");
      this.send(["listener", "screen", "host"], { type: "summary", summary: this.summary });
      return json({ summary: this.summary, cached: false });
    } finally {
      this.summarizing = false;
    }
  }

  board() {
    const qs = this.questions;
    const topics = new Map<string, { topic: string; title: string; count: number; sample: string }>();
    for (const q of qs.filter((q) => q.covered)) {
      const t = topics.get(q.cite) ?? { topic: q.cite, title: this.chunks.find((c) => c.tag === q.cite)?.title ?? q.cite, count: 0, sample: "" };
      t.count++;
      t.sample = q.q_en;
      topics.set(q.cite, t);
    }
    const queue = new Map<string, { qids: string[]; q: string; asked: string; count: number; langs: string[]; answeredAt: number | null; taught: boolean }>();
    for (const q of qs.filter((q) => !q.covered)) {
      const k = normalize(q.q_en);
      const g = queue.get(k) ?? { qids: [], q: q.q_en, asked: "", count: 0, langs: [], answeredAt: null, taught: true };
      g.qids.push(q.id);
      g.count++;
      if (!g.asked && q.text !== q.q_en) g.asked = q.text; // a listener's own words, when they asked in another language
      g.taught = g.taught && !!q.taught;
      if (!g.langs.includes(q.lang)) g.langs.push(q.lang);
      g.answeredAt = q.answeredAt;
      queue.set(k, g);
    }
    const bySlide: Record<number, number> = {};
    for (const q of qs) bySlide[q.slide] = (bySlide[q.slide] ?? 0) + 1;
    const qLangs: Record<string, number> = {};
    for (const q of qs) qLangs[q.lang] = (qLangs[q.lang] ?? 0) + 1;
    const live = this.lines.filter((l) => l.live).map((l) => l.ms).sort((a, b) => a - b);
    return {
      listeners: this.listenerLangs(),
      peak: this.peak,
      questions: qs.length,
      topics: [...topics.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      queue: [...queue.values()].sort((a, b) => Number(!!a.answeredAt) - Number(!!b.answeredAt) || b.count - a.count),
      bySlide,
      qLangs,
      lines: this.lines.length,
      p50: live.length ? live[Math.floor(live.length / 2)] : null,
    };
  }

  stageCard() {
    const m = this.meta!;
    const b = this.board();
    const worst = Object.entries(b.bySlide).sort((a, c) => c[1] - a[1])[0];
    return {
      title: m.title, speaker: m.speaker, langs: m.langs,
      duration: m.startedAt ? Math.round(((m.endedAt ?? Date.now()) - m.startedAt) / 1000) : 0,
      peak: this.peak, lines: this.lines.length, liveLines: this.lines.filter((l) => l.live).length,
      questions: b.questions, qLangs: b.qLangs, topics: b.topics,
      worstSlide: worst ? { slide: Number(worst[0]), count: worst[1], title: slidePages(this.pages)[Number(worst[0]) - 1]?.text.split("\n")[0] ?? "" } : null,
      unanswered: b.queue.filter((g) => !g.answeredAt).map((g) => ({ q: g.q, count: g.count })),
      p50: b.p50,
      speakers: (m.speakers ?? []).map((s) => ({ name: s.name, lines: this.lines.filter((l) => (l.speaker ?? "s0") === s.id).length })),
    };
  }

  // Replay for the public demo talk: plays the fixture with real gaps while anyone is watching.
  async alarm() {
    const m = this.meta;
    if (!m?.demo || m.mode !== "stage") return;
    const watching = this.ctx.getWebSockets("listener").length + this.ctx.getWebSockets("screen").length + this.ctx.getWebSockets("host").length;
    if (!watching) return; // next connection restarts it
    if (Date.now() < this.replayPausedUntil) return void this.ctx.storage.setAlarm(this.replayPausedUntil);
    // Start of a loop (or the object was evicted mid-loop): start clean so old and new lines never mix.
    if (this.replayI >= DEMO_TALK.length || (this.replayI === 0 && this.lines.length)) {
      this.replayI = 0;
      this.lines = [];
      this.summary = null; // it described the old loop
      this.questions = this.questions.slice(-30);
      m.startedAt = Date.now();
      m.slide = 1;
      await this.save("lines", "meta", "questions", "summary");
      this.send(["listener", "screen", "host"], { type: "reset", meta: this.publicMeta() });
      return void this.ctx.storage.setAlarm(Date.now() + 3000);
    }
    const d = DEMO_TALK[this.replayI++];
    if (m.status !== "live") await this.setStatus("live");
    if (d.slide !== m.slide) {
      m.slide = d.slide;
      await this.save("meta");
      this.send(["listener", "screen", "host"], { type: "slide", n: d.slide });
    }
    if (d.speaker !== this.lines.at(-1)?.speaker) {
      for (const s of m.speakers ?? []) this.send(["listener", "screen", "host"], { type: "speaking", speaker: s.id, on: s.id === d.speaker });
    }
    await this.addLine({ speaker: d.speaker, src: d.src, out: d.out, flags: [], ms: 0, live: false });
    const next = DEMO_TALK[this.replayI];
    await this.ctx.storage.setAlarm(Date.now() + (next ? next.delay : 9000));
  }

  // ---------- Counter ----------

  private async turn(req: Request, isHost: boolean, ip: string): Promise<Response> {
    const m = this.meta!;
    if (m.mode !== "counter") return json({ error: "Not a counter" }, 400);
    const audio = req.headers.get("content-type")?.startsWith("audio/");
    const body: any = audio ? {} : await req.json();
    const side = (audio ? req.headers.get("x-side") : body.side) === "owner" ? "owner" : "customer";
    const cid = String((audio ? req.headers.get("x-cid") : body.cid) ?? "").slice(0, 40);
    const hint = String((audio ? req.headers.get("x-lang") : body.lang) ?? "en").slice(0, 5);
    const text = audio ? "" : String(body.text ?? "").trim().slice(0, 500);
    const wav = audio ? await req.arrayBuffer() : null;
    if (!cid || (!text && !wav)) return json({ error: "Empty" }, 400);
    if (wav && (wav.byteLength < 1000 || wav.byteLength > 800_000)) return json({ error: "Bad audio" }, 413);
    if (side === "owner" && !isHost && !m.demo) return json({ error: "Not allowed" }, 403);
    if (!isHost && !this.allow(ip, "turn")) return json({ error: "limit" }, 429);

    let convo = this.convos.find((c) => c.id === cid);
    if (!convo) {
      if (side === "owner") return json({ error: "No conversation" }, 404);
      convo = { id: cid, lang: hint, started: Date.now(), open: false, turns: [] };
      this.convos.push(convo);
      if (this.convos.length > 300) this.convos.shift();
    }
    const input = wav ? { wavB64: b64(wav) } : { text };
    const added: Turn[] = [];

    if (side === "customer") {
      const { picked } = selectContext(this.chunks, text);
      const r = await tf<CustomerTurn>(this.env, "turn", turnModel(input), customerTurnPrompt({ name: m.title, type: m.bizType, ownerLang: m.ownerLang }, picked, input), {
        pub: m.demo,
        mock: () => {
          if (!text && !m.demo) return { src: MOCK_LINE, lang: hint, to_owner: MOCK_LINE, answer: { covered: false, text: "", text_owner: "", cite: "" } };
          const seed = !m.demo ? null : text ? DEMO_CONVOS.find((c) => normalize(c.customer) === normalize(text)) : DEMO_CONVOS[this.mockI++ % DEMO_CONVOS.length];
          if (seed) return { src: seed.customer, lang: seed.lang, to_owner: seed.to_owner, answer: seed.answer };
          const b = bestSentence(text, selectContext(this.chunks, text).best);
          return { src: text, lang: hint, to_owner: text, answer: { covered: b.covered, text: b.text, text_owner: b.text, cite: b.cite } };
        },
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const d = r.data;
      if (d.lang) convo.lang = d.lang.slice(0, 5);
      added.push({ id: uid(), t: Date.now(), side: "customer", lang: convo.lang, src: d.src, out: d.to_owner, live: r.live });
      const covered = !!d.answer?.covered && !!d.answer.text;
      if (covered) added.push({ id: uid(), t: Date.now(), side: "eco", lang: convo.lang, src: d.answer.text, out: d.answer.text_owner || d.answer.text, cite: d.answer.cite, live: r.live });
      convo.open = !covered;
    } else {
      const r = await tf<{ src: string; out: string }>(this.env, "turn", turnModel(input), ownerTurnPrompt(m.ownerLang, convo.lang, input), {
        pub: m.demo,
        mock: () => ({ src: text || "(audio)", out: text || "(audio)" }),
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      added.push({ id: uid(), t: Date.now(), side: "owner", lang: m.ownerLang, src: r.data.src, out: r.data.out, live: r.live });
      convo.open = false;
    }
    convo.turns.push(...added);
    await this.save("convos");
    const msg = { type: "turns", cid, lang: convo.lang, open: convo.open, turns: added };
    this.send(["owner"], msg, [`c:${cid}`]);
    return json(msg);
  }

  /**
   * Teach Eco on the Stage: the speaker (already past the host check) types an answer to questions the talk didn't cover.
   * It becomes a source, the stale "not covered" answers are dropped, and the listeners who asked get the text.
   * The speaker has reviewed `q` and `a` on their screen. Nothing here calls the AI.
   */
  private async teachQuestion(body: any): Promise<Response> {
    const m = this.meta!;
    if (m.demo) return json({ error: "The demo can't be edited" }, 400);
    const ids: string[] = Array.isArray(body.qids) ? body.qids.map(String) : [];
    const asked = this.questions.filter((q) => ids.includes(q.id) && !q.covered); // only questions the talk couldn't answer
    if (!asked.length) return json({ error: "No such question" }, 404);
    if (asked.every((q) => q.taught)) return json({ error: "Already added" }, 409);

    const r = teach(this.pages, { q: body.q, asked: body.asked, a: body.a });
    if (r.reason === "empty") return json({ error: "Write the question and the answer" }, 400);
    if (r.reason === "full") return json({ error: "The answers section is full. Tidy it in your notes." }, 409);
    if (r.added) {
      this.pages = r.pages;
      this.chunks = chunkPages(this.pages);
      this.cache = {}; // "not covered" came from the old sources
    }
    const answer = oneLine(body.a, 500);
    const at = this.elapsed();
    for (const q of asked) {
      q.taught = answer;
      q.answeredAt ??= at; // teaching it also counts as answering it
    }
    await this.save("pages", "chunks", "cache", "questions");
    this.send(["listener"], { type: "answered", qids: asked.map((q) => q.id), at, answer });
    this.pushBoard();
    return json({ ok: true, added: r.added, answered: asked.length, chunks: this.chunks.length });
  }

  /**
   * Teach Eco: the owner (already past the host check) turns one of their replies into a list entry.
   * The owner has reviewed `q` and `a` on their screen. Nothing here calls the AI.
   */
  private async teachAnswer(body: any): Promise<Response> {
    const m = this.meta!;
    if (m.mode !== "counter") return json({ error: "Not a counter" }, 400);
    if (m.demo) return json({ error: "The demo can't be edited" }, 400);
    const turn = this.convos.find((c) => c.id === body.cid)?.turns.find((t) => t.id === body.tid);
    if (!turn || turn.side !== "owner") return json({ error: "No such reply" }, 404);
    if (turn.taught) return json({ error: "Already added" }, 409);

    const r = teach(this.pages, { q: body.q, asked: body.asked, a: body.a });
    if (r.reason === "empty") return json({ error: "Write the question and the answer" }, 400);
    if (r.reason === "full") return json({ error: "The answers section is full. Tidy it in Edit info." }, 409);
    if (r.added) {
      this.pages = r.pages;
      this.chunks = chunkPages(this.pages);
      this.cache = {}; // answers came from the old info
    }
    turn.taught = true; // also for a duplicate: it's already in the list, so the button can go
    await this.save("pages", "chunks", "cache", "convos");
    this.send(["owner"], { type: "taught", cid: body.cid, tid: body.tid });
    return json({ ok: true, added: r.added, chunks: this.chunks.length });
  }

  counterCard() {
    const m = this.meta!;
    const langs: Record<string, number> = {};
    const topics: Record<string, number> = {};
    const missing: Record<string, number> = {};
    const unanswered: string[] = [];
    const known = new Set(terms(this.chunks.map((c) => c.text).join(" "))); // words the info already covers
    for (const c of this.convos) {
      langs[c.lang] = (langs[c.lang] ?? 0) + 1;
      c.turns.forEach((t, i) => {
        if (t.side !== "customer") return;
        const next = c.turns[i + 1];
        if (next?.side === "eco" && next.cite) topics[next.cite] = (topics[next.cite] ?? 0) + 1;
        else if (!next) {
          unanswered.push(t.out);
          for (const w of terms(t.out).filter((w) => w.length > 3 && !known.has(w))) missing[w] = (missing[w] ?? 0) + 1;
        }
      });
    }
    const gap = Object.entries(missing).sort((a, b) => b[1] - a[1])[0];
    return {
      title: m.title, bizType: m.bizType, ownerLang: m.ownerLang,
      conversations: this.convos.length,
      langs,
      topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([topic, count]) => ({ topic, count })),
      unanswered: unanswered.slice(-10),
      suggestion: gap ? { word: gap[0], count: gap[1] } : null,
    };
  }
}

