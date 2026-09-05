export type Billing = "openrouter" | "subscription";
export type Policy = "write" | "read";

export interface Role {
  model: string;
  policy: Policy;
  prompt: string;
  maxTurnSeconds: number;
  billing: Billing;
}

export type RoleOverride = Partial<Role>;

const write = (model: string, billing: Billing, maxTurnSeconds = 900): Role => ({
  model, policy: "write", prompt: "prompts/coder.md", maxTurnSeconds, billing,
});
const read = (model: string, billing: Billing, prompt: string, maxTurnSeconds = 600): Role => ({
  model, policy: "read", prompt, maxTurnSeconds, billing,
});

export const DEFAULT_ROLES: Record<string, Role> = {
  coder: write("openrouter/z-ai/glm-5.3-flash", "openrouter"),
  "coder-sol": write("openai/gpt-5.6-sol", "subscription", 1200),
  "coder-pro": write("openrouter/deepseek/deepseek-v4-pro-0813", "openrouter", 1200),
  "coder-max": write("openrouter/z-ai/glm-5.3", "openrouter", 1200),
  reviewer: read("openrouter/deepseek/deepseek-v4-flash-0731", "openrouter", "prompts/reviewer.md"),
  "reviewer-sol": read("openai/gpt-5.6-sol", "subscription", "prompts/reviewer.md"),
  planner: read("openrouter/qwen/qwen3.7-flash", "openrouter", "prompts/planner.md", 300),
};

export function mergeRoles(base: Record<string, Role>, overrides: Record<string, RoleOverride> = {}): Record<string, Role> {
  const out: Record<string, Role> = { ...base };
  for (const [name, patch] of Object.entries(overrides)) {
    const existing = out[name];
    if (existing) {
      out[name] = { ...existing, ...patch };
      continue;
    }
    if (!patch.model || !patch.policy || !patch.prompt || !patch.maxTurnSeconds || !patch.billing) {
      throw new Error(`role "${name}" is new and must define model, policy, prompt, maxTurnSeconds, billing`);
    }
    out[name] = patch as Role;
  }
  return out;
}

export async function resolvePromptText(role: Role, foremanDir: string, projectRoot: string): Promise<string> {
  const candidates = [role.prompt, `${projectRoot}/${role.prompt}`, `${foremanDir}/${role.prompt}`];
  for (const c of candidates) {
    const f = Bun.file(c);
    if (await f.exists()) return f.text();
  }
  throw new Error(`prompt file not found for role: ${role.prompt}`);
}
