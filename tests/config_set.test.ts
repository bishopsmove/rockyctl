import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

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

test("rockyctl config --set providers:0:readyTimeoutMs 5000 succeeds", () => {
  // We assume a valid config file exists because tests/config_cli.test.ts passed
  const result = runCommand(["config", "--set", "5000", "--field", "providers:0:readyTimeoutMs"]);
  assert.strictEqual(result.status, 0, `Expected success, got ${result.status}. stdout: ${result.stdout}`);
  assert.ok(result.stdout.includes("Updated providers:0:readyTimeoutMs to 5000"));

  // Verify change in file
  const configPath = resolve(projectRoot, ".rockyctl/config/rockyctl.yaml");
  if (fs.existsSync(configPath)) {
    const configContent = fs.readFileSync(configPath, "utf8");
    assert.ok(configContent.includes("readyTimeoutMs: 5000"));
  }
});

test("rockyctl config --set 5000 without --field returns error", () => {
  const result = runCommand(["config", "--set", "5000"]);
  assert.notStrictEqual(result.status, 0, "Expected failure when --field is missing");
  const errorMsg = result.stdout.includes("The --field switch is required when using --set") ? result.stdout : result.stderr;
  assert.ok(errorMsg.includes("The --field switch is required when using --set"));
});

test("rockyctl config --set without value returns error", () => {
  // When --set is the last argument and expects a value, commander will error
  const result = runCommand(["config", "--set"]);
  assert.notStrictEqual(result.status, 0, "Expected failure when --set is missing a value");
});
