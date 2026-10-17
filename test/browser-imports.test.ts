// Every named import between browser modules must exist. A missing export is a SyntaxError in the browser
// that stops the whole page (a black listener screen), and no Node unit test would notice.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "public");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".js") ? [join(dir, n)] : []));

const exportsOf = (src: string) => {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]!);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) for (const n of m[1]!.split(",")) names.add(n.split(/\s+as\s+/).pop()!.trim());
  return names;
};

describe("browser module imports", () => {
  for (const file of files(join(root, "js"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(\/js\/[^"]+)"/g)) {
      it(`${file.slice(root.length + 1)} gets ${m[2]} exports`, () => {
        const target = exportsOf(readFileSync(join(root, m[2]!), "utf8"));
        for (const raw of m[1]!.split(",")) {
          const name = raw.split(/\s+as\s+/)[0]!.trim();
          if (name) expect(target.has(name), `${m[2]} must export ${name}`).toBe(true);
        }
      });
    }
  }
});
