import { spawn } from "node:child_process";

function git(args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const child = spawn("git", args, { cwd, shell: false, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => res({ code: null, out, err: err + e.message }));
    child.on("close", (code) => res({ code, out, err }));
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  return r.code === 0 && r.out.trim() === "true";
}

export async function isDirty(cwd: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], cwd);
  if (r.code !== 0) throw new Error(`git status failed: ${r.err.trim()}`);
  return r.out.trim().length > 0;
}

/** Diff of everything not yet committed (staged + unstaged + untracked), bounded. */
export async function workingDiff(cwd: string, maxChars = 40_000): Promise<string> {
  await git(["add", "-N", "."], cwd); // intent-to-add so untracked files show in diff
  const r = await git(["diff", "HEAD", "--stat", "--patch", "--no-color"], cwd);
  const text = r.code === 0 ? r.out : `(git diff failed: ${r.err.trim()})`;
  return text.length > maxChars ? text.slice(0, maxChars) + `\n...[diff truncated ${text.length - maxChars} chars]` : text;
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  const add = await git(["add", "-A"], cwd);
  if (add.code !== 0) throw new Error(`git add failed: ${add.err.trim()}`);
  const commit = await git(["commit", "-m", message], cwd);
  if (commit.code !== 0) {
    if (/nothing to commit/i.test(commit.out + commit.err)) return "(nothing to commit)";
    throw new Error(`git commit failed: ${commit.err.trim() || commit.out.trim()}`);
  }
  const sha = await git(["rev-parse", "--short", "HEAD"], cwd);
  return sha.out.trim();
}
