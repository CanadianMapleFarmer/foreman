import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOk } from "../src/git";

test("foreman mcp lists the nine tools and answers foreman_budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreman-mcp-"));
  await gitOk(["init", "-q", "-b", "main"], root);
  await writeFile(join(root, "a.txt"), "a\n");
  await gitOk(["add", "-A"], root);
  await gitOk(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], root);
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "src", "cli.ts"), "mcp"],
    env: { ...process.env, FOREMAN_PROJECT_ROOT: root, FOREMAN_AGENT_COMMAND: `bun run ${join(import.meta.dir, "fake-agent.ts")}`, FOREMAN_NO_NETWORK: "1" } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(["foreman_budget", "worker_cancel", "worker_dispatch", "worker_finish", "worker_followup", "worker_gate", "worker_review", "worker_status", "worker_wait"]);
  const r = await client.callTool({ name: "foreman_budget", arguments: {} });
  const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
  expect(JSON.parse(text).perTaskCapUsd).toBe(0.5);
  await client.close();
});
