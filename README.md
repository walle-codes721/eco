# Eco

**Eco translates the room, answers from the source, and tells the person in charge what nobody understood.**

One engine, two rooms, all in the browser:

- **Stage.** A speaker talks in English. Listeners scan a QR code and follow live captions in Italian, Spanish or Hindi on their own phone, with an optional phone voice. They can ask the talk a question, and the answer comes only from the slides and the speaker's words, citing the slide. The speaker's board shows what people asked and which slide raised the most questions. Listeners get a recap at the end.
- **Counter.** Any business (café, shop, salon…) prints a QR sticker. A customer talks or types in their language and the owner reads it in Italian. Questions about prices, allergens or hours are answered right away from the owner's own info, and Eco never invents them. Everything else goes to the owner, translated. One iPad can also run face-to-face in split screen. The owner gets a weekly card.

Built for the lablab.ai **AMD Developer Hackathon ACT III**. Runs on **AMD Token Factory**:

| Job | Model | Calls |
|---|---|---|
| Speech → transcript + every language | `MiMo-V2.6-Flash` (audio in, strict JSON schema) | 1 per phrase, for all listeners and languages |
| Answers from the source | `Gemma-4-31B-IT` | 1 per new question (cached) |
| Counter turn: translate + answer from the info | `MiMo-V2.6-Flash` | 1 per turn |
| Menu photo → text | `MiMo-V2.6-Flash` (image in) | 1 per photo, once |

Retrieval is local BM25 keyword scoring, so it costs zero tokens.

## Run it (mock mode, no key needed)

```sh
npm install
npx wrangler dev          # http://localhost:8787
```

or with Docker:

```sh
docker build -t eco . && docker run -p 8787:8787 eco
```

Mock mode replays recorded sample responses and makes no API calls. Every page shows **Mock**, **Live** or **Replay**, so you always know which mode is running.

Try `/s/demo` (speaker console with a replaying demo talk), `/r/demo` (listener), `/o/gelato` (owner counter) and `/c/gelato` (customer).

## Live mode

Put `RADEON_API_KEY=...` in `.dev.vars` (gitignored) and set `ECO_LIVE = "1"` in `wrangler.jsonc`. Every call goes through one client (`src/tf.ts`) and one global limiter (`src/budget.ts`):

- at most 12 requests a minute, with the last 2 slots kept for translation;
- at most 3 calls at once;
- a daily call ceiling (`ECO_MAX_CALLS`) and an hourly cap for the public demo;
- retries on 429/502/503 only, and only when the wait fits the latency budget;
- it stops itself after 3 failures in a row.

## Architecture

```
phones / laptop / iPad ── WebSocket ──▶ Room (Durable Object, one per room)
      │ mic → VAD (600 ms pause) → 16 kHz WAV                │
      └──────────── POST /utterance ────────────────▶ tf.ts ─▶ AMD Token Factory
                                                         ▲
                                         Budget (Durable Object): limits + call log
```

- Cloudflare Workers + Durable Objects. Static pages in `public/`, plain JS, no build step.
- Slides never leave the speaker's laptop: pdf.js reads them in the browser, and only the text is sent.
- Voice: the phone's own speech synthesis today. `src/voice.ts` is the seam for a cloned voice model.

## Tests

```sh
npm test
```

## License

MIT
