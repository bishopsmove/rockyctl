import type { Settings } from "../config.js";
import type { ToolDefinition } from "../ollama.js";
import { listDir, readFile, searchFiles, writeFile } from "./fs.js";
import { runCommand } from "./shell.js";

export const READ_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file relative to the project root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative file path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and folders under a directory (relative to project root). Ignores node_modules, .git, build output.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative directory path, default '.'" },
          depth: { type: "integer", description: "How many levels deep, default 2" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search file contents with a case-insensitive regex. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or literal text to find" },
          path: { type: "string", description: "Relative directory to search, default '.'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run ONE plain command in the project root and return its exit code and output. Only allowlisted commands are permitted (see the system prompt). No shell: no pipes, redirects, && or globbing.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "e.g. 'npm test' or 'git status'" } },
        required: ["command"],
      },
    },
  },
];

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file relative to the project root. Always write the COMPLETE file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
];

export const GENERATOR_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
export const JUDGE_TOOLS = READ_TOOLS;

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  settings: Settings,
  allowWrites: boolean,
): Promise<string> {
  const str = (k: string, def?: string) => {
    const v = args[k];
    if (v === undefined || v === null) {
      if (def !== undefined) return def;
      throw new Error(`Missing required argument "${k}"`);
    }
    return String(v);
  };
  try {
    switch (name) {
      case "read_file":
        return await readFile(cwd, str("path"));
      case "list_dir":
        return await listDir(cwd, str("path", "."), Number(args.depth ?? 2));
      case "search_files":
        return await searchFiles(cwd, str("pattern"), str("path", "."));
      case "run_command": {
        const r = await runCommand(str("command"), cwd, settings.shell);
        return [
          `exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""} (${r.durationMs}ms)`,
          r.stdout ? `stdout:\n${r.stdout}` : "stdout: (empty)",
          r.stderr ? `stderr:\n${r.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "write_file":
        if (!allowWrites) throw new Error("write_file is not available to the judge.");
        return await writeFile(cwd, str("path"), str("content"));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}
