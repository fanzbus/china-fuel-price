import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const src = join(root, "data");
const dst = join(root, "public", "data");
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith(".json") || f.endsWith(".jsonl")) copyFileSync(join(src, f), join(dst, f));
}
console.log("synced data/ -> public/data/");
