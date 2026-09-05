import { createInterface } from "node:readline";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: any; result?: any; error?: any };
const out = (m: object) => process.stdout.write(`${JSON.stringify(m)}\n`);
let nextSession = 1;
let nextId = 1000;
const models: Record<string, string> = {};
const pending = new Map<number, (m: Msg) => void>();
const cancelled = new Set<string>();
const configOptions = (sid: string) => [{ id: "model", name: "Model", type: "select", currentValue: models[sid] ?? "opencode/free", options: [{ value: "opencode/free", name: "free" }, { value: "openrouter/z-ai/glm-5.3-flash", name: "glm" }] }];

async function ask(method: string, params: unknown): Promise<Msg> {
  const id = nextId++;
  out({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

async function prompt(id: number, sid: string, text: string) {
  const update = (u: object) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: u } });
  const chunk = (t: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
  if (text.includes("CRASH")) process.exit(3);
  if (text.includes("PERMISSION")) {
    const answer = await ask("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "c1", title: "echo hi", kind: "execute", rawInput: { command: "echo hi" } },
      options: [{ optionId: "a", name: "Allow", kind: "allow_once" }, { optionId: "r", name: "Reject", kind: "reject_once" }],
    });
    chunk(answer.result?.outcome?.optionId === "a" ? "granted" : "denied");
  }
  if (text.includes("DIFF")) {
    update({ sessionUpdate: "tool_call", toolCallId: "c2", title: "edit src/x.ts", kind: "edit", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", content: [{ type: "diff", path: "src/x.ts", oldText: "a", newText: "b" }] });
  }
  if (text.includes("SLOW")) {
    for (let i = 0; i < 50; i++) {
      await Bun.sleep(100);
      if (cancelled.has(sid)) {
        cancelled.delete(sid);
        return out({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      }
    }
  }
  if (text.includes("COST")) update({ sessionUpdate: "usage_update", used: 5000, size: 400000, cost: { amount: 0.0123, currency: "USD" } });
  if (!text.includes("PERMISSION")) { chunk("PO"); chunk("NG"); }
  out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as Msg;
  if (m.id !== undefined && !m.method) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
  const id = m.id as number;
  switch (m.method) {
    case "initialize": return out({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", version: "0" } } });
    case "session/new": { const sid = `ses_${nextSession++}`; return out({ jsonrpc: "2.0", id, result: { sessionId: sid, configOptions: configOptions(sid) } }); }
    case "session/load": { models[m.params.sessionId] = "opencode/free"; return out({ jsonrpc: "2.0", id, result: { configOptions: configOptions(m.params.sessionId) } }); }
    case "session/set_config_option": {
      if (m.params.value === "bad/model") return out({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown model" } });
      models[m.params.sessionId] = m.params.value;
      return out({ jsonrpc: "2.0", id, result: { configOptions: configOptions(m.params.sessionId) } });
    }
    case "session/prompt": return void prompt(id, m.params.sessionId, m.params.prompt.map((p: any) => p.text ?? "").join(""));
    case "session/cancel": return void cancelled.add(m.params.sessionId);
    default: if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${m.method}` } });
  }
});
