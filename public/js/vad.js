// Phrase cutter for the stage mic (PRD S-1). Pure, so it is unit tested in Node.
// Feed 16 kHz mono frames; get a phrase back at a 600 ms pause once >= 5 s of audio,
// or forcibly at 12 s. Speech threshold adapts to the room's noise floor.
export class Cutter {
  constructor({ rate = 16000, silenceMs = 600, minMs = 5000, maxMs = 12000, frameMs = 20 } = {}) {
    Object.assign(this, { rate, silenceMs, minMs, maxMs, frameMs });
    this.frame = Math.round((rate * frameMs) / 1000);
    this.reset();
    this.floor = 0.004;
  }
  reset() {
    this.chunks = [];
    this.len = 0;
    this.silence = 0;
    this.voiced = 0;
    this.pending = new Float32Array(0);
  }
  /** Returns { level, phrase? } for each pushed block. */
  push(samples) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    let i = 0, level = 0, phrase = null;
    for (; i + this.frame <= all.length; i += this.frame) {
      const f = all.subarray(i, i + this.frame);
      let e = 0;
      for (const x of f) e += x * x;
      const rms = Math.sqrt(e / f.length);
      level = Math.max(level, rms);
      const speech = rms > Math.max(0.012, this.floor * 3);
      if (!speech) this.floor = this.floor * 0.995 + rms * 0.005;
      if (!speech && !this.voiced) continue; // don't record leading silence
      this.chunks.push(f.slice());
      this.len += f.length;
      if (speech) { this.voiced += this.frameMs; this.silence = 0; } else this.silence += this.frameMs;
      const ms = (this.len / this.rate) * 1000;
      if ((this.silence >= this.silenceMs && ms >= this.minMs) || ms >= this.maxMs) phrase ??= this.take();
    }
    this.pending = all.slice(i);
    return { level: Math.min(1, level * 8), phrase };
  }
  /** Whatever is buffered, if it holds at least ~0.8 s of speech. */
  flush() {
    return this.voiced >= 800 ? this.take() : (this.reset(), null);
  }
  take() {
    const out = new Float32Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    // trim trailing silence
    const keep = Math.max(0, out.length - Math.round((Math.max(0, this.silence - 200) / 1000) * this.rate));
    this.reset();
    return out.subarray(0, keep);
  }
}

export function encodeWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: "audio/wav" });
}

/** Linear-interpolation resample to 16 kHz. */
export function resample(input, from, to = 16000) {
  if (from === to) return input;
  const out = new Float32Array(Math.floor((input.length * to) / from));
  const r = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * r, j = Math.floor(x), t = x - j;
    out[i] = input[j] * (1 - t) + (input[j + 1] ?? input[j]) * t;
  }
  return out;
}
