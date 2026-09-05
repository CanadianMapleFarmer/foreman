import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpHost } from "../src/acp-host";
import { Budget } from "../src/budget";
import { loadConfig } from "../src/config";
import { gitOk } from "../src/git";
import { Ledger } from "../src/ledger";
import { TaskManager } from "../src/tasks";

const fakeFetch = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith("/credits")) return new Response(JSON.stringify({ data: { total_credits: 20, total_usage: 0 } }));
  if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.000001", completion: "0.000001" } }] }));
  return new Response("nope", { status: 404 });
}) as typeof fetch;

async function setup(capUsd = 0.5) {
  const root = await mkdtemp(join(tmpdir(), "foreman-tasks-"));
  await gitOk(["init", "-q", "-b", "main"], root);
  await gitOk(["config", "user.email", "t@t"], root);
  await gitOk(["config", "user.name", "t"], root);
  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, ".foreman.json"), JSON.stringify({ acceptCommand: "test -f a.txt", perTaskCapUsd: capUsd }));
  await gitOk(["add", "-A"], root);
  await gitOk(["commit", "-q", "-m", "init"], root);
  const config = await loadConfig(root, {});
  const host = new AcpHost({ command: ["bun", "run", `${import.meta.dir}/fake-agent.ts`] });
  await host.start();
  const budget = new Budget({ key: "k", perTaskCapUsd: config.perTaskCapUsd, creditFloorUsd: 5, fetchImpl: fakeFetch });
  const ledger = new Ledger(config.projectRoot, config.ledgerDir);
  const foremanDir = join(import.meta.dir, "..");
  return { root: config.projectRoot, tm: new TaskManager({ config, host, ledger, budget, foremanDir }), host };
}

test("dispatch, wait, gate, review, merge", async () => {
  const { root, tm, host } = await setup();
  const d = await tm.dispatch({ taskId: "t1", role: "coder", spec: "Say hello. DIFF" });
  expect(d.worktree).toBe(join(root, ".worktrees", "t1"));
  const w = await tm.wait("t1", 10);
  expect(w.status).toBe("done");
  expect(w.summary).toBe("PONG");
  expect(w.filesChanged).toEqual(["src/x.ts"]);
  expect(w.estCostUsd).toBeCloseTo(0.00011);
  await writeFile(join(d.worktree, "b.txt"), "b\n");
  const g = await tm.gate("t1");
  expect(g.exitCode).toBe(0);
  const r = await tm.review("t1");
  expect(r.blocking.length).toBe(1);
  expect(r.blocking[0]!.issue).toMatch(/not JSON/);
  await expect(tm.finish("t1", "merge", "t1 done")).rejects.toThrow(/blocking/);
  const f = await tm.finish("t1", "merge", "t1 done", true);
  expect(f.merged).toBe(true);
  expect(await Bun.file(join(root, "b.txt")).exists()).toBe(true);
  expect((await tm.status("t1"))[0]!.state).toBe("merged");
  host.close();
});

test("wait reports running before the turn ends, cancel and followup continue the session", async () => {
  const { tm, host } = await setup();
  await tm.dispatch({ taskId: "t2", role: "coder", spec: "SLOW" });
  const w = await tm.wait("t2", 1);
  expect(w.status).toBe("running");
  await tm.cancel("t2");
  const after = await tm.wait("t2", 10);
  expect(["cancelled", "end_turn", "timeout"]).toContain(after.stopReason ?? "");
  const f = await tm.followup("t2", "now say hello");
  expect(f.summary).toBe("PONG");
  await tm.finish("t2", "discard");
  expect((await tm.status("t2"))[0]!.state).toBe("discarded");
  host.close();
});

test("cap stops further turns", async () => {
  const { tm, host } = await setup(0.0001);
  await tm.dispatch({ taskId: "t3", role: "coder", spec: "hello" });
  const w = await tm.wait("t3", 10);
  expect(w.status).toBe("budget_exceeded");
  await expect(tm.followup("t3", "again")).rejects.toThrow(/cap/);
  host.close();
});

test("unknown role and duplicate id are rejected", async () => {
  const { tm, host } = await setup();
  await expect(tm.dispatch({ taskId: "t4", role: "nope", spec: "x" })).rejects.toThrow(/unknown role/);
  await tm.dispatch({ taskId: "t5", role: "coder", spec: "x" });
  await expect(tm.dispatch({ taskId: "t5", role: "coder", spec: "x" })).rejects.toThrow();
  await tm.wait("t5", 10);
  host.close();
});

test("gate failure is reported and merge without gate is refused", async () => {
  const { tm, host } = await setup();
  await tm.dispatch({ taskId: "t6", role: "coder", spec: "hello" });
  await tm.wait("t6", 10);
  const g = await tm.gate("t6", "exit 7");
  expect(g.exitCode).toBe(7);
  await expect(tm.finish("t6", "merge")).rejects.toThrow(/gate/);
  const b = await tm.budgetSummary();
  expect(b.perTaskCapUsd).toBe(0.5);
  host.close();
});
