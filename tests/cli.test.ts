import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { execSync } from "node:child_process";

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);

describe("rockyctl init --updateGitIgnore", () => {
  test("init with --updateGitIgnore updates .gitignore", () => {
    const testDir = resolve(os.tmpdir(), "rockyctl-test-update-git-ignore-" + Date.now().toString());
    mkdirSync(testDir, { recursive: true });

    try {
      const scriptPath = resolve(rootDir, "src", "index.ts");
      execSync(`npx tsx ${scriptPath} init --updateGitIgnore`, { cwd: testDir });

      const gitignorePath = resolve(testDir, ".gitignore");
      assert.ok(existsSync(gitignorePath), ".gitignore should exist");
      const gitignoreContent = readFileSync(gitignorePath, "utf8");
      assert.ok(gitignoreContent.includes(".rockyctl/"), ".gitignore should contain .rockyctl/");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("init without --updateGitIgnore does NOT update .gitignore", () => {
    const testDir = resolve(os.tmpdir(), "rockyctl-test-no-update-git-ignore-" + Date.now().toString());
    mkdirSync(testDir, { recursive: true });

    try {
      const scriptPath = resolve(rootDir, "src", "index.ts");
      execSync(`npx tsx ${scriptPath} init`, { cwd: testDir });

      const gitignorePath = resolve(testDir, ".gitignore");
      if (existsSync(gitignorePath)) {
        const gitignoreContent = readFileSync(gitignorePath, "utf8");
        assert.ok(!gitignoreContent.includes(".rockyctl/"), ".gitignore should NOT contain .rockyctl/");
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("init with --updateGitIgnore when .rockyctl/ is already in .gitignore does nothing (no duplicate)", () => {
    const testDir = resolve(os.tmpdir(), "rockyctl-test-already-in-gitignore-" + Date.now().toString());
    mkdirSync(testDir, { recursive: true });

    try {
      const gitignorePath = resolve(testDir, ".gitignore");
      writeFileSync(gitignorePath, ".rockyctl/\n");

      const scriptPath = resolve(rootDir, "src", "index.ts");
      execSync(`npx tsx ${scriptPath} init --updateGitIgnore`, { cwd: testDir });

      const gitignoreContent = readFileSync(gitignorePath, "utf8");
      const occurrences = gitignoreContent.split(".rockyctl/").length - 1;
      assert.equal(occurrences, 1, ".gitignore should only have one entry for .rockyctl/");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
