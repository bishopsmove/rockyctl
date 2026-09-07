import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadSettings, setNestedValue, stringifySettings, SETTINGS_FILE } from "./config.js";
import { ui } from "./log.js";

export async function tune(cwd: string) {
  const logDir = resolve(cwd, ".rockyctl/logs");
  
  if (!existsSync(logDir)) {
    ui.info("No task logs found. A task needs to be run first.");
    return;
  }

  const files = readdirSync(logDir)
    .filter(f => f.endsWith(".jsonl"))
    .sort();

  if (files.length === 0) {
    ui.info("No task logs found. A task needs to be run first.");
    return;
  }

  // 1. Get last 3 log files
  const lastFiles = files.slice(-3);
  const allEvents: any[] = [];

  for (const fileName of lastFiles) {
    const filePath = join(logDir, fileName);
    const logContent = readFileSync(filePath, "utf8");
    const lines = logContent.trim().split("\n");
    for (const line of lines) {
      try {
        allEvents.push(JSON.parse(line));
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  const settings = loadSettings(cwd);
  const changes: { path: string; old: any; new: any; reason: string }[] = [];

  // Metrics collection
  const metrics = {
    tokens_per_second: [] as number[],
    prompt_tokens_per_second: [] as number[],
    eval_tokens_per_second: [] as number[],
    vram_usage_bytes: [] as number[],
    prompt_tokens: [] as number[],
    eval_tokens: [] as number[],
  };

  const errorMessages: string[] = [];

  for (const event of allEvents) {
    if (event.type === "error") {
      errorMessages.push((event.message || "").toLowerCase());
      continue;
    }

    // Metrics collection
    if (typeof event.tokens_per_second === 'number') metrics.tokens_per_second.push(event.tokens_per_second);
    if (typeof event.prompt_tokens_per_second === 'number') metrics.prompt_tokens_per_second.push(event.prompt_tokens_per_second);
    if (typeof event.eval_tokens_per_second === 'number') metrics.eval_tokens_per_second.push(event.eval_tokens_per_second);
    if (typeof event.vram_usage_bytes === 'number') metrics.vram_usage_bytes.push(event.vram_usage_bytes);
    if (typeof event.prompt_tokens === 'number') metrics.prompt_tokens.push(event.prompt_tokens);
    if (typeof event.eval_tokens === 'number') metrics.eval_tokens.push(event.eval_tokens);
  }

  const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const avgEvalTokensPerSec = mean(metrics.eval_tokens_per_second);
  const avgVramUsage = mean(metrics.vram_usage_bytes);
  const avgPromptTokens = mean(metrics.prompt_tokens);

  // --- Analysis ---

  // 1. Timeouts and Errors (using all 3 logs)
  for (const msg of errorMessages) {
    // Timeouts
    if (msg.includes("timeout") || msg.includes("timed out")) {
      if (msg.includes("shell")) {
        const current = settings.shell.timeoutMs;
        const next = current + 300_000;
        if (next <= 1_000_000 && current !== next) {
          if (!changes.find(c => c.path === "shell:timeoutMs")) {
            changes.push({
              path: "shell:timeoutMs",
              old: current,
              new: next,
              reason: "Previous task runs encountered shell timeouts."
            });
            setNestedValue(settings, "shell:timeoutMs", next);
          }
        }
      } else {
        const current = settings.ollama.requestTimeoutMs;
        const next = Math.ceil(current * 1.5);
        if (next <= 1_200_000 && current !== next) {
          if (!changes.find(c => c.path === "ollama:requestTimeoutMs")) {
            changes.push({
              path: "ollama:requestTimeoutMs",
              old: current,
              new: next,
              reason: "Previous task runs encountered Ollama request timeouts."
            });
            setNestedValue(settings, "ollama:requestTimeoutMs", next);
          }
        }
      }
    }

    // Context overflow errors
    if (msg.includes("context length exceeded") || msg.includes("too many tokens") || msg.includes("context window")) {
      const current = settings.ollama.numCtx;
      const next = Math.ceil(current * 1.5);
      if (next <= 32768 * 4 && current !== next) {
        if (!changes.find(c => c.path === "ollama:numCtx")) {
          changes.push({
            path: "ollama:numCtx",
            old: current,
            new: next,
            reason: "Previous task runs encountered context overflow errors."
          });
          setNestedValue(settings, "ollama:numCtx", next);
        }
      }
    }
  }

  // 2. Performance based tuning (numCtx)
  // If avgPromptTokens is approaching current numCtx, increase numCtx
  if (avgPromptTokens > settings.ollama.numCtx * 0.8 && avgPromptTokens > 0) {
    const current = settings.ollama.numCtx;
    const next = Math.min(32768 * 4, Math.ceil(avgPromptTokens * 1.2));
    if (next > current && next <= 32768 * 4) {
      if (!changes.find(c => c.path === "ollama:numCtx")) {
        changes.push({
          path: "ollama:numCtx",
          old: current,
          new: next,
          reason: "Prompt tokens are approaching the current context limit."
        });
        setNestedValue(settings, "ollama:numCtx", next);
      }
    }
  }

  // If eval tokens per second is very low and VRAM usage is being reported, 
  // it might indicate memory pressure/swapping, so try reducing numCtx.
  if (avgEvalTokensPerSec > 0 && avgEvalTokensPerSec < 5 && avgVramUsage > 0) {
    const current = settings.ollama.numCtx;
    const next = Math.max(1024, Math.floor(current / 2));
    if (next < current) {
      if (!changes.find(c => c.path === "ollama:numCtx")) {
        changes.push({
          path: "ollama:numCtx",
          old: current,
          new: next,
          reason: "Low tokens per second with VRAM usage suggests reducing context size might help."
        });
        setNestedValue(settings, "ollama:numCtx", next);
      }
    }
  }

  if (changes.length === 0) {
    ui.info("No settings need updating to improve performance based on the last 3 runs.");
    return;
  }

  // Write changes to file
  const sPath = resolve(cwd, SETTINGS_FILE);
  writeFileSync(sPath, stringifySettings(settings));

  ui.ok("Settings updated based on the last 3 runs:");
  for (const change of changes) {
    ui.info(`  - ${change.path}: ${change.old} -> ${change.new} (${change.reason})`);
  }
}
