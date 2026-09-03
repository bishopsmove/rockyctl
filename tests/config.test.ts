import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../src/config.js";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const projectRoot = fileURLToPath(new URL(".", import.meta.url).href); // This might not be right, let's use a safer way.
// Actually, dirname(fileURLToPath(import.meta.url)) is the directory of the current file.
// tests/config.test.ts -> dirname is tests/
// dirname(tests/) -> project root.

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);

test("loadSettings loads workingFolder from yaml in new location", () => {
  const testDir = resolve(tmpdir(), "rockyctl-test-" + Date.now().toString() + "-1");
  const configDir = resolve(testDir, ".rockyctl", "config");
  mkdirSync(configDir, { recursive: true });

  try {
    const yamlContent = `
ollama:
  baseUrl: http://localhost:11434
files:
  workingFolder: /tmp/custom-working-dir
`;
    writeFileSync(resolve(configDir, "rockyctl.yaml"), yamlContent);

    const settings = loadSettings(testDir);
    assert.strictEqual(settings.files.workingFolder, "/tmp/custom-working-dir");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("loadSettings uses default workingFolder if not provided in new location", () => {
  const testDir = resolve(tmpdir(), "rockyctl-test-" + Date.now().toString() + "-2");
  const configDir = resolve(testDir, ".rockyctl", "config");
  mkdirSync(configDir, { recursive: true });

  try {
    const yamlContent = `
ollama:
  baseUrl: http://localhost:11434
`;
    writeFileSync(resolve(configDir, "rockyctl.yaml"), yamlContent);

    const settings = loadSettings(testDir);
    assert.strictEqual(settings.files.workingFolder, "/");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("init command creates files in the correct locations", () => {
  const testDir = resolve(tmpdir(), "rockyctl-test-" + Date.now().toString() + "-3");
  mkdirSync(testDir, { recursive: true });

  try {
    const scriptPath = resolve(rootDir, "src", "index.ts");
    execSync(`npx tsx ${scriptPath} init`, { cwd: testDir });

    assert.ok(existsSync(resolve(testDir, ".rockyctl", "config", "rockyctl.yaml")), "rockyctl.yaml should exist in .rockyctl/config/");
    assert.ok(existsSync(resolve(testDir, ".rockyctl", "config", "PROMPT.md")), "PROMPT.md should exist in .rockyctl/config/");
    assert.ok(existsSync(resolve(testDir, ".rockyctl", "tasks.yaml")), "tasks.yaml should exist in .rockyctl/");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("rockyctl utilizes the files in their new locations", () => {
  const testDir = resolve(tmpdir(), "rockyctl-test-" + Date.now().toString() + "-4");
  const configDir = resolve(testDir, ".rockyctl", "config");
  mkdirSync(configDir, { recursive: true });

  try {
    const tasksContent = `
tasks:
  - id: 1
    title: test task
    description: a test task
    status: pending
`;
    writeFileSync(resolve(testDir, ".rockyctl", "tasks.yaml"), tasksContent);

    const settingsContent = `
ollama:
  baseUrl: http://localhost:11434
files:
  tasks: ".rockyctl/tasks.yaml"
`;
    writeFileSync(resolve(configDir, "rockyctl.yaml"), settingsContent);

    const settings = loadSettings(testDir);
    assert.strictEqual(settings.files.tasks, ".rockyctl/tasks.yaml");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
