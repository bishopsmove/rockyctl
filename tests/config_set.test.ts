import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const testsDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testsDir, "..");
const scriptPath = resolve(projectRoot, "src", "index.ts");

const runCommand = (args: string[], cwd: string) => {
  const result = spawnSync("npx", ["tsx", scriptPath, ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: true,
  });
  return result;
};

const withTempConfig = (fn: (cwd: string) => void) => {
  const testDir = resolve(os.tmpdir(), "rockyctl-test-config-set-" + Date.now().toString() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(testDir, { recursive: true });
  try {
    const init = runCommand(["init"], testDir);
    assert.strictEqual(init.status, 0, `init failed: ${init.stdout}${init.stderr}`);
    fn(testDir);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
};

test("rockyctl config --set providers:0:readyTimeoutMs 5000 succeeds", () => {
  withTempConfig((cwd) => {
    const result = runCommand(["config", "--set", "5000", "--field", "providers:0:readyTimeoutMs"], cwd);
    assert.strictEqual(result.status, 0, `Expected success, got ${result.status}. stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes("Updated providers:0:readyTimeoutMs to 5000"));

    const configPath = resolve(cwd, ".rockyctl/config/rockyctl.yaml");
    const configContent = fs.readFileSync(configPath, "utf8");
    assert.ok(configContent.includes("readyTimeoutMs: 5000"));
  });
});

test("rockyctl config --set 5000 without --field returns error", () => {
  withTempConfig((cwd) => {
    const result = runCommand(["config", "--set", "5000"], cwd);
    assert.notStrictEqual(result.status, 0, "Expected failure when --field is missing");
    const errorMsg = result.stdout.includes("The --field switch is required when using --set") ? result.stdout : result.stderr;
    assert.ok(errorMsg.includes("The --field switch is required when using --set"));
  });
});

test("rockyctl config --set without value returns error", () => {
  withTempConfig((cwd) => {
    const result = runCommand(["config", "--set"], cwd);
    assert.notStrictEqual(result.status, 0, "Expected failure when --set is missing a value");
  });
});
