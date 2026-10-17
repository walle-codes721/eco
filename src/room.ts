// One Durable Object per room: state, WebSocket fan-out, and every call the room makes.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { tf, isLive } from "./tf";
import { MODELS, LANG_NAMES, turnModel, utterancePrompt, answerPrompt, customerTurnPrompt, ownerTurnPrompt, summaryPrompt, transcriptText, mockSummary, translateAnswerPrompt, cleanTranslations, mockTranslations, pollPrompt, pollAnswersPrompt, slideRowsPrompt } from "./prompts";
import { cleanPoll, validVote, pollView, tally, answerLangs, answerCap, type Poll } from "./poll";
import { lineKey, validReaction, tallyReactions, topLines, type LineReactions } from "./reaction";
import { allergyContext, hasAllergenInfo, isAllergyQuestion, noAllergenInfo, withStaffLine } from "./safety";
import { adviceLine, cleanEmergencyNumber, emergencyLine, isHealthKind, sensitiveKind, type Sensitive } from "./health";
import { bestSentence, chunkPages, contextFingerprint, isEcho, normalize, oneLine, questionKey, selectContext, slidePages, teach, terms, transcriptChunks, type Chunk } from "./retrieve";
import {
  voiceFor, SAMPLE_TEXT, b64, canClone, sampleKey, savedKey, sampleObjectKey, parseVoiceUpload, loadStoredSample, deleteStoredSample, type VoiceMode, type VoiceSampleMime,
} from "./voice";
import { PRESET_VOICES, presetAudioKey, publicPresets } from "./preset-voice";
import { cloneDemand, parseListenerVoice, type ListenerVoice } from "./voice-choice";
import { VOICE_CLIPS_IN_FLIGHT } from "./limits";
import { phraseEvidence } from "./utterance";
import { customerTurn, ownerTurn, type CustomerTurn } from "./counter-turn";
import { translationTiming, timingHeader } from "./timing";
import { DEMO_SLIDES, DEMO_TALK, DEMO_SHOP, DEMO_CONVOS, DEMO_PHARMACY, DEMO_PHARMACY_CONVOS, DEMO_SPEAKERS } from "./fixtures/demo";
import { deckLang, rowsForTranslation, sanitizeDeckPages, type DeckPageRows, DEFAULT_DECK_LANG } from "./slide-rows";
import { parseSlideTranslation, rowTranslationTexts, slideTargetLangs, slidesToTranslate } from "./slide-repaint";

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
  emergency?: string; // counter, pharmacy/clinic/hospital: the local emergency number shown to customers
  deck?: boolean; // stage: the speaker's PDF is in R2, so every screen can show it
  deckLang?: string; // stage: language of the deck's written words (default English)
  speakers?: Speaker[]; // stage: s0 is the host; co-speakers join from their own device
  joinKey?: string; // stage: in the host's "add a speaker" QR
  voiceMode?: VoiceMode; // stage: missing on older rooms = "sample"
  presetsEnabled?: boolean; // stage: listeners may hear bundled preset voices (ADR 0006)
}
/** One device = one speaker. `key` authorises that device; `voice` = a consented sample is stored. */
export interface Speaker { id: string; name: string; key: string; voice: boolean }
export interface Line { speaker?: string; seq: number; t: number; at: number; slide: number; src: string; out: Record<string, string>; flags: string[]; ms: number; live: boolean; audio?: Record<string, string> }
export interface Question { id: string; t: number; at: number; slide: number; lang: string; text: string; q_en: string; covered: boolean; answer: string; cite: string; answeredAt: number | null; taught?: string /* the speaker's typed answer (Teach Eco) */; taughtOut?: Record<string, string> /* that answer in each language of the room, once translated */ }
export interface Turn { id: string; t: number; side: "customer" | "owner" | "eco"; lang: string; src: string; out: string; cite?: string; live: boolean; taught?: boolean /* owner turn already added to the list (Teach Eco) */; allergy?: boolean /* customer turn that asked about allergies, ingredients or diet */; health?: "emergency" | "advice" /* pharmacy, clinic or hospital: the customer asked for urgent help or for medical advice */ }
export interface Convo { id: string; lang: string; started: number; open: boolean; turns: Turn[] }
/** The talk's summary. `n` is the seq of the last line it covers: a newer line makes it stale. */
export interface Summary { n: number; text: Record<string, string>; live: boolean; at: number }
type Answer = { covered: boolean; answer: string; cite: string; q_en: string; sourceSeq?: number; sourceContext?: string };
/** A usable Counter language code, or null: unknown, clipped or regional codes never drive a conversation. */
function cleanCounterLang(v: unknown): string | null {
  const c = String(v ?? "").trim().toLowerCase();
  return /^[a-z]{2}$/.test(c) && LANG_NAMES[c] !== undefined ? c : null;
}

export const DEMOS: Record<string, "stage" | "counter"> = { "stage/eco/demo": "stage", "counter/eco/gelato": "counter", "counter/eco/farmacia": "counter" };
const LIMITS = { ask: [3, 10], voice: [4, 40], turn: [8, 60], react: [60, 300] } as const; // per visitor per hour: [demo, normal]

const rid = () => crypto.randomUUID().replaceAll("-", "");
const MOCK_LINE = "(Mock mode: Eco heard you. Real transcripts and translations need live mode.)";
const json = (data: unknown, status = 200) => Response.json(data, { status });
const uid = () => crypto.randomUUID().slice(0, 8);

/** Raw teleprompter script, parsed on the speaker's laptop. Arrays are the first version's stored phrases. */
const cleanScript = (v: unknown): string => (Array.isArray(v) ? v.join("\n") : String(v ?? "")).slice(0, 50_000).trim();

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
  polls: Poll[] = [];
  reactions: Record<string, LineReactions> = {};
  deckPages: DeckPageRows[] = [];
  /** Teleprompter script text. Host only: never in publicMeta, pages or chunks. */
  script = "";
  slideTranslations: Record<number, Record<string, string[]>> = {};
  private slideTransPending = new Set<number>();
  private summarizing = false;
  private visitors = new Map<string, number>();
  private mockI = 0;
  private clipsInFlight = 0;
  private samples = new Map<string, ArrayBuffer>();
  private sampleMime = new Map<string, VoiceSampleMime>();
  private replayI = 0;
  private replayPausedUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get(["meta", "pages", "chunks", "lines", "questions", "convos", "cache", "peak", "summary", "polls", "deckPages", "slideTranslations", "script", "reactions"]);
      this.meta = (s.get("meta") as Meta) ?? null;
      this.pages = (s.get("pages") as typeof this.pages) ?? [];
      this.chunks = (s.get("chunks") as Chunk[]) ?? [];
      this.lines = (s.get("lines") as Line[]) ?? [];
      this.questions = (s.get("questions") as Question[]) ?? [];
      this.convos = (s.get("convos") as Convo[]) ?? [];
      this.cache = (s.get("cache") as Record<string, Answer>) ?? {};
      this.peak = (s.get("peak") as number) ?? 0;
      this.summary = (s.get("summary") as Summary) ?? null;
      this.polls = (s.get("polls") as Poll[]) ?? [];
      this.deckPages = (s.get("deckPages") as DeckPageRows[]) ?? [];
      this.slideTranslations = (s.get("slideTranslations") as typeof this.slideTranslations) ?? {};
      this.script = cleanScript(s.get("script"));
      this.reactions = (s.get("reactions") as typeof this.reactions) ?? {};
    });
  }

  private save(...keys: ("meta" | "pages" | "chunks" | "lines" | "questions" | "convos" | "cache" | "peak" | "summary" | "polls" | "deckPages" | "slideTranslations" | "script" | "reactions")[]) {
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
      ...(isHealthKind(s(body.bizType, 30)) ? { emergency: cleanEmergencyNumber(body.emergency) } : {}),
    };
    if (mode === "stage") {
      // "saved" needs a signed-in owner who has recorded one; otherwise they record a sample for this talk.
      const want = (["saved", "sample", "phone"] as const).find((v) => v === body.voice) ?? "sample";
      this.meta.voiceMode = want === "saved" && !(owner && (await loadStoredSample(this.env.FILES, savedKey(owner)))) ? "sample" : want;
      this.meta.presetsEnabled = !!body.presetsEnabled;
    }
    const pages: { tag: string; text: string }[] = (Array.isArray(body.pages) ? body.pages : [])
      .slice(0, 200)
      .map((p: any) => ({ tag: s(p.tag, 40), text: s(p.text, 8000) }))
      .filter((p: { text: string }) => p.text);
    if (body.notes) pages.push({ tag: "notes", text: s(body.notes, 20000) });
    this.pages = pages;
    this.chunks = chunkPages(pages);
    this.script = cleanScript(body.script);
    await this.save("meta", "pages", "chunks", "script");
    return { id, hostKey: this.meta.hostKey };
  }

  private async ensureDemo(id: string) {
    if (this.meta || !DEMOS[id]) return;
    if (DEMOS[id] === "stage") {
      await this.init(id, { mode: "stage", title: "Eco: one engine, two rooms", speaker: "Seb", langs: ["it", "es", "hi"], pages: DEMO_SLIDES, demo: true });
    } else {
      const pharmacy = id.endsWith("/farmacia");
      const shop = pharmacy ? DEMO_PHARMACY : DEMO_SHOP;
      await this.init(id, { mode: "counter", title: shop.name, bizType: shop.type, ownerLang: shop.ownerLang, pages: shop.sources, demo: true });
      const t0 = Date.now() - 20 * 60_000;
      this.convos = pharmacy
        ? DEMO_PHARMACY_CONVOS.map((c, i) => {
            const t = t0 + i * 6 * 60_000;
            const turns: Turn[] = [{ id: uid(), t, side: "customer", lang: c.lang, src: c.customer, out: c.to_owner, live: false, ...(c.health ? { health: c.health } : {}) }];
            const line = (lang: string) => (c.health === "emergency" ? emergencyLine(lang, "pharmacy") : adviceLine(lang, "pharmacy"));
            if (c.health) turns.push({ id: uid(), t: t + 2500, side: "eco", lang: c.lang, src: line(c.lang), out: line(shop.ownerLang), cite: "", live: false });
            else if (c.answer?.covered) turns.push({ id: uid(), t: t + 2500, side: "eco", lang: c.lang, src: c.answer.text, out: c.answer.text_owner, cite: c.answer.cite, live: false });
            return { id: `seed${i}`, lang: c.lang, started: t, open: !!c.health || !c.answer?.covered, turns };
          })
        : DEMO_CONVOS.map((c, i) => {
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
      emergency: m.emergency, // pharmacy, clinic, hospital: shown to customers; absent for every other kind of shop
      live: isLive(this.env),
      slides: m.mode === "stage" ? slidePages(this.pages) : [],
      deck: !!m.deck,
      deckLang: m.deckLang ?? DEFAULT_DECK_LANG,
      speakers: (m.speakers ?? []).map(({ id, name, voice }) => ({ id, name, voice })),
      voice: m.voiceMode !== "phone" && canClone(this.env),
      voiceMode: m.voiceMode ?? "sample",
      presetsEnabled: !!m.presetsEnabled,
      presets: m.presetsEnabled ? publicPresets() : [],
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
      m.speakers = m.demo ? DEMO_SPEAKERS.map((name, i) => ({ id: `s${i}`, name, key: "", voice: false })) : [{ id: "s0", name: m.speaker || "Speaker", key: "", voice: m.voiceMode === "saved" }];
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
        return json({ ...this.publicMeta(), host: isHost, me: me?.id ?? null, ...(me ? { sampleText: SAMPLE_TEXT } : {}), ...(isHost ? { joinKey: m.joinKey, script: this.script } : {}) });
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
      case "POST vote":
        return this.vote(await req.json().catch(() => ({})));
      case "POST react":
        return this.react(await req.json().catch(() => ({})), ip);
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
        if (!this.talkVoiceAllowed(me)) return json({ error: "Not allowed" }, 403);
        if (req.headers.get("x-consent") !== "yes") return json({ error: "Consent needed" }, 400);
        const parsed = parseVoiceUpload(req.headers.get("content-type") ?? "", await req.arrayBuffer());
        if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
        const prefix = sampleKey(m, me!.id);
        await deleteStoredSample(this.env.FILES, prefix);
        await this.env.FILES.put(sampleObjectKey(prefix, parsed.ext), parsed.bytes, { httpMetadata: { contentType: parsed.mime } });
        this.samples.set(me!.id, parsed.bytes);
        this.sampleMime.set(me!.id, parsed.mime);
        me!.voice = true;
        await this.save("meta");
        this.sendSpeakers();
        return json({ ok: true });
      }
      case "DELETE voice": {
        if (!this.talkVoiceAllowed(me)) return json({ error: "Not allowed" }, 403); // a saved voice is deleted from /me
        const prefix = sampleKey(m, me!.id);
        await deleteStoredSample(this.env.FILES, prefix);
        this.samples.delete(me!.id);
        this.sampleMime.delete(me!.id);
        me!.voice = false;
        await this.save("meta");
        this.sendSpeakers();
        return json({ ok: true });
      }
      case "GET convos":
        return isHost || m.demo ? json({ convos: this.convos }) : json({ error: "Not allowed" }, 403);
      case "GET slidetr": {
        // Listeners read this: a slide's stored rows and, for their language, the words to paint. No call is made here.
        if (m.mode !== "stage" || !m.deck) return json({ error: "Not here" }, 404);
        const n = Math.floor(Number(url.searchParams.get("n")));
        const asked = url.searchParams.get("lang") ?? "";
        const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(asked) ? asked : "en";
        const deckL = m.deckLang ?? DEFAULT_DECK_LANG;
        const rows = n >= 1 && n <= 200 ? this.deckRowsForSlide(n) : [];
        return json({ deckLang: deckL, rows, paints: rowTranslationTexts(rows, this.slideTranslations[n], lang, deckL) });
      }
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
      if (m.status !== "ended") this.ctx.waitUntil(this.ensureSlideTranslations(m.slide)); // the first slides are ready before listeners look
      return json({ ok: true });
    }
    if (`${req.method} ${action}` === "GET sources") return json({ pages: this.pages });
    if (`${req.method} ${action}` === "GET deckrows") return json({ deckLang: m.deckLang ?? DEFAULT_DECK_LANG, pages: this.deckPages });
    if (`${req.method} ${action}` === "POST deckrows") {
      if (m.mode !== "stage" || m.demo) return json({ error: "Not here" }, 400);
      const body: any = await req.json().catch(() => ({}));
      m.deckLang = deckLang(body.deckLang);
      this.deckPages = sanitizeDeckPages(body.pages);
      this.slideTranslations = {};
      await this.save("meta", "deckPages", "slideTranslations");
      if (m.status !== "ended") this.ctx.waitUntil(this.ensureSlideTranslations(m.slide)); // a new or swapped deck, in the lobby or mid-talk
      return json({ ok: true, pages: this.deckPages.length });
    }
    const body: any = await req.json().catch(() => ({}));
    if (`${req.method} ${action}` === "POST script") {
      this.script = cleanScript(body.script);
      await this.save("script");
      return json({ script: this.script });
    }
    switch (`${req.method} ${action}`) {
      case "POST slide": {
        m.slide = Math.max(1, Math.min(Number(body.n) || 1, Math.max(1, slidePages(this.pages).length)));
        await this.save("meta");
        this.send(["listener", "screen", "host"], { type: "slide", n: m.slide });
        this.ctx.waitUntil(this.ensureSlideTranslations(m.slide));
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
      case "POST poll":
        return this.newPoll(body);
      case "POST pollclose":
        return this.closePoll(String(body.pid ?? ""));
      case "POST addanswer":
        return m.mode === "stage" ? this.teachQuestion(body) : this.teachAnswer(body);
      case "POST presets": {
        if (m.mode !== "stage" || m.demo) return json({ error: "Not here" }, 400);
        m.presetsEnabled = !!body.enabled;
        await this.save("meta");
        const presets = m.presetsEnabled ? publicPresets() : [];
        this.send(["listener", "screen", "host", "speaker"], { type: "presets", presetsEnabled: m.presetsEnabled, presets });
        return json({ ok: true, presetsEnabled: m.presetsEnabled, presets });
      }
    }
    return json({ error: "Unknown action" }, 404);
  }

  /** Per-talk voice sample on this speaker's device (not the account saved voice on s0). */
  private talkVoiceAllowed(me: Speaker | undefined): me is Speaker {
    const m = this.meta!;
    if (!me || m.demo || m.voiceMode === "phone") return false;
    if (m.voiceMode === "saved" && me.id === "s0" && m.owner) return false;
    return true;
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
    // The speaker has reached the current slide: translate it and the next (already stored slides make no call).
    if (status === "live" && m.mode === "stage") this.ctx.waitUntil(this.ensureSlideTranslations(m.slide));
    return { status };
  }

  // ---------- WebSockets (hibernation API) ----------

  private openSocket(url: URL, isHost: boolean, me?: Speaker): Response {
    const role = url.searchParams.get("role") ?? "listener";
    if ((role === "host" || role === "owner") && !isHost && !this.meta!.demo) return json({ error: "Not allowed" }, 403);
    if (role === "speaker" && !me) return json({ error: "Not allowed" }, 403);
    const lang = (url.searchParams.get("lang") ?? "en").slice(0, 5);
    const voice = parseListenerVoice(url.searchParams.get("voice"));
    const cid = (url.searchParams.get("cid") ?? "").slice(0, 40);
    const pair = new WebSocketPair();
    const tags = [role, `lang:${lang}`, ...(cid ? [`c:${cid}`] : [])];
    this.ctx.acceptWebSocket(pair[1], tags);
    pair[1].serializeAttachment({
      role, lang, voice, cid, speaker: role === "host" || role === "speaker" ? me?.id ?? "s0" : null,
    });

    const m = this.meta!;
    const hello: Record<string, unknown> = { type: "hello", meta: this.publicMeta() };
    // 50 = the client's line buffer (public/js/pages/listener.js); the two must stay in lockstep,
    // otherwise a late joiner can't scroll back through everything a long-time listener has.
    if (m.mode === "stage") hello.lines = this.lines.slice(-50);
    if (role === "host") (hello.board = this.board()), (hello.polls = this.hostPolls());
    if (role === "listener") hello.polls = this.polls.filter((p) => p.open || p.share).map((p) => pollView(p, p.share));
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
    if (d.type === "voice") {
      ws.serializeAttachment({ ...ws.deserializeAttachment(), voice: parseListenerVoice(d.voice) });
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

  private connectedListeners(): { lang: string; voice: ListenerVoice }[] {
    return this.ctx.getWebSockets("listener").map((ws) => {
      const att = ws.deserializeAttachment();
      return { lang: att?.lang ?? "en", voice: parseListenerVoice(att?.voice) };
    });
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

  private deckPageCount() {
    return Math.max(this.deckPages.reduce((m, p) => Math.max(m, p.n), 0), slidePages(this.pages).length, 1);
  }

  private deckRowsForSlide(n: number) {
    const page = this.deckPages.find((p) => p.n === n);
    return page && !page.skip ? page.rows : []; // a skipped slide has nothing to translate or paint
  }

  private async ensureSlideTranslations(currentSlide: number) {
    const m = this.meta!;
    if (m.mode !== "stage" || !m.deck || !this.deckPages.length) return;
    const stored = new Set(Object.keys(this.slideTranslations).map(Number));
    const due = slidesToTranslate(currentSlide, this.deckPageCount(), stored, (n) => rowsForTranslation(this.deckRowsForSlide(n)).length);
    for (const n of due) await this.translateSlide(n);
  }

  private async translateSlide(n: number) {
    const m = this.meta!;
    if (this.slideTransPending.has(n) || this.slideTranslations[n]) return;
    const rows = this.deckRowsForSlide(n);
    const phrases = rowsForTranslation(rows);
    if (!phrases.length) return;
    const langs = slideTargetLangs(m.langs, m.deckLang ?? DEFAULT_DECK_LANG); // includes English
    if (!langs.length) return;
    if (!isLive(this.env)) return; // mock: original words, no API call
    this.slideTransPending.add(n);
    try {
      const r = await tf(this.env, "slide", MODELS.answer, slideRowsPrompt(m.deckLang ?? DEFAULT_DECK_LANG, langs, phrases), {
        pub: m.demo,
        mock: () => ({ out: {} }), // not reached: mock rooms return above and keep the original words
      });
      if (r.data === null) return;
      const parsed = parseSlideTranslation(r.data, langs, phrases.length);
      if (!parsed) return;
      this.slideTranslations[n] = parsed;
      await this.save("slideTranslations");
      this.send(["listener"], { type: "slidetr", n });
    } finally {
      this.slideTransPending.delete(n);
    }
  }

  private async utterance(req: Request, tryVoice: boolean, speaker: string): Promise<Response> {
    const receivedAt = Date.now();
    const timing = req.headers.get("x-eco-timing") === "1" ? translationTiming() : undefined;
    const reply = (body: unknown, status = 200) => {
      const res = json(body, status);
      if (timing) res.headers.set("server-timing", timingHeader(timing, Date.now() - receivedAt));
      return res;
    };
    const m = this.meta!;
    if (m.status === "ended") return reply({ error: "Talk ended" }, 409);
    // Text from the browser's speech recognition (JSON), or a WAV for MiMo.
    let input: { text?: string; wavB64?: string };
    if (req.headers.get("content-type")?.startsWith("application/json")) {
      const text = String(((await req.json().catch(() => ({}))) as { text?: unknown }).text ?? "").trim().slice(0, 500);
      if (!text) return reply({ empty: true });
      input = { text };
    } else {
      const buf = await req.arrayBuffer();
      if (buf.byteLength < 1000 || buf.byteLength > 800_000) return reply({ error: "Bad audio" }, 413);
      input = { wavB64: b64(buf) };
    }
    const t0 = Date.now();
    if (tryVoice) this.replayPausedUntil = Date.now() + 45_000;

    const prev = this.lines.slice(-2).map((l) => l.src);
    // English is always offered to listeners; the original speech may be in any language.
    // Include it in the same phrase call, with the existing output cap and budget admission.
    const langs = [...new Set(["en", ...m.langs])];
    const r = await tf(this.env, "utterance", turnModel(input), utterancePrompt(input, langs, prev), {
      pub: m.demo,
      timing,
      mock: () => {
        // Mock mode cannot translate arbitrary speech: keep original-text fallback for missing English.
        if (!m.demo) return { src: input.text ?? MOCK_LINE, out: Object.fromEntries(m.langs.map((l) => [l, MOCK_LINE])), flags: ["mock"] };
        const d = DEMO_TALK[this.mockI++ % DEMO_TALK.length];
        return { src: d.src, out: Object.fromEntries(langs.map((l) => [l, d.out[l] ?? d.src])), flags: [] as string[] }; // demo originals are English
      },
    });
    if (r.data === null && !(r.invalidOutput && input.text)) {
      const why = "why" in r && r.why ? `${r.fallback}, ${r.why}` : r.fallback;
      this.send(["host"], { type: "notice", level: "warn", text: `Translation paused (${why}).` });
      return reply({ fallback: why }, 503);
    }
    const evidence = phraseEvidence(r.data, m.demo && !r.live ? undefined : input.text, langs);
    if (!evidence.src) {
      if (r.data && typeof r.data.src === "string" && !r.data.src.trim()) return reply({ empty: true });
      return reply({ fallback: "No complete transcript was returned" }, 503);
    }
    if (r.live && isEcho(this.lines, speaker, evidence.src, Date.now())) return reply({ dup: true });
    if (r.live && evidence.incomplete) {
      this.send(["host", "speaker"], { type: "notice", level: "warn", text: "Some translations are unavailable. The original speech was kept; no translation retry was made." });
    }
    if (m.status === "lobby") await this.setStatus("live");
    const line = await this.addLine({ speaker, src: evidence.src, out: evidence.out, flags: evidence.flags, ms: Date.now() - t0, live: r.live });
    return reply({ line });
  }

  private async addLine(p: Pick<Line, "speaker" | "src" | "out" | "flags" | "ms" | "live">): Promise<Line> {
    const line: Line = { seq: (this.lines.at(-1)?.seq ?? 0) + 1, t: Date.now(), at: this.elapsed(), slide: this.meta!.slide, ...p };
    this.lines.push(line);
    if (this.lines.length > 600) this.lines.splice(0, this.lines.length - 600);
    await this.save("lines");
    this.send(["listener", "screen", "host", "speaker"], { type: "line", line });
    this.ctx.waitUntil(Promise.allSettled([this.cloneSpeaker(line), this.clonePresets(line)]));
    return line;
  }

  /** At most VOICE_CLIPS_IN_FLIGHT cloned clips per room; busy pairs fall back to the phone voice. */
  private async clonedClip(run: () => Promise<ArrayBuffer | null>): Promise<ArrayBuffer | null> {
    if (this.clipsInFlight >= VOICE_CLIPS_IN_FLIGHT) return null;
    this.clipsInFlight++;
    try {
      return await run();
    } finally {
      this.clipsInFlight--;
    }
  }

  /** The line in its speaker's cloned voice, one clip per language that has listeners right now. */
  private async cloneSpeaker(line: Line) {
    const sp = this.meta!.speakers?.find((s) => s.id === line.speaker);
    if (this.meta!.voiceMode === "phone" || !canClone(this.env) || !sp?.voice) return;
    const langs = cloneDemand(this.connectedListeners(), line.out).speakerLangs;
    if (!langs.length) return;
    let sample = this.samples.get(sp.id);
    let mime = this.sampleMime.get(sp.id) ?? "audio/wav";
    if (!sample) {
      const stored = await loadStoredSample(this.env.FILES, sampleKey(this.meta!, sp.id));
      if (!stored) return;
      sample = stored.bytes;
      mime = stored.mime;
      this.samples.set(sp.id, sample);
      this.sampleMime.set(sp.id, mime);
    }
    const audio: Record<string, string> = {};
    await Promise.allSettled(langs.map(async (lang) => {
      const wav = await this.clonedClip(() => voiceFor(this.env, sample!, line.out[lang], lang, mime));
      if (!wav || !this.lines.includes(line)) return;
      const k = `${line.seq}-${line.t}-${lang}`;
      await this.env.FILES.put(`${this.meta!.id}/audio/${k}.wav`, wav);
      if (!this.lines.includes(line)) return;
      const url = `/api/rooms/${this.meta!.id}/audio?k=${k}`;
      audio[lang] = url;
      line.audio = { ...line.audio, [lang]: url };
      this.send(["listener"], { type: "audio", seq: line.seq, audio: { [lang]: url } });
    }));
    if (Object.keys(audio).length && this.lines.includes(line)) await this.save("lines");
  }

  /** Preset voice clips when the speaker enabled them for this talk. */
  private async clonePresets(line: Line) {
    const m = this.meta!;
    if (!m.presetsEnabled || m.voiceMode === "phone" || !canClone(this.env)) return;
    const demand = cloneDemand(this.connectedListeners(), line.out);
    if (!Object.keys(demand.presetLangs).length) return;
    for (const preset of PRESET_VOICES) {
      const langs = demand.presetLangs[preset.id] ?? [];
      if (!langs.length) continue;
      const refText = preset.referenceTranscript;
      const sample = preset.clip();
      const audio: Record<string, string> = {};
      await Promise.allSettled(langs.map(async (lang) => {
        const wav = await this.clonedClip(() => voiceFor(this.env, sample, line.out[lang], lang, preset.mime, refText));
        if (!wav || !this.lines.includes(line)) return;
        const k = `${line.seq}-${line.t}-${lang}-${preset.id}`;
        await this.env.FILES.put(`${m.id}/audio/${k}.wav`, wav);
        if (!this.lines.includes(line)) return;
        const url = `/api/rooms/${m.id}/audio?k=${k}`;
        const field = presetAudioKey(lang, preset.id);
        audio[field] = url;
        line.audio = { ...line.audio, [field]: url };
        this.send(["listener"], { type: "audio", seq: line.seq, audio: { [field]: url } });
      }));
      if (Object.keys(audio).length && this.lines.includes(line)) await this.save("lines");
    }
  }

  /** Deck chunks plus what the speaker has said so far, ~150 words per transcript chunk. */
  private sourceChunks(): Chunk[] {
    return [...this.chunks, ...transcriptChunks(this.lines)];
  }

  private async ask(body: any, ip: string): Promise<Response> {
    const m = this.meta!;
    const text = String(body.text ?? "").trim().slice(0, 300);
    const lang = String(body.lang ?? "en").slice(0, 5);
    if (!text) return json({ error: "Empty question" }, 400);
    const key = questionKey(text, lang);
    const sourceSeq = this.lines.at(-1)?.seq ?? 0;
    const sourceSlide = m.slide;
    const chunks = m.mode === "stage" ? this.sourceChunks() : this.chunks;
    // Reuse room context, not a guessed translation: taught sources and lexical hits retain priority.
    const fallbackTags = m.mode === "stage"
      ? [`slide ${sourceSlide}`, ...chunks.slice(this.chunks.length).slice(-2).reverse().map((c) => c.tag)]
      : [];
    const { picked, best } = selectContext(chunks, text, 1500, fallbackTags);
    const sourceContext = m.mode === "stage" ? await contextFingerprint(picked) : undefined;
    let a: Answer | undefined = this.cache[key];
    if (m.mode === "stage" && (a?.sourceSeq !== sourceSeq || a?.sourceContext !== sourceContext)) a = undefined;
    let fromCache = !!a;
    if (!a) {
      if (!this.allow(ip, "ask")) return json({ error: "limit" }, 429);
      const r = await tf<Answer>(this.env, "ask", MODELS.answer, answerPrompt(picked, text, lang), {
        pub: m.demo,
        mock: () => {
          const b = bestSentence(text, best, lang);
          return { covered: b.covered, answer: b.text, cite: b.cite, q_en: text };
        },
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const tags = new Set(chunks.map((c) => c.tag));
      const cite = tags.has(r.data.cite) ? r.data.cite : r.data.covered ? best?.tag ?? "" : "";
      a = { covered: !!r.data.covered && !!r.data.answer, answer: String(r.data.answer ?? ""), cite, q_en: String(r.data.q_en || text), sourceSeq, sourceContext };
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
      reactions: this.reactionCard(),
    };
  }

  /** Reactions for the Post-talk card: the series per Line (for a later chart) and the 3 Lines that drew the most. */
  private reactionCard() {
    const series = tallyReactions(this.reactions);
    const byKind: Record<string, number> = {};
    for (const x of series) for (const [r, n] of Object.entries(x.counts)) byKind[r] = (byKind[r] ?? 0) + n!;
    const top = topLines(series.filter((x) => this.lines.some((l) => l.seq === x.seq && l.t === x.t)))
      .map((x) => ({ ...x, text: this.lines.find((l) => l.seq === x.seq && l.t === x.t)!.src }));
    return { total: series.reduce((s, x) => s + x.n, 0), byKind, series, top };
  }

  // ---------- Reactions ----------

  /** A Listener reacts to a Line: one reaction per voter per Line, the last one counts, null clears. Private: only the Screen hears it, anonymously. */
  private async react(body: any, ip: string): Promise<Response> {
    const voter = String(body.voter ?? "").slice(0, 40);
    const r = validReaction(body.r);
    if (!voter || r === undefined) return json({ error: "Bad reaction" }, 400);
    const l = this.lines.find((x) => x.seq === body.seq && x.t === body.t);
    if (!l) return json({ error: "That line is gone" }, 404);
    if (!this.allow(ip, "react")) return json({ error: "busy" }, 429);
    const k = lineKey(l.seq, l.t);
    const x = (this.reactions[k] ??= { seq: l.seq, t: l.t, at: l.at, slide: l.slide, by: {} });
    if (r === null) delete x.by[voter];
    else if (!x.by[voter] && Object.keys(x.by).length >= 2000) return json({ error: "full" }, 409);
    else x.by[voter] = r;
    if (!Object.keys(x.by).length) delete this.reactions[k];
    await this.save("reactions");
    if (r) this.send(["screen"], { type: "react", r });
    return json({ ok: true });
  }

  // ---------- Polls ----------

  private hostPolls() {
    return this.polls.map((p) => pollView(p, true));
  }

  /** The speaker sends a poll: one call puts it into every room language. Nothing reaches listeners if that call fails. */
  private async newPoll(body: any): Promise<Response> {
    const m = this.meta!;
    if (m.mode !== "stage") return json({ error: "Not a stage" }, 400);
    if (this.polls.length >= 30) return json({ error: "Up to 30 polls per talk" }, 409);
    const d = cleanPoll(body);
    if (!d) return json({ error: "Check the question and its options" }, 400);
    const langs = [...new Set(["en", ...m.langs])].filter((l) => l !== d.lang);
    const p: Poll = { id: uid(), t: Date.now(), kind: d.kind, lang: d.lang, q: { [d.lang]: d.q }, options: { [d.lang]: d.options }, min: d.min, max: d.max, share: d.share, open: true, answers: [] };
    if (langs.length) {
      const r = await tf<{ q: Record<string, string>; options: Record<string, string[]> }>(this.env, "poll", MODELS.answer, pollPrompt(d.q, d.options, d.lang, langs), {
        pub: m.demo,
        mock: () => ({ q: Object.fromEntries(langs.map((l) => [l, d.q])), options: Object.fromEntries(langs.map((l) => [l, d.options])) }),
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      for (const l of langs) {
        const q = r.data.q?.[l], o = r.data.options?.[l];
        p.q[l] = typeof q === "string" && q.trim() ? q.trim().slice(0, 300) : d.q; // a missing language reads the original
        p.options[l] = Array.isArray(o) && o.length === d.options.length && o.every((x) => typeof x === "string" && x.trim()) ? o.map((x) => x.trim().slice(0, 120)) : d.options;
      }
    }
    this.polls.push(p);
    await this.save("polls");
    this.send(["listener"], { type: "poll", poll: pollView(p, p.share) });
    this.send(["host"], { type: "polls", polls: this.hostPolls() });
    return json({ id: p.id });
  }

  /** A listener answers. No AI call: choices are indexes, free text waits for the close. One answer per voter, the last one counts. */
  private async vote(body: any): Promise<Response> {
    const p = this.polls.find((x) => x.id === body.pid);
    if (!p?.open) return json({ error: "This poll is closed" }, 409);
    const voter = String(body.voter ?? "").slice(0, 40);
    const a = validVote(p, body.a);
    if (!voter || a === null) return json({ error: "Bad answer" }, 400);
    const lang = String(body.lang ?? "en").slice(0, 5);
    const i = p.answers.findIndex((x) => x.voter === voter);
    if (i >= 0) p.answers[i] = { voter, lang, a };
    else if (p.answers.length >= 2000) return json({ error: "This poll is full" }, 409);
    else p.answers.push({ voter, lang, a });
    await this.save("polls");
    this.send(["host"], { type: "polls", polls: this.hostPolls() });
    if (p.share) this.send(["listener"], { type: "tally", pid: p.id, tally: tally(p) });
    return json({ ok: true });
  }

  /**
   * The speaker closes a poll. Free answers get one call into every language they must be read in.
   * It closes even if that call fails; closing again retries only what's still missing.
   */
  private async closePoll(pid: string): Promise<Response> {
    const m = this.meta!;
    const p = this.polls.find((x) => x.id === pid);
    if (!p) return json({ error: "No such poll" }, 404);
    p.open = false;
    let failed: string | null = null;
    if (p.kind === "free") {
      const langs = answerLangs(p);
      for (const x of p.answers) x.out = { ...x.out, ...(langs.includes(x.lang) ? { [x.lang]: String(x.a) } : {}) };
      // ponytail: answers past the cap stay in their own words; batch in several calls if talks get that big.
      const todo = p.answers.filter((x) => langs.some((l) => !x.out?.[l])).slice(0, answerCap(p));
      const want = [...new Set(todo.flatMap((x) => langs.filter((l) => !x.out?.[l])))];
      if (todo.length) {
        const texts = todo.map((x) => String(x.a));
        const r = await tf<{ out: Record<string, string[]> }>(this.env, "poll", MODELS.answer, pollAnswersPrompt(texts, want, p.share), {
          pub: m.demo,
          mock: () => ({ out: Object.fromEntries(want.map((l) => [l, texts])) }),
        });
        if (r.data === null) failed = r.fallback;
        else
          for (const l of want) {
            const o = r.data.out?.[l];
            if (!Array.isArray(o) || o.length !== texts.length) continue; // a language came back short: leave it missing, a second close retries
            todo.forEach((x, i) => typeof o[i] === "string" && o[i].trim() && !x.out![l] && (x.out![l] = o[i].trim().slice(0, 300)));
          }
      }
    }
    await this.save("polls");
    this.send(["listener"], { type: "pollclose", pid, poll: p.share ? pollView(p, true) : null });
    this.send(["host"], { type: "polls", polls: this.hostPolls() });
    return failed ? json({ error: "busy", fallback: failed }, 503) : json({ ok: true });
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
      this.reactions = {}; // they were on the old loop's Lines
      this.summary = null; // it described the old loop
      this.questions = this.questions.slice(-30);
      m.startedAt = Date.now();
      m.slide = 1;
      await this.save("lines", "meta", "questions", "summary", "reactions");
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
      convo = { id: cid, lang: cleanCounterLang(hint) ?? "en", started: Date.now(), open: false, turns: [] };
      this.convos.push(convo);
      if (this.convos.length > 300) this.convos.shift();
    }
    const input = wav ? { wavB64: b64(wav) } : { text };
    const added: Turn[] = [];

    if (side === "customer") {
      // Allergy and diet questions never rest on the AI alone: it always reads the owner's allergen text,
      // the program adds the confirm line, and the owner is told. See safety.ts.
      const askedAllergy = isAllergyQuestion(text);
      // Pharmacy, clinic, hospital: emergencies and medical advice get a fixed line and never an answer from the model (see health.ts).
      // Such a message is sent to the AI only to be translated for the owner, with none of the shop's list, since its answer is thrown away.
      const kind = isHealthKind(m.bizType) ? m.bizType : null;
      const sensitive = kind ? sensitiveKind(text) : null;
      const usual = sensitive ? [] : selectContext(this.chunks, text).picked;
      const picked = askedAllergy && !sensitive ? allergyContext(this.chunks, usual) : usual;
      const selectedLang = wav ? undefined : cleanCounterLang(body.lang) ?? convo.lang;
      const r = await tf<CustomerTurn>(this.env, "turn", turnModel(input), customerTurnPrompt({ name: m.title, type: m.bizType, ownerLang: m.ownerLang }, picked, input, selectedLang), {
        pub: m.demo,
        mock: () => {
          if (!text && !m.demo) return { src: MOCK_LINE, lang: hint, to_owner: MOCK_LINE, answer: { covered: false, text: "", text_owner: "", cite: "" } };
          const seed = !m.demo || !m.id.endsWith("/gelato") ? null : text ? DEMO_CONVOS.find((c) => normalize(c.customer) === normalize(text)) : DEMO_CONVOS[this.mockI++ % DEMO_CONVOS.length];
          if (seed) return { src: seed.customer, lang: seed.lang, to_owner: seed.to_owner, answer: seed.answer };
          const b = bestSentence(text, selectContext(this.chunks, text).best);
          return { src: text, lang: hint, to_owner: text, answer: { covered: b.covered, text: b.text, text_owner: b.text, cite: b.cite } };
        },
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const d = customerTurn(r.data);
      if (!d) return json({ error: "Invalid Counter response. Please try again.", fallback: "error" }, 503);
      // Language precedence: a typed turn carries the customer's explicit selector
      // choice, so the hint is authoritative and model detection must not silently
      // override it (German misdetected as Hindi would relabel the convo, mistranslate
      // the next owner reply and mis-voice the customer). Detection still applies to
      // raw audio, where the spoken language is genuinely unknown to the client, and a
      // changed selector takes effect on the next typed turn. A missing or unusable
      // hint keeps the existing language.
      if (wav) {
        const detected = cleanCounterLang(d.lang);
        if (detected) convo.lang = detected;
      } else {
        const selected = cleanCounterLang(body.lang);
        if (selected) convo.lang = selected;
      }
      const allergy = askedAllergy || isAllergyQuestion(d.src) || isAllergyQuestion(d.to_owner); // a spoken question is only known after it is transcribed
      // A spoken question is only known after it is transcribed, so look at what the AI heard as well. An emergency beats advice.
      const heard: Sensitive[] = kind ? [sensitive, sensitiveKind(d.src), sensitiveKind(d.to_owner)] : [];
      const health: Sensitive = heard.includes("emergency") ? "emergency" : heard.includes("advice") ? "advice" : null;
      added.push({ id: uid(), t: Date.now(), side: "customer", lang: convo.lang, src: d.src, out: d.to_owner, live: r.live, ...(allergy ? { allergy: true } : {}), ...(health ? { health } : {}) });
      const covered = d.answer.covered;
      if (kind && health) {
        // The fixed line, in the customer's language and the owner's. The AI's own answer is discarded.
        const line = (lang: string) => (health === "emergency" ? emergencyLine(lang, kind, m.emergency) : adviceLine(lang, kind));
        added.push({ id: uid(), t: Date.now(), side: "eco", lang: convo.lang, src: line(convo.lang), out: line(m.ownerLang), cite: "", live: r.live });
        convo.open = true; // the owner is told, whatever the customer asks next
      } else if (allergy) {
        if (covered && hasAllergenInfo(this.chunks)) {
          // The owner's own words, plus a line the program adds, never one the AI has to remember.
          added.push({ id: uid(), t: Date.now(), side: "eco", lang: convo.lang, src: withStaffLine(d.answer.text, convo.lang), out: withStaffLine(d.answer.text_owner || d.answer.text, m.ownerLang), cite: d.answer.cite, live: r.live });
        } else {
          // Nothing the owner wrote answers it (or the AI claimed an answer from a list that never mentions allergens): never guess.
          added.push({ id: uid(), t: Date.now(), side: "eco", lang: convo.lang, src: noAllergenInfo(convo.lang), out: noAllergenInfo(m.ownerLang), cite: "", live: r.live });
        }
        convo.open = true; // the owner is told, even when Eco answered
      } else {
        if (covered) added.push({ id: uid(), t: Date.now(), side: "eco", lang: convo.lang, src: d.answer.text, out: d.answer.text_owner || d.answer.text, cite: d.answer.cite, live: r.live });
        // An allergy, emergency or medical question the owner has not yet answered keeps the conversation open, whatever the customer asks next.
        let pending = false;
        for (let i = convo.turns.length - 1; i >= 0 && convo.turns[i].side !== "owner"; i--) if (convo.turns[i].allergy || convo.turns[i].health) pending = true;
        convo.open = !covered || pending;
      }
    } else {
      const r = await tf<{ src: string; out: string }>(this.env, "turn", turnModel(input), ownerTurnPrompt(m.ownerLang, convo.lang, input), {
        pub: m.demo,
        mock: () => ({ src: text || "(audio)", out: text || "(audio)" }),
      });
      if (r.data === null) return json({ error: "busy", fallback: r.fallback }, 503);
      const d = ownerTurn(r.data);
      if (!d) return json({ error: "Invalid Counter response. Please try again.", fallback: "error" }, 503);
      added.push({ id: uid(), t: Date.now(), side: "owner", lang: m.ownerLang, src: d.src, out: d.out, live: r.live });
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
    this.ctx.waitUntil(this.translateTaught(asked.map((q) => q.id), answer)); // after the reply: saving never waits for a translation
    return json({ ok: true, added: r.added, answered: asked.length, chunks: this.chunks.length });
  }

  /**
   * The speaker's typed answer in every language of the room, so a waiting listener reads it in their own language.
   * One call, best effort: if it is refused, fails or comes back unusable, listeners keep the speaker's own text.
   */
  private async translateTaught(ids: string[], answer: string): Promise<void> {
    const m = this.meta!;
    const langs = [...new Set(["en", ...m.langs])];
    try {
      const r = await tf<Record<string, string>>(this.env, "ask", MODELS.answer, translateAnswerPrompt(answer, langs), {
        pub: m.demo,
        mock: () => mockTranslations(answer, langs),
      });
      if (r.data === null) return;
      const out = cleanTranslations(r.data, langs);
      if (!Object.keys(out).length) return;
      for (const q of this.questions) if (ids.includes(q.id)) q.taughtOut = out;
      await this.save("questions");
      this.send(["listener"], { type: "answerTranslated", qids: ids, answers: out });
    } catch {
      // the original text is already on their screens
    }
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

