import { isAbsolute, resolve } from "node:path";
import type { Policy } from "./roles";

export interface ToolCallInfo { kind: string; title: string; rawInput: unknown }
export interface PolicyContext { worktree: string; acceptCommand: string | null }
export interface Decision { allow: boolean; reason: string }

const FORBIDDEN_COMMANDS = [/\bgit\s+commit\b/, /\bgit\s+push\b/, /\bgit\s+worktree\b/, /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$)/, /\bsudo\b/];
const READ_ONLY_COMMANDS = [/^\s*git\s+(diff|log|status|show)\b/];
const SYSTEM_PATH_PREFIXES = ["/tmp/", "/private/tmp/", "/dev/", "/usr/", "/bin/", "/opt/", "/etc/"];

function commandOf(input: unknown, title: string): string {
  if (input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string") {
    return (input as { command: string }).command;
  }
  return title;
}

function pathsOf(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([k, v]) => typeof v === "string" && /path|file/i.test(k))
    .map(([, v]) => v as string);
}

function insideWorktree(path: string, worktree: string): boolean {
  const abs = isAbsolute(path) ? resolve(path) : resolve(worktree, path);
  return abs === worktree || abs.startsWith(`${worktree}/`);
}

function commandEscapes(command: string, worktree: string): boolean {
  if (/(^|[\s"'=:])\.\.\//.test(command)) return true;
  const absolutes = command.match(/(^|[\s"'=>:])(\/[^\s"'|;&>]+)/g) ?? [];
  return absolutes
    .map((m) => m.replace(/^[\s"'=>:]+/, ""))
    .filter((p) => !SYSTEM_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)) && p !== "/")
    .some((p) => !insideWorktree(p, worktree));
}

export function decide(policy: Policy, call: ToolCallInfo, ctx: PolicyContext): Decision {
  const command = commandOf(call.rawInput, call.title);
  const paths = pathsOf(call.rawInput);
  if (call.kind === "fetch") return { allow: false, reason: "network access is not allowed for workers" };
  if (policy === "read") {
    if (call.kind === "read" || call.kind === "search" || call.kind === "think") return { allow: true, reason: "read-only kind" };
    if (call.kind === "execute") {
      if (READ_ONLY_COMMANDS.some((re) => re.test(command))) return { allow: true, reason: "read-only git command" };
      if (ctx.acceptCommand && command.trim() === ctx.acceptCommand.trim()) return { allow: true, reason: "acceptance command" };
      return { allow: false, reason: `read policy forbids command: ${command}` };
    }
    return { allow: false, reason: `read policy forbids ${call.kind}` };
  }
  if (call.kind === "execute") {
    if (FORBIDDEN_COMMANDS.some((re) => re.test(command))) return { allow: false, reason: `forbidden command: ${command}` };
    if (commandEscapes(command, ctx.worktree)) return { allow: false, reason: "command references a path outside the task worktree" };
    return { allow: true, reason: "write policy" };
  }
  if (paths.some((p) => !insideWorktree(p, ctx.worktree))) return { allow: false, reason: "path outside the task worktree" };
  return { allow: true, reason: "write policy" };
}
