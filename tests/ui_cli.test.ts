import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import os from "node:os";
import fs from "node:fs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);
const scriptPath = resolve(rootDir, "src", "index.ts");
const fakeOllamaPath = resolve(rootDir, "tests/fake-ollama.mjs");

function runCommandWithInput(args: string[], inputs: string[], cwd?: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn("npx", ["tsx", scriptPath, ...args], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd
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
    assert.ok(result.stdout.includes("/tune"), "Should include /tune in help");
    assert.equal(result.exitCode, 0);
  });

  test("ui command handles all available commands", async () => {
    // Run against an isolated fixture pointed at a fake Ollama server, not the real
    // project's own .rockyctl/config/rockyctl.yaml (which talks to a real LAN server).
    const testDir = resolve(os.tmpdir(), "rockyctl-ui-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });

    execSync("git init", { cwd: testDir });
    execSync('git config user.email "test@example.com"', { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });
    fs.writeFileSync(path.join(testDir, "README.md"), "# Test Project");
    fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify({ name: "fixture", scripts: { tsc: "exit 0" } }));
    execSync("git add README.md package.json", { cwd: testDir });
    execSync('git commit -m "Initial commit"', { cwd: testDir });

    fs.writeFileSync(path.join(testDir, ".gitignore"), ".rockyctl/\n");
    execSync("git add .gitignore", { cwd: testDir });
    execSync('git commit -m "gitignore"', { cwd: testDir });

    const configDir = path.join(testDir, ".rockyctl", "config");
    fs.mkdirSync(configDir, { recursive: true });

    const port = 11497;
    const yamlContent = `
providers:
  - providerName: ollama
    baseUrl: http://localhost:${port}
models:
  generator: gen:latest
  judge: judge:latest
`;
    fs.writeFileSync(path.join(configDir, "rockyctl.yaml"), yamlContent);
    fs.writeFileSync(path.join(configDir, "PROMPT.md"), "You are a helpful assistant.");
    fs.writeFileSync(path.join(testDir, ".rockyctl", "tasks.yaml"), `tasks: ${JSON.stringify([
      {
        id: "ui-test-task",
        title: "ui test task",
        status: "pending",
        attempts: 0,
        description: "create a file",
        criteria: ["create a file named hello.txt"]
      }
    ], null, 2)}`);

    const fakeOllama = spawn("node", [fakeOllamaPath], {
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: "ignore"
    });
    fakeOllama.unref();
    await new Promise((r) => setTimeout(r, 1000));

    try {
      // /doctor
      const resDoctor = await runCommandWithInput(["ui"], ["/doctor", "/exit"], testDir);
      assert.equal(resDoctor.exitCode, 0, `doctor failed: ${resDoctor.stdout}\n${resDoctor.stderr}`);

      // /status
      const resStatus = await runCommandWithInput(["ui"], ["/status", "/exit"], testDir);
      assert.equal(resStatus.exitCode, 0);

      // /tune
      const resTune = await runCommandWithInput(["ui"], ["/tune", "/exit"], testDir);
      assert.equal(resTune.exitCode, 0);

      // /run (using --dry-run to keep it fast and avoid side effects)
      // Wait, I can't easily pass options to a command through UI if UI just prepends command name.
      // The current implementation of runUi does:
      // const newArgv = [originalArgv[0], originalArgv[1], command];
      // So it calls `rockyctl tune` if I type `/tune`.
      // If I want to pass options, it's tricky in the current implementation.
      // But I can try just `/run`.
      // Actually, the requirement is "check for all the available commands".

      // Let's see if we can test /run with /dry-run via UI if possible.
      // If I type `/run --dry-run`, then command will be `run --dry-run`.
      // newArgv will be [node, script, "run --dry-run"]
      // commander might not handle "run --dry-run" as a single command if it's passed as the 3rd arg.
      // Let's check if `/run --dry-run` works in UI.
      const resRun = await runCommandWithInput(["ui"], ["/run --dry-run", "/exit"], testDir);
      assert.equal(resRun.exitCode, 0, `run --dry-run failed: ${resRun.stdout}\n${resRun.stderr}`);
    } finally {
      fakeOllama.kill();
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
});
