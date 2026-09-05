import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type TaskRecord } from "../src/ledger";

const record = (taskId: string): TaskRecord => ({
  taskId, role: "coder", model: "m", state: "running", worktree: "/w", branch: "task/x", baseCommit: "abc", sessionId: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", estCostUsd: 0, turns: 0, gate: null, review: null,
  testFilesAtStart: 0, skipsAtStart: 0, lastSummary: "", filesChanged: [], error: null,
});

test("create, read, update, list", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreman-ledger-"));
  const ledger = new Ledger(root, ".foreman");
  await ledger.create(record("a"));
  await ledger.create(record("b"));
  const updated = await ledger.update("a", { state: "done", estCostUsd: 0.12 });
  expect(updated.state).toBe("done");
  expect((await ledger.read("a")).estCostUsd).toBe(0.12);
  expect((await ledger.list()).map((r) => r.taskId).sort()).toEqual(["a", "b"]);
  await expect(ledger.create(record("a"))).rejects.toThrow(/exists/);
  await expect(ledger.read("zzz")).rejects.toThrow(/unknown task/);
});

test("events and files", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreman-ledger-"));
  const ledger = new Ledger(root, ".foreman");
  await ledger.create(record("a"));
  await ledger.appendEvent("a", { x: 1 });
  await ledger.appendEvent("a", { x: 2 });
  expect((await ledger.readFile("a", "events.jsonl"))!.trim().split("\n").length).toBe(2);
  const p = await ledger.writeFile("a", "spec.md", "# spec");
  expect(p).toBe(join(root, ".foreman", "a", "spec.md"));
  expect(await ledger.readFile("a", "missing.md")).toBeNull();
  expect((await ledger.list()).length).toBe(1);
});
