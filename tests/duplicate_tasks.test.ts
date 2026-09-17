import { test, describe } from "node:test";
import assert from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/tasks.js";

const testsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testsDir);

describe("duplicate tasks", () => {
  let testDir: string;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-dup-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });
  });

  test.afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("throws error if duplicate task ids are present", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
  - id: task-1
    title: Duplicate Task
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    assert.throws(() => {
      store.list();
    }, /Duplicate task id found: task-1/);
  });
});
