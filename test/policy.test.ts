import { expect, test } from "bun:test";
import { decide } from "../src/policy";

const ctx = { worktree: "/repo/.worktrees/t1", acceptCommand: "bun run check" };
const exec = (command: string) => ({ kind: "execute", title: command, rawInput: { command } });
const edit = (path: string) => ({ kind: "edit", title: path, rawInput: { filePath: path } });
const wipeRoot = ["rm", "-rf", "/"].join(" ");

test("write policy allows edits inside the worktree and normal commands", () => {
  expect(decide("write", edit("/repo/.worktrees/t1/src/a.ts"), ctx).allow).toBe(true);
  expect(decide("write", edit("src/a.ts"), ctx).allow).toBe(true);
  expect(decide("write", exec("bun test"), ctx).allow).toBe(true);
  expect(decide("write", exec("cd apps/web && bun run check && bun run build"), ctx).allow).toBe(true);
  expect(decide("write", exec("ls /repo/.worktrees/t1/src"), ctx).allow).toBe(true);
  expect(decide("write", { kind: "read", title: "x", rawInput: {} }, ctx).allow).toBe(true);
});

test("write policy rejects git commit/push/worktree, wiping root, and paths outside the worktree", () => {
  expect(decide("write", exec("git commit -m x"), ctx).allow).toBe(false);
  expect(decide("write", exec("git push origin main"), ctx).allow).toBe(false);
  expect(decide("write", exec("git worktree add ../x"), ctx).allow).toBe(false);
  expect(decide("write", exec(wipeRoot), ctx).allow).toBe(false);
  expect(decide("write", exec("sudo rm x"), ctx).allow).toBe(false);
  expect(decide("write", edit("/repo/src/a.ts"), ctx).allow).toBe(false);
  expect(decide("write", edit("../../src/a.ts"), ctx).allow).toBe(false);
  expect(decide("write", exec("cat ../../secrets"), ctx).allow).toBe(false);
  expect(decide("write", exec("echo x > /repo/src/a.ts"), ctx).allow).toBe(false);
  expect(decide("write", { kind: "fetch", title: "https://x", rawInput: {} }, ctx).allow).toBe(false);
});

test("read policy allows only reads, searches and whitelisted commands", () => {
  expect(decide("read", { kind: "read", title: "x", rawInput: {} }, ctx).allow).toBe(true);
  expect(decide("read", { kind: "search", title: "x", rawInput: {} }, ctx).allow).toBe(true);
  expect(decide("read", exec("git diff main"), ctx).allow).toBe(true);
  expect(decide("read", exec("git log --oneline -5"), ctx).allow).toBe(true);
  expect(decide("read", exec("bun run check"), ctx).allow).toBe(true);
  expect(decide("read", exec("cd apps/web && bun run check && bun run test"), ctx).allow).toBe(true);
  expect(decide("read", exec("cat biome.json 2>/dev/null || cat biome.jsonc"), ctx).allow).toBe(true);
  expect(decide("read", exec("cat biome.json || cat biome.jsonc"), ctx).allow).toBe(true);
  expect(decide("read", exec("grep -rn createFileRoute src | head -5"), ctx).allow).toBe(true);
  expect(decide("read", exec("cd apps/web && bun install --frozen-lockfile 2>&1 | tail -5"), ctx).allow).toBe(true);
  expect(decide("read", exec("bun run build"), ctx).allow).toBe(true);
  expect(decide("read", exec("sed -i '' s/a/b/ src/a.ts"), ctx).allow).toBe(false);
  expect(decide("read", exec("mkdir x"), ctx).allow).toBe(false);
  expect(decide("read", exec("cat x > y"), ctx).allow).toBe(false);
  expect(decide("read", exec("cat ../../secrets"), ctx).allow).toBe(false);
  expect(decide("read", edit("/repo/.worktrees/t1/src/a.ts"), ctx).allow).toBe(false);
  expect(decide("read", { kind: "delete", title: "x", rawInput: {} }, ctx).allow).toBe(false);
});
