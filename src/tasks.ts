import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseDocument, isSeq, isMap, type Document } from "yaml";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";

export interface Task {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  status: TaskStatus;
  attempts: number;
  lastCritique?: string;
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
      };
    });
  }

  next(): Task | undefined {
    const tasks = this.list();
    return tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending");
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

  summary(): Record<TaskStatus, number> {
    const s: Record<TaskStatus, number> = { pending: 0, in_progress: 0, done: 0, blocked: 0 };
    for (const t of this.list()) s[t.status] = (s[t.status] ?? 0) + 1;
    return s;
  }
}
