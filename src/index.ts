#!/usr/bin/env node
import { Command } from "commander";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, SETTINGS_FILE } from "./config.js";
import { doctor } from "./doctor.js";
import { runLoop } from "./loop.js";
import { TaskStore } from "./tasks.js";
import { ui } from "./log.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as { version: string };
const templatesDir = resolve(here, "..", "templates");

const program = new Command()
  .name("rockyctl")
  .description("Ralph-loop agent harness for local LLMs via Ollama")
  .version(pkg.version);

program
  .command("init")
  .description(`Create ${SETTINGS_FILE}, PROMPT.md and tasks.yaml in the current directory`)
  .option("--force", "overwrite existing files")
  .action((opts: { force?: boolean }) => {
    const cwd = process.cwd();
    for (const f of [SETTINGS_FILE, "PROMPT.md", "tasks.yaml"]) {
      const dest = resolve(cwd, f);
      if (existsSync(dest) && !opts.force) {
        ui.warn(`${f} exists, skipping (use --force to overwrite)`);
        continue;
      }
      copyFileSync(resolve(templatesDir, f), dest);
      ui.ok(`created ${f}`);
    }
    ui.info("\nNext: edit rockyctl.yaml and PROMPT.md, describe work in tasks.yaml, then run `rockyctl doctor`.");
  });

program
  .command("doctor")
  .description("Check Ollama connectivity, model availability, tool support, git state and settings")
  .action(async () => {
    const cwd = process.cwd();
    const ok = await doctor(loadSettings(cwd), cwd);
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("run")
  .description("Run the generator/judge loop over pending tasks")
  .option("--once", "run a single iteration then stop")
  .option("--task <id>", "run only the given task id")
  .option("--dry-run", "show the prompt that would be sent and exit")
  .action(async (opts: { once?: boolean; task?: string; dryRun?: boolean }) => {
    const cwd = process.cwd();
    await runLoop(loadSettings(cwd), cwd, { once: opts.once, taskId: opts.task, dryRun: opts.dryRun });
  });

program
  .command("status")
  .description("Show task states")
  .action(() => {
    const cwd = process.cwd();
    const settings = loadSettings(cwd);
    const store = new TaskStore(resolve(cwd, settings.files.tasks));
    for (const t of store.list()) {
      const mark = t.status === "done" ? "✔" : t.status === "blocked" ? "✖" : t.status === "in_progress" ? "›" : "·";
      ui.info(`${mark} ${t.id.padEnd(16)} ${t.status.padEnd(12)} attempts=${t.attempts}  ${t.title}`);
      if (t.lastCritique) ui.dim(`    last critique: ${t.lastCritique.slice(0, 200)}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  ui.fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
