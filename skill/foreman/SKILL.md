---
name: foreman
description: Delegate bounded coding tasks to cheap worker models via the foreman MCP tools (worker_dispatch, worker_wait, worker_gate, worker_review, worker_finish). Use when implementing features or fixes that can be specified in a page and verified by the acceptance command.
---

# Foreman: orchestrating cheap workers

You are the orchestrator. Workers type, you decide. Follow this loop for every task.

1. **Write a bounded spec** (markdown, under a page): goal, likely files, acceptance command, out of scope, any conventions. One vertical slice or smaller. Never include secrets.
2. `worker_dispatch(taskId, role: "coder", spec)`. Task ids are kebab-case and unique (e.g. `catalogue-list-01`).
3. `worker_wait(taskId)`. Read the summary and `filesChanged`. If `status` is `running`, wait again. If `budget_exceeded` or `error`, go to step 6.
4. `worker_gate(taskId)`. If it fails, `worker_followup(taskId, <failure tail and what to fix>)`, then gate again. Maximum two follow-ups.
5. `worker_review(taskId)`. If `blocking` is non-empty, one `worker_followup` with the findings, then gate and review once more.
6. **Escalate** when the caps are hit: `worker_finish(taskId, "discard")`, then re-dispatch the same spec with the next role: `coder` → `coder-sol` → `coder-pro` → `coder-max` → do it yourself. Never loop beyond these caps.
7. `worker_finish(taskId, "merge", commitMessage)` on a passed gate with no blocking findings. Otherwise `discard` and say why.
8. Report the task's `costUsd` from the finish result.

Rules: read only the summaries and the files they name, never the raw event log. Run tasks in parallel only when their specs touch disjoint files. Check `foreman_budget` before a batch. Use `reviewer-sol` as a second opinion when the first review and the worker disagree. Roles with `subscription` billing (the `-sol` ones) cost nothing per token but share the OpenAI subscription's rate limit.
