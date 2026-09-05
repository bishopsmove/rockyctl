import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import os from "node:os";

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);
const scriptPath = resolve(rootDir, "src", "index.ts");

function runCommandWithInput(args: string[], inputs: string[]) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn("npx", ["tsx", scriptPath, ...args], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code || 0 });
    });

    // Feed inputs
    for (const input of inputs) {
      child.stdin.write(input + "\n");
    }
    child.stdin.end();
  });
}

describe("rockyctl ui", () => {
  test("ui command exits on /exit", async () => {
    const result = await runCommandWithInput(["ui"], ["/exit"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("Rockyctl UI"), "Should show UI welcome message");
  });

  test("ui command rejects invalid command prefix", async () => {
    const result = await runCommandWithInput(["ui"], ["doctor", "/exit"]);
    // Note: "doctor" instead of "/doctor" should trigger warning
    assert.ok(result.stdout.includes("All commands must start with /"), "Should warn about missing /");
    assert.equal(result.exitCode, 0);
  });

  test("ui command handles /help", async () => {
    const result = await runCommandWithInput(["ui"], ["/help", "/exit"]);
    assert.ok(result.stdout.includes("Available commands"), "Should show help information");
    assert.equal(result.exitCode, 0);
  });
});
