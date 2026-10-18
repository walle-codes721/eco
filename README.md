# Eco

[Live Site](https://eco.linolabs.co)

**Eco translates the room, answers from the source, and tells the person in charge what nobody understood.**

One engine, two rooms, all in the browser:

- **Stage.** One or more speakers talk in English. Listeners scan a QR code and follow live captions in Italian, Spanish or Hindi on their own phone, and hear each speaker **in that speaker's own cloned voice, in the listener's language**. Every line says who said it, and the page shows who is speaking right now. Listeners can ask the talk a question, and the answer comes only from the slides and the speaker's words, citing the slide. The speaker's board shows what people asked and which slide raised the most questions. Listeners get a recap at the end.
- **Counter.** Any business (café, shop, salon…) prints a QR sticker. A customer talks or types in their language and the owner reads it in Italian. Questions about prices, allergens or hours are answered right away from the owner's own info, and Eco never invents them. Everything else goes to the owner, translated. One iPad can also run face-to-face in split screen. The owner gets a weekly card.

Built for the lablab.ai **AMD Developer Hackathon ACT III**. Runs on **AMD Token Factory**:

| Job | Model | Calls |
|---|---|---|
| Speech → transcript + every language | `MiMo-V2.6-Flash` (audio in, strict JSON schema) | 1 per phrase, for all listeners and languages |
| Answers from the source | `Gemma-4-31B-IT` | 1 per new question (cached) |
| Counter turn, typed: translate + answer from the info | `Gemma-4-31B-IT` | 1 per turn |
| Counter turn, spoken: transcript + translate + answer | `MiMo-V2.6-Flash` (audio in) | 1 per turn |
| Menu photo → text | `MiMo-V2.6-Flash` (image in) | 1 per photo, once |
| Speaker's cloned voice in each language | OmniVoice (k2-fsa), backup Chatterbox Multilingual (Resemble AI), from a 10 s consented sample. On a Hugging Face Space (`voice/`) until AMD hosts it | 1 clip per phrase per language with listeners |

Gemma (Google DeepMind's open model, running on AMD GPUs through Token Factory) does every text-in job; MiMo is used only where the input is audio or a photo, which Gemma on Token Factory doesn't take.

Retrieval is local BM25 keyword scoring, so it costs zero tokens. Knowing who is speaking costs nothing either: each speaker uses their own device and mic, so every line is tagged by the device it came from.

**Questions across languages.** Stage searches both the original transcript and its existing translated captions. For example, a Hindi question such as “यह कंपनी कितने देशों में काम करती है?” can find the English phrase “We operate in 15 countries” through its Hindi caption, even when earlier slides fill the context window. Only the original source text is sent as evidence to the answer model, which is asked to answer in the listener's selected language. This adds no translation call and keeps the existing context allowance. Answers are cached while the transcript and selected evidence are unchanged. Slide navigation alone does not trigger another answer call if the ordered source tags and text are identical; changed evidence, new speech or source edits cause reevaluation.

When captions are missing, Stage uses the **current slide** and **two most recent transcript chunks** as fallback context before filling from source order. Keyword matches remain first. When keyword hits and distinct fallback sources would exceed the 1,500 estimated source-token allowance, up to 20% (300 tokens) of that same allowance is reserved for fallback excerpts, shared across those sources. Sources that all fit are kept intact. This gives the answer model useful English evidence without claiming the question matched that evidence; fallback text alone never becomes a mock answer or a substitute citation.

This is keyword retrieval plus contextual fallback, not universal semantic search. Relevant material on another slide can still be missed without shared keywords or translated captions, and facts beyond a truncated excerpt can still be omitted. Mock mode quotes matching source text or stored captions, rather than generating a translation; a Hindi question with only English fallback evidence still returns “not covered” in mock mode. Live answer quality needs a separately approved live test.

**Presenter language.** The presenter and co-speaker microphone controls each have a **Spoken Language** selector covering Eco's 15 languages. “Browser default” preserves the previous `navigator.language` behavior, including regional locales. To speak Italian on an English-configured device, select Italian before starting the mic. Stop the mic before changing languages; the next recognition session uses the new choice. The choice stays local to that page, does not affect another speaker or the listener's language, and resets to the browser default on reload.

The selector requires `SpeechRecognition` or `webkitSpeechRecognition`; supported languages and recognition quality depend on the browser's speech service. Without either API, the selector is disabled and Eco retains its existing WAV-upload path, whose success depends on the configured audio model's availability. Selecting a language does not add recognition support or send a language hint with WAV audio. Microphone permissions and, for remote recognition services, connectivity are still required. Original phrases are stored in their spoken language. The listener uses an existing translation for its selected language, including English; when it is missing, it shows the source as “Original” without guessing its language. Mock recaps also prefer stored English translations. Source-only speech playback still uses the selected listener voice because source language is not stored.

An Italian source such as “La nostra azienda opera in 15 paesi.” with a stored English caption can answer “How many countries does the company operate in?” in English, citing the Italian transcript evidence. Stage now requests English alongside the configured target languages in the **same phrase call**, retaining the 300-token output cap and existing budget checks. Actual output-token usage can increase, and long phrases across four languages may still exceed that cap. Missing or historical English translations are not backfilled. Mock mode cannot translate arbitrary Italian speech; offline tests in `test/speaker-language.test.ts` and `test/stage-questions.test.ts` supply translations and simulate speech recognition, without verifying live transcription or model translation quality. When speaker voice cloning is enabled, the existing voice path can also produce English audio from the new caption.

Browser-recognized text is now kept verbatim as the original evidence; the phrase call requests only translations and uncertainty flags, saving the redundant source copy. Responses marked incomplete or containing malformed JSON are discarded without a translation retry. The browser original is still saved, missing captions are flagged, and speakers receive a warning. Complete JSON is checked for string captions in requested languages; missing captions are never replaced with invented translations. WAV input still needs a complete model transcript and fails if none is available. Four full translations of a long phrase cannot be guaranteed within 300 tokens; a larger bounded output allowance would be the smallest follow-up if completeness is required, but needs an approved cost/budget change. Offline coverage includes `test/utterance-output.test.ts` and `test/mic-startup.test.ts`; recognition startup failures release microphone/language controls and show a retry message on both speaker pages.

**Status.** Captions, ask the talk, the board, Counter, multiple speakers (a co-speaker QR, "now speaking", names on captions) and voice samples work in mock mode. The cloned voice runs once the voice service in [`voice/`](voice/) is deployed (a Hugging Face Space until AMD can host the model) and `VOICE_URL` is set; until then listeners hear the phone's built-in voice, a different one per speaker.

**Contributing:** read [CONTRIBUTING.md](CONTRIBUTING.md) first (stack, workflow, and the rules that protect our shared API key). Open work is in [PLAN.md](PLAN.md).

**Stage latency diagnostics.** On the presenter page, append `?timing=1` (or `&timing=1` if there is already a query). Existing phrase requests then carry `x-eco-timing: 1`; their responses include `Server-Timing`, and the console logs the line sequence, status, final-result-to-response duration and timing header. This is opt-in and adds no requests, models, retries, persistent diagnostics or speech/prompt logging. Mock mode reports zero provider time. Live measurements still require the normal approval/budget process in CONTRIBUTING.md; the diagnostics do not authorize extra calls.

The header separates `budget` admission, `ai` provider round trips including response-body decoding, explicit `retry` sleeps, `accounting` (budget completion), remaining `processing` (body handling, validation, status changes, line persistence and broadcast), and total `server` time. Each `attempt_N` also reports its model, HTTP status and duration; status 0 means no HTTP response. The attempt durations are a breakdown of `ai`, not additional time to add again. `ai` cannot separate provider queuing, network time and GPU inference without provider telemetry. The server clock starts at the Room utterance handler; worker routing and transit remain outside it. The dashboard still starts at the browser's final recognition result, not at the physical end of speech. No clocks on different devices are subtracted.

Budget admission can wait up to 1.5 seconds under contention. Live cloned voices on current main also use Token Factory's shared budget. Existing 429/502/503 retries and a Gemma-to-DeepSeek fallback can add round trips. The 300-token output cap and models are unchanged. Offline tests inject these delays to verify the breakdown; they cannot establish the cause of a particular live 4–5-second observation.

**Stage audio scheduling.** Each caption has its own unchanged 4-second clone deadline and a snapshot of its language and speaker. A clone arriving after that decision cannot replay the phrase. Ready audio plays in caption order, one clip or browser utterance at a time; failed clip startup falls back once to phone speech, while a partially played clip is not repeated. Normal presentation completion lets already accepted final phrases drain, including phrases still waiting for clones. Pending work is cancelled immediately on language/mute changes, reconnect, reset and page exit. At most three **ready** waiting phrases are retained; overload drops the oldest ready waiting phrase without interrupting active speech or discarding captions still awaiting their clone deadline. Captions remain visible. A ready phrase may still wait behind an earlier phrase or active playback.

Playback recovery is separate from the 4-second clone deadline. A clip that has not started within 10 seconds falls back once to browser speech; browser speech also gets a 10-second startup limit. Once a clip starts, its media position is checked every second: 15 seconds without forward progress stops it and releases the queue without repeating partial audio. A progressing clip has no fixed duration cutoff. Browser speech may not provide boundary events, so its playback allowance is conservatively based on text length (3 Unicode code points per second plus 30 seconds of slack), refreshed only by advancing boundaries. This bounds a missing completion event while allowing long speech; the estimate cannot guarantee every browser voice's pacing. Cancellation clears all watchdogs, aborts pending clip downloads and detaches callbacks so late events cannot replay old work.

Cloned audio is broadcast separately for each language immediately after its WAV upload, so a slow or failed sibling language no longer delays a ready clip. Completed URLs are merged into the transcript and persisted after the generation batch settles. Generation calls, admission limits, the two-line clone concurrency limit and voice selection are unchanged. Tests in `test/stage-audio.test.ts`, `test/stage-playback.test.ts`, `test/listener-completion.test.ts`, `test/stage-delivery.test.ts` and `test/translation-timing.test.ts` use fake timers, page handlers, storage, speech and provider responses only.

**Stack:** TypeScript on Cloudflare Workers + Durable Objects, with plain HTML and vanilla JS pages. No Next.js, React or other framework, no build step, no agent framework.

## Run it (mock mode, no key needed)

```sh
npm install
npm run dev              # http://localhost:8787, always mock (npm run dev:live only with Seb's go)
```

or with Docker:

```sh
docker build -t eco . && docker run -p 8787:8787 eco
```

Mock mode replays recorded sample responses and makes no API calls. Every page shows **Mock**, **Live** or **Replay**, so you always know which mode is running.

Try `/stage/eco/demo/speak` (speaker console with a replaying demo talk), `/stage/eco/demo` (listener), `/counter/eco/gelato/owner` (owner counter) and `/counter/eco/gelato` (customer). `/counter/eco/farmacia` is a pharmacy front desk: it answers only from the owner's list and never gives medical advice. Speakers and owners sign in with Google (`/me` lists their talks and shops); everyone else needs no account.

## Live mode

Live mode needs two things: `ECO_LIVE = "1"` in `wrangler.jsonc` (set) and the `RADEON_API_KEY` secret. Locally, put the key in `.dev.vars` (gitignored, see `.dev.vars.example`). In production only Seb sets it, with `wrangler secret put RADEON_API_KEY`. Without the key the app stays in mock mode even when `ECO_LIVE` is on. Every call goes through one client (`src/tf.ts`) and one global limiter (`src/budget.ts`):

- at most 12 requests a minute, with the last 2 slots kept for translation;
- at most 3 calls at once;
- a daily call ceiling (`ECO_MAX_CALLS`, `0` = off, as in production) and an hourly cap for the public demo;
- retries on 429/502/503 only, and only when the wait fits the latency budget;
- it stops itself after 3 errors in a row that won't fix themselves (bad key, bad request), and probes again every 30 s; timeouts and 5xx fail only that phrase.

## Architecture

```
speaker devices (1 per speaker)                            listener phones · owner iPad · customer phone
mic → VAD (600 ms pause) → 16 kHz WAV                   ▲  captions labelled by speaker,
        │                                               │  "now speaking", each speaker's
        │ POST /utterance (tagged by speaker)           │  cloned voice
        │ WebSocket: speaking / stopped                 │ WebSocket
        ▼                                               │
Room (Durable Object, one per room) ────────────────────┘
        │
        ├─▶ tf.ts ─▶ AMD Token Factory (MiMo: speech + photos · Gemma: answers + typed turns)
        └─▶ voice.ts ─▶ voice clone (OmniVoice, backup Chatterbox; hosting pending)

Budget (Durable Object): limits + call log for every live call, voice included
```

- Cloudflare Workers + Durable Objects. Static pages in `public/`, plain JS, no build step.
- Slides: pdf.js reads the PDF in the browser and only the text goes to the model. The PDF itself is stored in Eco's own R2 bucket so the projector and other devices can show it; it is never sent to Token Factory.
- Voice: each speaker records a 30 s sample with an explicit consent checkbox, and only that sample is cloned. Nobody in Counter is ever cloned. `src/voice.ts` is where the cloned-voice call plugs in. Until then, phones use their own speech synthesis.

## Tests

```sh
npm test
```

`test/multilingual.test.ts` covers caption matching in Hindi, Italian, Spanish and English, preserving original evidence and Hindi character marks. `test/english-only-qa.test.ts` covers a long English-only deck, distracting facts, unsupported questions, context limits and documented retrieval misses. `test/stage-questions.test.ts` exercises the room's question handler in mock mode, including answer-language instructions, citations, fallback context, cache reuse and invalidation. None makes live API calls.

## License

GPL-3.0. See [LICENSE](LICENSE).
