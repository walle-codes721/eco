import type { Budget } from "./budget";
import type { Room } from "./room";
import type { Account } from "./account";

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<Room>;
  BUDGET: DurableObjectNamespace<Budget>;
  ACCOUNT: DurableObjectNamespace<Account>;
  FILES: R2Bucket; // slide PDFs and voice samples
  ECO_LIVE?: string;
  ECO_MAX_CALLS?: string;
  ECO_PUBLIC_HOURLY?: string;
  RADEON_API_KEY?: string; // secret
  ADMIN_KEY?: string; // secret
  GOOGLE_CLIENT_ID?: string; // secret
  GOOGLE_CLIENT_SECRET?: string; // secret
  SESSION_SECRET?: string; // secret
  VOICE_URL?: string; // secret: the voice service (Hugging Face Space now, AMD later)
  VOICE_TOKEN?: string; // secret
}
