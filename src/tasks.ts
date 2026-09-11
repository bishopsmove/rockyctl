import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseDocument, isSeq, isMap, type Document } from "yaml";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked" | "skip";

export interface Task {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  status: TaskStatus;
  attempts: number;
  lastCritique?: string;
  dependencies?: string[];
}

/**
 * Round-trips tasks.yaml through the yaml Document API so comments and ordering the
 * user wrote survive our status/attempt updates.
 */
export class TaskStore {
  private doc: Document;

  constructor(private readonly path: string) {
    if (!existsSync(path)) throw new Error(`Task file not found: ${path}. Run \`rockyctl init\`.`);
    this.doc = parseDocument(readFileSync(path, "utf8"));
    const seq = this.doc.get("tasks");
    if (!isSeq(seq)) throw new Error(`${path} must contain a top-level \`tasks:\` list.`);
  }

  list(): Task[] {
    const raw = this.doc.toJS() as { tasks?: Partial<Task>[] };
    return (raw.tasks ?? []).map((t, i) => {
      if (!t.id) throw new Error(`Task at index ${i} has no id.`);
      return {
        id: String(t.id),
        title: t.title ?? String(t.id),
        description: t.description ?? "",
        criteria: t.criteria ?? [],
        status: (t.status as TaskStatus) ?? "pending",
        attempts: Number(t.attempts ?? 0),
        lastCritique: t.lastCritique,
        dependencies: t.dependencies as string[] | undefined,
      };
    });
  }

  next(): Task | undefined {
    const tasks = this.list();
    const inProgress = tasks.find((t) => t.status === "in_progress");
    if (inProgress) return inProgress;

    for (const t of tasks) {
      if (t.status === "pending") {
        const depStatus = this.checkDependencies(t);
        if (depStatus === 'done' || depStatus === 'blocked') {
          return t;
        }
      }
    }

    return undefined;
  }

  get(id: string): Task | undefined {
    return this.list().find((t) => t.id === id);
  }

  update(id: string, patch: Partial<Pick<Task, "status" | "attempts" | "lastCritique">>): void {
    const seq = this.doc.get("tasks");
    if (!isSeq(seq)) return;
    const idx = seq.items.findIndex((n) => isMap(n) && String(n.get("id")) === id);
    if (idx < 0) throw new Error(`Task ${id} not found.`);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) this.doc.deleteIn(["tasks", idx, k]);
      else this.doc.setIn(["tasks", idx, k], v);
    }
    writeFileSync(this.path, this.doc.toString({ lineWidth: 0 }), "utf8");
  }

  summary(): Record<string, number> {
    const s: Record<string, number> = { pending: 0, in_progress: 0, done: 0, blocked: 0, skip: 0 };
    for (const t of this.list()) {
      const status = t.status as string;
      s[status] = (s[status] ?? 0) + 1;
    }
    return s;
  }

  checkDependencies(task: Task): 'done' | 'pending' | 'blocked' {
    if (!task.dependencies || task.dependencies.length === 0) {
      return 'done';
    }

    let anyPending = false;

    for (const depId of task.dependencies) {
      const depTask = this.get(depId);
      
      if (!depTask) {
        return 'blocked'; // Treat missing dependencies as blocked
      }

      if (depTask.status === 'blocked' || depTask.lastCritique) {
        return 'blocked';
      }

      if (depTask.status === 'pending' || depTask.status === 'in_progress') {
        anyPending = true;
      }
    }

    if (anyPending) {
      return 'pending';
    }

    return 'done';
  }
}
