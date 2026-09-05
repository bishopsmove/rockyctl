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

  const lastLogFile = join(logDir, files[files.length - 1]);
  const logContent = readFileSync(lastLogFile, "utf8");
  const lines = logContent.trim().split("\n");

  const settings = loadSettings(cwd);
  const changes: { path: string; old: any; new: any; reason: string }[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "error") {
        const msg = (event.message || "").toLowerCase();
        if (msg.includes("timeout") || msg.includes("timed out")) {
          if (msg.includes("shell")) {
            const current = settings.shell.timeoutMs;
            const next = current + 300_000;
            if (next <= 1_000_000) {
              changes.push({
                path: "shell:timeoutMs",
                old: current,
                new: next,
                reason: "Previous task run encountered a shell timeout."
              });
              setNestedValue(settings, "shell:timeoutMs", next);
            }
          } else {
            const current = settings.ollama.requestTimeoutMs;
            const next = Math.ceil(current * 1.5);
            if (next <= 1_200_000) {
              changes.push({
                path: "ollama:requestTimeoutMs",
                old: current,
                new: next,
                reason: "Previous task run encountered an Ollama request timeout."
              });
              setNestedValue(settings, "ollama:requestTimeoutMs", next);
            }
          }
        }
      }
    } catch (e) {
        // ignore parse errors
    }
  }

  if (changes.length === 0) {
    ui.info("No settings need updating to improve performance based on the last run.");
    return;
  }

  // Write changes to file
  const sPath = resolve(cwd, SETTINGS_FILE);
  writeFileSync(sPath, stringifySettings(settings));

  ui.ok("Settings updated based on last task run:");
  for (const change of changes) {
    ui.info(`  - ${change.path}: ${change.old} -> ${change.new} (${change.reason})`);
  }
}
