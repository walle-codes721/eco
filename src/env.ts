import type { Budget } from "./budget";
import type { Room } from "./room";

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<Room>;
  BUDGET: DurableObjectNamespace<Budget>;
  ECO_LIVE?: string;
  ECO_MAX_CALLS?: string;
  ECO_PUBLIC_HOURLY?: string;
  RADEON_API_KEY?: string; // secret
  ADMIN_KEY?: string; // secret
}
