# Foreman: Claude Code orchestrating OpenRouter workers over ACP

Date: 2026-09-05. Status: draft for review.

## 1. Goal

Claude Code stays the orchestrator (planning, task decomposition, acceptance, merging). Cheap open-weight models bought through OpenRouter do the implementation and first-pass review. The mechanism is a small MCP server, **foreman**, that Claude Code loads from the project and that drives **OpenCode** worker sessions over the **Agent Client Protocol (ACP)**.

Two sub-projects, built in this order:

1. **Foreman** (this spec): the dispatch framework, proven on a throwaway task.
2. **Kustom** (separate spec, next brainstorm): the mousepad e-commerce platform on TanStack Start + Supabase. Claude scaffolds the skeleton itself, then Kustom features flow through foreman.

## 2. Decisions already made

| Decision | Choice | Source |
|---|---|---|
| Architecture | B: ACP client wrapped in an MCP server, workers are `opencode acp` sessions | user, 2026-09-05 |
| Worker runtime | OpenCode 1.18.25 (OpenRouter already authenticated in it) | research, verified |
| Kustom stack | TanStack Start (React) as a static SPA on Firebase Hosting; Supabase for database, auth, storage, edge functions | user |
| Autonomy | Workers may run any shell command inside their worktree except commit and push. Claude merges when the gate passes and the reviewer has no blocking findings. | user |
| Budget | Hard cap $0.50 per task. Refuse new dispatches when OpenRouter credit remaining is below $5. | user |
| Orchestrator billing | This Claude Code session on its normal Anthropic endpoint. No proxy, no base URL swap. | research |

## 3. Facts that constrain the design (verified 2026-09-05)

- Claude Code subagents run Anthropic models only. Cheap workers must live outside Claude Code.
- `opencode acp` speaks ACP v1 over stdio. `session/new` takes a `cwd`, so one process can host sessions in different worktrees. `session/set_config_option {configId:"model"}` switches the OpenRouter model per session at runtime. There is no `--model` flag on `opencode acp`.
- ACP has no final-answer field. The client concatenates `agent_message_chunk` updates until the `session/prompt` response arrives with `stopReason`. Diffs arrive as `tool_call_update` content of type `diff`.
- Permission requests (`session/request_permission`) reach the client only for tools OpenCode has configured as `ask`. Anything set to `allow` never asks. This lets the client enforce per-role policy.
- OpenCode's `usage_update.cost` reported 0 on the free model. Cost must be computed from token usage and OpenRouter's public price list, and reconciled against OpenRouter's credits endpoint.
- A mistyped agent name in OpenCode silently falls back to the OpenAI OAuth credential with exit 0. The project config must disable the `openai` provider.
- Without a project `AGENTS.md`, OpenCode workers inherit `~/.claude/CLAUDE.md`, including the RTK rewrite rules. The project needs its own `AGENTS.md`.
- Fresh sessions cost roughly 10k to 14k input tokens before the model speaks. Flash-tier models are the default; big models are escalation only.
- ACP v2 is a draft that moves turn completion into `state_update`. All local agents answer v1 today. The client isolates "wait for turn end" so the v2 switch is local.

## 4. Architecture

```
Claude Code (orchestrator)
   │  MCP tools over stdio (.mcp.json)
   ▼
foreman  (tools/foreman, TypeScript on bun)
   ├─ AcpHost        one long-lived `opencode acp --pure` child, JSON-RPC over stdio
   ├─ Roles          roles.json → model id, permission policy, prompt, caps
   ├─ Worktrees      git worktree per task under .worktrees/<task-id>, branch task/<task-id>
   ├─ Ledger         .foreman/<task-id>/ {spec.md, events.jsonl, result.md, review.json, gate.log, cost.json}
   └─ Budget         per-task cap, credit floor, OpenRouter /credits + /models price cache
   │
   ▼
OpenCode sessions, one per worker turn, each pinned to an OpenRouter model
```

### 4.1 Components

**AcpHost.** Spawns `opencode acp --pure` once, performs `initialize` (protocolVersion 1, no fs or terminal capabilities), and multiplexes sessions. Provides `newSession(cwd)`, `setModel(sessionId, modelId)`, `prompt(sessionId, text)` returning an async stream of updates plus a promise for the turn result, and `cancel(sessionId)`. Restarts the child if it exits, failing any in-flight turns with a clear error. Depends on `@agentclientprotocol/sdk` 1.4.0 for framing and types only; if the SDK's method helpers prove awkward, the fallback is the 40-line raw JSON-RPC client already validated in research.

**Roles.** `tools/foreman/roles.json`, one entry per role:

```jsonc
{
  "coder":      { "model": "openrouter/z-ai/glm-5.3-flash",              "policy": "write", "prompt": "prompts/coder.md",    "maxTurnSeconds": 900 },
  "coder-pro":  { "model": "openrouter/deepseek/deepseek-v4-pro-0813",   "policy": "write", "prompt": "prompts/coder.md",    "maxTurnSeconds": 1200 },
  "coder-max":  { "model": "openrouter/z-ai/glm-5.3",                    "policy": "write", "prompt": "prompts/coder.md",    "maxTurnSeconds": 1200 },
  "reviewer":   { "model": "openrouter/deepseek/deepseek-v4-flash-0731", "policy": "read",  "prompt": "prompts/reviewer.md", "maxTurnSeconds": 600 },
  "reviewer-2": { "model": "openrouter/qwen/qwen3.8-27b",                "policy": "read",  "prompt": "prompts/reviewer.md", "maxTurnSeconds": 600 },
  "planner":    { "model": "openrouter/qwen/qwen3.7-flash",              "policy": "read",  "prompt": "prompts/planner.md",  "maxTurnSeconds": 300 }
}
```

Policies decide permission requests by `toolCall.kind` and `rawInput`:

- `write`: allow read, search, edit, execute. Reject execute when the command matches `git commit`, `git push`, `git worktree`, `rm -rf /`, or touches a path outside the task worktree. Reject fetch.
- `read`: allow read and search. Allow execute only for `git diff`, `git log`, `git status`, and the project's acceptance command. Reject edit, delete, move, fetch.

Writer and reviewer are always different model lineages. Role prompts are prepended to the task prompt; project rules come from `AGENTS.md` in the worktree.

**Worktrees.** `git worktree add .worktrees/<task-id> -b task/<task-id> <base>` where base defaults to the current branch head. `.worktrees/` and `.foreman/` are gitignored. Workers never commit. On finish, foreman commits the worktree's changes on the task branch with a message Claude supplies, merges into the base branch with `--no-ff`, and removes the worktree and branch. On discard it removes both without merging.

**Ledger.** Everything a worker produces lands in `.foreman/<task-id>/`. Claude reads the summary and the files it names, never the raw event stream. `events.jsonl` keeps every ACP update for debugging.

**Budget.** Before every dispatch foreman checks OpenRouter `GET /api/v1/credits` (total credits minus total usage). Below $5 it refuses with a message that says so. During a turn it accumulates estimated cost from `session/prompt` usage times the cached price for the pinned model (prices fetched once per process from `GET /api/v1/models`). If a task's cumulative estimate would exceed $0.50, the current turn is cancelled and the tool returns `budget_exceeded`. Estimates are reconciled against the credits delta in `cost.json` so the user can see how far off the estimate is. The OpenRouter key comes from `OPENROUTER_API_KEY`, falling back to OpenCode's `auth.json` under `$XDG_DATA_HOME/opencode/`.

### 4.2 MCP tools exposed to Claude

| Tool | Input | Returns | Notes |
|---|---|---|---|
| `worker_dispatch` | `taskId`, `role`, `spec` (markdown), `base?` | `{taskId, sessionId, worktree}` | Creates worktree, writes `spec.md`, opens session, pins model, sends prompt. Non-blocking. Fails if budget floor hit or `taskId` exists. |
| `worker_wait` | `taskId`, `timeoutSeconds?` | `{status, stopReason, summary, filesChanged[], usage, estCostUsd}` | `status` is `done`, `running` (timeout hit, nothing cancelled), `budget_exceeded`, `error`. |
| `worker_followup` | `taskId`, `message` | same as `worker_wait` | Continues the same session (prompt cache hit) for fix-up rounds. Counts against the task cap. |
| `worker_gate` | `taskId`, `command` | `{exitCode, logPath, tail}` | Runs the acceptance command in the worktree with a timeout. Foreman runs it, not the worker. |
| `worker_review` | `taskId`, `role?` (default `reviewer`) | `{blocking[], warnings[], reviewPath}` | Fresh session in the same worktree; prompt contains the spec and `git diff <base>`. Reviewer output is parsed as JSON; unparseable output is returned as one blocking finding. |
| `worker_finish` | `taskId`, `action` (`merge` or `discard`), `commitMessage?` | `{merged, commit?, costUsd}` | Merge requires a passed gate recorded in the ledger; otherwise refuses unless `force: true`. Closes sessions, removes worktree. |
| `worker_status` | `taskId?` | list of tasks with state, role, model, elapsed, estCostUsd | |
| `worker_cancel` | `taskId` | `{cancelled}` | `session/cancel`, worktree kept for inspection. |
| `foreman_budget` | none | `{creditsRemainingUsd, spentThisSessionUsd, perTaskCapUsd, floorUsd}` | |

### 4.3 The orchestration loop Claude follows

Encoded in `.claude/skills/foreman/SKILL.md` so Claude runs it consistently:

1. Write a bounded spec: goal, files likely touched, acceptance command, out of scope. One vertical slice or smaller.
2. `worker_dispatch(role: coder)`, then `worker_wait`.
3. `worker_gate` with the acceptance command. If it fails, `worker_followup` with the failure tail. Maximum two follow-ups.
4. `worker_review`. If blocking findings exist, one `worker_followup` with the findings, then re-gate and re-review once.
5. Escalate on repeated failure: re-dispatch the same spec with `coder-pro`, then `coder-max`, then Claude implements it itself. Never loop more than the caps above.
6. `worker_finish(merge)` on green gate and no blocking findings. Otherwise `discard` and report.
7. Report cost per task from `worker_finish`.

Claude may run several tasks concurrently when their specs touch disjoint files. Each has its own worktree and branch, so merges are ordinary git merges.

### 4.4 Project files

```
.mcp.json                          registers foreman: bun run tools/foreman/src/index.ts
AGENTS.md                          worker-facing project rules (stack, commands, conventions, "do not commit")
opencode.json                      disabled_providers: ["openai"]; permission map with ask for edit/bash so foreman policies apply; instructions: AGENTS.md
.claude/skills/foreman/SKILL.md    the loop above, tool reference, escalation rules
tools/foreman/
  package.json, tsconfig.json
  roles.json
  prompts/{coder,reviewer,planner}.md
  src/index.ts                     MCP server wiring
  src/acp-host.ts                  ACP client and session multiplexer
  src/roles.ts, src/policy.ts      role loading and permission policy
  src/worktree.ts                  git worktree lifecycle
  src/ledger.ts                    .foreman/<task-id> files
  src/budget.ts                    OpenRouter credits and price cache
  src/tools/*.ts                   one file per MCP tool
  test/                            see section 6
.foreman/  .worktrees/             gitignored
```

## 5. Error handling

- **Child exits or hangs**: AcpHost detects exit, fails in-flight turns with `error`, restarts on next call. Turn timeouts from the role's `maxTurnSeconds` trigger `session/cancel` and return `status: error` with `reason: timeout`.
- **Empty final text**: common when a worker only edits files. `summary` falls back to a generated list of `filesChanged` from diff updates, and the tool flags `summaryEmpty: true`.
- **Model unavailable or 4xx from OpenRouter**: surfaces as an ACP error on the prompt. Returned verbatim under `error`, task left in `failed`, worktree kept.
- **Worker attempts a forbidden action**: policy rejects it; the rejection is logged to `events.jsonl` and counted. More than five rejections in one turn cancels the turn as runaway.
- **Gate tampering**: `worker_gate` records the number of test files and skipped tests before and after; a drop is reported as a warning in the gate result.
- **Budget**: see 4.1. Refusals are explicit tool errors with the current numbers, never silent.
- **Silent provider fallback**: prevented by `disabled_providers` and by `setModel` reading back `currentValue` and failing if it does not match.

## 6. Testing

- **Unit** (bun test): policy decisions for each kind and command pattern; role loading and validation; budget arithmetic and floor logic with a mocked HTTP layer; ledger file layout.
- **Protocol** (bun test): a fake ACP agent script (stdio, ~60 lines) that speaks v1, emits chunks, tool_call diffs, a permission request, and a stop. AcpHost is tested against it for the happy path, cancel, timeout, child crash, and set-model mismatch.
- **Integration smoke** (manual, costs under $0.02): `worker_dispatch` with role `reviewer` and spec "Reply PONG" against real `opencode acp`; assert model id in the ledger matches roles.json and the credits delta is nonzero.
- **End-to-end proof**: one bounded coding task on a scratch TanStack app (add a route with a test) through the full loop with `coder` = glm-5.3-flash and `reviewer` = deepseek-v4-flash. This is the acceptance test for sub-project 1.

## 7. Kustom bootstrap (Claude does this, not workers)

Once foreman passes its end-to-end proof:

1. Supabase project already exists: `kustom-design`, ref `ubohdxsdbdwzzkcfkyum`, region eu-west-1, created by the user on 2026-09-05. Its MCP server is registered in `.mcp.json` (HTTP, needs a one-time `/mcp` authentication). Bootstrap runs `supabase init` and `supabase link --project-ref ubohdxsdbdwzzkcfkyum`, and keeps schema as migrations under `supabase/`. The Supabase CLI and every Bun process must run with `NODE_EXTRA_CA_CERTS=~/.config/certs/keychain-ca.pem` because Cloudflare Gateway re-signs TLS on this Mac; foreman's `.mcp.json` entry sets that env, and the same applies to foreman's own OpenRouter calls.
2. Done 2026-09-05: TanStack Start React app scaffolded at `apps/web` (bun, Biome, TanStack Query, shadcn, t3env) in SPA mode (`tanstackStart({ spa: { enabled: true } })`), `@supabase/supabase-js` client in `src/lib/supabase.ts` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` validated in `src/env.ts`. Hosting: Firebase Hosting serves the static SPA only (project `kustom-design-69420`, web app `kustom-web`, site https://kustom-design-69420.web.app, `firebase.json` rewrites everything to `/_shell.html`); the project is on the Spark plan so App Hosting/SSR is not available. Supabase is the only backend: database, auth, storage, edge functions. Deploy: `bun run build` in `apps/web`, then `firebase deploy --only hosting` at the root.
3. Acceptance command for Kustom tasks: `bun run check && bun run build` in `apps/web` until a test runner is added (vitest, then Playwright with the first UI slice).
4. Then the Kustom product brainstorm: which slice ships first (catalogue, custom design upload, checkout, admin). Input already in the repo: `Mousepad E-commerce Platform Design/` holds a Claude Design canvas (`Kustom Platform.dc.html`) with storefront, product, artwork upload, cart/checkout and admin dashboard screens, plus the "Modernist" design system (Archivo, single red accent, zero radius, tokens in `styles.css`, an oxlint adherence config). Workers should build against those tokens.

## 8. Out of scope for this spec

Orca supervision, a second worker CLI (Codex, Gemini), remote workers, a web dashboard, Kustom feature design.

## 9. Open items to verify during implementation

1. Whether `opencode acp` exposes custom primary agents as the `mode` config option. If yes, roles can also map to OpenCode agents for prompts and permissions; if no, the design above already works without it.
2. The exact SDK method helper name for `session/set_config_option` in `@agentclientprotocol/sdk` 1.4.0.
3. Real multi-file edit success rate of glm-5.3-flash and deepseek-v4-flash through ACP tool calls. If poor, swap defaults to the pro tier and re-check cost.
4. Whether OpenCode forwards per-model `options.provider` (pinning, `require_parameters`) to OpenRouter on the wire.
5. Add-on ids for the TanStack CLI at scaffold time.

## 10. Amendments after approval (2026-09-05, user request)

1. **Portable.** Foreman is its own repository at `~/Development/dev/foreman` (bun, TypeScript, zero runtime deps beyond `@modelcontextprotocol/sdk` and `zod`), exposed as a `foreman` binary via `bun link`. Any project adopts it by adding one `.mcp.json` entry (`foreman mcp`) and an optional `.foreman.json` at its root: `{ "acceptCommand", "baseBranch", "worktreeDir", "roles": { overrides } }`. Project root is `FOREMAN_PROJECT_ROOT` if set, else the git top level of the server's cwd. Kustom is the first consumer, not the home.
2. **Roles over ACP.** Verified: `opencode acp` exposes only `build` and `plan` modes, so OpenCode agents are not usable per role. Roles are foreman-side: model pinned with `session/set_config_option` (read back and verified), role prompt prepended to the task, and permissions enforced by answering `session/request_permission`. OpenCode is launched with `OPENCODE_CONFIG_CONTENT` setting `edit`, `bash`, `external_directory` to `ask` and `webfetch`, `websearch`, `task`, `question`, `doom_loop` to `deny`. Verified live: with `bash: ask`, the request reaches the client with `kind: "execute"`. `disabled_providers` is no longer needed because the model is set explicitly and verified.
3. **GPT-5.6 Sol via the user's OpenAI subscription.** `openai/gpt-5.6-sol` is available in OpenCode's ACP model list (OpenAI OAuth already stored) and completed a tool-calling turn at zero marginal cost. Roles gain a `billing` field: `openrouter` (metered) or `subscription` (counted, not priced). Roster becomes: `coder` glm-5.3-flash, `coder-sol` gpt-5.6-sol, `coder-pro` deepseek-v4-pro-0813, `coder-max` glm-5.3, `reviewer` deepseek-v4-flash-0731, `reviewer-sol` gpt-5.6-sol, `planner` qwen3.7-flash. Escalation ladder: coder, then coder-sol (free), then coder-pro, then coder-max, then Claude. The subscription has its own rate limits, so Sol is a tier, not the default.
4. **Cron continuation.** A session cron job re-issues "continue the foreman plan" on a schedule so the build resumes after a usage-limit pause. Progress state is the checkbox list in the plan file, so any resumption is idempotent.
5. **Git from here on.** Kustom and foreman are committed as work lands.
