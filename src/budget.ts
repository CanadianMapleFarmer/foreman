import { homedir } from "node:os";
import { join } from "node:path";
import type { Billing } from "./roles";

export interface TurnUsage { inputTokens: number; outputTokens: number; totalTokens: number }

export class BudgetError extends Error {
  constructor(public kind: "floor" | "cap", message: string) { super(message); }
}

export async function resolveOpenRouterKey(env: Record<string, string | undefined>): Promise<string | null> {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  const dataHome = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const f = Bun.file(join(dataHome, "opencode", "auth.json"));
  if (!(await f.exists())) return null;
  const auth = (await f.json()) as { openrouter?: { key?: string } };
  return auth.openrouter?.key ?? null;
}

interface Price { prompt: number; completion: number }

export class Budget {
  spentThisProcessUsd = 0;
  private prices: Map<string, Price> | null = null;
  private fetchImpl: typeof fetch;

  constructor(private opts: { key: string | null; perTaskCapUsd: number; creditFloorUsd: number; fetchImpl?: typeof fetch }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get perTaskCapUsd(): number { return this.opts.perTaskCapUsd; }
  get creditFloorUsd(): number { return this.opts.creditFloorUsd; }

  async creditsRemainingUsd(): Promise<number | null> {
    if (!this.opts.key) return null;
    const r = await this.fetchImpl("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${this.opts.key}` } });
    if (!r.ok) throw new Error(`openrouter credits check failed: HTTP ${r.status}`);
    const { data } = (await r.json()) as { data: { total_credits: number; total_usage: number } };
    return data.total_credits - data.total_usage;
  }

  async priceFor(model: string): Promise<Price | null> {
    if (!model.startsWith("openrouter/")) return null;
    if (!this.prices) {
      const r = await this.fetchImpl("https://openrouter.ai/api/v1/models");
      if (!r.ok) throw new Error(`openrouter models fetch failed: HTTP ${r.status}`);
      const { data } = (await r.json()) as { data: Array<{ id: string; pricing: { prompt: string; completion: string } }> };
      this.prices = new Map(data.map((m) => [m.id, { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) }]));
    }
    return this.prices.get(model.slice("openrouter/".length)) ?? null;
  }

  async estimateUsd(model: string, billing: Billing, usage: TurnUsage | null): Promise<number> {
    if (billing === "subscription" || !usage) return 0;
    const price = await this.priceFor(model);
    if (!price) return 0;
    const usd = usage.inputTokens * price.prompt + usage.outputTokens * price.completion;
    this.spentThisProcessUsd += usd;
    return usd;
  }

  async assertCanDispatch(): Promise<void> {
    const remaining = await this.creditsRemainingUsd();
    if (remaining !== null && remaining < this.opts.creditFloorUsd) {
      throw new BudgetError("floor", `OpenRouter credit remaining $${remaining.toFixed(2)} is below the floor of $${this.opts.creditFloorUsd.toFixed(2)}; refusing to dispatch`);
    }
  }

  assertWithinCap(taskEstUsd: number): void {
    if (taskEstUsd >= this.opts.perTaskCapUsd) {
      throw new BudgetError("cap", `task estimate $${taskEstUsd.toFixed(3)} reached the per-task cap of $${this.opts.perTaskCapUsd.toFixed(2)}`);
    }
  }
}
