import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk } from "./git";

export interface Worktree { path: string; branch: string; baseCommit: string }

export async function createWorktree(root: string, worktreeDir: string, taskId: string, base: string): Promise<Worktree> {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  const path = join(root, worktreeDir, taskId);
  const branch = `task/${taskId}`;
  if (await Bun.file(join(path, ".git")).exists()) throw new Error(`worktree already exists: ${path}`);
  await mkdir(join(root, worktreeDir), { recursive: true });
  const baseCommit = (await gitOk(["rev-parse", base], root)).trim();
  await gitOk(["worktree", "add", "-q", "-b", branch, path, baseCommit], root);
  return { path, branch, baseCommit };
}

export async function hasChanges(worktreePath: string): Promise<boolean> {
  return (await gitOk(["status", "--porcelain"], worktreePath)).trim().length > 0;
}

export async function stagedDiff(worktreePath: string, baseCommit: string): Promise<string> {
  await gitOk(["add", "-A"], worktreePath);
  return gitOk(["diff", "--cached", baseCommit], worktreePath);
}

export async function commitAndMerge(root: string, worktreePath: string, branch: string, message: string): Promise<{ commit: string | null }> {
  if (!(await hasChanges(worktreePath))) return { commit: null };
  await gitOk(["add", "-A"], worktreePath);
  await gitOk(["commit", "-q", "-m", message], worktreePath);
  await gitOk(["merge", "--no-ff", "-q", "-m", `Merge ${branch}: ${message}`, branch], root);
  return { commit: (await gitOk(["rev-parse", "HEAD"], root)).trim() };
}

export async function removeWorktree(root: string, worktreePath: string, branch: string): Promise<void> {
  await gitOk(["worktree", "remove", "--force", worktreePath], root);
  await git(["branch", "-D", branch], root);
}
