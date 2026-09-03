import { promises as fs } from "node:fs";
import { resolve, relative, sep, join } from "node:path";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "bin", "obj", ".rockyctl"]);

/** Resolves `p` inside `root`, refusing anything that escapes the working directory. */
export function safePath(root: string, p: string): string {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`Path escapes the working directory: ${p}`);
  }
  return abs;
}

export async function readFile(root: string, path: string, maxChars = 60_000): Promise<string> {
  const abs = safePath(root, path);
  const text = await fs.readFile(abs, "utf8");
  return text.length > maxChars ? text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]` : text;
}

export async function writeFile(root: string, path: string, content: string): Promise<string> {
  const abs = safePath(root, path);
  await fs.mkdir(resolve(abs, ".."), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return `Wrote ${content.length} chars to ${path}`;
}

export async function listDir(root: string, path = ".", depth = 2): Promise<string> {
  const abs = safePath(root, path);
  const lines: string[] = [];
  async function walk(dir: string, level: number, prefix: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      lines.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && level < depth) await walk(join(dir, e.name), level + 1, prefix + "  ");
    }
  }
  await walk(abs, 1, "");
  return lines.length ? lines.join("\n") : "(empty)";
}

export async function searchFiles(root: string, pattern: string, path = ".", maxResults = 100): Promise<string> {
  const abs = safePath(root, path);
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: string[] = [];
  async function walk(dir: string) {
    if (hits.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (hits.length >= maxResults) return;
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        let text: string;
        try {
          const stat = await fs.stat(full);
          if (stat.size > 2_000_000) continue;
          text = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\0")) continue; // binary
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
          if (re.test(lines[i])) hits.push(`${relative(root, full).split(sep).join("/")}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  }
  await walk(abs);
  return hits.length ? hits.join("\n") : "(no matches)";
}
