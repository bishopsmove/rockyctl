import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tune } from "../src/tune.js";
import { loadSettings } from "../src/config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("tune command", () => {
  let tempDir: string;
  let cwd: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(os.tmpdir());
    cwd = tempDir;
    
    const configDir = resolve(cwd, ".rockyctl/config");
    const logsDir = resolve(cwd, ".rockyctl/logs");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    // Create a default rockyctl.yaml in the temp dir
    const defaultSettings = {
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        readyTimeoutMs: 120000,
        requestTimeoutMs: 600000,
        keepAlive: "30m",
        numCtx: 32768
      },
      models: {
        generator: "gemma4:26b-a4b-it-qat",
        judge: "gemma4:12b-it-qat"
      },
      loop: {
        maxAttempts: 3,
        maxIterations: 50,
        maxToolCallsPerIteration: 40
      },
      git: {
        autoCommit: true,
        checkDirtyTree: true,
        commitPrefix: "rockyctl:"
      },
      shell: {
        allow: ["git *", "npm *", "npx *", "node *"],
        timeoutMs: 300000,
        maxOutputChars: 20000
      },
      files: {
        prompt: ".rockyctl/config/PROMPT.md",
        tasks: ".rockyctl/tasks.yaml",
        logDir: ".rockyctl/logs",
        workingFolder: "/"
      }
    };
    writeFileSync(resolve(cwd, ".rockyctl/config/rockyctl.yaml"), JSON.stringify(defaultSettings, null, 2));
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("should inform user if no log files exist", async () => {
    const settingsBefore = loadSettings(cwd);
    
    await tune(cwd);
    
    const settingsAfter = loadSettings(cwd);
    assert.deepEqual(settingsBefore, settingsAfter, "Settings should not change if no logs exist");
  });

  test("should update ollama timeout if a request timeout error is found in logs", async () => {
    const logsDir = resolve(cwd, ".rockyctl/logs");
    const logFile = resolve(logsDir, "run-test.jsonl");
    
    const errorEvent = {
      ts: new Date().toISOString(),
      type: "error",
      message: "Ollama request timed out"
    };
    writeFileSync(logFile, JSON.stringify(errorEvent) + "\n");

    const settingsBefore = loadSettings(cwd);
    const oldTimeout = settingsBefore.ollama.requestTimeoutMs;

    await tune(cwd);

    const settingsAfter = loadSettings(cwd);
    const newTimeout = settingsAfter.ollama.requestTimeoutMs;

    assert.strictEqual(newTimeout, Math.ceil(oldTimeout * 1.5));
  });

  test("should update shell timeout if a shell timeout error is found in logs", async () => {
    const logsDir = resolve(cwd, ".rockyctl/logs");
    const logFile = resolve(logsDir, "run-test.jsonl");
    
    const errorEvent = {
      ts: new Date().toISOString(),
      type: "error",
      message: "Shell command timed out"
    };
    writeFileSync(logFile, JSON.stringify(errorEvent) + "\n");

    const settingsBefore = loadSettings(cwd);
    const oldTimeout = settingsBefore.shell.timeoutMs;

    await tune(cwd);

    const settingsAfter = loadSettings(cwd);
    const newTimeout = settingsAfter.shell.timeoutMs;

    assert.strictEqual(newTimeout, oldTimeout + 300000);
  });
});
