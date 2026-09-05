import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "foreman-cfg-"));
  Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
  return dir;
}

test("defaults when .foreman.json is absent", async () => {
  const dir = await gitRepo();
  const cfg = await loadConfig(dir, {});
  expect(cfg.projectRoot).toBe(await realpath(dir));
  expect(cfg.acceptCommand).toBeNull();
  expect(cfg.baseBranch).toBe("main");
  expect(cfg.perTaskCapUsd).toBe(0.5);
  expect(cfg.creditFloorUsd).toBe(5);
  expect(cfg.roles.coder!.model).toBe("openrouter/z-ai/glm-5.3-flash");
  expect(cfg.copyIntoWorktree).toEqual([]);
});

test("reads .foreman.json and env override", async () => {
  const dir = await gitRepo();
  await writeFile(join(dir, ".foreman.json"), JSON.stringify({
    acceptCommand: "bun run check",
    perTaskCapUsd: 0.25,
    roles: { coder: { model: "openai/gpt-5.6-sol", billing: "subscription" } },
  }));
  const cfg = await loadConfig("/", { FOREMAN_PROJECT_ROOT: dir });
  expect(cfg.acceptCommand).toBe("bun run check");
  expect(cfg.perTaskCapUsd).toBe(0.25);
  expect(cfg.roles.coder!.model).toBe("openai/gpt-5.6-sol");
  expect(cfg.roles.coder!.billing).toBe("subscription");
});

test("fails outside a git repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foreman-nogit-"));
  await expect(loadConfig(dir, {})).rejects.toThrow(/not inside a git repository/);
});
