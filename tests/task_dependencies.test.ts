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
    assert.deepStrictEqual(tasks[0].dependencies, undefined);
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

  test("next() returns task only if dependencies are done", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    status: pending
    dependencies: ["task-0"]
  - id: task-0
    title: Task 0
    status: pending
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    
    // Initially only task-0 is pending and has no dependencies (wait, it's pending)
    // actually task-0 is also pending and has no dependencies.
    assert.strictEqual(store.next()?.id, "task-0");

    // Make task-0 done
    store.update("task-0", { status: "done" });
    assert.strictEqual(store.next()?.id, "task-1");
  });

  test("next() returns task if dependencies are blocked", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    status: pending
    dependencies: ["task-0"]
  - id: task-0
    title: Task 0
    status: blocked
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    // task-1's dependency is blocked, so next() should return task-1.
    assert.strictEqual(store.next()?.id, "task-1");
  });

  test("checkDependencies returns 'pending' if dependencies are in_progress", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    status: pending
    dependencies: ["task-0"]
  - id: task-0
    title: Task 0
    status: in_progress
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const task1 = store.get("task-1")!;
    assert.strictEqual(store.checkDependencies(task1), 'pending');
  });

  test("checkDependencies returns 'blocked' if dependency has lastCritique", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    status: pending
    dependencies: ["task-0"]
  - id: task-0
    title: Task 0
    status: done
    lastCritique: "something went wrong"
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const task1 = store.get("task-1")!;
    assert.strictEqual(store.checkDependencies(task1), 'blocked');
  });

  test("checkDependencies returns 'blocked' if dependency is blocked", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    status: pending
    dependencies: ["task-0"]
  - id: task-0
    title: Task 0
    status: blocked
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const task1 = store.get("task-1")!;
    assert.strictEqual(store.checkDependencies(task1), 'blocked');
  });

  test("checkDependencies returns 'blocked' if dependency is missing", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-1
    title: Task 1
    status: pending
    dependencies: ["non-existent"]
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    const task1 = store.get("task-1")!;
    assert.strictEqual(store.checkDependencies(task1), 'blocked');
  });
});
