#!/usr/bin/env bash
set -euo pipefail
root="${1:?usage: install-into-project.sh <project-root> [acceptCommand]}"
accept="${2:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
pem="$HOME/.config/certs/keychain-ca.pem"
cd "$root"
python3 - "$accept" "$pem" "$here" <<'PY'
import json, os, sys, pathlib
accept, pem, here = sys.argv[1], sys.argv[2], sys.argv[3]
mcp = pathlib.Path(".mcp.json"); data = json.loads(mcp.read_text()) if mcp.exists() else {}
servers = data.setdefault("mcpServers", {})
entry = {"type": "stdio", "command": "bun", "args": ["run", f"{here}/src/cli.ts", "mcp"]}
if os.path.exists(pem): entry["env"] = {"NODE_EXTRA_CA_CERTS": pem}
servers["foreman"] = entry
mcp.write_text(json.dumps(data, indent=2) + "\n")
cfg = pathlib.Path(".foreman.json")
if not cfg.exists():
    cfg.write_text(json.dumps({"acceptCommand": accept or None, "baseBranch": "main", "perTaskCapUsd": 0.5, "creditFloorUsd": 5}, indent=2) + "\n")
gi = pathlib.Path(".gitignore"); lines = gi.read_text().splitlines() if gi.exists() else []
for l in (".worktrees/", ".foreman/"):
    if l not in lines: lines.append(l)
gi.write_text("\n".join(lines) + "\n")
PY
mkdir -p .claude/skills/foreman
cp -R "$here/skill/foreman/." .claude/skills/foreman/
echo "foreman installed into $root"
