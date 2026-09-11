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

describe("task skip status", () => {
  let testDir: string;

  test.beforeEach(async () => {
    testDir = resolve(os.tmpdir(), "rockyctl-skip-test-" + Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });
  });

  test.afterEach(async () => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("next() skips tasks with status 'skip'", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-skip
    title: Skipped Task
    status: skip
  - id: task-pending
    title: Pending Task
    status: pending
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    
    // next() should return the pending task, skipping the one with status 'skip'
    const nextTask = store.next();
    assert.strictEqual(nextTask?.id, "task-pending");

    // If we remove the pending task, next() should be undefined (because task-skip is skipped)
    store.update("task-pending", { status: "done" });
    assert.strictEqual(store.next(), undefined);
  });

  test("a file with only a skip task yields undefined for next()", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-skip
    title: Skipped Task
    status: skip
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    assert.strictEqual(store.next(), undefined);
  });

  test("skipped task is considered done for its dependents", async () => {
    const tasksFile = path.join(testDir, "tasks.yaml");
    const yamlContent = `
tasks:
  - id: task-dep
    title: Dependent Task
    status: pending
    dependencies: ["task-skip"]
  - id: task-skip
    title: Skipped Task
    status: skip
`;
    fs.writeFileSync(tasksFile, yamlContent);

    const store = new TaskStore(tasksFile);
    
    // task-skip is skipped, so task-dep's dependency is met.
    assert.strictEqual(store.next()?.id, "task-dep");
  });
});
