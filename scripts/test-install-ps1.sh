#!/usr/bin/env bash
# Checks install.ps1 (Windows) in a throwaway home with PowerShell (pwsh, or $PWSH): settings, add-ons, Windows Terminal, uninstall.
# The Terminal app is never touched (--no-terminal). Exits non-zero on the first failed check.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home" CLAUDE_CONFIG_DIR="$WORK/home/.claude"
mkdir -p "$CLAUDE_CONFIG_DIR" "$WORK/dotfiles"
SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
failed=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failed=1; fi; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
theme() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig")).get("theme"))' "$1"; }

# Stubs for claude, git and bun, first on the PATH from the start: nothing here reaches the real ones.
# claude's calls go to $CCALLS, everything else to $CALLS. The plugin "list" is the file $WORK/pt-installed, the marketplace "list" $WORK/pt-mp.
BIN="$WORK/bin"; CALLS="$WORK/calls.txt"; CCALLS="$WORK/ccalls.txt"; STATEF="$CLAUDE_CONFIG_DIR/carapace-install.json"
mkdir -p "$BIN"; : > "$CALLS"; : > "$CCALLS"
cat > "$BIN/claude" <<STUB
#!/bin/sh
echo "claude \$*" >> "$CCALLS"
case "\$1 \$2 \$3" in
  "--version  ") echo "\$(cat "$WORK/ver" 2>/dev/null || echo 2.1.300)" ;;
  "plugin list --json")
    out=""
    for pair in "pt-installed:ponytail@ponytail" "hk-installed:hookify@claude-plugins-official" "sg-installed:security-guidance@claude-plugins-official"; do
      if [ -e "$WORK/\${pair%%:*}" ]; then out="\$out\${out:+,}{\"id\":\"\${pair#*:}\",\"version\":\"5.3.2\"}"; fi
    done
    echo "[\$out]" ;;
  "plugin marketplace list")
    out='{"name": "other"}'
    if [ -e "$WORK/pt-mp" ]; then out="\$out,{\"name\": \"ponytail\"}"; fi
    if [ -e "$WORK/off-mp" ]; then out="\$out,{\"name\": \"claude-plugins-official\"}"; fi
    echo "[\$out]" ;;
  "plugin marketplace add") case "\$4" in anthropics/*) touch "$WORK/off-mp" ;; *) touch "$WORK/pt-mp" ;; esac ;;
  "plugin marketplace remove") case "\$4" in claude-plugins-official) rm -f "$WORK/off-mp" ;; *) rm -f "$WORK/pt-mp" ;; esac ;;
  "plugin install ponytail@ponytail") touch "$WORK/pt-installed" ;;
  "plugin uninstall ponytail@ponytail") rm -f "$WORK/pt-installed" ;;
  "plugin install hookify@claude-plugins-official") touch "$WORK/hk-installed" ;;
  "plugin uninstall hookify@claude-plugins-official") rm -f "$WORK/hk-installed" ;;
  "plugin install security-guidance@claude-plugins-official") touch "$WORK/sg-installed" ;;
  "plugin uninstall security-guidance@claude-plugins-official") rm -f "$WORK/sg-installed" ;;
esac
STUB
cat > "$BIN/git" <<STUB
#!/bin/sh
echo "git \$*" >> "$CALLS"
if [ "\$1" = clone ]; then
  for last; do :; done
  mkdir -p "\$last/bin"
  printf '#!/bin/sh\necho "gstack-setup" >> "$CALLS"\n' > "\$last/setup"
  printf '#!/bin/sh\necho "gstack-uninstall \$*" >> "$CALLS"\n' > "\$last/bin/gstack-uninstall"
  chmod +x "\$last/setup" "\$last/bin/gstack-uninstall"
fi
STUB
chmod +x "$BIN/claude" "$BIN/git"
export PATH="$BIN:$PATH"
PWSH="${PWSH:-pwsh}"
command -v "$PWSH" >/dev/null || { echo "skip: PowerShell not found (set PWSH)"; exit 0; }
# npm and rea stand-ins: REA's install and setup are only logged.
# REA is not on the PATH until npm installs it, as on a machine without it.
cat > "$BIN/npm" <<STUB
#!/bin/sh
echo "npm \$*" >> "$CALLS"
if [ "\$1 \$2 \$3" = "install --global rea-agents" ]; then printf '#!/bin/sh\necho "rea \$*" >> "$CALLS"\n' > "$BIN/rea"; chmod +x "$BIN/rea"; fi
STUB
printf '#!/bin/sh\necho "bun $*" >> "%s"\n' "$CALLS" > "$BIN/bun"
chmod +x "$BIN/npm" "$BIN/bun"
export LOCALAPPDATA="$WORK/localappdata"
ps() { (cd "$WORK" && "$PWSH" -NoLogo -NoProfile -File "$REPO/install.ps1" "$@"); }
json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8-sig")); print(eval(sys.argv[2]))' "$@"; }

# Windows Terminal's settings file, where PowerShell itself places it on this system.
WT="$("$PWSH" -NoLogo -NoProfile -Command 'Join-Path $env:LOCALAPPDATA "Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json"')"
mkdir -p "$(dirname "$WT")"
printf '{\n  "profiles": { "defaults": {}, "list": [ { "name": "PowerShell" } ] },\n  "schemes": []\n}\n' > "$WT"
cp "$WT" "$WORK/wt-original.json"
printf '\xef\xbb\xbf{\n  "theme": "light",\n  "model": "opus"\n}\n' > "$SETTINGS"
cp "$SETTINGS" "$WORK/original.json"

ps > "$WORK/out1.txt" 2>&1
check "install exits 0" '[[ $? -eq 0 ]]'
check "Deep Sea theme set" '[[ $(json "$SETTINGS" "d.get(\"theme\")") == custom:carapace:deep-sea ]]'
check "other keys kept" '[[ $(json "$SETTINGS" "d.get(\"model\")") == opus ]]'
check "carapace listed in CLAUDE_CODE_PLUGIN_DIRS" '[[ $(json "$SETTINGS" "d[\"env\"][\"CLAUDE_CODE_PLUGIN_DIRS\"]") == *"$REPO"* ]]'
check "Crew limits set" '[[ $(json "$SETTINGS" "d[\"env\"][\"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS\"]") == 20 ]]'
check "status line points at statusline.ps1" '[[ $(json "$SETTINGS" "d[\"statusLine\"][\"command\"]") == *statusline.ps1* ]]'
check "state file written" '[[ -f $STATEF ]]'
check "ponytail added by default" 'grep -q "plugin install ponytail@ponytail" "$CCALLS"'
check "Windows Terminal got the Deep Sea scheme" 'grep -q "Deep Sea" "$WT"'
check "Windows Terminal backup kept" 'cmp -s "$WORK/wt-original.json" "$WT.bak"'
check "closing line printed" 'grep -qxF "Open a new Claude Code session. Setup asks a few questions the first time." "$WORK/out1.txt"'
check "ponytail explained before it is added" 'grep -qF "ponytail: a third-party plugin that makes Claude write less code. -NoPonytail skips it." "$WORK/out1.txt"'

cp "$SETTINGS" "$WORK/after1.json"
ps > "$WORK/out2.txt" 2>&1
check "rerun exits 0" '[[ $? -eq 0 ]]'
diff <(json "$WORK/after1.json" "json.dumps(d,sort_keys=True,indent=1)") <(json "$SETTINGS" "json.dumps(d,sort_keys=True,indent=1)") > "$WORK/rerun.diff"
check "rerun changes no setting" '[[ ! -s $WORK/rerun.diff ]]'
check "rerun lists carapace once" '[[ $(json "$SETTINGS" "d[\"env\"][\"CLAUDE_CODE_PLUGIN_DIRS\"].count(\"$REPO\")") == 1 ]]'

: > "$CALLS"; : > "$CCALLS"
ps -NoTerminal -With hookify,security-guidance,rea,gstack > "$WORK/out3.txt" 2>&1
check "add-ons install exits 0" '[[ $? -eq 0 ]]'
check "hookify installed" 'grep -q "plugin install hookify@claude-plugins-official" "$CCALLS"'
check "security-guidance installed" 'grep -q "plugin install security-guidance@claude-plugins-official" "$CCALLS"'
check "REA installed with npm, then set up" 'grep -q "npm install --global rea-agents" "$CALLS" && grep -q "rea setup --client claude_code --yes --json" "$CALLS"'
check "gstack cloned and set up" 'grep -q "git clone" "$CALLS" && grep -q "gstack-setup" "$CALLS"'
check "add-ons recorded" '[[ $(json "$STATEF" "\",\".join(sorted(k for k in (\"hookify\",\"security-guidance\",\"rea\",\"gstack\") if d.get(k)))") == "gstack,hookify,rea,security-guidance" ]]'

: > "$CCALLS"
check "hookify writes no rule files by itself" '[[ ! -e $WORK/.claude/hookify.carapace-no-dashes.local.md ]]'
ps -NoTerminal -With writing-rules > "$WORK/out3b.txt" 2>&1
check "writing-rules written into the current folder" '[[ -e $WORK/.claude/hookify.carapace-no-dashes.local.md && -e $WORK/.claude/hookify.carapace-filler-words.local.md ]] && grep -q "writing-rules: added" "$WORK/out3b.txt"'
check "writing-rules recorded with its folder" '[[ $(json "$STATEF" "d.get(\"writing-rules\")") == installed && -n $(json "$STATEF" "d.get(\"writingRulesDir\") or \"\"") ]]'
ps -NoTerminal -Remove writing-rules > "$WORK/out3c.txt" 2>&1
check "-Remove writing-rules deletes the rule files" '[[ ! -e $WORK/.claude/hookify.carapace-no-dashes.local.md ]]'
mkdir -p "$WORK/elsewhere"
ps -NoTerminal -With writing-rules -Folder "$WORK/elsewhere" > "$WORK/out3d.txt" 2>&1
check "-Folder: rules go into the given folder" '[[ -e $WORK/elsewhere/.claude/hookify.carapace-no-dashes.local.md ]]'
ps -NoTerminal -Remove hookify > "$WORK/out4.txt" 2>&1
check "-Remove hookify exits 0" '[[ $? -eq 0 ]]'
check "-Remove uninstalls hookify" 'grep -q "plugin uninstall hookify@claude-plugins-official" "$CCALLS"'
check "-Remove leaves carapace in place" '[[ $(json "$SETTINGS" "d[\"env\"][\"CLAUDE_CODE_PLUGIN_DIRS\"]") == *"$REPO"* ]]'

ps -Uninstall > "$WORK/out5.txt" 2>&1
check "uninstall exits 0" '[[ $? -eq 0 ]]'
check "theme put back" '[[ $(json "$SETTINGS" "d.get(\"theme\")") == light ]]'
check "carapace no longer listed" '[[ $(json "$SETTINGS" "d.get(\"env\",{}).get(\"CLAUDE_CODE_PLUGIN_DIRS\",\"\")") != *"$REPO"* ]]'
check "status line removed" '[[ $(json "$SETTINGS" "\"statusLine\" in d") == False ]]'
check "other keys still kept" '[[ $(json "$SETTINGS" "d.get(\"model\")") == opus ]]'
check "ponytail removed on uninstall" 'grep -q "plugin uninstall ponytail@ponytail" "$CCALLS"'
check "REA removed on uninstall" 'grep -q "rea uninstall --purge-data" "$CALLS"'
diff <(json "$WORK/wt-original.json" "json.dumps(d,sort_keys=True,indent=1)") <(json "$WT" "json.dumps(d,sort_keys=True,indent=1)") > "$WORK/wt.diff"
check "Windows Terminal restored (same settings)" '[[ ! -s $WORK/wt.diff ]]'
check "state file removed" '[[ ! -f $STATEF ]]'
check "uninstall removes the writing rules" '[[ ! -e $WORK/elsewhere/.claude/hookify.carapace-no-dashes.local.md ]]'

# -NoPonytail on a fresh home, and a settings file that is not an object is refused untouched.
rm -rf "$CLAUDE_CONFIG_DIR"; mkdir -p "$CLAUDE_CONFIG_DIR"; : > "$CCALLS"
ps -NoTerminal -NoPonytail > "$WORK/out6.txt" 2>&1
check "-NoPonytail exits 0 on an empty home" '[[ $? -eq 0 ]]'
check "-NoPonytail adds no ponytail" '! grep -q "plugin install ponytail" "$CCALLS"'
echo '[1, 2]' > "$SETTINGS"
ps -NoTerminal -NoPonytail > "$WORK/out7.txt" 2>&1
check "a list in settings.json is refused" '[[ $? -ne 0 ]]'
check "the refused file is untouched" '[[ $(cat "$SETTINGS") == "[1, 2]" ]]'

# Claude Code older than the minimum: stop unless -Force.
rm -rf "$CLAUDE_CONFIG_DIR"; mkdir -p "$CLAUDE_CONFIG_DIR"; echo 2.1.200 > "$WORK/ver"
ps -NoTerminal -NoPonytail > "$WORK/out8.txt" 2>&1
check "old Claude Code: exits non-zero and names -Force" '[[ $? -ne 0 ]] && grep -q -- "-Force" "$WORK/out8.txt" && [[ ! -f $SETTINGS ]]'
ps -NoTerminal -NoPonytail -Force > "$WORK/out9.txt" 2>&1
check "old Claude Code with -Force: installs" '[[ $? -eq 0 && $(theme "$SETTINGS") == custom:carapace:deep-sea ]]'
rm -f "$WORK/ver"

# At a keyboard, Windows Terminal is changed only after a yes. `script` gives the installer a real terminal;
# util-linux and BSD spell it differently.
atkbd() { if script --version 2>/dev/null | grep -q util-linux; then script -qec "$(printf '%q ' "$@")" /dev/null; else script -q /dev/null "$@"; fi; }
rm -rf "$CLAUDE_CONFIG_DIR"; mkdir -p "$CLAUDE_CONFIG_DIR"; cp "$WORK/wt-original.json" "$WT"; rm -f "$WT.bak"
printf 'n\n' | (cd "$WORK" && atkbd "$PWSH" -NoLogo -NoProfile -File "$REPO/install.ps1" -NoPonytail) > "$WORK/out10.txt" 2>&1
check "asked at a keyboard: no leaves Windows Terminal alone" 'grep -q "\[Y/n\]" "$WORK/out10.txt" && cmp -s "$WORK/wt-original.json" "$WT"'
rm -rf "$CLAUDE_CONFIG_DIR"; mkdir -p "$CLAUDE_CONFIG_DIR"
printf 'y\n' | (cd "$WORK" && atkbd "$PWSH" -NoLogo -NoProfile -File "$REPO/install.ps1" -NoPonytail) > "$WORK/out11.txt" 2>&1
check "asked at a keyboard: yes adds the Deep Sea scheme" 'grep -q "Deep Sea" "$WT"'

# The status line script prints nothing and saves the cache data, as statusline.py does.
echo '{"session_id":"s1","prompt_cache":{"expires_at":"2026-10-20T10:00:00Z"}}' | "$PWSH" -NoLogo -NoProfile -File "$REPO/scripts/statusline.ps1" > "$WORK/sl.txt" 2>&1
check "statusline.ps1 prints nothing" '[[ ! -s $WORK/sl.txt ]]'
check "statusline.ps1 saves the status file" '[[ -f $HOME/.claude/carapace/statusline.json || -f $CLAUDE_CONFIG_DIR/carapace/statusline.json ]]'

[[ $failed -eq 0 ]] && echo "all install.ps1 checks passed" || { echo "--- outputs"; for f in "$WORK/rerun.diff" "$WORK/wt.diff"; do echo "== $f"; cat "$f"; done; }
exit $failed
