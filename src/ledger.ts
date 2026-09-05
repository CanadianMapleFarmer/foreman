import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export type TaskState = "running" | "done" | "gated" | "reviewed" | "merged" | "discarded" | "failed" | "budget_exceeded" | "cancelled";

export interface TaskRecord {
  taskId: string; role: string; model: string; state: TaskState;
  worktree: string; branch: string; baseCommit: string; sessionId: string | null;
  createdAt: string; updatedAt: string; estCostUsd: number; turns: number;
  gate: { exitCode: number; passedAt: string } | null;
  review: { blocking: number; warnings: number } | null;
  testFilesAtStart: number; skipsAtStart: number;
  lastSummary: string; filesChanged: string[]; error: string | null;
}

export class Ledger {
  constructor(private root: string, private ledgerDir: string) {}

  dir(taskId: string): string { return join(this.root, this.ledgerDir, taskId); }

  async create(record: TaskRecord): Promise<void> {
    const path = join(this.dir(record.taskId), "status.json");
    if (await Bun.file(path).exists()) throw new Error(`task already exists: ${record.taskId}`);
    await mkdir(this.dir(record.taskId), { recursive: true });
    await Bun.write(path, JSON.stringify(record, null, 2));
  }

  async read(taskId: string): Promise<TaskRecord> {
    const file = Bun.file(join(this.dir(taskId), "status.json"));
    if (!(await file.exists())) throw new Error(`unknown task: ${taskId}`);
    return file.json();
  }

  async update(taskId: string, patch: Partial<TaskRecord>): Promise<TaskRecord> {
    const next = { ...(await this.read(taskId)), ...patch, updatedAt: new Date().toISOString() };
    await Bun.write(join(this.dir(taskId), "status.json"), JSON.stringify(next, null, 2));
    return next;
  }

  async list(): Promise<TaskRecord[]> {
    const base = join(this.root, this.ledgerDir);
    let names: string[] = [];
    try { names = await readdir(base); } catch { return []; }
    const records: TaskRecord[] = [];
    for (const n of names) {
      const f = Bun.file(join(base, n, "status.json"));
      if (await f.exists()) records.push(await f.json());
    }
    return records;
  }

  async appendEvent(taskId: string, event: unknown): Promise<void> {
    await appendFile(join(this.dir(taskId), "events.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), ...(event as object) })}\n`);
  }

  async writeFile(taskId: string, name: string, content: string): Promise<string> {
    const path = join(this.dir(taskId), name);
    await Bun.write(path, content);
    return path;
  }

  async readFile(taskId: string, name: string): Promise<string | null> {
    const f = Bun.file(join(this.dir(taskId), name));
    return (await f.exists()) ? f.text() : null;
  }
}
