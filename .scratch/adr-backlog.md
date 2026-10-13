# ADR backlog

Candidates noted during domain modeling (Tue 13 Oct 2026). Write each up when the decision is confirmed in code — format per the ADR skill, files in `docs/adr/`.

## ADR candidate: one call per phrase returns every language

- **Decision:** Each Stage phrase becomes exactly one MiMo call whose strict-JSON response carries the transcript plus all target languages at once (`src/prompts.ts` `utterancePrompt`, rule 10).
- **Alternative rejected:** One call per language (3× the calls, 3× the latency skew between listeners, 3× the budget burn).
- **Why it's ADR-worthy:** Hard to reverse (shapes prompt schema, budget math, latency targets); surprising without context (why one prompt with an object of languages?); a real trade-off (bigger single responses vs. 3× call cost).
- **Where it shows up:** `src/room.ts` `utterance()`, `src/limits.ts` RESERVED lanes, plan §"one translation call per phrase covers every language".

## ADR candidate: one mic per speaker; the device is the speaker's identity

- **Decision:** Every speaker joins from their own device with their own mic; lines are tagged by the sending device, so attribution costs zero AI calls. Diarization (several speakers on one mic) stays a stretch goal.
- **Alternative rejected:** Voice-based speaker diarization on a shared mic — slower, less reliable, costs tokens, and misattribution is user-visible.
- **Why it's ADR-worthy:** Hard to reverse (drives `speakers[]` on the room, the speaker field on every Line, the invite-link flow, crosstalk dedup); surprising (why no diarization? everyone asks); genuine trade-off (hardware requirement per speaker vs. cost/reliability).
- **Where it shows up:** plan task 4 ("Why one mic per speaker"), `src/room.ts` data model, README "Knowing who is speaking costs nothing".

## Also queued, not yet decisions

- Replay fallback at 80% of the daily cap (plan task 6) — ADR-worthy once designed and agreed with Seb.
- Culture adaptations behind an approve screen (plan task 10) — ADR-worthy if the approve-screen flow ships.
