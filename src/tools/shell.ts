import { spawn } from "node:child_process";
import type { Settings } from "../config.js";

/**
 * Characters that would only have meaning to a shell. We never hand the command to a
 * shell on POSIX, and on Windows we only do so after rejecting these, so chaining,
 * piping, redirection and expansion cannot sneak past the allowlist.
 */
const SHELL_METACHARS = /[|&;<>`$(){}\n\r]/;

/** Tokenizer with basic single/double quote handling. Throws on metacharacters. */
export function tokenize(command: string): string[] {
  if (SHELL_METACHARS.test(command)) {
    throw new Error(
      "Command contains shell metacharacters (| & ; < > ` $ ( ) { }). Commands run without a shell; issue one plain command at a time.",
    );
  }
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(cur);
        cur = "";
        inToken = false;
      }
      continue;
    }
    cur += ch;
    inToken = true;
  }
  if (quote) throw new Error("Unterminated quote in command.");
  if (inToken) tokens.push(cur);
  return tokens;
}

/**
 * Pattern matching: "git *" allows any git command; "npm test" allows exactly that;
 * "npm run *" allows any npm script. A "*" in a non-final position matches one token.
 */
export function matchesPattern(tokens: string[], pattern: string): boolean {
  const pt = pattern.trim().split(/\s+/).filter(Boolean);
  if (pt.length === 0) return false;
  for (let i = 0; i < pt.length; i++) {
    const p = pt[i];
    const isLast = i === pt.length - 1;
    if (p === "*" && isLast) return tokens.length >= i; // trailing * matches zero or more
    if (i >= tokens.length) return false;
    if (p === "*") continue;
    if (p.toLowerCase() !== tokens[i].toLowerCase()) return false;
  }
  return tokens.length === pt.length;
}

export function isAllowed(tokens: string[], allow: string[]): string | undefined {
  return allow.find((p) => matchesPattern(tokens, p));
}

/** Tools that exist on one family of OS and not the other. Used by `doctor` to warn. */
const POSIX_ONLY = new Set(["ls", "cat", "grep", "sed", "awk", "rm", "cp", "mv", "touch", "chmod", "chown", "find", "which", "sh", "bash", "zsh", "tail", "head", "wc", "make"]);
const WINDOWS_ONLY = new Set(["dir", "type", "del", "copy", "move", "ren", "cmd", "powershell", "pwsh", "where", "findstr", "cls", "rd", "md", "erase"]);

export function platformWarnings(allow: string[], platform = process.platform): string[] {
  const warnings: string[] = [];
  for (const pattern of allow) {
    const head = pattern.trim().split(/\s+/)[0]?.toLowerCase();
    if (!head || head === "*") continue;
    if (platform === "win32" && POSIX_ONLY.has(head)) {
      warnings.push(`"${pattern}" targets a Unix tool that is not available on Windows.`);
    } else if (platform !== "win32" && WINDOWS_ONLY.has(head)) {
      warnings.push(`"${pattern}" targets a Windows tool that is not available on ${platform}.`);
    } else if (POSIX_ONLY.has(head) || WINDOWS_ONLY.has(head)) {
      warnings.push(`"${pattern}" is OS-specific; other contributors on a different OS will see it fail. Prefer a cross-platform tool.`);
    }
  }
  return warnings;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export async function runCommand(
  command: string,
  cwd: string,
  shell: Settings["shell"],
): Promise<CommandResult> {
  const tokens = tokenize(command);
  if (tokens.length === 0) throw new Error("Empty command.");
  const matched = isAllowed(tokens, shell.allow);
  if (!matched) {
    throw new Error(
      `Command not allowed: "${command}". Allowed patterns: ${shell.allow.map((p) => `"${p}"`).join(", ")}`,
    );
  }

  // On Windows, .cmd/.bat launchers (npm, npx, dotnet tool shims...) cannot be spawned
  // without a shell since Node 20.12. The metacharacter rejection above already guarantees
  // the string is a single plain command, so handing it to cmd.exe is safe.
  const useShell = process.platform === "win32";

  const started = Date.now();
  return new Promise<CommandResult>((resolvePromise) => {
    const child = useShell
      ? spawn(command, { cwd, shell: true, windowsHide: true })
      : spawn(tokens[0], tokens.slice(1), { cwd, shell: false });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string) => (s.length > shell.maxOutputChars ? s.slice(0, shell.maxOutputChars) + `\n...[truncated ${s.length - shell.maxOutputChars} chars]` : s);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, shell.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        command,
        exitCode: null,
        stdout: cap(stdout),
        stderr: cap(stderr + `\nspawn error: ${err.message}`),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        command,
        exitCode: code,
        stdout: cap(stdout),
        stderr: cap(stderr),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
