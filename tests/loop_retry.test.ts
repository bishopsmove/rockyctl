import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
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

describe("chat() retry is logged, not silent", () => {
  let testDir: string;
  let fakeOllama: any;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-retry-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });

    execSync(`git init`, { cwd: testDir });
    fs.writeFileSync(path.join(testDir, "README.md"), "# Test Project");
    // runLoop shells out to `npm run tsc` after the generator step; give it a no-op script
    // since this fixture has no real TypeScript to check.
    fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify({ name: "fixture", scripts: { tsc: "exit 0" } }));
    execSync(`git add README.md package.json`, { cwd: testDir });
    execSync(`git commit -m "Initial commit"`, { cwd: testDir });

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

  test("a mid-stream connection reset is retried, recovers, and lands in the run log", async () => {
    const configDir = path.join(testDir, ".rockyctl", "config");
    fs.mkdirSync(configDir, { recursive: true });

    const yamlContent = `
ollama:
  baseUrl: http://localhost:11498
  maxRetries: 2
  retryBackoffMs: 20
models:
  generator: gen:latest
  judge: judge:latest
loop:
  maxAttempts: 3
  maxIterations: 1
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
          id: "test-task",
          title: "test task",
          status: "pending",
          attempts: 0,
          description: "create a file",
          criteria: ["create a file named hello.txt"],
        },
      ],
      null,
      2,
    )}`;
    fs.writeFileSync(path.join(testDir, ".rockyctl", "tasks.yaml"), tasksContent);

    await runLoop(loadSettings(testDir), testDir, { once: true });

    // The task should still have completed despite the mid-stream reset.
    const store = new TaskStore(path.join(testDir, ".rockyctl", "tasks.yaml"));
    const task = store.get("test-task");
    assert.equal(task?.status, "done", "task should pass once the retried generator call succeeds");

    // And the reset must be visible in the run log, not swallowed silently.
    const logDir = path.join(testDir, ".rockyctl", "logs");
    const logFile = fs.readdirSync(logDir).find((f) => f.endsWith(".jsonl"));
    assert.ok(logFile, "a run log should have been created");
    const events = fs
      .readFileSync(join(logDir, logFile!), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const retries = events.filter((e) => e.type === "retry");
    assert.equal(retries.length, 1, "exactly one retry should have been logged");
    assert.equal(retries[0].role, "generator");
    assert.equal(retries[0].task, "test-task");
    assert.equal(retries[0].attempt, 1);
    assert.match(retries[0].error, /Streaming from gen:latest failed|ended without a final chunk/);
  });
});
