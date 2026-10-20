#!/usr/bin/env python3
# carapace's status line command. Claude Code pipes it a JSON document; this keeps the session id, prompt_cache and
# rate_limits in ~/.claude/carapace/statusline.json (atomic write) for the footer, and prints nothing.
import json, os, sys

try:
    data = json.load(sys.stdin)
    keep = {k: data[k] for k in ("session_id", "prompt_cache", "rate_limits") if k in data}
    folder = os.path.join(os.path.expanduser("~"), ".claude", "carapace")
    os.makedirs(folder, exist_ok=True)
    tmp = os.path.join(folder, f"statusline.json.{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(keep, f)
    os.replace(tmp, os.path.join(folder, "statusline.json"))
except Exception:
    pass
