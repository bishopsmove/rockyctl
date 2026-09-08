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

describe("tsc check error handling", () => {
  let testDir: string;
  let fakeOllama: any;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-tsc-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });

    execSync(`git init`, { cwd: testDir });
    fs.writeFileSync(path.join(testDir, "README.md"), "# Test Project");
    // Package.json with tsc command that always fails.
    const pkgJson = {
      name: "fixture",
      scripts: {
        tsc: "node -e 'process.exit(1)'"
      }
    };
    fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify(pkgJson));
    execSync(`git add README.md package.json`, { cwd: testDir });
    execSync(`git commit -m "Initial commit"`, { cwd: testDir });

    const fakeOllamaPath = resolve(rootDir, "tests/fake-ollama.mjs");
    fakeOllama = spawn("node", [fakeOllamaPath], {
      env: { ...process.env, PORT: "11498" },
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

  test("tsc check error does not stop loop and skips judge", async () => {
    const configDir = path.join(testDir, ".rockyctl", "config");
    fs.mkdirSync(configDir, { recursive: true });

    const yamlContent = `
ollama:
  baseUrl: http://localhost:11498
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
  allow: ["git *", "npm *", "npx *", "node *", "touch *", "write_file *"]
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
          id: "tsc-task",
          title: "tsc task",
          status: "pending",
          attempts: 0,
          description: "create hello.txt",
          criteria: ["create hello.txt"],
        },
      ],
      null,
      2,
    )}`;
    fs.writeFileSync(path.join(testDir, ".rockyctl", "tasks.yaml"), tasksContent);

    // We expect the loop to:
    // Iteration 1: generator calls write_file. tsc fails. Task status becomes 'pending'. Loop continues.
    // Iteration 2: generator calls write_file. tsc fails. Task status becomes 'pending'. Loop ends.
    // Total iterations: 2.
    
    // If we were using the old code (with throw), this would throw an error and the test would fail.
    await runLoop(loadSettings(testDir), testDir, { once: true });

    // The task should still be 'pending' (not 'done' because judge was never reached)
    const store = new TaskStore(path.join(testDir, ".rockyctl", "tasks.yaml"));
    const task = store.get("tsc-task");
    assert.equal(task?.status, "pending", "task should be pending because tsc failed in every iteration");

    // And the loop should have finished normally.
    // We can check if the log file exists.
    const logDir = path.join(testDir, ".rockyctl", "logs");
    const logFiles = fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(logFiles.length > 0, "a run log should have been created");
  });
});
