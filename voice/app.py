# Eco voice service: the speaker's sample + a translated line -> the line in the speaker's voice.
# OmniVoice (k2-fsa) by default, Chatterbox Multilingual (Resemble AI) with ENGINE=chatterbox.
# Runs as a Hugging Face Docker Space on a GPU now; the same container can move to AMD (ROCm) later.
import hashlib, io, os, tempfile

import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response

ENGINE = os.environ.get("ENGINE", "omnivoice")
TOKEN = os.environ.get("VOICE_TOKEN", "")
DEVICE = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"

if ENGINE == "chatterbox":
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)
    RATE = model.sr
else:
    from omnivoice import OmniVoice

    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=DEVICE, dtype=torch.float16 if DEVICE != "cpu" else torch.float32)
    RATE = 24000

app = FastAPI()
refs: dict[str, str] = {}  # sample hash -> temp file, so a speaker's sample is written once


@app.get("/")
def health():
    return {"ok": True, "engine": ENGINE, "device": DEVICE}


@app.post("/tts")
async def tts(text: str = Form(...), lang: str = Form("en"), ref_text: str = Form(""), ref: UploadFile = File(...), authorization: str = Header("")):
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(401)
    if not text.strip() or len(text) > 600:
        raise HTTPException(400, "text")
    data = await ref.read()
    key = hashlib.sha1(data).hexdigest()
    if key not in refs:
        f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        f.write(data)
        f.close()
        refs[key] = f.name
    with torch.inference_mode():
        if ENGINE == "chatterbox":
            audio = model.generate(text, language_id=lang, audio_prompt_path=refs[key]).squeeze(0).cpu().numpy()
        else:
            audio = model.generate(text=text, ref_audio=refs[key], ref_text=ref_text or None)[0]
    buf = io.BytesIO()
    sf.write(buf, audio, RATE, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")
