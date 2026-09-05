import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const SETTINGS_FILE = ".rockyctl/config/rockyctl.yaml";

const OllamaSchema = z.object({
  baseUrl: z.string().url().default("http://192.168.0.192:11434"),
  // Total budget for: server reachable + models present + models warmed into memory.
  readyTimeoutMs: z.number().int().positive().default(120_000),
  // Per-generation timeout for a single /api/chat call.
  requestTimeoutMs: z.number().int().positive().default(600_000),
  // How long Ollama keeps a model loaded after a request. Prevents unload between iterations.
  keepAlive: z.string().default("30m"),
  // Context window requested for generation. Generator needs room for tools + file contents.
  numCtx: z.number().int().positive().default(32_768),
});

const ModelsSchema = z.object({
  generator: z.string().default("gemma4:26b-a4b-it-qat"),
  judge: z.string().default("gemma4:12b-it-qat"),
});

const LoopSchema = z.object({
  maxAttempts: z.number().int().positive().default(3),
  maxIterations: z.number().int().positive().default(50),
  maxToolCallsPerIteration: z.number().int().positive().default(40),
});

const GitSchema = z.object({
  autoCommit: z.boolean().default(true),
  checkDirtyTree: z.boolean().default(true),
  commitPrefix: z.string().default("rockyctl:"),
});

const ShellSchema = z.object({
  // Allowlist patterns. Each pattern is matched token-by-token against the command;
  // "*" matches any single token, and a trailing "*" matches the rest of the command.
  allow: z.array(z.string()).default(["git *", "npm *", "npx *", "node *"]),
  timeoutMs: z.number().int().positive().default(300_000),
  maxOutputChars: z.number().int().positive().default(20_000),
});

const FilesSchema = z.object({
  // Project-level instructions handed to the generator on every iteration.
  prompt: z.string().default(".rockyctl/config/PROMPT.md"),
  // The task list the loop works through. See tasks.yaml for the format.
  tasks: z.string().default(".rockyctl/tasks.yaml"),
  // Where run logs land. Expected to grow into a full "storage" section later.
  logDir: z.string().default(".rockyctl/logs"),
  // The absolute directory path where files are modified.
  workingFolder: z.string().default("/"),
});

export const SettingsSchema = z.object({
  ollama: OllamaSchema.default({}),
  models: ModelsSchema.default({}),
  loop: LoopSchema.default({}),
  git: GitSchema.default({}),
  shell: ShellSchema.default({}),
  files: FilesSchema.default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function settingsPath(cwd = process.cwd()): string {
  return resolve(cwd, SETTINGS_FILE);
}

export function loadSettings(cwd = process.cwd()): Settings {
  const path = settingsPath(cwd);
  if (!existsSync(path)) {
    throw new Error(
      `No ${SETTINGS_FILE} found in ${cwd}. Run \`rockyctl init\` to create one.`,
    );
  }
  const raw = parse(readFileSync(path, "utf8")) ?? {};
  const result = SettingsSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${SETTINGS_FILE}:\n${issues}`);
  }
  return result.data;
}

export function getNestedValue(obj: any, path: string): any {
  const parts = path.split(':');
  let current = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function stringifySettings(settings: Settings): string {
  return stringify(settings);
}
