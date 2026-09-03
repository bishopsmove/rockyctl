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

  // Where did the models actually land? A model that only partially fits in VRAM runs on
  // CPU for the rest and can be 10x slower — the usual reason a first iteration "hangs".
  try {
    const loaded = await client.loadedModels();
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + " GB";
    for (const model of new Set(Object.values(settings.models))) {
      const m = loaded.find((l) => l.name === model || l.name === `${model}:latest`);
      if (!m) {
        ui.warn(`${model} is not resident after warm-up (evicted already? check keepAlive / other clients).`);
        continue;
      }
      const pct = m.size ? Math.round((m.size_vram / m.size) * 100) : 0;
      const ctx = m.context_length ? `, ctx ${m.context_length}` : "";
      if (pct >= 100) ui.ok(`${model}: ${gb(m.size)} fully in GPU memory${ctx}`);
      else if (pct === 0) ui.warn(`${model}: ${gb(m.size)} loaded entirely on CPU${ctx} — expect very slow generation.`);
      else ui.warn(`${model}: ${gb(m.size)} loaded, only ${pct}% in GPU memory${ctx} — partial CPU offload, expect slow generation.`);
    }
    const total = loaded.reduce((a, m) => a + m.size, 0);
    if (loaded.length > 1) ui.info(`  ${loaded.length} models resident, ${gb(total)} total. If they don't both fit, Ollama will swap them every iteration.`);
  } catch (err) {
    ui.warn(`Could not query /api/ps: ${err instanceof Error ? err.message : String(err)}`);
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
