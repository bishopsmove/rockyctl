#!/usr/bin/env node
import { Command } from "commander";
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
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
