import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoop } from "../src/loop.js";
import { loadSettings } from "../src/config.js";
import { createServer } from "node:http";

test("cleanupGitLock removes index.lock if judge fails", async () => {
  const tempDirBase = resolve(process.cwd(), "temp_test_git_lock");
  const tempDir = tempDirBase + "_" + Date.now();
  if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir);

  // 1. Setup git repo
  execSync("git init", { cwd: tempDir });
  execSync("git config user.email \"test@example.com\"", { cwd: tempDir });
  execSync("git config user.name \"Test User\"", { cwd: tempDir });
  execSync('git commit --allow-empty -m "initial"', { cwd: tempDir });

  const gitDir = resolve(tempDir, ".git");
  const lockFile = join(gitDir, "index.lock");
  writeFileSync(lockFile, "lock content");
  assert.ok(existsSync(lockFile), "Lock file should exist initially");

  // 2. Start a failing server on a random port
  const server = await new Promise<typeof createServer>((resolve, reject) => {
    const s = createServer((req, res) => {
      if (req.url === "/api/chat") {
        res.writeHead(500);
        res.end();
      } else if (req.url === "/api/tags" || req.url === "/api/ps") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "gen:latest", size: 100 }, { name: "judge:latest", size: 100 }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
    s.on('error', reject);
  });
  const port = server.address()?.port as number;
  if (port === undefined) throw new Error("Could not get server port");

  try {
    // 3. Prepare configuration
    const configDir = resolve(tempDir, ".rockyctl/config");
    const tasksDir = resolve(tempDir, ".rockyctl");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(tasksDir, { recursive: true });

    const yamlContent = `
ollama:
  baseUrl: "http://127.0.0.1:${port}"
  readyTimeoutMs: 2000
  requestTimeoutMs: 2000
models:
  generator: "gen:latest"
  judge: "judge:latest"
loop:
  maxAttempts: 1
  maxIterations: 2
tasks: ".rockyctl/tasks.yaml"
files:
  tasks: ".rockyctl/tasks.yaml"
  prompt: ".rockyctl/PROMPT.md"
  logDir: ".rockyctl/logs"
`;
    writeFileSync(resolve(configDir, "rockyctl.yaml"), yamlContent);
    writeFileSync(resolve(tasksDir, "tasks.yaml"), "[]");
    writeFileSync(resolve(configDir, "PROMPT.md"), "prompt");

    // 4. Run the loop. We expect it to fail eventually.
    const settings = loadSettings(tempDir);
    try {
      await runLoop(settings, tempDir, { once: true });
    } catch (e) {
      // Expected error from the server
    }

    // 5. Verify lock file is gone
    assert.ok(!existsSync(lockFile), "Lock file should have been cleaned up");

  } finally {
    server.close();
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  }
});
