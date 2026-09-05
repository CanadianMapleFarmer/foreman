import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TaskManager } from "./tasks";
import { VERSION } from "./version";

const ok = (result: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
const run = async (fn: () => Promise<unknown>) => {
  try { return ok(await fn()); } catch (e) { return fail(e); }
};

export function buildServer(tm: TaskManager): McpServer {
  const server = new McpServer({ name: "foreman", version: VERSION });
  server.registerTool("worker_dispatch", {
    description: "Start a worker on a bounded task in a fresh git worktree. Non-blocking; follow with worker_wait. Roles: coder, coder-sol, coder-pro, coder-max (write); reviewer, reviewer-sol, planner (read).",
    inputSchema: { taskId: z.string().regex(/^[A-Za-z0-9._-]+$/), role: z.string(), spec: z.string().min(20), base: z.string().optional() },
  }, (a) => run(() => tm.dispatch(a)));
  server.registerTool("worker_wait", {
    description: "Wait up to timeoutSeconds (default 45, max 300) for the task's current turn. Returns status running when the turn is still going: call again. Otherwise done|budget_exceeded|error|timeout with the worker summary, files changed and cost.",
    inputSchema: { taskId: z.string(), timeoutSeconds: z.number().int().positive().max(300).optional() },
  }, (a) => run(() => tm.wait(a.taskId, a.timeoutSeconds)));
  server.registerTool("worker_followup", {
    description: "Send a follow-up message in the same worker session (gate failures, review findings) and wait for the turn.",
    inputSchema: { taskId: z.string(), message: z.string().min(1) },
  }, (a) => run(() => tm.followup(a.taskId, a.message)));
  server.registerTool("worker_gate", {
    description: "Run the acceptance command in the task worktree. Foreman runs it, not the worker. Reports exit code, log tail and test-count deltas.",
    inputSchema: { taskId: z.string(), command: z.string().optional() },
  }, (a) => run(() => tm.gate(a.taskId, a.command)));
  server.registerTool("worker_review", {
    description: "Have a read-only reviewer model of a different lineage review the task diff against its spec. Returns blocking and warning findings.",
    inputSchema: { taskId: z.string(), role: z.string().optional() },
  }, (a) => run(() => tm.review(a.taskId, a.role)));
  server.registerTool("worker_finish", {
    description: "merge: commit the worktree on its branch and merge into the base branch (needs a passed gate and zero blocking findings unless force). discard: drop the worktree.",
    inputSchema: { taskId: z.string(), action: z.enum(["merge", "discard"]), commitMessage: z.string().optional(), force: z.boolean().optional() },
  }, (a) => run(() => tm.finish(a.taskId, a.action, a.commitMessage, a.force)));
  server.registerTool("worker_status", {
    description: "List tasks with state, model, cost and gate/review results.",
    inputSchema: { taskId: z.string().optional() },
  }, (a) => run(() => tm.status(a.taskId)));
  server.registerTool("worker_cancel", {
    description: "Cancel the task's in-flight turn. The worktree is kept for inspection.",
    inputSchema: { taskId: z.string() },
  }, (a) => run(() => tm.cancel(a.taskId)));
  server.registerTool("foreman_budget", {
    description: "OpenRouter credit remaining, spend this process, per-task cap and floor.",
    inputSchema: {},
  }, () => run(() => tm.budgetSummary()));
  return server;
}
