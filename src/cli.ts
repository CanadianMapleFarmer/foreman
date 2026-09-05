#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AcpHost } from "./acp-host";
import { Budget, resolveOpenRouterKey } from "./budget";
import { FOREMAN_DIR, loadConfig } from "./config";
import { Ledger } from "./ledger";
import { buildServer } from "./server";
import { TaskManager } from "./tasks";
import { VERSION } from "./version";

async function build() {
  const config = await loadConfig(process.cwd());
  const key = process.env.FOREMAN_NO_NETWORK ? null : await resolveOpenRouterKey(process.env);
  const budget = new Budget({ key, perTaskCapUsd: config.perTaskCapUsd, creditFloorUsd: config.creditFloorUsd });
  const command = process.env.FOREMAN_AGENT_COMMAND?.split(" ").filter(Boolean);
  const host = new AcpHost({ command, cwd: config.projectRoot });
  const ledger = new Ledger(config.projectRoot, config.ledgerDir);
  return { config, key, budget, host, tm: new TaskManager({ config, host, ledger, budget, foremanDir: FOREMAN_DIR }) };
}

async function mcp() {
  const { host, tm } = await build();
  await host.start();
  const server = buildServer(tm);
  const transport = new StdioServerTransport();
  const shutdown = () => { host.close(); process.exit(0); };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await server.connect(transport);
}

async function doctor() {
  const { config, key, budget } = await build();
  const opencode = Bun.spawnSync(["opencode", "--version"]).stdout.toString().trim();
  console.log(`foreman ${VERSION}`);
  console.log(`project root: ${config.projectRoot}`);
  console.log(`accept command: ${config.acceptCommand ?? "(none)"}  base: ${config.baseBranch}`);
  console.log(`opencode: ${opencode || "NOT FOUND"}`);
  console.log(`openrouter key: ${key ? "found" : "MISSING"}`);
  try {
    console.log(`credits remaining: ${await budget.creditsRemainingUsd()}`);
  } catch (e) {
    console.log(`credits: ${(e as Error).message}`);
  }
  for (const [name, r] of Object.entries(config.roles)) console.log(`role ${name.padEnd(13)} ${r.model.padEnd(45)} ${r.policy.padEnd(5)} ${r.billing}`);
}

const command = process.argv[2] ?? "mcp";
if (command === "--version") console.log(VERSION);
else if (command === "mcp") await mcp();
else if (command === "doctor") await doctor();
else {
  console.error("usage: foreman [mcp|doctor|--version]");
  process.exit(2);
}
