# Eco

Eco translates the room, answers from the source, and tells the person in charge what nobody understood. One engine, two rooms: a Stage, where speakers are heard in their own voice in every listener's language, and a Counter, where a customer and an owner talk through Eco, answered only from the owner's own list.

## Rooms

**Room**:
A live space at its own link where Eco serves one conversation in one of the two modes.
_Avoid_: session, event

**Stage**:
A room where speakers address listeners live: captions in each listener's language, ask the talk, and a board for the speaker.
_Avoid_: presentation, webinar

**Counter**:
A room where a customer talks to an owner through Eco, answered only from the owner's list.
_Avoid_: shop, kiosk, booth

**Demo room**:
A permanent, publicly open room that runs on replay under stricter per-visitor limits.

## People

**Speaker**:
A person the Stage translates, identified by their own device and mic, so every line is theirs by construction.
_Avoid_: presenter, host

**Listener**:
A person following a Stage on their own phone, in their own language.
_Avoid_: audience, attendee

**Owner**:
The person in charge of a Counter, who reads in their own language and personally answers what the list can't.
_Avoid_: shopkeeper, vendor, staff

**Customer**:
A person talking to a Counter in their own language.
_Avoid_: tourist, user, guest

**Visitor**:
An unidentified person using a public room, limited per hour to protect the budget.
_Avoid_: user, guest

## Stage

**Phrase**:
The stretch of speech between pauses that the Stage captures as one unit — the smallest thing Eco translates.
_Avoid_: utterance, sentence, chunk

**Line**:
One phrase as the room keeps it: who said it, what was said, every translation, and the slide showing at the time. Delivered to everyone in the room.
_Avoid_: caption, message, utterance

**Caption**:
A line as one listener reads it, in that listener's language.

**Reaction**:
A listener's single emoji on a line (👍 👎 😂 🤯 ❤️ 🤔), chosen by tapping its caption; they can change or clear it. Private to that listener: only the projector shows it, anonymously, and the speaker reads them on the Post-talk card. Not a Poll.
_Avoid_: like, vote, feedback

**Deck**:
The speaker's slides for a Stage. Its written words are in one language, English unless the speaker chooses another.
_Avoid_: presentation, slideshow

**Slide**:
One page of the deck. On a PDF, the projector shows it as designed, and a listener's phone shows that same page with the written words in their language, except rows the speaker kept. The listener can switch to the designed page and back; the choice stays for the talk. Without a PDF, the page stays in the deck's language.
_Avoid_: presentation, page, caption, user

**Skipped slide**:
A slide the speaker marks, while reviewing the deck, so that none of its rows are translated. Every phone shows it as designed, whatever the listener's language, and no translation call is made for it. Its rows stay stored, so the speaker can undo this, and it wins over any row marked kept on that slide.
_Avoid_: ignored slide, hidden slide

**Row**:
The written words on a slide that sit together on one baseline. A wide gap on that baseline starts another row. Translated as one string, then painted across that row. A row the speaker marks when uploading the deck stays in the deck's language on every phone.
_Avoid_: line, text run, fragment, quotation

**Now speaking**:
The room's live signal of which speaker is talking at this moment, driven by speech detection on each speaker's device, never by an AI call.
_Avoid_: active speaker

**Poll**:
A question the speaker sends the listeners — free response, multiple choice, true/false, rating or ranking — answered on their phones. The speaker writes and reads results in their own language; each listener reads it in theirs. Results stay with the speaker unless they choose to share them.
_Avoid_: survey, quiz

## Questions and grounding

**Ask the talk**:
A listener's question about the Stage, answered only from the sources or sent to the speaker.
_Avoid_: Q&A, chat

**Sources**:
The only material any answer may draw on: a Stage's deck plus what has been said so far; a Counter's list.
_Avoid_: knowledge base, context

**Covered**:
Said of a question the sources can answer; decided once, at the moment the question is asked.
_Avoid_: answered

**Not covered**:
Said of a question the sources can't answer; it is never answered from outside knowledge and goes to the speaker instead.
_Avoid_: unanswered (that means something else), unknown

**Cite**:
The source tag an answer points back to, such as a slide. Every covered answer has one; not covered never does.
_Avoid_: reference, link

**Queue**:
The board's list of not-covered questions, grouped when they mean the same thing.
_Avoid_: backlog

**Unanswered**:
A not-covered question still waiting for the speaker to address it; the board tracks these until the speaker marks them answered. Covering is decided by the sources; being answered is decided by the human.
_Avoid_: not covered

**Board**:
The speaker's live view of the room's questions: what was asked, grouped by topic and slide, plus the queue.
_Avoid_: dashboard, admin

## Counter

**Conversation**:
One customer's exchange with a Counter, open until the owner has personally answered what the list couldn't.
_Avoid_: chat, session

**Turn**:
One side's contribution to a conversation. Every turn belongs to a side.
_Avoid_: message, reply

**Eco turn**:
The Counter's own reply, made when the list covers the customer's question. Eco is a side in the conversation, not a hidden annotator.
_Avoid_: auto-answer, bot reply

**List**:
The owner's published information for a Counter — prices, allergens, hours, policies — the only thing Counter answers may draw on. Nothing is ever invented.
_Avoid_: menu (a menu photo is one way to build the list), business info

**Sticker**:
The printed QR code that opens a Counter for customers.
_Avoid_: poster, sign

## Modes

**Mock mode**:
The default: every AI response comes from recorded samples and nothing leaves the machine. No key needed.
_Avoid_: dev mode, offline mode

**Live mode**:
Real model calls, every one through the single client and under the budget.
_Avoid_: production

**Replay**:
A recorded take played back as if live — how demo rooms run, and where a room falls back when the network or budget fails. Always announced on screen.
_Avoid_: demo mode, playback

## Budget

**Call**:
One request to one model — the unit every limit and every cost figure counts.
_Avoid_: request, query

**Lane**:
A reserved share of the budget for one kind of call, so translation is never crowded out by questions or voice.
_Avoid_: queue, tier

**Daily ceiling**:
The most live calls allowed in a day; past it, live mode refuses everything rather than risk the demo.
_Avoid_: quota

**Public hourly cap**:
The most calls public visitors may spend in an hour, so the open URL can never burn the shared key.
_Avoid_: rate limit

**Tripped**:
The breaker state after three errors in a row that won't fix themselves (400/401/403/404/422): no live calls until a probe succeeds, one probe every 30 s. Timeouts, 429 and 5xx fail only their own phrase.
_Avoid_: blocked, errored

## Voice

**Voice sample**:
Half a minute a speaker records of their own voice; the only material a clone may be built from.
_Avoid_: recording, reference audio

**Consent**:
The speaker's explicit yes to their voice being cloned, recorded with the sample. Nobody in a Counter is ever cloned; never a listener.
_Avoid_: permission (device mic permission is a different thing)

**Clone**:
A synthetic voice built from one speaker's consented sample, used to speak that speaker's lines in every language.
_Avoid_: TTS, voice model

**Phone voice**:
The listener's built-in device voice — the standing fallback while cloning is unavailable — with a distinct phone voice per speaker so listeners can still tell them apart.
_Avoid_: TTS, robot voice

## Cards

**Post-talk card**:
The Stage's one-page summary after a talk, led by which slide raised the most questions.
_Avoid_: report, deck summary

**Weekly card**:
The Owner's periodic Counter summary: conversations, languages, top questions, what the list couldn't answer, and one suggestion.
_Avoid_: report, invoice
