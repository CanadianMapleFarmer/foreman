import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AcpHost, TurnResult, TurnUsage } from "./acp-host";
import { type Budget, BudgetError } from "./budget";
import type { ForemanConfig } from "./config";
import type { Ledger, TaskRecord, TaskState } from "./ledger";
import { decide, type ToolCallInfo } from "./policy";
import { resolvePromptText, type Role } from "./roles";
import { commitAndMerge, copyUntracked, createWorktree, removeWorktree, stagedDiff } from "./worktree";

export interface WaitResult {
  status: "done" | "running" | "budget_exceeded" | "error" | "timeout";
  stopReason: string | null;
  summary: string;
  summaryEmpty: boolean;
  filesChanged: string[];
  usage: TurnUsage | null;
  estCostUsd: number;
  rejections: number;
  error: string | null;
}
export interface Finding { file: string; line: number; issue: string }

interface Deps { config: ForemanConfig; host: AcpHost; ledger: Ledger; budget: Budget; foremanDir: string }

const MAX_REJECTIONS_PER_TURN = 5;
const GATE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_DIFF_CHARS = 200_000;

export class TaskManager {
  private live = new Map<string, Promise<WaitResult>>();

  constructor(private deps: Deps) {}

  private role(name: string): Role {
    const r = this.deps.config.roles[name];
    if (!r) throw new Error(`unknown role: ${name} (known: ${Object.keys(this.deps.config.roles).join(", ")})`);
    return r;
  }

  async dispatch(input: { taskId: string; role: string; spec: string; base?: string }) {
    const { config, host, ledger, budget } = this.deps;
    const role = this.role(input.role);
    await budget.assertCanDispatch();
    const wt = await createWorktree(config.projectRoot, config.worktreeDir, input.taskId, input.base ?? config.baseBranch);
    await copyUntracked(config.projectRoot, wt.path, config.copyIntoWorktree);
    const { testFiles, skips } = await countTests(wt.path);
    const now = new Date().toISOString();
    await ledger.create({
      taskId: input.taskId, role: input.role, model: role.model, state: "running",
      worktree: wt.path, branch: wt.branch, baseCommit: wt.baseCommit, sessionId: null,
      createdAt: now, updatedAt: now, estCostUsd: 0, turns: 0, gate: null, review: null,
      testFilesAtStart: testFiles, skipsAtStart: skips, lastSummary: "", filesChanged: [], error: null,
    });
    await ledger.writeFile(input.taskId, "spec.md", input.spec);
    const sessionId = await host.newSession(wt.path);
    await host.setModel(sessionId, role.model);
    await ledger.update(input.taskId, { sessionId });
    const prompt = `${await resolvePromptText(role, this.deps.foremanDir, config.projectRoot)}\n\n# Task ${input.taskId}\n\n${input.spec}`;
    this.startTurn(input.taskId, role, sessionId, prompt);
    return { taskId: input.taskId, sessionId, worktree: wt.path };
  }

  private startTurn(taskId: string, role: Role, sessionId: string, text: string): Promise<WaitResult> {
    const promise = this.runTurn(taskId, role, sessionId, text);
    this.live.set(taskId, promise);
    return promise;
  }

  private async runTurn(taskId: string, role: Role, sessionId: string, text: string): Promise<WaitResult> {
    const { host, ledger, budget, config } = this.deps;
    const record = await ledger.read(taskId);
    let rejections = 0;
    const handlers = {
      onEvent: (e: unknown) => { void ledger.appendEvent(taskId, { event: e }); },
      onPermission: (call: ToolCallInfo) => {
        const d = decide(role.policy, call, { worktree: record.worktree, acceptCommand: config.acceptCommand });
        void ledger.appendEvent(taskId, { permission: call, decision: d });
        if (!d.allow && ++rejections >= MAX_REJECTIONS_PER_TURN) host.cancel(sessionId);
        return d;
      },
    };
    let turn: TurnResult;
    try {
      turn = await host.prompt(sessionId, text, handlers, role.maxTurnSeconds * 1000);
    } catch (e) {
      const error = (e as Error).message;
      await ledger.update(taskId, { state: "failed", error });
      return { status: "error", stopReason: null, summary: "", summaryEmpty: true, filesChanged: record.filesChanged, usage: null, estCostUsd: record.estCostUsd, rejections, error };
    }
    const estCostUsd = record.estCostUsd + (await budget.estimateUsd(role.model, role.billing, turn.usage));
    const filesChanged = [...new Set([...record.filesChanged, ...turn.filesChanged])];
    const summaryEmpty = turn.text.trim().length === 0;
    const summary = summaryEmpty ? `No summary text. Files changed: ${filesChanged.join(", ") || "none detected"}` : turn.text.trim();
    let status: WaitResult["status"] = turn.stopReason === "timeout" ? "timeout" : "done";
    let state: TaskState = turn.stopReason === "timeout" ? "failed" : "done";
    try {
      budget.assertWithinCap(estCostUsd);
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
      status = "budget_exceeded";
      state = "budget_exceeded";
    }
    const error = status === "timeout" ? `turn exceeded ${role.maxTurnSeconds}s` : null;
    await ledger.update(taskId, { state, estCostUsd, turns: record.turns + 1, lastSummary: summary, filesChanged, error });
    await ledger.writeFile(taskId, `result-${record.turns + 1}.md`, summary);
    return { status, stopReason: turn.stopReason, summary, summaryEmpty, filesChanged, usage: turn.usage, estCostUsd, rejections: turn.rejections, error };
  }

  async wait(taskId: string, timeoutSeconds = 600): Promise<WaitResult> {
    const live = this.live.get(taskId);
    const record = await this.deps.ledger.read(taskId);
    if (!live) {
      const status = record.state === "failed" ? "error" : record.state === "budget_exceeded" ? "budget_exceeded" : "done";
      return { status, stopReason: null, summary: record.lastSummary, summaryEmpty: !record.lastSummary, filesChanged: record.filesChanged, usage: null, estCostUsd: record.estCostUsd, rejections: 0, error: record.error };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Promise<"running">((r) => { timer = setTimeout(() => r("running"), timeoutSeconds * 1000); });
    const outcome = await Promise.race([live, pending]);
    if (timer) clearTimeout(timer);
    if (outcome === "running") {
      return { status: "running", stopReason: null, summary: "", summaryEmpty: true, filesChanged: [], usage: null, estCostUsd: record.estCostUsd, rejections: 0, error: null };
    }
    this.live.delete(taskId);
    return outcome;
  }

  async followup(taskId: string, message: string): Promise<WaitResult> {
    const record = await this.deps.ledger.read(taskId);
    if (this.live.has(taskId)) throw new Error(`task ${taskId} still has a turn in flight; call worker_wait first`);
    this.deps.budget.assertWithinCap(record.estCostUsd);
    if (!record.sessionId) throw new Error(`task ${taskId} has no session`);
    const role = this.role(record.role);
    await this.deps.ledger.update(taskId, { state: "running" });
    const result = await this.startTurn(taskId, role, record.sessionId, message);
    this.live.delete(taskId);
    return result;
  }

  async gate(taskId: string, command?: string) {
    const { config, ledger } = this.deps;
    const record = await ledger.read(taskId);
    const cmd = command ?? config.acceptCommand;
    if (!cmd) throw new Error("no acceptance command: pass one or set acceptCommand in .foreman.json");
    const proc = Bun.spawn(["bash", "-lc", cmd], { cwd: record.worktree, stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => proc.kill(), GATE_TIMEOUT_MS);
    const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(killer);
    const log = `$ ${cmd}\n${out}${err}\nexit=${exitCode}\n`;
    const logPath = await ledger.writeFile(taskId, "gate.log", log);
    const { testFiles, skips } = await countTests(record.worktree);
    const passed = exitCode === 0;
    await ledger.update(taskId, { gate: passed ? { exitCode, passedAt: new Date().toISOString() } : null, state: passed ? "gated" : record.state });
    return { exitCode, logPath, tail: log.split("\n").slice(-40).join("\n"), testFilesDelta: testFiles - record.testFilesAtStart, skipsDelta: skips - record.skipsAtStart };
  }

  async review(taskId: string, roleName = "reviewer") {
    const { host, ledger, budget, config } = this.deps;
    const record = await ledger.read(taskId);
    const role = this.role(roleName);
    if (role.policy !== "read") throw new Error(`review role must have read policy: ${roleName}`);
    const spec = (await ledger.readFile(taskId, "spec.md")) ?? "";
    const diff = await stagedDiff(record.worktree, record.baseCommit);
    const sessionId = await host.newSession(record.worktree);
    await host.setModel(sessionId, role.model);
    const prompt = `${await resolvePromptText(role, this.deps.foremanDir, config.projectRoot)}\n\n# Task spec\n\n${spec}\n\n# Diff against base\n\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``;
    const turn = await host.prompt(sessionId, prompt, {
      onPermission: (call) => decide("read", call, { worktree: record.worktree, acceptCommand: config.acceptCommand }),
      onEvent: (e) => { void ledger.appendEvent(taskId, { review: e }); },
    }, role.maxTurnSeconds * 1000);
    const estCostUsd = await budget.estimateUsd(role.model, role.billing, turn.usage);
    const parsed = parseFindings(turn.text);
    const reviewPath = await ledger.writeFile(taskId, "review.json", JSON.stringify({ role: roleName, model: role.model, ...parsed, raw: turn.text }, null, 2));
    await ledger.update(taskId, { review: { blocking: parsed.blocking.length, warnings: parsed.warnings.length }, estCostUsd: record.estCostUsd + estCostUsd, state: "reviewed" });
    return { ...parsed, reviewPath, estCostUsd };
  }

  async finish(taskId: string, action: "merge" | "discard", commitMessage?: string, force = false) {
    const { config, ledger } = this.deps;
    const record = await ledger.read(taskId);
    if (this.live.has(taskId)) throw new Error(`task ${taskId} still has a turn in flight`);
    if (action === "merge") {
      if (!force && !record.gate) throw new Error(`task ${taskId} has no passing gate; run worker_gate or pass force`);
      if (!force && (record.review?.blocking ?? 0) > 0) throw new Error(`task ${taskId} has ${record.review!.blocking} blocking review findings; fix them or pass force`);
      const message = commitMessage ?? `${taskId}: ${record.lastSummary.split("\n")[0] ?? ""}`.trim();
      const { commit } = await commitAndMerge(config.projectRoot, record.worktree, record.branch, message);
      await removeWorktree(config.projectRoot, record.worktree, record.branch);
      await ledger.update(taskId, { state: "merged" });
      return { merged: commit !== null, commit, costUsd: record.estCostUsd };
    }
    await removeWorktree(config.projectRoot, record.worktree, record.branch);
    await ledger.update(taskId, { state: "discarded" });
    return { merged: false, commit: null, costUsd: record.estCostUsd };
  }

  async status(taskId?: string): Promise<TaskRecord[]> {
    if (taskId) return [await this.deps.ledger.read(taskId)];
    return this.deps.ledger.list();
  }

  async cancel(taskId: string): Promise<{ cancelled: boolean }> {
    const record = await this.deps.ledger.read(taskId);
    if (!record.sessionId || !this.live.has(taskId)) return { cancelled: false };
    this.deps.host.cancel(record.sessionId);
    await this.deps.ledger.update(taskId, { state: "cancelled" });
    return { cancelled: true };
  }

  async budgetSummary() {
    const { budget } = this.deps;
    return { creditsRemainingUsd: await budget.creditsRemainingUsd(), spentThisProcessUsd: budget.spentThisProcessUsd, perTaskCapUsd: budget.perTaskCapUsd, floorUsd: budget.creditFloorUsd };
  }
}

export function parseFindings(text: string): { blocking: Finding[]; warnings: Finding[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { blocking?: Finding[]; warnings?: Finding[] };
      return { blocking: obj.blocking ?? [], warnings: obj.warnings ?? [] };
    } catch {}
  }
  return { blocking: [{ file: "", line: 0, issue: `reviewer output was not JSON: ${text.slice(0, 300)}` }], warnings: [] };
}

async function countTests(dir: string): Promise<{ testFiles: number; skips: number }> {
  let testFiles = 0;
  let skips = 0;
  const walk = async (d: string) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".worktrees") continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        testFiles++;
        skips += ((await Bun.file(p).text()).match(/\b(it|test|describe)\.skip\(|\bx(it|test|describe)\(/g) ?? []).length;
      }
    }
  };
  await walk(dir);
  return { testFiles, skips };
}
