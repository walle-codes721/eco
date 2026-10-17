# Contributing to Eco

Read this before you touch the code or the API. Eco is a hackathon project with one shared AMD Token Factory key and a small daily spend cap. If we burn the cap before the demo, we lose the demo. The rules below exist for that reason.

## Stack (no framework, on purpose)

- **Backend:** TypeScript on Cloudflare Workers + Durable Objects. A small hand-written router in `src/worker.ts`, one `Room` Durable Object per room, one global `Budget` Durable Object.
- **Frontend:** plain HTML and vanilla JavaScript in `public/`. Native ES modules, no build step. It is **not** Next.js, React or any other framework.
- **Tooling:** Wrangler (run and deploy), Vitest (tests), `tsc` (type check).
- **No agent framework.** Each action is one fixed model call through `src/tf.ts`. Nothing plans or loops.
- **New dependencies:** none without agreeing first. Match the style of the code around you and keep changes small.

## Run it

```sh
npm install
npm run dev             # http://localhost:8787, always mock, even with a key in .dev.vars
npm test
npm run check
```

Demo rooms that work with no key: `/stage/eco/demo/speak`, `/stage/eco/demo`, `/counter/eco/gelato/owner`, `/counter/eco/gelato`, `/counter/eco/farmacia` (a pharmacy front desk).

## Workflow

1. Branch from `main`, one branch per task (see [PLAN.md](PLAN.md)).
2. Run `npm test` and `npm run check` before you open a PR.
3. Open a PR. Seb merges. Every merge to `main` deploys to eco.linolabs.co automatically (Cloudflare Workers Builds), so `main` must always work. Don't run `wrangler deploy` yourself.
4. The repo goes **public (MIT) on Sunday 18 Oct**. Treat every commit as public.

## Token rules

**Mock mode is the default and is all you need to develop.** Without `ECO_LIVE=1` and a key, the client returns recorded or sample responses and makes no API calls.

1. **You never need the key.** Do not ask for it, share it, paste it in chat, commit it, log it or put it in browser code. It lives only as a Worker secret and in Seb's local `.dev.vars`. If you think you need a live test, ask Seb to run it.
2. **Live calls are run by Seb**, who states the budget first ("N calls, model X, why"). No exploratory calls, no load tests, no loops against the API.
3. **Every call goes through `src/tf.ts`.** It is the only Token Factory client. Never call the API from anywhere else, and never from client-side code.
4. **One translation call per phrase covers every language.** Never translate one language per call.
5. **Anything we can do locally, we do locally.** Retrieval is local BM25 keyword scoring, the question board and the cards are local counts, and answers are cached by normalized question. Token Factory has no embeddings, TTS or image generation today.
6. **Thinking off, tight `max_tokens`.** Keep prompts and outputs small.
7. **Retry only on 429/502/503, at most twice**, and never retry 400/401/403/404/422.
8. **Stop after 3 failed live calls in a row** that won't fix themselves (400/401/403/404/422) and report it. Timeouts, 429 and 5xx don't count. After a stop, one probe call every 30 s (Seb, 17 Oct).
9. **Limits are enforced in `src/budget.ts` and `src/limits.ts`:** at most 12 requests a minute, 3 at once, a daily call ceiling (`ECO_MAX_CALLS`, `0` = off), and an hourly cap for the public demo. Don't weaken or bypass them. Add unit tests when you change them.
10. **Prompts are logged by Token Factory for about 2 days.** Don't send real personal data, even in tests.

## Voices

Only clone a voice from a sample the speaker recorded themselves, with an explicit consent checkbox. Never clone anyone in Counter, and never a listener. The Morgan Freeman preset is the one documented exception for the hackathon demo only; see [ADR 0006](docs/adr/0006-preset-voice-is-the-consent-exception.md) and issue #35.

## Secrets and the public repo

- `.dev.vars`, `.env*` and key screenshots are gitignored. Check `git status` before every push.
- A `.dev.vars.example` shows the variable names with no values.
- Production secrets (`RADEON_API_KEY`, `ADMIN_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`) are set by Seb with `wrangler secret put`. Without the Google ones, sign-in is hidden and rooms are created as guests.

## Where things are

See the code map in [README.md](README.md) and the open work in [PLAN.md](PLAN.md).
