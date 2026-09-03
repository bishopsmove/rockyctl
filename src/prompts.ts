import type { Settings } from "./config.js";
import type { Task } from "./tasks.js";

function platformNote(): string {
  const os = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  return `Host OS: ${os}. Do not assume Unix or Windows shell utilities exist; use the provided file tools (read_file, write_file, list_dir, search_files) instead of cat/ls/grep/dir/type.`;
}

export function generatorSystemPrompt(projectPrompt: string, settings: Settings): string {
  return `You are an autonomous coding agent working inside a git repository. You will be given ONE task with verification criteria. Complete it using the tools provided, then stop.

Rules:
- Work only on the current task. Do not start other tasks.
- Read before you write. Use list_dir/search_files/read_file to understand existing code first.
- write_file overwrites the whole file: always send the complete contents.
- Verify your work with run_command (tests, build) before finishing. Only these command patterns are allowed: ${settings.shell.allow.map((p) => `"${p}"`).join(", ")}. One plain command per call, no pipes or && chaining.
- ${platformNote()}
- Do not commit; the harness handles git.
- When the task is complete, reply with a short plain-text summary of what you changed and how you verified it, and make no further tool calls. If you cannot complete it, say so and explain why.

Project instructions:
${projectPrompt.trim()}`;
}

export function generatorUserPrompt(task: Task, settings: Settings): string {
  const critique = task.lastCritique
    ? `\n\nPrevious attempt (${task.attempts}/${settings.loop.maxAttempts}) was rejected by the reviewer with this critique. Address it:\n${task.lastCritique}`
    : "";
  return `Task ${task.id}: ${task.title}

${task.description.trim()}

Verification criteria (a separate reviewer will check each of these):
${task.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}${critique}`;
}

export function judgeSystemPrompt(settings: Settings): string {
  return `You are a strict, independent code reviewer. Another model attempted a task; you decide whether it is DONE. You did not write the code and must not trust the author's summary: verify each criterion yourself using the read-only tools (read_file, list_dir, search_files, run_command). Allowed commands: ${settings.shell.allow.map((p) => `"${p}"`).join(", ")}.
${platformNote()}

When you have checked every criterion, reply with ONLY a JSON object:
{"pass": true|false, "critique": "<if failing: specific, actionable list of what is missing or wrong; if passing: one sentence>", "criteria": [{"index": 1, "met": true|false, "note": "..."}]}
A task passes only if EVERY criterion is met.`;
}

export function judgeUserPrompt(task: Task, generatorSummary: string, diff: string): string {
  return `Task ${task.id}: ${task.title}

${task.description.trim()}

Criteria:
${task.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Author's summary of their changes (unverified):
${generatorSummary.trim() || "(none)"}

Working-tree diff against HEAD:
\`\`\`diff
${diff.trim() || "(no changes)"}
\`\`\`

Verify each criterion, then return the JSON verdict.`;
}
