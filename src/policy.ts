import { isAbsolute, resolve } from "node:path";
import type { Policy } from "./roles";

export interface ToolCallInfo { kind: string; title: string; rawInput: unknown }
export interface PolicyContext { worktree: string; acceptCommand: string | null }
export interface Decision { allow: boolean; reason: string }

const FORBIDDEN_COMMANDS = [/\bgit\s+commit\b/, /\bgit\s+push\b/, /\bgit\s+worktree\b/, /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$)/, /\bsudo\b/];
const READ_ONLY_SEGMENT = [
  /^cd(\s|$)/, /^(cat|ls|head|tail|wc|grep|rg|find|echo|pwd|tree|stat|file|diff|sort|uniq|cut|awk|sed\s+-n)(\s|$)/,
  /^git\s+(diff|log|status|show|ls-files|blame|rev-parse|branch\s+--list)(\s|$)/,
  /^supabase\s+(status|test\s+db|db\s+(lint|diff)|migration\s+list|gen\s+types)(\s|$)/,
  /^(bun|npm|pnpm|yarn)\s+(install|ci|run|test|x)(\s|$)/,
  /^(bunx|npx)\s+/, /^(tsc|biome|eslint|prettier|vitest|jest|dotnet\s+(build|test)|cargo\s+(check|test|build)|go\s+(vet|test|build)|pytest|make)(\s|$)/,
];
const SYSTEM_PATH_PREFIXES = ["/tmp/", "/private/tmp/", "/dev/", "/usr/", "/bin/", "/opt/", "/etc/"];
const ROOT_PREFIXES = ["/Users/", "/home/", "/root/", "/private/", "/tmp/", "/var/", "/etc/", "/opt/", "/usr/", "/bin/", "/dev/", "/Library/", "/Applications/", "/Volumes/", "/mnt/", "/srv/", "/workspace/"];

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
    .filter((p) => ROOT_PREFIXES.some((prefix) => p.startsWith(prefix)))
    .filter((p) => !SYSTEM_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)))
    .some((p) => !insideWorktree(p, worktree));
}

function isReadOnlyCommand(command: string): boolean {
  const cleaned = command.replace(/2>\/dev\/null|2>&1/g, "");
  if (/[>]|\btee\b|\bsed\s+-i\b|\brm\s|\bmv\s|\bcp\s|\bchmod\s|\btouch\s|\bmkdir\s/.test(cleaned)) return false;
  return cleaned
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
    .every((segment) => READ_ONLY_SEGMENT.some((re) => re.test(segment)));
}

export function decide(policy: Policy, call: ToolCallInfo, ctx: PolicyContext): Decision {
  const command = commandOf(call.rawInput, call.title);
  const paths = pathsOf(call.rawInput);
  if (call.kind === "fetch") return { allow: false, reason: "network access is not allowed for workers" };
  if (call.kind === "execute" && /\b(curl|wget)\b|https?:\/\//.test(command)) return { allow: false, reason: "network access is not allowed for workers; use installed packages and the spec instead of fetching" };
  if (policy === "read") {
    if (call.kind === "read" || call.kind === "search" || call.kind === "think") return { allow: true, reason: "read-only kind" };
    if (call.kind === "execute") {
      if (commandEscapes(command, ctx.worktree)) return { allow: false, reason: "command references a path outside the task worktree" };
      if (ctx.acceptCommand && command.trim() === ctx.acceptCommand.trim()) return { allow: true, reason: "acceptance command" };
      if (isReadOnlyCommand(command)) return { allow: true, reason: "read-only command" };
      return { allow: false, reason: `read policy allows only inspection commands (cat, ls, grep, git diff/log/status, lint, test); got: ${command}` };
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
