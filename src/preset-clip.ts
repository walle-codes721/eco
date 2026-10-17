// Bundled preset reference clip (deployed with the Worker).
import clipData from "./assets/preset-morgan-freeman.mp3";

let cache: ArrayBuffer | undefined;

function fromBase64(data: string): ArrayBuffer {
  const b64 = data.includes(",") ? data.split(",")[1]! : data;
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Loads the bundled Morgan Freeman reference clip once. */
export function morganFreemanClip(): ArrayBuffer {
  if (cache?.byteLength) return cache;
  if (clipData instanceof ArrayBuffer) cache = clipData;
  else if (typeof clipData === "string") cache = fromBase64(clipData);
  if (!cache?.byteLength) throw new Error("Preset reference clip missing");
  return cache;
}
