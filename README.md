# foreman

An MCP server that lets Claude Code dispatch bounded coding tasks to cheap worker models (OpenRouter open-weight models, or GPT-5.6 Sol on an OpenAI subscription) running as OpenCode sessions over the Agent Client Protocol. Each task gets a git worktree, a role-pinned model, a permission policy, an acceptance gate, a reviewer of a different lineage, and a cost record.

## Install (once per machine)

    bun install
    chmod +x src/cli.ts && ln -sf "$PWD/src/cli.ts" ~/.local/bin/foreman

The project `.mcp.json` entry written by the installer uses `bun run <this repo>/src/cli.ts mcp`, so the symlink is only a convenience for `foreman doctor`.

## Add to a project

    scripts/install-into-project.sh /path/to/project "bun run check && bun run build"

Then restart Claude Code in that project and confirm `/mcp` lists `foreman`. Run `foreman doctor` inside the project to verify roles and credit.

## Configuration: `.foreman.json` in the project root

    { "acceptCommand": "bun test", "baseBranch": "main", "perTaskCapUsd": 0.5, "creditFloorUsd": 5,
      "roles": { "coder": { "model": "openrouter/z-ai/glm-5.3-flash" } } }

Roles: coder, coder-sol, coder-pro, coder-max (write policy); reviewer, reviewer-sol, planner (read policy). Defaults live in `src/roles.ts`. Role prompts resolve from the project root first, then this repo's `prompts/`.

## How a task runs

1. `worker_dispatch` creates `.worktrees/<taskId>` on branch `task/<taskId>`, opens an OpenCode ACP session there, pins the role's model and sends the role prompt plus your spec.
2. Permission requests from the worker are answered by the role policy: writers may edit and run commands inside the worktree but never commit or push; reviewers may only read.
3. `worker_gate` runs the acceptance command. `worker_review` asks a read-only model for JSON findings. `worker_finish` merges with `--no-ff` or discards.
4. Everything lands in `.foreman/<taskId>/` (spec, results, gate log, review, event stream). Cost is estimated from token usage and OpenRouter prices; dispatch refuses below the credit floor and turns stop at the per-task cap.

## Requirements

opencode ≥ 1.18 with OpenRouter (and optionally OpenAI) logged in via `opencode auth login`. On machines with TLS interception, set `NODE_EXTRA_CA_CERTS` for Bun; the installer does this when `~/.config/certs/keychain-ca.pem` exists.

## Development

    bun test && bun run typecheck
