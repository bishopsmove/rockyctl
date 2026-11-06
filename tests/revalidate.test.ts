import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFactory } from "../src/clients/clients.js";
import { runLoop } from "../src/loop.js";
import { SettingsSchema } from "../src/config.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskStore } from "../src/tasks.js";
import fs from "node:fs";

test("revalidate: status remains blocked if criteria are valid", async () => {
  const originalCreateClient = clientFactory.createClient;
  let revalidateCalled = false;

  // Mocking the client
  clientFactory.createClient = (provider: any) => ({
    waitUntilReady: async () => {},
    chat: async (model: string, messages: any[]) => {
      if (messages[0].content.includes("You are an expert evaluator")) {
        revalidateCalled = true;
        return {
          message: { content: '{"valid": true}' },
          done: true
        };
      }

      // First call (generator)
      if (messages[0].role === "user" && messages[0].content.includes("Task task1")) {
         return {
            message: { content: '{"pass": false, "critique": "failed"}' },
            done: true
          };
      }

      return {
        message: { content: '{"pass": false, "critique": "failed"}' },
        done: true
      };
    },
    generate: async () => ({ response: "ok", done: true }),
    loadedModels: async () => [],
    supportsTools: async () => true,
  });

  const tempDir = mkdtempSync(join(tmpdir(), 'revalidate-test-1-'));
  
  try {
    const settings = SettingsSchema.parse({
      providers: [{
        providerName: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      }],
      models: {
        generator: { name: "m1" },
        judge: { name: "m2" },
      },
      files: {
        tasks: "tasks.yaml",
      },
      loop: {
        maxIterations: 1,
        maxAttempts: 1,
        maxToolCallsPerIteration: 1,
        temp: 0,
        thinkEffort: "none"
      }
    });

    // Create dummy package.json so tsc check doesn't fail
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      "name": "test-project",
      "type": "module",
      "scripts": {
        "tsc": "echo 'skipping tsc'"
      }
    }));

    writeFileSync(join(tempDir, "tasks.yaml"), `
tasks:
  - id: task1
    title: Test Task
    description: Test description
    criteria: ["Criterion 1"]
    status: pending
    attempts: 0
`);

    const safeSettings = SettingsSchema.parse({
      ...settings,
      git: {
        autoCommit: false,
        checkDirtyTree: false,
      }
    });

    await runLoop(safeSettings, tempDir);
    
    const store = new TaskStore(join(tempDir, "tasks.yaml"));
    const task = store.get("task1");
    assert.ok(revalidateCalled, "revalidate should have been called");
    assert.ok(task?.status === "blocked", `Expected status to be blocked, but got ${task?.status}`);

  } finally {
    clientFactory.createClient = originalCreateClient;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
} , { timeout: 60000 });

test("revalidate: status becomes revalidation_required if criteria are invalid", async () => {
  const originalCreateClient = clientFactory.createClient;
  
  clientFactory.createClient = (provider: any) => ({
    waitUntilReady: async () => {},
    chat: async (model: string, messages: any[]) => {
      if (messages[0].content.includes("You are an expert evaluator")) {
        return {
          message: { content: '{"valid": false, "reason": "insufficient criteria"}' },
          done: true
        };
      }

      // First call (generator)
      if (messages[0].role === "user" && messages[0].content.includes("Task task1")) {
         return {
            message: { content: '{"pass": false, "critique": "failed"}' },
            done: true
          };
      }

      return {
        message: { content: '{"pass": false, "critique": "failed"}' },
        done: true
      };
    },
    generate: async () => ({ response: "ok", done: true }),
    loadedModels: async () => [],
    supportsTools: async () => true,
  });

  const tempDir = mkdtempSync(join(tmpdir(), 'revalidate-test-2-'));
  
  try {
    const settings = SettingsSchema.parse({
      providers: [{
        providerName: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      }],
      models: {
        generator: { name: "m1" },
        judge: { name: "m2" },
      },
      files: {
        tasks: "tasks.yaml",
      },
      loop: {
        maxIterations: 1,
        maxAttempts: 1,
        maxToolCallsPerIteration: 1,
        temp: 0,
        thinkEffort: "none"
      }
    });

    // Create dummy package.json so tsc check doesn't fail
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({
      "name": "test-project",
      "type": "module",
      "scripts": {
        "tsc": "echo 'skipping tsc'"
      }
    }));

    writeFileSync(join(tempDir, "tasks.yaml"), `
tasks:
  - id: task1
    title: Test Task
    description: Complicated description that is not covered by simple criteria
    criteria: ["Simple criterion that does not cover description"]
    status: pending
    attempts: 0
`);

    const safeSettings = SettingsSchema.parse({
      ...settings,
      git: {
        autoCommit: false,
        checkDirtyTree: false,
      }
    });

    await runLoop(safeSettings, tempDir);
    
    const store = new TaskStore(join(tempDir, "tasks.yaml"));
    const task = store.get("task1");
    assert.ok(task?.status === "revalidation_required", `Expected status to be revalidation_required, but got ${task?.status}`);

  } finally {
    clientFactory.createClient = originalCreateClient;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
} , { timeout: 60000 });
