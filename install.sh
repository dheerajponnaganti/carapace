#!/usr/bin/env bash
# Sets up carapace with one command:
#   1. lists this folder in CLAUDE_CODE_PLUGIN_DIRS, so every mod loads in every session and hot reloads on save
#   2. switches Claude Code's theme to Deep Sea (the previous theme is kept for --uninstall)
#   3. lets the Crew run 20 helpers at once (only where you have not set your own limits)
#   4. sets a status line that saves the prompt cache clock for the footer (only where you have no status line)
#   5. on macOS, when run from the Terminal app, makes Deep Sea its profile, in open windows and new ones (asks first when you can answer)
# Everything else in ~/.claude/settings.json is kept. Backups: settings.json.bak (latest) and settings.json.carapace-orig (before the first install).
#
#   ./install.sh                 set everything up
#   ./install.sh --terminal      also set up the Terminal app when installing from another terminal
#   ./install.sh --no-terminal   leave the Terminal app alone
#   ./install.sh --with rea,gstack   also add REA (reverse-engineering tools) and/or gstack (skills); "all" adds both. --with-rea still works
#   ./install.sh --no-ponytail   skip ponytail, the token-saving Claude Code plugin that is installed by default
#   ./install.sh --with hookify,security-guidance   also add the official hookify and security-guidance plugins (not in "all")
#   ./install.sh --with writing-rules   also write carapace's writing rules (hookify rules) into ./.claude; --folder <dir> picks another folder
#   ./install.sh --remove <rea|gstack|ponytail|hookify|security-guidance|writing-rules>   remove one add-on that carapace added
#   ./install.sh --manage <rea|gstack|ponytail|hookify|security-guidance>   let carapace own an add-on that was yours (uninstall then removes it)
#   ./install.sh --force         install even when Claude Code is older than the minimum version
#   ./install.sh --uninstall     undo all of it, keep everything else (add-ons are removed only if carapace added them)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CONFIG/settings.json"
STATE="$CONFIG/carapace-install.json"
MIN_VERSION="2.1.299"

MODE=install
TERMINAL=auto
WITH=","
PONYTAIL=yes
ONE=""
FORCE=no
FOLDER=""
usage() { echo "Unknown option: $1 (use --uninstall, --terminal, --no-terminal, --with <rea,gstack|all>, --no-ponytail, --force, --folder <dir>, --remove <add-on> or --manage <add-on>)" >&2; exit 2; }
valid() { case "$1" in rea|gstack|ponytail|hookify|security-guidance|writing-rules) ;; *) echo "Unknown add-on: $1 (rea, gstack, ponytail, hookify, security-guidance or writing-rules)" >&2; exit 2 ;; esac; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --terminal) TERMINAL=yes ;;
    --no-terminal) TERMINAL=no ;;
    --no-ponytail) PONYTAIL=no ;;
    --force) FORCE=yes ;;
    --folder)
      [[ $# -ge 2 ]] || usage "$1"
      FOLDER="$2"; shift ;;
    --with-rea) WITH="${WITH}rea," ;;
    --with)
      [[ $# -ge 2 ]] || usage "$1"
      list="${2//all/rea,gstack}"
      for id in ${list//,/ }; do valid "$id"; WITH="${WITH}${id},"; done
      shift ;;
    --remove|--manage)
      [[ $# -ge 2 ]] || usage "$1"
      valid "$2"; MODE="${1#--}"; ONE="$2"
      shift ;;
    *) usage "$1" ;;
  esac
  shift
done
wants() { [[ $WITH == *",$1,"* ]]; }

# Whether REA was on the PATH before carapace touched anything.
REA_BEFORE=no
command -v rea >/dev/null && REA_BEFORE=yes

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# ---- Add-ons: REA, gstack, ponytail. The state file's key for each is "installed" (carapace added it) or "preexisting" (it was here first).
# Every external step reports its result, and a failed add-on never stops the rest.
state_get() { if [[ -f $STATE ]]; then python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get(sys.argv[2]) or "")' "$STATE" "$1" 2>/dev/null || true; fi; }
rea_state() { state_get rea; }
# state_edit set <key> <value> | state_edit del <key>: an atomic write that keeps every other key.
state_edit() {
  python3 - "$STATE" "$@" <<'PY'
import json, os, sys
path, op, key = sys.argv[1:4]
state = json.load(open(path, encoding="utf-8-sig")) if os.path.exists(path) else {}
if op == "set":
    state[key] = sys.argv[4]
else:
    state.pop(key, None)
real = os.path.realpath(path)
os.makedirs(os.path.dirname(real), exist_ok=True)
tmp = f"{real}.{os.getpid()}.tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
os.replace(tmp, real)
PY
}
remember_rea() { state_edit set rea "$1"; }

# The gstack section of the global CLAUDE.md, between marker comments. Added only when the file has no "# gstack" section;
# removal deletes only the marked block. Atomic write, backup in CLAUDE.md.bak.
claude_md() {
  python3 - "$CONFIG/CLAUDE.md" "$1" <<'PY'
import os, re, shutil, stat, sys
path, op = sys.argv[1:3]
OPEN, CLOSE = "<!-- carapace:gstack -->", "<!-- /carapace:gstack -->"
BLOCK = f"""{OPEN}
# gstack

Use the /browse skill from gstack for all web browsing. Never use the mcp__claude-in-chrome__* tools.
{CLOSE}
"""
real = os.path.realpath(path)
text = open(real, encoding="utf-8").read() if os.path.exists(real) else ""
marked = re.compile(r"\n?" + re.escape(OPEN) + r".*?" + re.escape(CLOSE) + r"\n?", re.S)
if op == "add":
    if OPEN in text:
        sys.exit(print("gstack: the CLAUDE.md section is already there.") or 0)
    if re.search(r"^#+\s*gstack\b", text, re.M | re.I):
        sys.exit(print("gstack: CLAUDE.md already has a gstack section, so it was left alone.") or 0)
    new = text + ("" if not text or text.endswith("\n\n") else "\n" if text.endswith("\n") else "\n\n") + BLOCK
    done = "gstack: added its section to CLAUDE.md."
else:
    if OPEN not in text:
        sys.exit(0)
    new = marked.sub("", text, count=1)
    done = "gstack: removed its section from CLAUDE.md."
mode = stat.S_IMODE(os.stat(real).st_mode) if os.path.exists(real) else 0o644
os.makedirs(os.path.dirname(real), exist_ok=True)
if os.path.exists(real):
    shutil.copy(real, real + ".bak")
tmp = f"{real}.{os.getpid()}.tmp"
try:
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(new)
    os.chmod(tmp, mode)
    os.replace(tmp, real)
finally:
    if os.path.exists(tmp):
        os.remove(tmp)
print(done)
PY
}

GSTACK_DIR="$CONFIG/skills/gstack"
ponytail_listed() { claude plugin list --json 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if any(str(p.get("id","")).split("@")[0]=="ponytail" for p in json.load(sys.stdin)) else 1)' 2>/dev/null; }
is_present() {
  case "$1" in
    rea) command -v rea >/dev/null ;;
    gstack) [[ -d $GSTACK_DIR ]] ;;
    ponytail) command -v claude >/dev/null && ponytail_listed ;;
    writing-rules) return 1 ;;
    hookify|security-guidance) command -v claude >/dev/null && plugin_listed "$1" ;;
  esac
}

install_rea() {
  if [[ $(rea_state) == installed ]]; then
    echo "REA: already added by carapace."
  elif [[ $REA_BEFORE == yes ]]; then
    remember_rea preexisting
    echo "REA was here before carapace, so carapace leaves it alone."
  elif ! command -v npm >/dev/null; then
    echo "REA: skipped, it needs npm (install Node.js, then run ./install.sh --with rea)."
  elif npm install --global rea-agents && rea setup --client claude_code --yes --json >/dev/null; then
    remember_rea installed
    echo "REA: added for Claude Code. Restart Claude Code to use it."
  else
    if command -v rea >/dev/null; then remember_rea installed; fi
    echo "REA: the install did not finish. Run ./install.sh --with rea again, or npm install --global rea-agents." >&2
  fi
}
remove_rea() {
  case "$(rea_state)" in
    installed)
      if rea uninstall --purge-data >/dev/null; then echo "REA: removed from Claude Code."; else echo "REA: its own uninstall failed. Run rea uninstall yourself." >&2; fi
      if npm uninstall --global rea-agents >/dev/null; then echo "REA: package removed."; else echo "REA: npm could not remove the package. Run npm uninstall --global rea-agents." >&2; fi
      state_edit del rea ;;
    preexisting) echo "REA was here before carapace, so carapace leaves it alone." ;;
  esac
}

install_gstack() {
  if [[ $(state_get gstack) == installed ]]; then
    echo "gstack: already added by carapace."
  elif [[ -d $GSTACK_DIR ]]; then
    state_edit set gstack preexisting
    echo "gstack was here before carapace, so carapace leaves it alone."
  elif ! command -v git >/dev/null; then
    echo "gstack: skipped, it needs git."
  elif ! command -v bun >/dev/null; then
    echo "gstack: skipped, it needs Bun (https://bun.sh). Install it, then run ./install.sh --with gstack."
  else
    mkdir -p "$(dirname "$GSTACK_DIR")"
    if git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git "$GSTACK_DIR" && (cd "$GSTACK_DIR" && ./setup); then
      state_edit set gstack installed
      echo "gstack: added. Restart Claude Code to use it."
      claude_md add || echo "gstack: could not update CLAUDE.md. Add the section yourself if you want it." >&2
    else
      if [[ -d $GSTACK_DIR ]]; then state_edit set gstack installed; fi
      echo "gstack: the install did not finish. Run ./install.sh --remove gstack, then ./install.sh --with gstack again." >&2
    fi
  fi
}
remove_gstack() {
  case "$(state_get gstack)" in
    installed)
      if [[ -x $GSTACK_DIR/bin/gstack-uninstall ]] && "$GSTACK_DIR/bin/gstack-uninstall" --force >/dev/null; then
        echo "gstack: removed."
        state_edit del gstack
      else
        echo "gstack: its own uninstall failed. Run $GSTACK_DIR/bin/gstack-uninstall yourself." >&2
      fi
      claude_md remove || echo "gstack: could not update CLAUDE.md." >&2 ;;
    preexisting) echo "gstack was here before carapace, so carapace leaves it alone." ;;
  esac
}

install_ponytail() {
  local added=no
  if [[ $(state_get ponytail) == installed ]]; then
    echo "ponytail: already added by carapace."
  elif ! command -v claude >/dev/null; then
    echo "ponytail: skipped, Claude Code is not on your PATH. Run ./install.sh --with ponytail once it is."
  elif ponytail_listed; then
    state_edit set ponytail preexisting
    echo "ponytail was here before carapace, so carapace leaves it alone."
  else
    echo "ponytail: a third-party plugin that makes Claude write less code. --no-ponytail skips it."
    if ! claude plugin marketplace list --json 2>/dev/null | grep -q '"name": *"ponytail"'; then
      if claude plugin marketplace add DietrichGebert/ponytail --scope user >/dev/null; then
        added=yes
      else
        echo "ponytail: could not add its marketplace. Run claude plugin marketplace add DietrichGebert/ponytail yourself." >&2
        return 0
      fi
    fi
    if claude plugin install ponytail@ponytail --scope user >/dev/null; then
      state_edit set ponytail installed
      if [[ $added == yes ]]; then state_edit set ponytailMarketplace yes; fi
      echo "ponytail: added. Restart Claude Code to use it."
    else
      echo "ponytail: the install did not finish. Run claude plugin install ponytail@ponytail yourself." >&2
    fi
  fi
}
remove_ponytail() {
  case "$(state_get ponytail)" in
    installed)
      if claude plugin uninstall ponytail@ponytail --scope user >/dev/null; then
        echo "ponytail: removed."
        state_edit del ponytail
        if [[ $(state_get ponytailMarketplace) == yes ]]; then
          if claude plugin marketplace remove ponytail >/dev/null; then state_edit del ponytailMarketplace; else echo "ponytail: could not remove its marketplace. Run claude plugin marketplace remove ponytail." >&2; fi
        fi
      else
        echo "ponytail: its uninstall failed. Run claude plugin uninstall ponytail@ponytail yourself." >&2
      fi ;;
    preexisting) echo "ponytail was here before carapace, so carapace leaves it alone." ;;
  esac
}

# ---- hookify and security-guidance: plugins of the official marketplace. Nothing here runs unless asked for (--with).
# The marketplace is added only when it is missing (state key officialMarketplace) and removed only when carapace added it
# and no other official add-on of carapace's still needs it.
OFFICIAL_MP="claude-plugins-official"
plugin_listed() { claude plugin list --json 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if any(str(p.get("id","")).split("@")[0]==sys.argv[1] for p in json.load(sys.stdin)) else 1)' "$1" 2>/dev/null; }

# hookify reads its rules only from .claude/hookify.*.local.md in the folder Claude Code runs in, so the writing rules go into
# .claude of the folder given with --folder, or else the folder this installer runs in. The folder is recorded for removal.
# They are their own add-on (writing-rules): they need hookify to take effect, but installing hookify does not write them.
RULE_FILES="hookify.carapace-no-dashes.local.md hookify.carapace-filler-words.local.md"
install_writing-rules() {
  local dir="${FOLDER:-$PWD}/.claude"
  if [[ $(state_get writing-rules) == installed ]]; then echo "writing-rules: already added by carapace in $(state_get writingRulesDir)."; return 0; fi
  mkdir -p "$dir"
  dir="$(cd "$dir" && pwd)"
  cat > "$dir/hookify.carapace-no-dashes.local.md" <<'RULE'
---
name: carapace-no-dashes
enabled: true
event: file
pattern: [\u2014\u2013]
action: warn
---

Writing rule: no em dashes and no en dashes. Use a comma, a colon, a period or parentheses. Rewrite the sentence instead of swapping the mark.
RULE
  cat > "$dir/hookify.carapace-filler-words.local.md" <<'RULE'
---
name: carapace-filler-words
enabled: true
event: file
pattern: \b(basically|essentially|simply|just|actually|obviously|clearly|of course|in order to|needless to say|at the end of the day|note that|worth noting|important to note)\b
action: warn
---

Writing rule: no filler words. Delete the filler, or say it directly ("in order to" becomes "to").
RULE
  state_edit set writingRulesDir "$dir"
  state_edit set writing-rules installed
  echo "writing-rules: added carapace's writing rules to $dir. They apply when you run Claude Code in that folder with hookify (--with hookify)."
}
# Also clears the folder key older installs used (hookifyRulesDir).
remove_writing-rules() {
  local dir f key
  for key in writingRulesDir hookifyRulesDir; do
    dir="$(state_get $key)"
    [[ -n $dir ]] || continue
    for f in $RULE_FILES; do rm -f "$dir/$f"; done
    state_edit del $key
    echo "writing-rules: removed carapace's writing rules from $dir."
  done
  state_edit del writing-rules
}

install_official() {
  local id="$1" added=no
  if [[ $(state_get "$id") == installed ]]; then
    echo "$id: already added by carapace."
  elif ! command -v claude >/dev/null; then
    echo "$id: skipped, Claude Code is not on your PATH. Run ./install.sh --with $id once it is."
  elif plugin_listed "$id"; then
    state_edit set "$id" preexisting
    echo "$id was here before carapace, so carapace leaves it alone."
  else
    if ! claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": *\"$OFFICIAL_MP\""; then
      if claude plugin marketplace add anthropics/claude-plugins-official --scope user >/dev/null; then
        added=yes
      else
        echo "$id: could not add the $OFFICIAL_MP marketplace. Run claude plugin marketplace add anthropics/claude-plugins-official yourself." >&2
        return 0
      fi
    fi
    if claude plugin install "$id@$OFFICIAL_MP" --scope user >/dev/null; then
      state_edit set "$id" installed
      if [[ $added == yes ]]; then state_edit set officialMarketplace yes; fi
      echo "$id: added. Restart Claude Code to use it."
    else
      echo "$id: the install did not finish. Run claude plugin install $id@$OFFICIAL_MP yourself." >&2
    fi
  fi
}
remove_official() {
  local id="$1" other
  case "$(state_get "$id")" in
    installed)
      if claude plugin uninstall "$id@$OFFICIAL_MP" --scope user >/dev/null; then
        echo "$id: removed."
        state_edit del "$id"
        other=security-guidance; if [[ $id == security-guidance ]]; then other=hookify; fi
        if [[ $(state_get officialMarketplace) == yes && $(state_get "$other") != installed ]]; then
          if claude plugin marketplace remove "$OFFICIAL_MP" >/dev/null; then state_edit del officialMarketplace; else echo "$id: could not remove the $OFFICIAL_MP marketplace. Run claude plugin marketplace remove $OFFICIAL_MP." >&2; fi
        fi
      else
        echo "$id: its uninstall failed. Run claude plugin uninstall $id@$OFFICIAL_MP yourself." >&2
      fi ;;
    preexisting) echo "$id was here before carapace, so carapace leaves it alone." ;;
  esac
}
remove_hookify() { remove_official hookify; }
install_hookify() { install_official hookify; }
remove_security-guidance() { remove_official security-guidance; }
install_security-guidance() { install_official security-guidance; }

# --remove <add-on> and --manage <add-on>: one add-on only, then done (this is what the Shipyard's buttons run).
if [[ $MODE == remove ]]; then
  [[ -n $(state_get "$ONE") ]] || echo "$ONE: carapace did not add it, so there is nothing to remove."
  "remove_$ONE"
  exit 0
elif [[ $MODE == manage ]]; then
  if [[ $(state_get "$ONE") == installed ]]; then
    echo "$ONE: carapace already manages it."
  elif is_present "$ONE"; then
    state_edit set "$ONE" installed
    echo "$ONE: carapace now manages it. Uninstalling carapace removes it too."
  else
    echo "$ONE: not found, nothing to manage." >&2
  fi
  exit 0
fi

# Claude Code older than the minimum lacks events the mods use: stop, unless --force.
if [[ $MODE == install ]] && command -v claude >/dev/null; then
  have="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [[ -n $have ]] && [[ "$(printf '%s\n%s\n' "$MIN_VERSION" "$have" | sort -V | head -1)" != "$MIN_VERSION" ]]; then
    if [[ $FORCE == yes ]]; then
      echo "Claude Code $have is older than $MIN_VERSION. Continuing because of --force; some mods may not work."
    else
      echo "Claude Code $have is older than $MIN_VERSION, so carapace was not installed. Update it (claude update), or run ./install.sh --force to install anyway." >&2
      exit 1
    fi
  fi
elif [[ $MODE == install ]]; then
  echo "Note: Claude Code is not on your PATH. Install it, then start a session."
fi

python3 - "$REPO" "$SETTINGS" "$STATE" "$MODE" <<'PY'
import json, os, shutil, stat, sys

repo, settings, state_path, mode = sys.argv[1:5]
THEME = "custom:carapace:deep-sea"
STATUS_COMMAND = f'python3 "{os.path.join(repo, "scripts", "statusline.py")}"'
LIMITS = {"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "20", "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY": "20"}

def write_atomic(path, obj):
    # Follow a symlink (dotfile repos) and write through to the real file, keeping its mode.
    real = os.path.realpath(path)
    os.makedirs(os.path.dirname(real), exist_ok=True)
    mode_bits = stat.S_IMODE(os.stat(real).st_mode) if os.path.exists(real) else 0o644
    tmp = f"{real}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(obj, f, indent=2)
            f.write("\n")
        os.chmod(tmp, mode_bits)
        os.replace(tmp, real)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

def load(path):
    with open(path, encoding="utf-8-sig") as f:  # utf-8-sig drops a BOM
        return json.load(f)

data = {}
if os.path.exists(settings):
    try:
        data = load(settings)
    except ValueError as e:
        sys.exit(f"{settings} is not valid JSON ({e}). Nothing was changed.")
    if not isinstance(data, dict):
        sys.exit(f"{settings} is not a JSON object. Nothing was changed.")
    shutil.copy(settings, settings + ".bak")
    if not os.path.exists(settings + ".carapace-orig"):
        shutil.copy(settings, settings + ".carapace-orig")  # the copy from before the first install, never overwritten
state = {}
if os.path.exists(state_path):
    state = load(state_path)
    if not isinstance(state, dict):
        state = {}

env = data.setdefault("env", {})
current = [p for p in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(os.pathsep) if p]
# Drop this repo and anything inside it (older installs listed each mod), then add the repo once.
kept = [p for p in current if p != repo and not p.startswith(repo + os.sep)]
dirs = kept if mode == "uninstall" else kept + [repo]
if dirs:
    env["CLAUDE_CODE_PLUGIN_DIRS"] = os.pathsep.join(dirs)
else:
    env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)

if mode == "install":
    added = set(state.get("limits", []))
    for key, value in LIMITS.items():
        if key not in env:
            env[key] = value
            added.add(key)
    state["limits"] = sorted(added)
    # The status line command feeds the footer's cache countdown. Set only where the person has no status line of their own.
    if "statusLine" not in data:
        data["statusLine"] = {"type": "command", "command": STATUS_COMMAND}
        state["statusLine"] = STATUS_COMMAND
    if data.get("theme") != THEME:
        state.setdefault("themeBefore", data.get("theme"))
        data["theme"] = THEME
else:
    for key in state.get("limits", []):
        if env.get(key) == LIMITS.get(key):
            env.pop(key)
    if state.get("statusLine") and (data.get("statusLine") or {}).get("command") == state["statusLine"]:
        data.pop("statusLine")
    if data.get("theme") == THEME:
        before = state.get("themeBefore")
        if before:
            data["theme"] = before
        else:
            data.pop("theme")

if not env:
    data.pop("env")

write_atomic(settings, data)

if mode == "install":
    write_atomic(state_path, state)
    mods = sorted(d for d in os.listdir(os.path.join(repo, "mods")) if not d.startswith(".") and d != "shared")
    print(f"carapace registered in {settings}: {', '.join(mods)}")
    def limit(key):
        value = str(env.get(key, LIMITS[key])).strip()
        return int(value) if value.isdigit() and int(value) > 0 else int(LIMITS[key])
    crew = min(limit(key) for key in LIMITS)
    print(f"Theme: Deep Sea. Crew: up to {crew} helpers at once" + ("" if state["limits"] else " (your own limits kept)") + ".")
else:
    print("Removed carapace from", settings, "and put your theme back.")
    if os.path.exists(settings + ".carapace-orig"):
        print("The copy from before the first install is kept as", settings + ".carapace-orig", "(known good).")
PY

# The Terminal app's window background: a profile, because Claude Code themes cannot paint the window.
terminal_set() {
  osascript -e "tell application \"Terminal\" to set default settings to settings set \"$1\"" \
            -e "tell application \"Terminal\" to set startup settings to settings set \"$1\"" >/dev/null
}
# Records the Terminal setup in the state file: the default profile before carapace, and that the profiles went in.
remember_terminal() {
  python3 - "$STATE" "$1" <<'PY'
import json, os, sys
path, before = sys.argv[1:3]
state = json.load(open(path, encoding="utf-8-sig")) if os.path.exists(path) else {}
if before and before != "Deep Sea":
    state.setdefault("terminalBefore", before)
state["terminal"] = True
real = os.path.realpath(path)
tmp = f"{real}.{os.getpid()}.tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
    f.write("\n")
os.replace(tmp, real)
PY
}

# Copies the background images, gives each profile a bookmark to its image (made here, so it resolves on this Mac),
# imports the four profiles, and closes the windows the import opened (the person's own windows stay).
APPSUPPORT="$HOME/Library/Application Support/carapace"
import_terminal_profiles() {
  local tmp known ids image
  tmp="$(mktemp -d)"
  mkdir -p "$APPSUPPORT"
  for image in deep-sea-bg deep-sea-deep-bg deep-sea-crush-bg; do
    cp "$REPO/terminal/$image.png" "$APPSUPPORT/$image.png"
  done
  python3 - "$REPO/terminal" "$tmp" "$APPSUPPORT" <<'PY'
import base64, os, plistlib, subprocess, sys
src, out, appsupport = sys.argv[1:4]
IMAGES = {"Deep Sea": "deep-sea-bg", "Deep Sea · Deep": "deep-sea-deep-bg", "Deep Sea · Crush": "deep-sea-crush-bg"}
for name in ["Deep Sea", "Deep Sea · Deep", "Deep Sea · Crush"]:
    with open(os.path.join(src, name + ".terminal"), "rb") as f:
        profile = plistlib.load(f)
    if name in IMAGES:
        image = os.path.join(appsupport, IMAGES[name] + ".png")
        archived = subprocess.run(["/usr/bin/swift", os.path.join(src, "archive.swift"), "bookmark", image],
                                  capture_output=True, text=True, check=True).stdout.strip()
        # The shipped background color stays fully opaque: Terminal draws the image over it, and a clear color
        # makes the whole window see-through, image included.
        profile["BackgroundImageBookmark"] = base64.b64decode(archived)
    with open(os.path.join(out, name + ".terminal"), "wb") as f:
        plistlib.dump(profile, f, fmt=plistlib.FMT_XML)
PY
  known="$(osascript -e 'tell application "Terminal" to get id of every window' 2>/dev/null || true)"
  open "$tmp/Deep Sea.terminal" "$tmp/Deep Sea · Deep.terminal" "$tmp/Deep Sea · Crush.terminal"
  sleep 2
  cat > "$tmp/close-new.applescript" <<'APPLESCRIPT'
on run argv
  tell application "Terminal"
    repeat with w in (every window as list)
      if argv does not contain ((id of w) as text) then close w
    end repeat
  end tell
end run
APPLESCRIPT
  IFS=', ' read -r -a ids <<< "$known"
  osascript "$tmp/close-new.applescript" ${ids[@]+"${ids[@]}"} >/dev/null 2>&1 || true
  # Importing a profile whose name exists adds "<name> 1" instead of replacing it.
  # Move the default, startup and open tabs to the new one, delete the old one, and give the new one the name.
  cat > "$tmp/merge-dupes.applescript" <<'APPLESCRIPT'
on run argv
  tell application "Terminal"
    repeat with profileName in argv
      set fresh to (profileName as text) & " 1"
      if (exists settings set fresh) and (exists settings set (profileName as text)) then
        set newS to settings set fresh
        if name of default settings is (profileName as text) then set default settings to newS
        if name of startup settings is (profileName as text) then set startup settings to newS
        repeat with w in windows
          repeat with t in tabs of w
            try
              if name of current settings of t is (profileName as text) then set current settings of t to newS
            end try
          end repeat
        end repeat
        delete settings set (profileName as text)
        set name of newS to (profileName as text)
      end if
    end repeat
    -- A tab can keep its copy of a replaced profile, still named "<name> 1": point it at the real one.
    repeat with w in windows
      repeat with t in tabs of w
        try
          set n to name of current settings of t
          if n ends with " 1" then
            set n to text 1 thru -3 of n
            if (argv contains n) and (exists settings set n) then set current settings of t to settings set n
          end if
        end try
      end repeat
    end repeat
  end tell
end run
APPLESCRIPT
  osascript "$tmp/merge-dupes.applescript" "Deep Sea" "Deep Sea · Deep" "Deep Sea · Crush" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}

if [[ "$(uname)" == Darwin ]]; then
  if [[ $MODE == install ]]; then
    # Only the Terminal app's own windows show its profiles: from another terminal, skip unless asked.
    if [[ $TERMINAL == auto ]]; then
      if [[ ${TERM_PROGRAM:-} == Apple_Terminal ]]; then
        TERMINAL=yes
      else
        TERMINAL=no
        echo "Terminal: skipped, this is not the Terminal app. Run ./install.sh --terminal to set it up anyway."
      fi
    fi
    if [[ $TERMINAL == yes ]] && ! before="$(osascript -e 'tell application "Terminal" to get name of default settings' 2>/dev/null)"; then
      TERMINAL=no
      echo "Terminal: macOS did not let the installer control the Terminal app. Allow it in System Settings > Privacy & Security > Automation, then run the installer again (or use --no-terminal)."
    fi
    if [[ $TERMINAL == yes && -t 0 ]]; then
      read -r -p "Make Deep Sea the Terminal profile for every window? [Y/n] " answer || answer=n
      case "$answer" in [nN]*) TERMINAL=no; echo "Terminal: left alone. Run ./install.sh --terminal to set it up later." ;; esac
    fi
    if [[ $TERMINAL == yes ]]; then
      remember_terminal "$before"
      import_terminal_profiles
      terminal_set "Deep Sea" || echo "Terminal: the profiles are in, but Deep Sea could not be made the default. Pick it in Terminal's Settings > Profiles."
      # Open tabs change now too; tabs already on a carapace profile keep theirs.
      osascript -e 'tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            set n to name of current settings of t
            if n does not start with "Deep Sea" then set current settings of t to settings set "Deep Sea"
          end repeat
        end repeat
      end tell' >/dev/null 2>&1 || true
      echo "Terminal: Deep Sea is the profile of every window, open and new. (--no-terminal skips this.)"
    fi
  elif [[ -f $STATE ]]; then
    before="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("terminalBefore") or "")' "$STATE")"
    if [[ -n $before ]] && terminal_set "$before"; then echo "Terminal: back to $before."; fi
    had="$(python3 -c 'import json,sys; print("yes" if json.load(open(sys.argv[1])).get("terminal") or json.load(open(sys.argv[1])).get("terminalBefore") else "")' "$STATE")"
    if [[ -n $had ]]; then echo "Terminal: the carapace profiles (Deep Sea, Deep Sea · Deep, Deep Sea · Crush) and their images stay in place. Delete them in Terminal's Settings > Profiles if you want them gone."; fi
  fi
fi

if [[ $MODE == install ]]; then
  if [[ $PONYTAIL == yes ]] || wants ponytail; then install_ponytail; fi
  if wants gstack; then install_gstack; fi
  if wants rea; then install_rea; fi
  if wants hookify; then install_hookify; fi
  if wants security-guidance; then install_security-guidance; fi
  if wants writing-rules; then install_writing-rules; fi
elif [[ $MODE == uninstall ]]; then
  remove_ponytail
  remove_gstack
  remove_rea
  remove_hookify
  remove_security-guidance
  remove_writing-rules
fi

[[ $MODE == uninstall ]] && rm -f "$STATE"
# Offer only the add-ons that are neither recorded nor already on the machine (installed by hand counts as there).
addon_present() {
  case $1 in
    rea) command -v rea >/dev/null 2>&1 ;;
    gstack) [[ -d $GSTACK_DIR ]] ;;
    writing-rules) return 1 ;;
    *) plugin_listed "$1" ;;
  esac
}
missing=""
for id in rea gstack hookify security-guidance writing-rules; do
  if [[ -z $(state_get "$id") ]] && ! addon_present "$id"; then missing="${missing}${missing:+,}${id}"; fi
done
if [[ $MODE == install && -n $missing ]]; then
  names="${missing/rea/REA}"
  echo "Optional add-ons: ${names//,/, }. Add them from the Shipyard (/mods) or with --with ${missing}."
fi
if [[ $MODE == install ]]; then
  echo "Open a new Claude Code session. Setup asks a few questions the first time."
else
  echo "Start a new Claude Code session (or claude --resume) to apply the change."
fi
