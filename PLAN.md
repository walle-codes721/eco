# Eco: open work

Deadline: **Sun 18 Oct, 12:00 Italian time** (submit by 11:30). Live pitches 14:00-16:00. Event: lablab.ai AMD Developer Hackathon ACT III.
Rules for working here: [CONTRIBUTING.md](CONTRIBUTING.md). Owners are suggestions; ask if you want a different task.

Status as of 13 Oct: Stage and Counter work in mock mode and are deployed at eco.linolabs.co. Not done: first live calls, multiple speakers, cloned voice, the 80% replay switch, device testing, submission material.

1. **Get set up** (everyone, today)
   a. Clone, `npm install`, `npx wrangler dev`.
   b. Walk through `/s/demo` + `/r/demo`, then `/o/gelato` + `/c/gelato`, on desktop and on a phone.
   c. Run `npm test` and `npm run check`; read `src/room.ts`, `src/tf.ts`, `src/retrieve.ts`.
   d. Note anything confusing or broken.
2. **Token Factory spike** (Seb, Tue-Wed, max 10 live calls)
   a. One MiMo audio call: English in, `{src, it, es, hi}` out. Check the Hindi.
   b. One Gemma answer call: one cited answer, one "not covered".
   c. One menu-photo call.
   d. Record every response as a fixture; measure latency from Italy and tokens per call.
   e. Fallback if MiMo is slow or weak in Hindi: browser speech recognition plus one translate call.
3. **Stage end to end, live** (Seb + Ritik, Wed)
   a. One live minute: laptop to an Italian phone and a Hindi phone.
   b. Latency p50 <= 3 s, p90 <= 4.5 s from server timestamps.
   c. Late joiners see recent lines; killing the network switches to replay and says so on screen.
4. **Multiple speakers** (open, Wed-Thu)
   a. `speakers[]` on the room and a `speaker` field on every line (`src/room.ts`).
   b. `/s/{id}/join`: each co-speaker uses their own device and mic.
   c. "Now speaking" from the existing pause detector, sent over WebSocket (no API cost).
   d. Name on every caption; board and card split by speaker.
   e. Drop near-duplicate lines when two mics hear the same voice.
   f. Mock two-speaker demo talk and a unit test.
5. **Cloned voice per speaker** (blocked on AMD hosting; build in mock now)
   a. 30 s self-recorded sample with a consent checkbox.
   b. `voiceFor()` in `src/voice.ts`: translated line plus the speaker's sample gives one clip per language, only for languages with listeners.
   c. Listener page plays each line in its speaker's voice.
   d. Voice needs its own rate-limit lane in `src/budget.ts`; confirm limits with AMD.
   e. Fallback: phone voice, a different voice per speaker.
6. **Ask-the-talk grounding tests** (Ritik, Wed-Thu)
   a. 20 questions against the demo slides: about 12 answerable, 8 not, in four languages.
   b. Expected slide tag or "not covered" for each.
   c. Vitest case; tune `src/retrieve.ts` where it misses.
   d. Draft 20 likely judge questions to pre-seed the cache.
7. **Replay at 80% of the daily cap** (open, Thu)
   a. Budget reads usage sparingly in live mode and flips the app to replay at 80%.
   b. Unit test with a mocked usage response.
   c. Clear Replay banner on every page.
8. **Board, cards, cost meter** (open, Thu)
   a. Board: top 3 topics, language split, not-covered list.
   b. Post-talk card and weekly card from local counts.
   c. Cost meter from `/api/stats`.
9. **Counter end to end** (open, Fri)
   a. Full tourist-to-owner conversation, allergen question answered only from the list.
   b. Unanswered question forwarded to the owner, translated.
   c. iPad split mode; owner setup and sticker; spoken output.
10. **Culture adaptations** (open, Thu-Fri, cut first if behind)
    a. One Gemma call per language per deck, cached.
    b. Approve screen in `/s/new`; only approved swaps used live.
11. **Device and browser QA** (Ritik, Wed-Fri)
    a. iOS Safari, Android Chrome, iPad Safari, macOS Chrome with a projector.
    b. Two speakers on two devices; audio after one tap.
    c. File each bug as an issue with device, steps and screenshot.
12. **Translation quality** (anyone who reads the language, Thu and after Saturday's take)
    a. Rate Italian, Spanish and Hindi: target >= 9/10 sentences natural.
    b. Rate the cloned voice per language.
13. **Saturday in Milan** (Seb + team, Sat 17)
    a. Test venue Wi-Fi and a hotspot.
    b. Record the Stage take, ideally with two speakers; replace the hand-written demo talk.
    c. Pre-seed the answer cache; film the Counter at a real shop.
14. **Submission package** (Sun 18)
    a. Deck, video (under 5 min, under 300 MB, English subtitles), cover, descriptions, tags.
    b. Show the five Track 4 explanations in the video and deck.
    c. Make the repo public (MIT); check `git status` for keys and `.dev.vars`.
15. **Live pitch** (Seb, Sun 18, 14:00-16:00)
    a. The pitch is a real Eco room; the audience scans and follows along.
    b. Fallbacks: hotspot and a replay of Saturday's take.

**Blocked:** voice hosting (waiting on Maharshi at AMD: OmniVoice, backup Chatterbox Multilingual); two tracks for one project; whether Gemma counts for the Google prize.
