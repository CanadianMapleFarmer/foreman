import { expect, test } from "bun:test";
import { DEFAULT_ROLES, mergeRoles } from "../src/roles";

test("default roles cover the roster", () => {
  expect(Object.keys(DEFAULT_ROLES).sort()).toEqual(
    ["coder", "coder-max", "coder-pro", "coder-sol", "planner", "reviewer", "reviewer-sol"].sort(),
  );
  expect(DEFAULT_ROLES.coder!.model).toBe("openrouter/z-ai/glm-5.3-flash");
  expect(DEFAULT_ROLES["coder-sol"]!.billing).toBe("subscription");
  expect(DEFAULT_ROLES.reviewer!.policy).toBe("read");
});

test("mergeRoles overrides fields and adds roles", () => {
  const merged = mergeRoles(DEFAULT_ROLES, {
    coder: { model: "openrouter/x/y" },
    docs: { model: "openai/gpt-5.6-sol", policy: "write", prompt: "prompts/coder.md", maxTurnSeconds: 60, billing: "subscription" },
  });
  expect(merged.coder!.model).toBe("openrouter/x/y");
  expect(merged.coder!.policy).toBe("write");
  expect(merged.docs!.maxTurnSeconds).toBe(60);
  expect(() => mergeRoles(DEFAULT_ROLES, { partial: { model: "x" } })).toThrow(/must define/);
});
