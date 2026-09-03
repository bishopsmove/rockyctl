import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadSettings } from "../src/config.js";
import { tmpdir } from "node:os";

test("loadSettings loads workingFolder from yaml", () => {
  const testDir = resolve(tmpdir(), "rockyctl-test-" + Date.now().toString());
  mkdirSync(testDir, { recursive: true });

  try {
    const yamlContent = `
ollama:
  baseUrl: http://localhost:11434
files:
  workingFolder: /tmp/custom-working-dir
`;
    writeFileSync(resolve(testDir, "rockyctl.yaml"), yamlContent);

    const settings = loadSettings(testDir);
    assert.strictEqual(settings.files.workingFolder, "/tmp/custom-working-dir");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test("loadSettings uses default workingFolder if not provided", () => {
  const testDir = resolve(tmpdir(), "rockyctl-test-default-" + Date.now().toString());
  mkdirSync(testDir, { recursive: true });

  try {
    const yamlContent = `
ollama:
  baseUrl: http://localhost:11434
`;
    writeFileSync(resolve(testDir, "rockyctl.yaml"), yamlContent);

    const settings = loadSettings(testDir);
    assert.strictEqual(settings.files.workingFolder, "/");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
