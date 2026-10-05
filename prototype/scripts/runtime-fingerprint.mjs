import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("A harness source directory is required");
const hash = createHash("sha256");
function visit(relative = "") {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (["node_modules", "dist", ".DS_Store", ".git"].includes(entry.name)) continue;
    const path = join(relative, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) {
      const contents = readFileSync(join(root, path));
      hash.update(JSON.stringify([path, contents.length]));
      hash.update(contents);
    }
  }
}
visit();
process.stdout.write(hash.digest("hex") + "\n");
