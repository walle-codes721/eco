---
status: proposed
---

# Stream one translation call, and retry once only for the languages it did not finish

A phrase is still one translation call whose JSON holds every language, but we read it as a stream: a language's caption is delivered, and its clone starts, the moment that language's string closes. A listener has no caption for a line until their own language has arrived (see Caption in `CONTEXT.md`), so nobody is shown or played another language in its place.

If the stream ends before every language closed, we make one retry for only the unfinished languages. It is scoped (the original text and the finished translations as context), capped (one per phrase, and only when the first stream produced the original or at least one language), counted against the reserved translation slots and `admit()`, and never played as audio if the next phrase has already been spoken. This amends token rule 4 ("one translation call per phrase") and token rule 7 (retry only on 429/502/503). We chose it over showing a permanent gap, which keeps both rules but leaves a listener with no caption for that line, and over silently showing the original text, which could speak the wrong language.

## Consequences

- Rule 4 and rule 7 in `CONTRIBUTING.md` now name this exception, so a second translation call for one phrase is no longer a bug by itself.
- The retry starts only after the first stream failed, so it adds that stream's time plus a second call. Partial failure can spend two of the 12 requests a minute.
- Streaming is behind a flag and unproven live: Seb must confirm `stream: true` with `json_object` and that keys arrive in the order the prompt lists them.
