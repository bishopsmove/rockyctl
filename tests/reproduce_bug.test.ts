import { test, describe } from "node:test";
import assert from "node:assert";
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

describe("reproduce loop bug", () => {
  let testDir: string;
  let fakeOllama: any;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-reproduce-bug-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });
    
    // Initialize git in testDir
    execSync(`git init`, { cwd: testDir });
    fs.writeFileSync(path.join(testDir, "README.md"), "# Test Project");
    execSync(`git add README.md`, { cwd: testDir });
    execSync(`git commit -m "Initial commit"`, { cwd: testDir });

    // Start fake-ollama in the background
    const fakeOllamaPath = resolve(rootDir, "tests/fake-ollama.mjs");
    fakeOllama = spawn("node", [fakeOllamaPath, "--port", "11499"], {
      detached: true,
      stdio: 'ignore'
    });
    fakeOllama.unref();
    
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create a dummy package.json so npm run tsc doesn't fail
    fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify({
      "name": "test-project",
      "type": "module",
      "scripts": {
        "tsc": "echo 'skipping tsc'"
      }
    }));
  });

  test.afterEach(async () => {
    if (fakeOllama && !fakeOllama.killed) {
      fakeOllama.kill();
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("loop should continue to next task when current task reaches maxAttempts", async () => {
    const configDir = path.join(testDir, ".rockyctl", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, ".rockyctl"), { recursive: true });
    
    const yamlContent = `
providers:
  - providerName: "ollama"
    baseUrl: http://localhost:11499
models:
  generator: gen:latest
  judge: judge:latest
loop:
  maxAttempts: 1
  maxIterations: 5
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
    const gitIgnoreContent = `
.rockyctl/
`;
    fs.writeFileSync(path.join(testDir, ".gitignore"), gitIgnoreContent);

    execSync(`git add .gitignore`, { cwd: testDir });
    execSync(`git commit -m "gitIgnore commit"`, { cwd: testDir });

    // Two tasks. Task 1 will fail, Task 2 should be attempted.
    const tasksContent = `tasks: ${JSON.stringify([
      {
        id: "task-1",
        title: "task 1",
        status: "pending",
        attempts: 0,
        description: "fail me",
        criteria: ["some criteria"]
      },
      {
        id: "task-2",
        title: "task 2",
        status: "pending",
        attempts: 0,
        description: "succeed me",
        criteria: ["some criteria"]
      }
    ], null, 2)}`;
    fs.writeFileSync(path.join(testDir, ".rockyctl", "tasks.yaml"), tasksContent);

    try {
      await runLoop(loadSettings(testDir), testDir, { once: false });
    } catch (e) {
      console.error("Error during runLoop:", e);
    }

    const store = new TaskStore(path.join(testDir, ".rockyctl", "tasks.yaml"));
    const task1 = store.get("task-1");
    const task2 = store.get("task-2");
    
    console.log("Task 1 status:", task1?.status);
    console.log("Task 2 status:", task2?.status);
    console.log("Task 2 attempts:", task2?.attempts);

    // If the bug is present:
    // Task 1 is attempted once, fails, gets blocked. 
    // Loop iteration counter becomes 1. 
    // Since maxLoopCount was Math.min(1, 5) = 1, the loop exits.
    // Task 2 status will be 'pending' and attempts will be 0.
    
    // If the bug is fixed:
    // Task 2 should have been attempted.
    assert.notStrictEqual(task2?.status, "pending", "Task 2 should have been attempted and its status should not be pending");
  });
});
