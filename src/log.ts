import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class RunLog {
  private readonly file: string;

  constructor(logDir: string, cwd: string) {
    const dir = join(cwd, logDir);
    mkdirSync(dir, { recursive: true });
    // Keep run logs out of the target repo's auto-commits without touching its .gitignore.
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(dir, `run-${stamp}.jsonl`);
  }

  get path(): string {
    return this.file;
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
  }
}

export const ui = {
  info: (msg: string) => console.log(msg),
  step: (msg: string) => console.log(`\x1b[36m›\x1b[0m ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m✔\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[33m!\x1b[0m ${msg}`),
  fail: (msg: string) => console.error(`\x1b[31m✖\x1b[0m ${msg}`),
  dim: (msg: string) => console.log(`\x1b[2m${msg}\x1b[0m`),
};
