import { spawn } from "node:child_process";
import type { TurnUsage } from "./budget";
import { JsonRpcPeer } from "./jsonrpc";
import type { ToolCallInfo } from "./policy";

export type { TurnUsage } from "./budget";

export const OPENCODE_PERMISSION_CONFIG = JSON.stringify({
  permission: { edit: "ask", bash: "ask", external_directory: "ask", webfetch: "deny", websearch: "deny", task: "deny", question: "deny", doom_loop: "deny" },
});

export interface AcpHostOptions { command?: string[]; env?: Record<string, string>; cwd?: string }
export interface TurnHandlers {
  onChunk?(text: string): void;
  onThought?(text: string): void;
  onToolCall?(update: unknown): void;
  onPermission(call: ToolCallInfo): { allow: boolean; reason: string };
  onEvent?(event: unknown): void;
}
export interface TurnResult { stopReason: string; text: string; filesChanged: string[]; usage: TurnUsage | null; rejections: number }

interface ActiveTurn { handlers: TurnHandlers; text: string[]; files: Set<string>; rejections: number }
interface ConfigOption { id?: string; configId?: string; currentValue?: string }
interface PermissionRequest {
  sessionId: string;
  toolCall: { kind: string; title: string; rawInput: unknown };
  options: Array<{ optionId: string; kind: string }>;
}

export class AcpHost {
  private peer: JsonRpcPeer | null = null;
  private alive = false;
  private turns = new Map<string, ActiveTurn>();

  constructor(private opts: AcpHostOptions = {}) {}

  isAlive(): boolean { return this.alive; }

  async start(): Promise<void> {
    const [cmd, ...args] = this.opts.command ?? ["opencode", "acp", "--pure"];
    const proc = spawn(cmd!, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: OPENCODE_PERMISSION_CONFIG, ...this.opts.env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.peer = new JsonRpcPeer(proc);
    this.alive = true;
    this.peer.onExit(() => { this.alive = false; });
    this.peer.onNotification("session/update", (p) => this.onUpdate(p as { sessionId: string; update: any }));
    this.peer.onRequest("session/request_permission", async (p) => this.onPermission(p as PermissionRequest));
    await this.peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "foreman", version: "0.1.0" },
    }, 30_000);
  }

  async newSession(cwd: string): Promise<string> {
    const r = await this.rpc().request<{ sessionId: string }>("session/new", { cwd, mcpServers: [] }, 60_000);
    return r.sessionId;
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const r = await this.rpc().request<{ configOptions?: ConfigOption[] }>(
      "session/set_config_option", { sessionId, configId: "model", value: model }, 30_000);
    const current = (r.configOptions ?? []).find((c) => (c.id ?? c.configId) === "model")?.currentValue;
    if (current !== model) throw new Error(`model not applied: wanted ${model}, agent reports ${current ?? "unknown"}`);
  }

  async prompt(sessionId: string, text: string, handlers: TurnHandlers, timeoutMs: number): Promise<TurnResult> {
    const turn: ActiveTurn = { handlers, text: [], files: new Set(), rejections: 0 };
    this.turns.set(sessionId, turn);
    const request = this.rpc().request<{ stopReason: string; usage?: TurnUsage }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const finish = (stopReason: string, usage: TurnUsage | null): TurnResult => ({
      stopReason, text: turn.text.join(""), filesChanged: [...turn.files], usage, rejections: turn.rejections,
    });
    try {
      const outcome = await Promise.race([request, timeout]);
      if (outcome === "timeout") {
        this.cancel(sessionId);
        const late = await Promise.race([request.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
        return finish("timeout", late?.usage ?? null);
      }
      return finish(outcome.stopReason, outcome.usage ?? null);
    } finally {
      if (timer) clearTimeout(timer);
      this.turns.delete(sessionId);
    }
  }

  cancel(sessionId: string): void { this.peer?.notify("session/cancel", { sessionId }); }

  close(): void { this.peer?.close(); this.alive = false; }

  private rpc(): JsonRpcPeer {
    if (!this.peer || !this.alive) throw new Error("agent is not running; call start()");
    return this.peer;
  }

  private onUpdate(p: { sessionId: string; update: any }): void {
    const turn = this.turns.get(p.sessionId);
    if (!turn) return;
    const u = p.update;
    turn.handlers.onEvent?.(u);
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") { turn.text.push(u.content.text); turn.handlers.onChunk?.(u.content.text); }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") turn.handlers.onThought?.(u.content.text);
        break;
      case "tool_call":
      case "tool_call_update":
        for (const c of u.content ?? []) if (c.type === "diff" && c.path) turn.files.add(c.path);
        for (const loc of u.locations ?? []) if (loc.path && (u.kind === "edit" || u.kind === "delete" || u.kind === "move")) turn.files.add(loc.path);
        turn.handlers.onToolCall?.(u);
        break;
    }
  }

  private async onPermission(p: PermissionRequest) {
    const turn = this.turns.get(p.sessionId);
    const decision = turn
      ? turn.handlers.onPermission({ kind: p.toolCall.kind, title: p.toolCall.title, rawInput: p.toolCall.rawInput })
      : { allow: false, reason: "no active turn" };
    if (!decision.allow && turn) turn.rejections++;
    const wanted = decision.allow ? "allow" : "reject";
    const option = p.options.find((o) => o.kind.startsWith(wanted)) ?? p.options[0];
    if (!option) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
}
