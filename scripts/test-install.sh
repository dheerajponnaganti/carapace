#!/usr/bin/env bash
# Checks install.sh's settings handling in a throwaway home: symlinks, file mode, a BOM, refusal, backups, uninstall.
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

# A settings file kept in a dotfiles folder, linked in, with a BOM and private permissions.
printf '\xef\xbb\xbf{\n  "theme": "light",\n  "model": "opus"\n}\n' > "$WORK/dotfiles/settings.json"
chmod 600 "$WORK/dotfiles/settings.json"
ln -s "$WORK/dotfiles/settings.json" "$SETTINGS"
cp "$WORK/dotfiles/settings.json" "$WORK/original.json"

"$REPO/install.sh" --no-terminal > "$WORK/out1.txt" 2>&1
check "install exits 0" '[[ $? -eq 0 ]]'
check "settings is still a link" '[[ -L $SETTINGS ]]'
check "the linked file has the Deep Sea theme" '[[ $(theme "$WORK/dotfiles/settings.json") == custom:carapace:deep-sea ]]'
check "other keys kept" 'grep -q "\"model\": \"opus\"" "$WORK/dotfiles/settings.json"'
check "file mode 600 kept" '[[ $(mode_of "$WORK/dotfiles/settings.json") == 600 ]]'
check "no temp file left" '[[ -z $(find "$WORK" -name "*.tmp") ]]'
check ".carapace-orig holds the original" 'cmp -s "$WORK/original.json" "$SETTINGS.carapace-orig"'
check ".bak exists" '[[ -f $SETTINGS.bak ]]'

"$REPO/install.sh" --no-terminal > /dev/null 2>&1
check "second install leaves .carapace-orig alone" 'cmp -s "$WORK/original.json" "$SETTINGS.carapace-orig"'

"$REPO/install.sh" --uninstall > "$WORK/out2.txt" 2>&1
check "uninstall puts the theme back" '[[ $(theme "$WORK/dotfiles/settings.json") == light ]]'
check "uninstall names the known-good copy" 'grep -q carapace-orig "$WORK/out2.txt"'
check "uninstall removes the state file" '[[ ! -f $CLAUDE_CONFIG_DIR/carapace-install.json ]]'

# A settings file that is not a JSON object is refused and left exactly as it was.
rm -f "$SETTINGS" "$SETTINGS.bak" "$SETTINGS.carapace-orig"
echo '[1, 2]' > "$SETTINGS"
"$REPO/install.sh" --no-terminal > "$WORK/out3.txt" 2>&1
check "a JSON array is refused" '[[ $? -ne 0 ]]'
check "the refused file is unchanged" '[[ $(cat "$SETTINGS") == "[1, 2]" ]]'
check "no backups made for a refused file" '[[ ! -e $SETTINGS.bak && ! -e $SETTINGS.carapace-orig ]]'

# REA, with npm and rea stubbed on PATH. Every call is logged to $CALLS.
printf '#!/bin/sh\necho "npm $*" >> "%s"\nif [ "$1 $2" = "install --global" ]; then printf "#!/bin/sh\\necho \\"rea \\$*\\" >> \\"%s\\"\\n" > "%s/rea"; chmod +x "%s/rea"; fi\nif [ "$1" = uninstall ]; then rm -f "%s/rea"; fi\n' "$CALLS" "$CALLS" "$BIN" "$BIN" "$BIN" > "$BIN/npm"
chmod +x "$BIN/npm"
rea_key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("rea"))' "$STATEF"; }
BASEPATH="$PATH"
run() { PATH="$BIN:$BASEPATH" "$REPO/install.sh" --no-terminal "$@" > "$WORK/rea-out.txt" 2>&1; }

echo '{}' > "$SETTINGS"; : > "$CALLS"
run
check "no flag: no npm or rea call" '[[ ! -s $CALLS ]]'
check "no flag: the closing message offers every missing add-on" 'grep -qF "Optional add-ons: REA, gstack, hookify, security-guidance, writing-rules. Add them from the Shipyard (/mods) or with --with rea,gstack,hookify,security-guidance,writing-rules." "$WORK/rea-out.txt"'
check "no flag: nothing recorded" '[[ $(rea_key) == None ]]'
run --uninstall; : > "$CALLS"

# gstack installed by hand (its folder exists, no install record) is not offered.
mkdir -p "$CLAUDE_CONFIG_DIR/skills/gstack"
run
check "a hand-installed gstack is not offered" 'grep -q "Optional add-ons" "$WORK/rea-out.txt" && ! grep -q "Optional add-ons: .*gstack" "$WORK/rea-out.txt"'
run --uninstall; rm -rf "$CLAUDE_CONFIG_DIR/skills/gstack"; : > "$CALLS"

run --with-rea
check "with-rea: npm installs rea-agents globally" 'grep -qx "npm install --global rea-agents" "$CALLS"'
check "with-rea: setup is Claude Code only and non-interactive" 'grep -qx "rea setup --client claude_code --yes --json" "$CALLS"'
check "with-rea: no Hopper install" '! grep -q hopper "$CALLS"'
check "with-rea: state records installed" '[[ $(rea_key) == installed ]]'
check "with-rea: REA is no longer offered once added" 'grep -qF "Optional add-ons: gstack, hookify, security-guidance, writing-rules." "$WORK/rea-out.txt"'
: > "$CALLS"; run --uninstall
check "uninstall: rea uninstall runs" 'grep -qx "rea uninstall --purge-data" "$CALLS"'
check "uninstall: npm uninstall runs" 'grep -qx "npm uninstall --global rea-agents" "$CALLS"'
check "uninstall: the rea stub is gone" '[[ ! -e $BIN/rea ]]'

# ponytail, gstack and --with / --remove / --manage.
key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2]))' "$STATEF" "$1"; }
reset() { echo '{}' > "$SETTINGS"; rm -f "$WORK/pt-installed" "$WORK/pt-mp" "$WORK/hk-installed" "$WORK/sg-installed" "$WORK/off-mp" "$CLAUDE_CONFIG_DIR/CLAUDE.md" "$CLAUDE_CONFIG_DIR/CLAUDE.md.bak"; rm -rf "$CLAUDE_CONFIG_DIR/skills"; : > "$CALLS"; : > "$CCALLS"; }
BUNBIN="$WORK/bunbin"; mkdir -p "$BUNBIN"; printf '#!/bin/sh\necho "bun $*" >> "%s"\n' "$CALLS" > "$BUNBIN/bun"; chmod +x "$BUNBIN/bun"
MD="$CLAUDE_CONFIG_DIR/CLAUDE.md"; GS="$CLAUDE_CONFIG_DIR/skills/gstack"
runb() { PATH="$BUNBIN:$BIN:$BASEPATH" "$REPO/install.sh" --no-terminal "$@" > "$WORK/rea-out.txt" 2>&1; }

reset
run
check "ponytail by default: marketplace added at user scope" 'grep -qx "claude plugin marketplace add DietrichGebert/ponytail --scope user" "$CCALLS"'
check "ponytail by default: plugin installed at user scope" 'grep -qx "claude plugin install ponytail@ponytail --scope user" "$CCALLS"'
check "ponytail by default: recorded as installed" '[[ $(key ponytail) == installed && $(key ponytailMarketplace) == yes ]]'
check "ponytail by default: no gstack or REA step" '! grep -q "clone\|npm" "$CALLS"'
: > "$CCALLS"; run --uninstall
check "uninstall: ponytail plugin removed" 'grep -qx "claude plugin uninstall ponytail@ponytail --scope user" "$CCALLS"'
check "uninstall: its marketplace removed, carapace added it" 'grep -qx "claude plugin marketplace remove ponytail" "$CCALLS"'

reset
run --no-ponytail
check "no-ponytail: no plugin install" '! grep -q "plugin install\|marketplace add" "$CCALLS"'
check "no-ponytail: nothing recorded" '[[ $(key ponytail) == None ]]'
run --uninstall

reset; touch "$WORK/pt-installed" "$WORK/pt-mp"
run
check "pre-existing ponytail: no install or marketplace call" '! grep -q "plugin install\|marketplace add" "$CCALLS"'
check "pre-existing ponytail: recorded as preexisting" '[[ $(key ponytail) == preexisting ]]'
check "pre-existing ponytail: says it is left alone" 'grep -q "ponytail was here before carapace" "$WORK/rea-out.txt"'
: > "$CCALLS"; run --uninstall
check "pre-existing ponytail: uninstall removes nothing" '! grep -q "plugin uninstall\|marketplace remove" "$CCALLS"'

reset; touch "$WORK/pt-installed" "$WORK/pt-mp"
run
run --manage ponytail
check "manage: records that carapace owns ponytail" '[[ $(key ponytail) == installed ]]'
check "manage: leaves its settings alone (no theme change on --manage)" '[[ $(theme "$SETTINGS") == custom:carapace:deep-sea ]]'
: > "$CCALLS"; run --uninstall
check "manage then uninstall: the plugin is removed" 'grep -qx "claude plugin uninstall ponytail@ponytail --scope user" "$CCALLS"'
check "manage then uninstall: a marketplace that was not carapace's stays" '! grep -q "marketplace remove" "$CCALLS"'

reset; printf '# Mine\n\nKeep this.\n' > "$MD"
runb --with gstack
check "gstack: cloned from the official repo, shallow" 'grep -qx "git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git $GS" "$CALLS"'
check "gstack: setup ran" 'grep -qx gstack-setup "$CALLS"'
check "gstack: recorded as installed" '[[ $(key gstack) == installed ]]'
check "gstack: marked block in CLAUDE.md" 'grep -q "<!-- carapace:gstack -->" "$MD" && grep -q "<!-- /carapace:gstack -->" "$MD" && grep -q "^# gstack" "$MD" && grep -q "mcp__claude-in-chrome__" "$MD"'
check "gstack: own CLAUDE.md text kept, backup made" 'grep -q "Keep this." "$MD" && grep -q "Keep this." "$MD.bak"'
check "gstack: no offer for gstack once added" '! grep -q "Optional add-ons: .*gstack" "$WORK/rea-out.txt"'
: > "$CALLS"; run --uninstall
check "gstack uninstall: its own non-interactive uninstall runs" 'grep -qx "gstack-uninstall --force" "$CALLS"'
check "gstack uninstall: only the marked block is gone" '! grep -q "carapace:gstack\|gstack" "$MD" && grep -q "Keep this." "$MD"'
check "gstack uninstall: the file is back to what it was" '[[ $(cat "$MD") == "$(printf "# Mine\n\nKeep this.")" ]]'

reset; printf '# gstack\n\nMy own notes about gstack.\n' > "$MD"; cp "$MD" "$WORK/md-orig"
runb --with gstack
check "unmarked gstack section: CLAUDE.md untouched" 'cmp -s "$MD" "$WORK/md-orig"'
check "unmarked gstack section: gstack itself still installed" '[[ $(key gstack) == installed ]]'
run --uninstall
check "unmarked gstack section: still untouched after uninstall" 'cmp -s "$MD" "$WORK/md-orig"'

reset; mkdir -p "$GS"
runb --with gstack
check "pre-existing gstack: no clone, recorded preexisting" '! grep -q clone "$CALLS" && [[ $(key gstack) == preexisting ]]'
: > "$CALLS"; run --uninstall
check "pre-existing gstack: uninstall leaves it" '! grep -q gstack-uninstall "$CALLS" && [[ -d $GS ]]'

reset
PATH="$BIN:/usr/bin:/bin" "$REPO/install.sh" --no-terminal --with gstack > "$WORK/rea-out.txt" 2>&1
check "no bun: gstack skipped with the reason and the link" 'grep -q "gstack: skipped, it needs Bun (https://bun.sh)" "$WORK/rea-out.txt" && ! grep -q clone "$CALLS"'
check "no bun: the rest of the install finished" '[[ $(theme "$SETTINGS") == custom:carapace:deep-sea && $(key ponytail) == installed ]]'
run --uninstall

reset
runb --with gstack
: > "$CALLS"
runb --remove gstack
check "--remove gstack: runs its uninstall and clears the record" 'grep -qx "gstack-uninstall --force" "$CALLS" && [[ $(key gstack) == None ]]'
check "--remove gstack: the marked block is gone" '! grep -q gstack "$MD"'
check "--remove gstack: ponytail and settings untouched" '[[ $(key ponytail) == installed && $(theme "$SETTINGS") == custom:carapace:deep-sea ]]'
run --uninstall

reset
runb --with all
check "--with all: gstack cloned" 'grep -q "^git clone" "$CALLS"'
check "--with all: REA installed" 'grep -qx "npm install --global rea-agents" "$CALLS"'
check "--with all: both recorded" '[[ $(key gstack) == installed && $(key rea) == installed ]]'
check "--with all: REA and gstack are no longer offered" '! grep -qE "Optional add-ons: .*(REA|gstack)" "$WORK/rea-out.txt"'
run --uninstall
check "--with all, then uninstall: everything gone" '[[ ! -f $STATEF && ! -f $WORK/pt-installed && ! -e $BIN/rea ]]'

# hookify and security-guidance (official marketplace). Run in a project folder: hookify reads its rules from ./.claude there.
PROJ="$WORK/proj"; mkdir -p "$PROJ"
runp() { (cd "$PROJ" && PATH="$BIN:$BASEPATH" "$REPO/install.sh" --no-terminal "$@" > "$WORK/rea-out.txt" 2>&1); }
RULES="$PROJ/.claude"

reset; rm -rf "$PROJ/.claude"
runp
check "official add-ons are off by default: no install of either" '! grep -q "claude-plugins-official" "$CCALLS" && [[ $(key hookify) == None && $(key security-guidance) == None ]]'
check "official add-ons are off by default: no rule files" '[[ ! -e $RULES ]]'
runp --uninstall

reset; rm -rf "$PROJ/.claude"
runp --with hookify
check "hookify: marketplace added at user scope when missing" 'grep -qx "claude plugin marketplace add anthropics/claude-plugins-official --scope user" "$CCALLS"'
check "hookify: plugin installed from the official marketplace at user scope" 'grep -qx "claude plugin install hookify@claude-plugins-official --scope user" "$CCALLS"'
check "hookify: recorded, with the marketplace" '[[ $(key hookify) == installed && $(key officialMarketplace) == yes ]]'
check "hookify: writes no rule files by itself"  '[[ ! -e $RULES ]]'
check "hookify: security-guidance not touched" '! grep -q "security-guidance" "$CCALLS"'
runp --with writing-rules
check "writing-rules: em dash and en dash rule file written" 'grep -q "^event: file" "$RULES/hookify.carapace-no-dashes.local.md" && grep -qF "u2014" "$RULES/hookify.carapace-no-dashes.local.md" && grep -qF "u2013" "$RULES/hookify.carapace-no-dashes.local.md" && grep -q "^action: warn" "$RULES/hookify.carapace-no-dashes.local.md"'
check "writing-rules: filler words rule file written" 'grep -q "basically" "$RULES/hookify.carapace-filler-words.local.md" && grep -q "in order to" "$RULES/hookify.carapace-filler-words.local.md" && grep -q "^action: warn" "$RULES/hookify.carapace-filler-words.local.md"'
check "writing-rules: says which folder" 'grep -qF "writing-rules: added carapace'"'"'s writing rules to $RULES" "$WORK/rea-out.txt"'
check "writing-rules: recorded as an add-on with its folder" '[[ $(key writing-rules) == installed && $(key writingRulesDir) == $RULES ]]'
printf 'keep\n' > "$RULES/hookify.mine.local.md"
: > "$CCALLS"; runp --remove hookify
check "--remove hookify: uninstalls the plugin" 'grep -qx "claude plugin uninstall hookify@claude-plugins-official --scope user" "$CCALLS"'
check "--remove hookify: leaves the writing rules (their own add-on)" '[[ -e $RULES/hookify.carapace-no-dashes.local.md ]]'
check "--remove hookify: removes the marketplace carapace added" 'grep -qx "claude plugin marketplace remove claude-plugins-official" "$CCALLS" && [[ $(key officialMarketplace) == None ]]'
runp --remove writing-rules
check "--remove writing-rules: deletes only carapace's rule files" '[[ ! -e $RULES/hookify.carapace-no-dashes.local.md && ! -e $RULES/hookify.carapace-filler-words.local.md && -f $RULES/hookify.mine.local.md && $(key writing-rules) == None && $(key writingRulesDir) == None ]]'
FOLD="$WORK/elsewhere"; mkdir -p "$FOLD"
runp --with writing-rules --folder "$FOLD"
check "writing-rules --folder: written into the given folder and says so" '[[ -e $FOLD/.claude/hookify.carapace-no-dashes.local.md && ! -e $RULES/hookify.carapace-no-dashes.local.md ]] && grep -qF "$FOLD/.claude" "$WORK/rea-out.txt"'
runp --uninstall
check "uninstall: writing rules removed from the recorded folder" '[[ ! -e $FOLD/.claude/hookify.carapace-no-dashes.local.md ]]'
runp --uninstall

reset; rm -rf "$PROJ/.claude"; touch "$WORK/off-mp"
runp --with hookify,security-guidance
check "official marketplace already configured: not added again" '! grep -q "marketplace add anthropics" "$CCALLS" && [[ $(key officialMarketplace) == None ]]'
check "security-guidance: installed from the official marketplace" 'grep -qx "claude plugin install security-guidance@claude-plugins-official --scope user" "$CCALLS" && [[ $(key security-guidance) == installed ]]'
: > "$CCALLS"; runp --uninstall
check "uninstall: both official plugins removed" 'grep -qx "claude plugin uninstall hookify@claude-plugins-official --scope user" "$CCALLS" && grep -qx "claude plugin uninstall security-guidance@claude-plugins-official --scope user" "$CCALLS"'
check "uninstall: a marketplace that was not carapace's stays" '! grep -q "marketplace remove claude-plugins-official" "$CCALLS" && [[ -e $WORK/off-mp ]]'

reset; rm -rf "$PROJ/.claude"
runp --with hookify,security-guidance
: > "$CCALLS"; runp --remove hookify
check "marketplace stays while the other official add-on is carapace's" '! grep -q "marketplace remove claude-plugins-official" "$CCALLS" && [[ $(key officialMarketplace) == yes ]]'
runp --remove security-guidance
check "marketplace goes with the last official add-on" '[[ $(key officialMarketplace) == None && ! -e $WORK/off-mp ]]'
runp --uninstall

reset; rm -rf "$PROJ/.claude"; touch "$WORK/hk-installed" "$WORK/sg-installed" "$WORK/off-mp"
runp --with hookify,security-guidance
check "pre-existing hookify and security-guidance: left alone, no rules" '! grep -q "install hookify\|install security" "$CCALLS" && [[ $(key hookify) == preexisting && $(key security-guidance) == preexisting && ! -e $RULES ]]'
runp --manage hookify
check "manage hookify: carapace owns it" '[[ $(key hookify) == installed ]]'
: > "$CCALLS"; runp --uninstall
check "pre-existing security-guidance survives uninstall, managed hookify does not" '! grep -q "uninstall security-guidance" "$CCALLS" && grep -q "uninstall hookify" "$CCALLS"'

# Claude Code older than the minimum: stop with an error unless --force.
reset; echo 2.1.200 > "$WORK/ver"
run; code=$?
check "old Claude Code: exits non-zero" '[[ $code -ne 0 ]]'
check "old Claude Code: says so and names --force" 'grep -q "older than" "$WORK/rea-out.txt" && grep -q -- "--force" "$WORK/rea-out.txt"'
check "old Claude Code: nothing was changed" '[[ $(cat "$SETTINGS") == "{}" && ! -f $STATEF ]]'
run --force; code=$?
check "old Claude Code with --force: installs" '[[ $code -eq 0 && $(theme "$SETTINGS") == custom:carapace:deep-sea ]]'
run --uninstall; rm -f "$WORK/ver"

# What ponytail is, said before it is added; the closing line.
reset
run
check "ponytail: explained before it is added" 'grep -qF "ponytail: a third-party plugin that makes Claude write less code. --no-ponytail skips it." "$WORK/rea-out.txt"'
check "closing line" 'grep -qxF "Open a new Claude Code session. Setup asks a few questions the first time." "$WORK/rea-out.txt"'
check "no printed /theme-sea or /clean budget" '! grep -rqE "theme-sea|clean budget" "$WORK/rea-out.txt" "$REPO/install.sh" "$REPO/install.ps1"'

# At a keyboard, the Terminal app is changed only after a yes. A stand-in osascript logs every call; `script` gives a real terminal.
# The Terminal app exists only on macOS, so the check runs there.
if [[ "$(uname)" == Darwin ]]; then
  reset; run --uninstall
  printf '#!/bin/sh\necho "osascript $*" >> "%s"\necho Basic\n' "$WORK/osa.txt" > "$BIN/osascript"; chmod +x "$BIN/osascript"; : > "$WORK/osa.txt"
  printf 'n\n' | PATH="$BIN:$BASEPATH" script -q /dev/null "$REPO/install.sh" --terminal --no-ponytail > "$WORK/kbd.txt" 2>&1
  check "asked at a keyboard: no leaves the Terminal app alone" 'grep -q "\[Y/n\]" "$WORK/kbd.txt" && grep -q "Terminal: left alone" "$WORK/kbd.txt" && [[ $(wc -l < "$WORK/osa.txt") -eq 1 ]]'
  rm -f "$BIN/osascript"; run --uninstall
fi
run --uninstall

reset; runp --with nonsense
check "an unknown add-on is refused" '[[ $? -ne 0 ]] && grep -q "Unknown add-on: nonsense" "$WORK/rea-out.txt"'
runp --uninstall

reset
run --remove rea
check "--remove of an add-on carapace never added makes no call" '! grep -q "npm" "$CALLS"'
run --uninstall

# REA already on the PATH: never installed, set up or removed.
printf '#!/bin/sh\necho "rea $*" >> "%s"\n' "$CALLS" > "$BIN/rea"; chmod +x "$BIN/rea"
echo '{}' > "$SETTINGS"; : > "$CALLS"
run --with-rea
check "pre-existing: says it is left alone" 'grep -q "REA was here before carapace" "$WORK/rea-out.txt"'
check "pre-existing: no npm or rea call" '[[ ! -s $CALLS ]]'
check "pre-existing: state records it" '[[ $(rea_key) == preexisting ]]'
run --uninstall
check "pre-existing: uninstall makes no call" '[[ ! -s $CALLS ]]'

# No npm: REA is skipped, the rest of the install goes on.
rm -f "$BIN/npm" "$BIN/rea"; echo '{}' > "$SETTINGS"
PATH="$BIN:/usr/bin:/bin" "$REPO/install.sh" --no-terminal --with-rea > "$WORK/rea-out.txt" 2>&1
check "no npm: REA skipped with a reason" 'grep -q "needs npm" "$WORK/rea-out.txt"'
check "no npm: the install still finished" '[[ $(theme "$SETTINGS") == custom:carapace:deep-sea ]]'

# The status line (the footer's cache countdown): set only where there is none, removed only when carapace set it.
sl() { python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get("statusLine")))' "$SETTINGS"; }
rm -f "$SETTINGS" "$STATEF"; echo '{}' > "$SETTINGS"
run
check "statusLine: set when absent" 'sl | grep -q "scripts/statusline.py"'
check "statusLine: recorded in the state" 'grep -q statusLine "$STATEF"'
run --uninstall
check "statusLine: removed on uninstall, carapace set it" '[[ $(sl) == null ]]'
rm -f "$STATEF"; echo '{"statusLine":{"type":"command","command":"my-line"}}' > "$SETTINGS"
run
check "statusLine: left alone when the person has one" '[[ $(sl) == *my-line* ]] && ! grep -q statusLine "$STATEF"'
run --uninstall
check "statusLine: theirs stays on uninstall" '[[ $(sl) == *my-line* ]]'
echo '{"session_id":"s","prompt_cache":{"warm":true},"model":"x"}' | python3 "$REPO/scripts/statusline.py" > "$WORK/sl-out.txt"
SAVED="$HOME/.claude/carapace/statusline.json"
check "statusline.py: prints nothing" '[[ ! -s $WORK/sl-out.txt ]]'
check "statusline.py: saves the cache and session only" 'python3 -c "import json,sys; sys.exit(0 if sorted(json.load(open(sys.argv[1]))) == [\"prompt_cache\", \"session_id\"] else 1)" "$SAVED"'

exit $failed
