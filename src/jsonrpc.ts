import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
type RequestHandler = (params: unknown, id: number) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

export class JsonRpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private exitHandlers: Array<(code: number | null) => void> = [];
  private exited = false;

  constructor(private proc: ChildProcess) {
    if (!proc.stdout || !proc.stdin) throw new Error("child must have piped stdin and stdout");
    createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    proc.on("exit", (code) => {
      this.exited = true;
      for (const [id, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`agent exited with code ${code} before answering request ${id}`));
      }
      this.pending.clear();
      for (const h of this.exitHandlers) h(code);
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.exited) return Promise.reject(new Error("agent exited"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`)); }, timeoutMs)
        : null;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }
  onRequest(method: string, handler: RequestHandler): void { this.requestHandlers.set(method, handler); }
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, [...(this.notificationHandlers.get(method) ?? []), handler]);
  }
  onExit(handler: (code: number | null) => void): void { this.exitHandlers.push(handler); }
  close(): void { if (!this.exited) this.proc.kill(); }

  private send(msg: object): void {
    if (this.exited) return;
    this.proc.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) return this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
      handler(msg.params, msg.id)
        .then((result) => this.send({ jsonrpc: "2.0", id: msg.id, result }))
        .catch((e: Error) => this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } }));
      return;
    }
    for (const h of this.notificationHandlers.get(msg.method) ?? []) h(msg.params);
  }
}
