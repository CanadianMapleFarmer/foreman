import { expect, test } from "bun:test";
import { Budget, BudgetError } from "../src/budget";

const fakeFetch = (credits: { total_credits: number; total_usage: number }) => (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.endsWith("/credits")) return new Response(JSON.stringify({ data: credits }));
  if (u.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: "0.000000075", completion: "0.00000025" } }] }));
  return new Response("nope", { status: 404 });
}) as typeof fetch;

test("credits, price and estimate", async () => {
  const b = new Budget({ key: "k", perTaskCapUsd: 0.5, creditFloorUsd: 5, fetchImpl: fakeFetch({ total_credits: 20, total_usage: 1.5 }) });
  expect(await b.creditsRemainingUsd()).toBeCloseTo(18.5);
  expect((await b.priceFor("openrouter/z-ai/glm-5.3-flash"))!.prompt).toBeCloseTo(0.000000075);
  expect(await b.priceFor("openai/gpt-5.6-sol")).toBeNull();
  const est = await b.estimateUsd("openrouter/z-ai/glm-5.3-flash", "openrouter", { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
  expect(est).toBeCloseTo(0.325);
  expect(await b.estimateUsd("openai/gpt-5.6-sol", "subscription", { inputTokens: 5, outputTokens: 5, totalTokens: 10 })).toBe(0);
  expect(b.spentThisProcessUsd).toBeCloseTo(0.325);
});

test("floor and cap enforcement", async () => {
  const low = new Budget({ key: "k", perTaskCapUsd: 0.5, creditFloorUsd: 5, fetchImpl: fakeFetch({ total_credits: 20, total_usage: 16 }) });
  await expect(low.assertCanDispatch()).rejects.toBeInstanceOf(BudgetError);
  const ok = new Budget({ key: "k", perTaskCapUsd: 0.5, creditFloorUsd: 5, fetchImpl: fakeFetch({ total_credits: 20, total_usage: 1 }) });
  await ok.assertCanDispatch();
  expect(() => ok.assertWithinCap(0.49)).not.toThrow();
  expect(() => ok.assertWithinCap(0.5)).toThrow(BudgetError);
});

test("no key means no credit check and zero estimates", async () => {
  const b = new Budget({ key: null, perTaskCapUsd: 0.5, creditFloorUsd: 5, fetchImpl: fakeFetch({ total_credits: 0, total_usage: 0 }) });
  expect(await b.creditsRemainingUsd()).toBeNull();
  await b.assertCanDispatch();
});
