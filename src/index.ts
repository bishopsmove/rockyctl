#!/usr/bin/env node
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, getNestedValue, stringifySettings, SETTINGS_FILE, setNestedValue, SettingsSchema } from "./config.js";
import { doctor } from "./doctor.js";
import { runLoop } from "./loop.js";
import { TaskStore } from "./tasks.js";
import { ui } from "./log.js";
import { runUi } from "./ui_cli.js";
import { tune } from "./tune.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as { version: string };
const templatesDir = resolve(here, "..", "templates");

const program = new Command()
  .name("rockyctl")
  .description("Ralph-loop agent harness for local LLMs via Ollama")
  .version(pkg.version);

program
  .command("init")
  .description(`Create configuration files in .rockyctl/config/ and .rockyctl/`)
  .option("--force", "overwrite existing files")
  .option("--updateGitIgnore", "add .rockyctl/ to .gitignore")
  .action((opts: { force?: boolean; updateGitIgnore?: boolean }) => {
    const cwd = process.cwd();
    const filesToCreate = [
      { name: "rockyctl.yaml", subfolder: ".rockyctl/config" },
      { name: "PROMPT.md", subfolder: ".rockyctl/config" },
      { name: "tasks.yaml", subfolder: ".rockyctl" },
    ];

    for (const file of filesToCreate) {
      const destDir = resolve(cwd, file.subfolder);
      const dest = resolve(destDir, file.name);

      if (existsSync(dest) && !opts.force) {
        ui.warn(`${file.name} exists at ${file.subfolder}, skipping (use --force to overwrite)`);
        continue;
      }

      // Ensure directory exists
      mkdirSync(destDir, { recursive: true });

      copyFileSync(resolve(templatesDir, file.name), dest);
      ui.ok(`created ${file.name} in ${file.subfolder}`);
    }

    if (opts.updateGitIgnore) {
      const gitignorePath = resolve(cwd, ".gitignore");
      const gitignoreExists = existsSync(gitignorePath);
      let gitignoreContent = "";
      if (gitignoreExists) {
        gitignoreContent = readFileSync(gitignorePath, "utf8");
      }

      const lineToSearch = ".rockyctl/";
      if (!gitignoreContent.includes(lineToSearch)) {
        const contentToAdd = gitignoreExists && gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? "\n" : "";
        appendFileSync(gitignorePath, `${contentToAdd}${lineToSearch}\n`);
        ui.ok(`added ${lineToSearch} to .gitignore`);
      } else {
        ui.info(`.gitignore already contains ${lineToSearch}`);
      }
    }

    ui.info("\nNext: edit rockyctl.yaml and PROMPT.md in .rockyctl/config, describe work in .rockyctl/tasks.yaml, then run `rockyctl doctor`.");
  });

program
  .command("ui")
  .description("Enter interactive UI mode")
  .action(async () => {
    await runUi(program);
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
  .command("tune")
  .description("Optimize settings based on the last task run log")
  .action(async () => {
    const cwd = process.cwd();
    await tune(cwd);
  });

program
  .command("config")
  .description("View or update settings in .rockyctl/config/rockyctl.yaml")
  .option("--field <path>", "colon-separated path into the settings (e.g. providers:0:requestTimeoutMs)")
  .option("--set <value>", "write a new value at --field")
  .action((opts: { field?: string; set?: string }) => {
    const cwd = process.cwd();
    const settings = loadSettings(cwd);

    if (opts.set !== undefined) {
      if (!opts.field) {
        ui.fail("The --field switch is required when using --set");
        process.exitCode = 1;
        return;
      }
      let value: unknown = opts.set;
      try {
        value = JSON.parse(opts.set);
      } catch {
        // not JSON (a plain string like a URL) - keep the raw string
      }
      setNestedValue(settings, opts.field, value);
      writeFileSync(resolve(cwd, SETTINGS_FILE), stringifySettings(settings));
      ui.ok(`Updated ${opts.field} to ${opts.set}`);
      return;
    }

    if (opts.field) {
      const value = getNestedValue(settings, opts.field);
      if (value === undefined) {
        ui.fail(`Setting not found: ${opts.field}`);
        process.exitCode = 1;
        return;
      }
      console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
      return;
    }

    console.log(stringifySettings(settings));
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
