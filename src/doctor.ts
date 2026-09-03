import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Settings } from "./config.js";
import { OllamaClient } from "./ollama.js";
import { platformWarnings } from "./tools/shell.js";
import { isGitRepo, isDirty } from "./tools/git.js";
import { ui } from "./log.js";

/** Exercises every external dependency and reports; exits non-zero on hard failures. */
export async function doctor(settings: Settings, cwd: string): Promise<boolean> {
  let healthy = true;
  const fail = (m: string) => {
    healthy = false;
    ui.fail(m);
  };

  ui.info(`Platform: ${process.platform} (${process.arch}), Node ${process.version}`);

  for (const w of platformWarnings(settings.shell.allow)) ui.warn(`shell.allow: ${w}`);

  for (const [k, f] of Object.entries({ prompt: settings.files.prompt, tasks: settings.files.tasks })) {
    if (existsSync(resolve(cwd, f))) ui.ok(`${k} file: ${f}`);
    else fail(`${k} file missing: ${f}`);
  }

  if (await isGitRepo(cwd)) {
    const dirty = await isDirty(cwd);
    ui.ok(`git repository (${dirty ? "dirty" : "clean"} working tree)`);
    if (dirty && settings.git.checkDirtyTree) ui.warn("git.checkDirtyTree is on; `rockyctl run` will refuse to start until the tree is clean.");
  } else if (settings.git.autoCommit || settings.git.checkDirtyTree) {
    fail("Not a git repository, but git.autoCommit / git.checkDirtyTree are enabled.");
  }

  const client = new OllamaClient(settings.ollama);
  const started = Date.now();
  try {
    await client.waitUntilReady([settings.models.generator, settings.models.judge], ui.step);
    ui.ok(`Ollama ready in ${((Date.now() - started) / 1000).toFixed(1)}s (budget ${settings.ollama.readyTimeoutMs}ms)`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return false;
  }

  for (const [role, model] of Object.entries(settings.models)) {
    try {
      const ok = await client.supportsTools(model, settings.ollama.requestTimeoutMs);
      if (ok) ui.ok(`${role} model ${model} supports tool calling`);
      else fail(`${role} model ${model} does NOT support tool calling in Ollama; pick a tool-capable model.`);
    } catch (err) {
      fail(`${role} model ${model}: tool probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ui.info(healthy ? "\nAll checks passed." : "\nSome checks failed.");
  return healthy;
}
