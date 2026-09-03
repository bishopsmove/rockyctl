import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Settings } from "./config.js";
import { OllamaClient, type ChatMessage } from "./ollama.js";
import { TaskStore, type Task } from "./tasks.js";
import { GENERATOR_TOOLS, JUDGE_TOOLS, executeTool } from "./tools/index.js";
import { commitAll, isDirty, isGitRepo, workingDiff } from "./tools/git.js";
import { generatorSystemPrompt, generatorUserPrompt, judgeSystemPrompt, judgeUserPrompt } from "./prompts.js";
import { RunLog, ui } from "./log.js";

export interface RunOptions {
  once?: boolean;
  taskId?: string;
  dryRun?: boolean;
}

interface Verdict {
  pass: boolean;
  critique: string;
  criteria?: { index: number; met: boolean; note?: string }[];
}

export async function runLoop(settings: Settings, cwd: string, opts: RunOptions = {}): Promise<void> {
  const client = new OllamaClient(settings.ollama);
  const store = new TaskStore(resolve(cwd, settings.files.tasks));
  const promptPath = resolve(cwd, settings.files.prompt);
  const projectPrompt = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
  const log = new RunLog(settings.files.logDir, cwd);

  const inRepo = await isGitRepo(cwd);
  if (!inRepo && (settings.git.autoCommit || settings.git.checkDirtyTree)) {
    throw new Error(`${cwd} is not a git repository. Run \`git init\` or disable git.autoCommit and git.checkDirtyTree.`);
  }
  if (settings.git.checkDirtyTree && (await isDirty(cwd))) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them first, or set git.checkDirtyTree: false.");
  }

  await client.waitUntilReady([settings.models.generator, settings.models.judge], ui.step);
  log.event("ready", { models: settings.models });

  try {
    await runIterations(client, settings, cwd, store, projectPrompt, log, opts);
  } catch (err) {
    log.event("error", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    ui.dim(`Log: ${log.path}`);
    throw err;
  }

  ui.dim(`Log: ${log.path}`);
  const s = store.summary();
  ui.info(`Tasks — done: ${s.done}, pending: ${s.pending}, blocked: ${s.blocked}`);
}

async function runIterations(
  client: OllamaClient,
  settings: Settings,
  cwd: string,
  store: TaskStore,
  projectPrompt: string,
  log: RunLog,
  opts: RunOptions,
): Promise<void> {
  for (let iteration = 1; iteration <= settings.loop.maxIterations; iteration++) {
    const task = opts.taskId ? store.get(opts.taskId) : store.next();
    if (!task) {
      ui.ok(opts.taskId ? `Task ${opts.taskId} not found.` : "No pending tasks. Done.");
      break;
    }
    if (opts.taskId && (task.status === "done" || task.status === "blocked")) {
      ui.warn(`Task ${task.id} is ${task.status}; set it back to pending in ${settings.files.tasks} to re-run.`);
      break;
    }

    ui.info("");
    ui.step(`Iteration ${iteration}/${settings.loop.maxIterations} — task ${task.id}: ${task.title} (attempt ${task.attempts + 1}/${settings.loop.maxAttempts})`);
    log.event("iteration.start", { iteration, task: task.id, attempt: task.attempts + 1 });
    store.update(task.id, { status: "in_progress" });

    if (opts.dryRun) {
      ui.dim(generatorUserPrompt(task, settings));
      break;
    }

    // --- Generator: fresh context every iteration; state lives on disk. ---
    const summary = await runGenerator(client, settings, cwd, task, projectPrompt, log);
    ui.dim(`Generator summary: ${summary.slice(0, 400)}${summary.length > 400 ? "..." : ""}`);

    // --- Judge: separate model, separate context, sees diff + summary, verifies itself. ---
    const diff = await workingDiff(cwd);
    const verdict = await runJudge(client, settings, cwd, task, summary, diff, log);

    if (verdict.pass) {
      store.update(task.id, { status: "done", attempts: task.attempts + 1, lastCritique: undefined });
      ui.ok(`Task ${task.id} passed: ${verdict.critique}`);
      if (settings.git.autoCommit) {
        const sha = await commitAll(cwd, `${settings.git.commitPrefix} ${task.id} - ${task.title}`);
        ui.ok(`Committed ${sha}`);
        log.event("commit", { task: task.id, sha });
      }
    } else {
      const attempts = task.attempts + 1;
      const blocked = attempts >= settings.loop.maxAttempts;
      store.update(task.id, { status: blocked ? "blocked" : "pending", attempts, lastCritique: verdict.critique });
      ui.warn(`Task ${task.id} rejected (${attempts}/${settings.loop.maxAttempts}): ${verdict.critique.slice(0, 300)}`);
      if (blocked) {
        ui.fail(`Task ${task.id} marked blocked after ${attempts} attempts. Uncommitted changes left in the working tree for inspection.`);
        log.event("task.blocked", { task: task.id });
        if (settings.git.checkDirtyTree) {
          ui.warn("Working tree is now dirty; resolve it before the next run (or use `git checkout . && git clean -fd` to discard).");
          break;
        }
      }
    }

    if (opts.once) break;
  }
}

async function runGenerator(
  client: OllamaClient,
  settings: Settings,
  cwd: string,
  task: Task,
  projectPrompt: string,
  log: RunLog,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: generatorSystemPrompt(projectPrompt, settings) },
    { role: "user", content: generatorUserPrompt(task, settings) },
  ];
  let toolCalls = 0;
  for (;;) {
    const res = await client.chat(settings.models.generator, messages, { tools: GENERATOR_TOOLS });
    const msg = res.message;
    messages.push(msg);
    log.event("generator.turn", { task: task.id, content: msg.content, tool_calls: msg.tool_calls, eval_count: res.eval_count });

    if (!msg.tool_calls?.length) return msg.content ?? "";

    for (const call of msg.tool_calls) {
      toolCalls++;
      const name = call.function.name;
      const args = call.function.arguments ?? {};
      ui.dim(`  tool: ${name}(${describeArgs(args)})`);
      const result = await executeTool(name, args, cwd, settings, true);
      log.event("tool", { role: "generator", task: task.id, name, args, result: result.slice(0, 4000) });
      messages.push({ role: "tool", content: result, tool_name: name });
    }
    if (toolCalls >= settings.loop.maxToolCallsPerIteration) {
      messages.push({
        role: "user",
        content: `Tool call budget (${settings.loop.maxToolCallsPerIteration}) exhausted. Stop now and summarize what you did and what remains.`,
      });
      const final = await client.chat(settings.models.generator, messages);
      log.event("generator.turn", { task: task.id, content: final.message.content, budgetExhausted: true });
      return final.message.content ?? "";
    }
  }
}

async function runJudge(
  client: OllamaClient,
  settings: Settings,
  cwd: string,
  task: Task,
  summary: string,
  diff: string,
  log: RunLog,
): Promise<Verdict> {
  ui.step(`Judging with ${settings.models.judge} ...`);
  const messages: ChatMessage[] = [
    { role: "system", content: judgeSystemPrompt(settings) },
    { role: "user", content: judgeUserPrompt(task, summary, diff) },
  ];
  let toolCalls = 0;
  for (;;) {
    const res = await client.chat(settings.models.judge, messages, { tools: JUDGE_TOOLS, temperature: 0 });
    const msg = res.message;
    messages.push(msg);
    log.event("judge.turn", { task: task.id, content: msg.content, tool_calls: msg.tool_calls });

    if (msg.tool_calls?.length && toolCalls < settings.loop.maxToolCallsPerIteration) {
      for (const call of msg.tool_calls) {
        toolCalls++;
        ui.dim(`  judge tool: ${call.function.name}(${describeArgs(call.function.arguments ?? {})})`);
        const result = await executeTool(call.function.name, call.function.arguments ?? {}, cwd, settings, false);
        log.event("tool", { role: "judge", task: task.id, name: call.function.name, result: result.slice(0, 4000) });
        messages.push({ role: "tool", content: result, tool_name: call.function.name });
      }
      continue;
    }

    const parsed = parseVerdict(msg.content ?? "");
    if (parsed) {
      log.event("verdict", { task: task.id, ...parsed });
      return parsed;
    }
    // Model chatted instead of returning JSON: ask once more with JSON mode forced.
    messages.push({ role: "user", content: "Return ONLY the JSON verdict object now." });
    const retry = await client.chat(settings.models.judge, messages, { format: "json", temperature: 0 });
    const parsed2 = parseVerdict(retry.message.content ?? "");
    log.event("verdict", { task: task.id, ...(parsed2 ?? { pass: false, critique: "unparseable" }), raw: retry.message.content });
    return parsed2 ?? { pass: false, critique: `Judge returned an unparseable verdict: ${retry.message.content?.slice(0, 500)}` };
  }
}

function parseVerdict(text: string): Verdict | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const j = JSON.parse(match[0]) as Partial<Verdict>;
    if (typeof j.pass !== "boolean") return undefined;
    return { pass: j.pass, critique: String(j.critique ?? ""), criteria: j.criteria };
  } catch {
    return undefined;
  }
}

function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v)}`)
    .join(", ");
}
