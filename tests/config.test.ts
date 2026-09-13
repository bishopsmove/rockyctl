import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings, SettingsSchema } from "../src/config.js";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// const projectRoot = fileURLToPath(new URL(".", import.meta.url).href); // This might not be right, let's use a safer way.
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
providers:
  - providerName: ollama
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
providers:
  - providerName: ollama
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
providers:
  - providerName: ollama
    baseUrl: http://localhost:11434
models:
  generator:
    name: gemma:latest
    temp: 0.5
  judge:
    name: gemma:latest
    temp: 0.8
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

function settingsDirWith(content: string) {
  const testDir = resolve(tmpdir(), "rockyctl-test-" + Date.now().toString() + "-" + Math.random().toString(36).slice(2));
  const configDir = resolve(testDir, ".rockyctl", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "rockyctl.yaml"), content);
  return testDir;
}

// test("thinkEffort setting loads when present under the ollama provider", () => {
//   const testDir = settingsDirWith(`
// providers:
//   - providerName: ollama
//     baseUrl: http://localhost:11434
// models:
//   generator:
//     name: gemma:latest
//     temp: 0.5
//   judge:
//     name: gemma:latest
//     temp: 0.8
// `);
//   // This test is now obsolete or should be updated. The instruction says: 
//   // "rewrite the config tests to place thinkEffort under models.generator/models.judge"
//   // So I will remove this old test or rewrite it.
// });

test("thinkEffort accepts low, medium, high and boolean values", () => {
  const parsed = SettingsSchema.parse({
    models: {
      generator: { name: "gemma", thinkEffort: "low" },
      judge: { name: "gemma", thinkEffort: "medium" }
    },
  });
  assert.strictEqual(parsed.models.generator.thinkEffort, "low");
  assert.strictEqual(parsed.models.judge.thinkEffort, "medium");

  const parsed2 = SettingsSchema.parse({
    models: {
      generator: { name: "gemma", thinkEffort: true },
      judge: { name: "gemma", thinkEffort: false }
    },
  });
  assert.strictEqual(parsed2.models.generator.thinkEffort, true);
  assert.strictEqual(parsed2.models.judge.thinkEffort, false);
});

test("thinkEffort defaults to absent when not in the settings file", () => {
  const testDir = settingsDirWith(`
providers:
  - providerName: ollama
    baseUrl: http://localhost:11434
models:
  generator:
    name: gemma:latest
    temp: 0.5
  judge:
    name: gemma:latest
    temp: 0.8
`);
  try {
    const settings = loadSettings(testDir);
    assert.ok(settings.models.generator.thinkEffort === undefined);
    assert.ok(settings.models.judge.thinkEffort === undefined);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("invalid thinkEffort values are rejected", () => {
  assert.throws(
    () => SettingsSchema.parse({ models: { generator: { name: "gemma", thinkEffort: "maximum" } } }),
  );
  assert.throws(
    () => SettingsSchema.parse({ models: { generator: { name: "gemma", thinkEffort: 42 } } }),
  );
});

test("temp setting loads when present in models", () => {
  const testDir = settingsDirWith(`
models:
  generator:
    name: gemma:latest
    temp: 0.5
  judge:
    name: gemma:latest
    temp: 0.8
`);
  try {
    const settings = loadSettings(testDir);
    assert.strictEqual(settings.models.generator.temp, 0.5);
    assert.strictEqual(settings.models.judge.temp, 0.8);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("temp setting can be a string for model name and number for temp", () => {
  const parsed = SettingsSchema.parse({
    models: {
      generator: "gemma:latest",
      judge: { name: "gemma:latest", temp: 0.7 }
    }
  });
  assert.strictEqual(parsed.models.generator.name, "gemma:latest");
  assert.strictEqual(parsed.models.judge.name, "gemma:latest");
  assert.strictEqual(parsed.models.judge.temp, 0.7);
});
