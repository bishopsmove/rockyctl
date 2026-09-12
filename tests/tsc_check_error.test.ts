import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLoop } from "../src/loop.js";
import { loadSettings } from "../src/config.js";
import { TaskStore } from "../src/tasks.js";

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);

describe("tsc check error handling", () => {
  let testDir: string;
  let fakeOllama: any;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-tsc-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });

    execSync(`git init`, { cwd: testDir });
    fs.writeFileSync(path.join(testDir, "README.md"), "# Test Project");
    
    // Create a package.json where tsc always fails
    fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify({
      name: "fixture",
      scripts: { tsc: "exit 1" }
    }));

    execSync(`git add README.md package.json`, { cwd: testDir });
    execSync(`git commit -m "Initial commit"`, { cwd: testDir });
    const gitIgnoreContent = `
.rockyctl/
`;
    fs.writeFileSync(path.join(testDir, ".gitignore"), gitIgnoreContent);

    execSync(`git add .gitignore`, { cwd: testDir });
    execSync(`git commit -m "gitIgnore commit"`, { cwd: testDir });

    const fakeOllamaPath = resolve(rootDir, "tests/fake-ollama.mjs");
    fakeOllama = spawn("node", [fakeOllamaPath], {
      env: { ...process.env, PORT: "11498", RESET_ONCE: "1" },
      detached: true,
      stdio: "ignore",
    });
    fakeOllama.unref();

    await new Promise((r) => setTimeout(r, 1000));
  });

  test.afterEach(async () => {
    if (fakeOllama && !fakeOllama.killed) {
      fakeOllama.kill();
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("tsc check failure does not stop the loop and provides critique for next attempt", async () => {
    const configDir = path.join(testDir, ".rockyctl", "config");
    fs.mkdirSync(configDir, { recursive: true });

    const yamlContent = `
providers:
  - providerName: ollama
    baseUrl: http://localhost:11498
    maxRetries: 2
    retryBackoffMs: 20
models:
  generator: gen:latest
  judge: judge:latest
loop:
  maxAttempts: 2
  maxIterations: 2
  maxToolCallsPerIteration: 10
git:
  autoCommit: true
  checkDirtyTree: false
  commitPrefix: "test:"
shell:
  allow: ["git *", "npm *", "npx *", "node *", "touch *"]
files:
  prompt: ".rockyctl/config/PROMPT.md"
  tasks: ".rockyctl/tasks.yaml"
  logDir: ".rockyctl/logs"
  workingFolder: "."
`;
    fs.writeFileSync(path.join(configDir, "rockyctl.yaml"), yamlContent);
    fs.writeFileSync(path.join(configDir, "PROMPT.md"), "You are a helpful assistant.");

    const tasksContent = `tasks: ${JSON.stringify(
      [
        {
          id: "tsc-test-task",
          title: "tsc test task",
          status: "pending",
          attempts: 0,
          description: "do nothing",
          criteria: ["do nothing"],
        },
      ],
      null,
      2,
    )}`;
    fs.writeFileSync(path.join(testDir, ".rockyctl", "tasks.yaml"), tasksContent);

    // We expect runLoop to finish without throwing because it should handle tsc errors.
    // If it throws, the test will fail.
    await runLoop(loadSettings(testDir), testDir, { once: true });

    const store = new TaskStore(path.join(testDir, ".rockyctl", "tasks.yaml"));
    const task = store.get("tsc-test-task");

    // The task should be 'pending' or 'blocked' but not 'done'.
    // Since maxAttempts is 2, and we had 2 iterations.
    // 1st iteration: generator runs, tsc fails, status -> pending, attempts -> 1.
    // 2nd iteration: generator runs, tsc fails, status -> pending, attempts -> 2.
    // loop ends because maxIterations is 2.
    
    // If maxAttempts was 1, it would be blocked.
    // But in the loop, if we set status to pending, and it's the last iteration, it'll be pending.
    
    assert.notEqual(task?.status, "done", "task should not be done");
    assert.ok(task?.lastCritique?.includes("TSC check failed"), "lastCritique should contain TSC error");
    assert.equal(task?.attempts, 2, "task attempts should have been incremented");
  });
});
