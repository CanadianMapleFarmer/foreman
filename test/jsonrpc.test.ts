import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { JsonRpcPeer } from "../src/jsonrpc";

const fake = () => spawn("bun", ["run", `${import.meta.dir}/fake-agent.ts`], { stdio: ["pipe", "pipe", "inherit"] });

test("request/response round trip", async () => {
  const peer = new JsonRpcPeer(fake());
  const r = await peer.request<{ protocolVersion: number }>("initialize", { protocolVersion: 1 });
  expect(r.protocolVersion).toBe(1);
  peer.close();
});

test("errors reject with code and message", async () => {
  const peer = new JsonRpcPeer(fake());
  const s = await peer.request<{ sessionId: string }>("session/new", { cwd: "/", mcpServers: [] });
  await expect(peer.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: "bad/model" }))
    .rejects.toThrow(/unknown model/);
  peer.close();
});

test("incoming requests are dispatched to handlers and notifications observed", async () => {
  const peer = new JsonRpcPeer(fake());
  const seen: string[] = [];
  peer.onNotification("session/update", (p: any) => { if (p.update.sessionUpdate === "agent_message_chunk") seen.push(p.update.content.text); });
  peer.onRequest("session/request_permission", async (p: any) => ({ outcome: { outcome: "selected", optionId: p.options[0].optionId } }));
  const s = await peer.request<{ sessionId: string }>("session/new", { cwd: "/", mcpServers: [] });
  const r = await peer.request<{ stopReason: string }>("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "PERMISSION" }] });
  expect(r.stopReason).toBe("end_turn");
  expect(seen).toEqual(["granted"]);
  peer.close();
});

test("request timeout rejects", async () => {
  const peer = new JsonRpcPeer(fake());
  const s = await peer.request<{ sessionId: string }>("session/new", { cwd: "/", mcpServers: [] });
  await expect(peer.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "SLOW" }] }, 300)).rejects.toThrow(/timeout/);
  peer.close();
});

test("exit handler fires and pending requests reject when the child dies", async () => {
  const peer = new JsonRpcPeer(fake());
  let code: number | null | undefined;
  peer.onExit((c) => { code = c; });
  const s = await peer.request<{ sessionId: string }>("session/new", { cwd: "/", mcpServers: [] });
  await expect(peer.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "CRASH" }] })).rejects.toThrow(/exited/);
  expect(code).toBe(3);
});
