import { test } from "node:test";
import assert from "node:assert/strict";
import { clientFactory } from "../src/clients.js";
import { runLoop } from "../src/loop.js";
import { SettingsSchema } from "../src/config.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("runLoop calls createClient with the first provider", async () => {
  const originalCreateClient = clientFactory.createClient;
  let calledWithProvider: any = null;

  // Define the mock implementation
  clientFactory.createClient = async (provider: any) => {
    calledWithProvider = provider;
    return {
      waitUntilReady: async () => {},
      chat: async () => ({ 
        message: { content: "ok" }, 
        done: true 
      }),
      generate: async () => ({ response: "ok", done: true }),
      loadedModels: async () => [],
      supportsTools: async () => true,
    } as any;
  };

  const tempDir = mkdtempSync(join(tmpdir(), 'rockyctl-test-'));
  
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
      }
    });

    writeFileSync(join(tempDir, "tasks.yaml"), "[]");

    const safeSettings = SettingsSchema.parse({
      ...settings,
      git: {
        autoCommit: false,
        checkDirtyTree: false,
      }
    });

    await runLoop(safeSettings, tempDir);
  } catch (e) {
    // We expect it might fail if it tries to call some command that's not there, but createClient should have been called.
  } finally {
    // Clean up the mock
    clientFactory.createClient = originalCreateClient;
  }

  try {
    assert.ok(calledWithProvider !== null, "createClient should have been called");
    assert.equal(calledWithProvider.providerName, "ollama");
  } finally {
    // Clean up the temp directory if possible, though it's managed by the OS usually
  }
});
