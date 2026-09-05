import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsDir, "..");

const runCommand = (args: string[]) => {
  const result = spawnSync("npx", ["tsx", "src/index.ts", ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    shell: true,
  });
  return result;
};

test("rockyctl config outputs all settings", () => {
  const result = runCommand(["config"]);
  assert.strictEqual(result.status, 0);
  assert.ok(result.stdout.includes("ollama:"), "Should include ollama section");
  assert.ok(result.stdout.includes("baseUrl:"), "Should include baseUrl");
});

test("rockyctl config --field ollama:readyTimeoutMs outputs specific value", () => {
  const result = runCommand(["config", "--field", "ollama:readyTimeoutMs"]);
  assert.strictEqual(result.status, 0);
  // Default value in src/config.ts for readyTimeoutMs is 120000 (number)
  assert.ok(result.stdout.trim().match(/^[0-9]+$/), `Expected numeric value, got: ${result.stdout.trim()}`);
});

test("rockyctl config --field nonExistentField returns error", () => {
  const result = runCommand(["config", "--field", "nonExistent:field"]);
  assert.notStrictEqual(result.status, 0);
  assert.ok(result.stdout.includes("Setting not found") || result.stderr.includes("Setting not found"));
});
