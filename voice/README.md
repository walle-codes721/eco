---
title: Eco Voice
emoji: 🎙️
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
license: other
---

# Eco voice service

The speaker's consented voice sample plus a translated line in, the line in the speaker's own voice out (WAV).
Eco's Worker calls `POST /tts` (multipart: `text`, `lang`, `ref_text`, `ref`), with `Authorization: Bearer $VOICE_TOKEN`.

- Model: [OmniVoice](https://github.com/k2-fsa/OmniVoice) (k2-fsa). Code Apache-2.0, **weights CC-BY-NC**: fine for the hackathon demo, not for commercial use. `ENGINE=chatterbox` switches to Chatterbox Multilingual (MIT).
- Hosted here until AMD hosts the model; moving means pointing Eco's `VOICE_URL` secret elsewhere.

## Deploy (Seb)

1. Create a Hugging Face Space: SDK **Docker**, hardware **GPU** (e.g. Nvidia T4 small). Push this folder to it.
2. In the Space settings, add the secret `VOICE_TOKEN` (any long random string).
3. Check `https://<user>-eco-voice.hf.space/` returns `{"ok": true}`.
4. In Eco: `npx wrangler secret put VOICE_URL` (the Space URL) and `npx wrangler secret put VOICE_TOKEN` (the same string).

Pause the Space when not testing: a GPU Space bills while it runs.
