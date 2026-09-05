import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_ROLES, mergeRoles, type Role } from "./roles";

const RoleOverrideSchema = z.object({
  model: z.string().optional(),
  policy: z.enum(["write", "read"]).optional(),
  prompt: z.string().optional(),
  maxTurnSeconds: z.number().int().positive().optional(),
  billing: z.enum(["openrouter", "subscription"]).optional(),
});

const FileSchema = z.object({
  acceptCommand: z.string().nullable().optional(),
  baseBranch: z.string().optional(),
  worktreeDir: z.string().optional(),
  ledgerDir: z.string().optional(),
  perTaskCapUsd: z.number().nonnegative().optional(),
  creditFloorUsd: z.number().nonnegative().optional(),
  roles: z.record(z.string(), RoleOverrideSchema).optional(),
});

export interface ForemanConfig {
  projectRoot: string;
  acceptCommand: string | null;
  baseBranch: string;
  worktreeDir: string;
  ledgerDir: string;
  perTaskCapUsd: number;
  creditFloorUsd: number;
  roles: Record<string, Role>;
}

export const FOREMAN_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function gitTopLevel(cwd: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().trim();
}

export async function resolveProjectRoot(cwd: string, env: Record<string, string | undefined>): Promise<string> {
  const root = env.FOREMAN_PROJECT_ROOT ?? gitTopLevel(cwd);
  if (!root) throw new Error(`not inside a git repository: ${cwd} (set FOREMAN_PROJECT_ROOT)`);
  return realpath(root);
}

export async function loadConfig(cwd: string, env: Record<string, string | undefined> = process.env): Promise<ForemanConfig> {
  const projectRoot = await resolveProjectRoot(cwd, env);
  const file = Bun.file(join(projectRoot, ".foreman.json"));
  const parsed = (await file.exists()) ? FileSchema.parse(await file.json()) : {};
  return {
    projectRoot,
    acceptCommand: parsed.acceptCommand ?? null,
    baseBranch: parsed.baseBranch ?? "main",
    worktreeDir: parsed.worktreeDir ?? ".worktrees",
    ledgerDir: parsed.ledgerDir ?? ".foreman",
    perTaskCapUsd: parsed.perTaskCapUsd ?? 0.5,
    creditFloorUsd: parsed.creditFloorUsd ?? 5,
    roles: mergeRoles(DEFAULT_ROLES, parsed.roles),
  };
}
