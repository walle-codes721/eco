# Eco

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

**Status.** Captions, ask the talk, the board, Counter, multiple speakers (a co-speaker QR, "now speaking", names on captions) and voice samples work in mock mode. The cloned voice runs once the voice service in [`voice/`](voice/) is deployed (a Hugging Face Space until AMD can host the model) and `VOICE_URL` is set; until then listeners hear the phone's built-in voice, a different one per speaker.

**Contributing:** read [CONTRIBUTING.md](CONTRIBUTING.md) first (stack, workflow, and the rules that protect our shared API key). Open work is in [PLAN.md](PLAN.md).

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

Try `/stage/eco/demo/speak` (speaker console with a replaying demo talk), `/stage/eco/demo` (listener), `/counter/eco/gelato/owner` (owner counter) and `/counter/eco/gelato` (customer). Speakers and owners sign in with Google (`/me` lists their talks and shops); everyone else needs no account.

## Live mode

Live mode needs two things: `ECO_LIVE = "1"` in `wrangler.jsonc` (set) and the `RADEON_API_KEY` secret. Locally, put the key in `.dev.vars` (gitignored, see `.dev.vars.example`). In production only Seb sets it, with `wrangler secret put RADEON_API_KEY`. Without the key the app stays in mock mode even when `ECO_LIVE` is on. Every call goes through one client (`src/tf.ts`) and one global limiter (`src/budget.ts`):

- at most 12 requests a minute, with the last 2 slots kept for translation;
- at most 3 calls at once;
- a daily call ceiling (`ECO_MAX_CALLS`) and an hourly cap for the public demo;
- retries on 429/502/503 only, and only when the wait fits the latency budget;
- it stops itself after 3 failures in a row.

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

## License

MIT
