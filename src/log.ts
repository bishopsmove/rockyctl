import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenFn } from "./ollama.js";

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
    // Create the file immediately so a failure before the first event still leaves a trace.
    this.event("run.start", { cwd, platform: process.platform, node: process.version });
  }

  get path(): string {
    return this.file;
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n");
  }

  error(err: unknown, context: Record<string, unknown> = {}): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.event("error", { message: e.message, name: e.name, stack: e.stack, ...context });
  }
}

const tty = process.stdout.isTTY ?? false;

export const ui = {
  info: (msg: string) => console.log(msg),
  step: (msg: string) => console.log(`\x1b[36m›\x1b[0m ${msg}`),
  ok: (msg: string) => console.log(`\x1b[32m✔\x1b[0m ${msg}`),
  warn: (msg: string) => console.log(`\x1b[33m!\x1b[0m ${msg}`),
  fail: (msg: string) => console.error(`\x1b[31m✖\x1b[0m ${msg}`),
  dim: (msg: string) => console.log(`\x1b[2m${msg}\x1b[0m`),

  /**
   * Returns an onToken handler that keeps a single status line updated while a model is
   * generating, so a slow local model is visibly alive rather than silently hanging.
   */
  progress(label: string): TokenFn & { done: () => void } {
    let lastPrint = 0;
    const render = (text: string) => {
      if (tty) process.stdout.write(`\r\x1b[2K\x1b[2m  ${label}: ${text}\x1b[0m`);
    };
    const fn = (({ tokens, elapsedMs, phase }) => {
      const now = Date.now();
      if (now - lastPrint < 250 && tokens > 0) return;
      lastPrint = now;
      const secs = (elapsedMs / 1000).toFixed(0);
      if (phase === "prompt" || tokens === 0) render(`processing prompt... ${secs}s`);
      else render(`${tokens} tokens, ${secs}s (${(tokens / Math.max(elapsedMs / 1000, 0.001)).toFixed(1)} tok/s)`);
    }) as TokenFn & { done: () => void };
    fn.done = () => {
      if (tty) process.stdout.write("\r\x1b[2K");
    };
    return fn;
  },
};
