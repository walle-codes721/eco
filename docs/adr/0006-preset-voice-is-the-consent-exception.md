# A preset voice is the one exception to consent

Every other Clone is built from a speaker's own sample, recorded with their explicit consent. The Morgan Freeman Preset voice is built from a clip of a person who never agreed. It is allowed for the hackathon demo only: always labelled as synthetic on screen, never offered for a listener's or a Counter's voice, and tracked in issue #35 to be removed or replaced with a voice we hold rights to before production.

We bundle the clip in the Worker because Workers Builds deploys from git, so a private store would not have worked for the live demo. That means the clip is in the public repo from Sunday 18 Oct until #35 is resolved. We accepted that to have a working demo, over dropping the preset or keeping it local-only.

The clip is also sent to Token Factory: once to MiMo for a transcript, and with every cloned line as the OmniVoice reference audio. That is part of the same exception, so it applies to the demo only. Remove the repo copy under `references/`: only the bundled `src/assets` clip is accepted.
