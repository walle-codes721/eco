// Bundled preset reference clips (deployed with the Worker).
import morganData from "./assets/preset-morgan-freeman.mp3";
import jackData from "./assets/preset-jack-sparrow.mp3";
import spongebobData from "./assets/preset-spongebob.mp3";

function fromBase64(data: string): ArrayBuffer {
  const b64 = data.includes(",") ? data.split(",")[1]! : data;
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Loads a bundled reference clip once. */
function loader(clipData: unknown): () => ArrayBuffer {
  let cache: ArrayBuffer | undefined;
  return () => {
    if (cache?.byteLength) return cache;
    if (clipData instanceof ArrayBuffer) cache = clipData;
    else if (typeof clipData === "string") cache = fromBase64(clipData);
    if (!cache?.byteLength) throw new Error("Preset reference clip missing");
    return cache;
  };
}

export const morganFreemanClip = loader(morganData);
export const jackSparrowClip = loader(jackData);
export const spongebobClip = loader(spongebobData);
