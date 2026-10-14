// User, talk and shop names in URLs: /stage/{user}/{talk}. Pure, so tests can import it.

export const NAME = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED = new Set(["new", "me", "api", "auth", "eco", "admin", "demo", "stage", "counter", "join", "speak", "owner"]);

export const slugify = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export const nameOk = (n: string) => NAME.test(n) && !RESERVED.has(n) && !n.startsWith("guest-") && !n.includes("--");
