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

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);

describe("cleanup test-created assets", () => {
  let testDir: string;
  let fakeOllama: any;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-cleanup-test-" + Date.now().toString());
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
  });

  test.afterEach(async () => {
    if (fakeOllama && !fakeOllama.killed) {
      fakeOllama.kill();
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("untracked files are removed at the end of an iteration", async () => {
    const configDir = path.join(testDir, ".rockyctl", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, ".rockyctl"), { recursive: true });
    
    const yamlContent = `
ollama:
  baseUrl: http://localhost:11499
loop:
  maxAttempts: 2
  maxIterations: 1
  maxToolCallsPerIteration: 10
git:
  autoCommit: true
  checkDirtyTree: true
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
    
    const tasksContent = JSON.stringify([
      {
        id: "test-task",
        title: "test task",
        status: "pending",
        attempts: 0,
        description: "create a file",
      }
    ], null, 2);
    fs.writeFileSync(path.join(testDir, ".rockyctl", "tasks.yaml"), tasksContent);

    try {
      await runLoop(loadSettings(testDir), testDir, { once: true });
    } catch (e) {
      console.error("Error during runLoop:", e);
    }

    const helloTxtPath = path.join(testDir, "hello.txt");
    assert.ok(!fs.existsSync(helloTxtPath), "hello.txt should have been removed");
  });
});
