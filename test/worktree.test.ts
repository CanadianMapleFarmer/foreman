import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOk } from "../src/git";
import { commitAndMerge, createWorktree, hasChanges, removeWorktree, stagedDiff } from "../src/worktree";

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "foreman-wt-"));
  await gitOk(["init", "-q", "-b", "main"], dir);
  await gitOk(["config", "user.email", "t@t"], dir);
  await gitOk(["config", "user.name", "t"], dir);
  await writeFile(join(dir, "a.txt"), "a\n");
  await gitOk(["add", "-A"], dir);
  await gitOk(["commit", "-q", "-m", "init"], dir);
  return dir;
}

test("create, change, diff, merge, remove", async () => {
  const root = await repo();
  const wt = await createWorktree(root, ".worktrees", "t1", "main");
  expect(wt.path).toBe(join(root, ".worktrees", "t1"));
  expect(wt.branch).toBe("task/t1");
  expect(await hasChanges(wt.path)).toBe(false);
  await writeFile(join(wt.path, "b.txt"), "b\n");
  expect(await hasChanges(wt.path)).toBe(true);
  expect(await stagedDiff(wt.path, wt.baseCommit)).toContain("+b");
  const { commit } = await commitAndMerge(root, wt.path, wt.branch, "task t1");
  expect(commit ?? "").toMatch(/^[0-9a-f]{40}$/);
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe("b\n");
  await removeWorktree(root, wt.path, wt.branch);
  expect(await Bun.file(join(wt.path, "b.txt")).exists()).toBe(false);
  expect((await gitOk(["branch", "--list", "task/t1"], root)).trim()).toBe("");
});

test("merging a worktree with no changes is a no-op", async () => {
  const root = await repo();
  const wt = await createWorktree(root, ".worktrees", "t2", "main");
  expect((await commitAndMerge(root, wt.path, wt.branch, "x")).commit).toBeNull();
  await removeWorktree(root, wt.path, wt.branch);
});

test("duplicate and invalid task ids fail", async () => {
  const root = await repo();
  await createWorktree(root, ".worktrees", "t3", "main");
  await expect(createWorktree(root, ".worktrees", "t3", "main")).rejects.toThrow();
  await expect(createWorktree(root, ".worktrees", "bad id", "main")).rejects.toThrow(/invalid/);
});
