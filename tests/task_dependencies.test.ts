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

describe("task dependencies", () => {
  let testDir: string;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-deps-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });
  });

  test.afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("can load tasks with dependencies", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    dependencies:
      - task-0
  - id: task-2
    title: Task 2
    dependencies: ["task-1"]
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const tasks = store.list();

    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(tasks[0].dependencies, ["task-0"]);
    assert.deepStrictEqual(tasks[1].dependencies, ["task-1"]);
  });

  test("can load tasks without dependencies", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const tasks = store.list();

    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].dependencies, undefined);
  });

  test("can load tasks with empty dependencies", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    dependencies: []
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const tasks = store.list();

    assert.strictEqual(tasks.length, 1);
    assert.deepStrictEqual(tasks[0].dependencies, []);
  });
});
