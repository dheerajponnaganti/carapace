# Sets up carapace on Windows with one command:
#   1. lists this folder in CLAUDE_CODE_PLUGIN_DIRS, so every mod loads in every session and hot reloads on save
#   2. switches Claude Code's theme to Deep Sea (the previous theme is kept for -Uninstall)
#   3. lets the Crew run 20 helpers at once (only where you have not set your own limits)
#   4. dresses Windows Terminal in Deep Sea when it is installed (colors, cursor, opacity, and a background image when terminal\deep-sea-bg.png exists)
# Everything else in ~/.claude/settings.json is kept. Backups: settings.json.bak (latest) and settings.json.carapace-orig (before the first install).
# Windows Terminal's settings.json is rewritten without its comments. The original is saved as settings.json.bak next to it.
#
#   .\install.ps1                  set everything up
#   .\install.ps1 -NoTerminal      leave Windows Terminal alone
#   .\install.ps1 -With rea,gstack also add REA (reverse-engineering tools) and/or gstack (skills); "all" adds both. -WithRea still works
#   .\install.ps1 -NoPonytail      skip ponytail, the token-saving Claude Code plugin that is installed by default
#   .\install.ps1 -With hookify,security-guidance   also add the official hookify and security-guidance plugins (not in "all")
#   .\install.ps1 -With writing-rules   also write carapace's writing rules (hookify rules) into .\.claude; -Folder <dir> picks another folder
#   .\install.ps1 -Remove <rea|gstack|ponytail|hookify|security-guidance|writing-rules>   remove one add-on that carapace added
#   .\install.ps1 -Manage <rea|gstack|ponytail|hookify|security-guidance>   let carapace own an add-on that was yours (uninstall then removes it)
#   .\install.ps1 -Force          install even when Claude Code is older than the minimum version
#   .\install.ps1 -Uninstall       undo all of it, keep everything else (add-ons are removed only if carapace added them)
param([switch]$Uninstall, [switch]$Terminal, [switch]$NoTerminal, [string[]]$With, [switch]$WithRea, [switch]$NoPonytail, [switch]$Force, [string]$Folder, [string]$Remove, [string]$Manage)
$ErrorActionPreference = 'Stop'
$wanted = @($With | ForEach-Object { "$_".Split(',') } | Where-Object { $_ })
if ($wanted -contains 'all') { $wanted = @('rea', 'gstack') }
if ($WithRea) { $wanted += 'rea' }
foreach ($id in @($wanted) + @($Remove, $Manage)) {
  if ($id -and (('rea', 'gstack', 'ponytail', 'hookify', 'security-guidance', 'writing-rules') -notcontains $id)) { throw "Unknown add-on: $id (rea, gstack, ponytail, hookify, security-guidance or writing-rules)" }
}
# Whether REA was on the PATH before carapace touched anything.
$reaBefore = [bool](Get-Command rea -ErrorAction SilentlyContinue)
$minVersion = [version]'2.1.299'

$repo = (Resolve-Path $PSScriptRoot).Path.TrimEnd('\', '/')
$configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$settings = Join-Path $configDir 'settings.json'
$statePath = Join-Path $configDir 'carapace-install.json'
$theme = 'custom:carapace:deep-sea'
$statusCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $repo 'scripts\statusline.ps1')`""
$limits = [ordered]@{ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '20'; CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '20' }
$sep = [IO.Path]::PathSeparator

# Small helpers for the JSON objects that ConvertFrom-Json returns.
function Test-Prop($obj, [string]$name) { [bool]($obj -and $obj.PSObject.Properties[$name]) }
function Get-Prop($obj, [string]$name) { if (Test-Prop $obj $name) { $obj.PSObject.Properties[$name].Value } }
function Set-Prop($obj, [string]$name, $value) {
  if (Test-Prop $obj $name) { $obj.$name = $value } else { Add-Member -InputObject $obj -NotePropertyName $name -NotePropertyValue $value }
}

# Writes BOM-less UTF-8 atomically: a temp file next to the target, then a swap. A symlink is followed, so the real file is updated.
function Write-Atomic([string]$path, [string]$text) {
  $real = $path
  $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
  if ($item -and $item.LinkType -and $item.PSObject.Methods['ResolveLinkTarget']) {
    $target = $item.ResolveLinkTarget($true)
    if ($target) { $real = $target.FullName }
  }
  $tmp = "$real.$PID.tmp"
  try {
    [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding $false))
    if (Test-Path -LiteralPath $real) { [IO.File]::Replace($tmp, $real, [NullString]::Value) } else { Move-Item -LiteralPath $tmp -Destination $real -Force }
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

$state = [ordered]@{ limits = @(); themeBefore = $null; hasThemeBefore = $false; terminal = $null; rea = $null; gstack = $null; ponytail = $null; ponytailMarketplace = $null; hookify = $null; 'security-guidance' = $null; officialMarketplace = $null; hookifyRulesDir = $null; 'writing-rules' = $null; writingRulesDir = $null; statusLine = $null }
if (Test-Path $statePath) {
  $saved = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($saved.statusLine) { $state.statusLine = $saved.statusLine }
  if ($saved.limits) { $state.limits = @($saved.limits) }
  if ($saved.PSObject.Properties.Name -contains 'themeBefore') { $state.themeBefore = $saved.themeBefore; $state.hasThemeBefore = $true }
  if ($saved.PSObject.Properties.Name -contains 'terminal') { $state.terminal = $saved.terminal }
  foreach ($k in 'rea', 'gstack', 'ponytail', 'ponytailMarketplace', 'hookify', 'security-guidance', 'officialMarketplace', 'hookifyRulesDir', 'writing-rules', 'writingRulesDir') { if ($saved.PSObject.Properties.Name -contains $k) { $state[$k] = $saved.$k } }
}


# ---- Add-ons: REA, gstack, ponytail. Each key in the state file is 'installed' (carapace added it) or 'preexisting' (it was here first).
# Every external step reports its result, and a failed add-on never stops the rest.
$notes = @()
function Say([string]$text) { $script:notes += $text }
function Write-State {
  $stateJson = [ordered]@{ limits = @($state.limits) }
  if ($state.statusLine) { $stateJson.statusLine = $state.statusLine }
  if ($state.hasThemeBefore) { $stateJson.themeBefore = $state.themeBefore }
  if ($state.terminal) { $stateJson.terminal = $state.terminal }
  foreach ($k in 'rea', 'gstack', 'ponytail', 'ponytailMarketplace', 'hookify', 'security-guidance', 'officialMarketplace', 'hookifyRulesDir', 'writing-rules', 'writingRulesDir') { if ($state[$k]) { $stateJson[$k] = $state[$k] } }
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  Write-Atomic $statePath (($stateJson | ConvertTo-Json -Depth 10) + "`n")
}
function Test-Cmd([string]$name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# The gstack section of the global CLAUDE.md, between marker comments. Added only when the file has no "# gstack" section;
# removal deletes only the marked block. Atomic write, backup in CLAUDE.md.bak.
$mdOpen = '<!-- carapace:gstack -->'
$mdClose = '<!-- /carapace:gstack -->'
function Update-ClaudeMd([string]$op) {
  $path = Join-Path $configDir 'CLAUDE.md'
  $text = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { '' }
  if ($op -eq 'add') {
    if ($text.Contains($mdOpen)) { Say 'gstack: the CLAUDE.md section is already there.'; return }
    if ($text -match '(?im)^#+\s*gstack\b') { Say 'gstack: CLAUDE.md already has a gstack section, so it was left alone.'; return }
    $gap = if (-not $text -or $text.EndsWith("`n`n")) { '' } elseif ($text.EndsWith("`n")) { "`n" } else { "`n`n" }
    $new = $text + $gap + "$mdOpen`n# gstack`n`nUse the /browse skill from gstack for all web browsing. Never use the mcp__claude-in-chrome__* tools.`n$mdClose`n"
    $done = 'gstack: added its section to CLAUDE.md.'
  } else {
    if (-not $text.Contains($mdOpen)) { return }
    $new = ([regex]"\n?$([regex]::Escape($mdOpen))[\s\S]*?$([regex]::Escape($mdClose))\n?").Replace($text, '', 1)
    $done = 'gstack: removed its section from CLAUDE.md.'
  }
  if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path "$path.bak" -Force }
  Write-Atomic $path $new
  Say $done
}

$gstackDir = Join-Path (Join-Path $configDir 'skills') 'gstack'
function Test-PonytailListed {
  try { [bool](@(& claude plugin list --json 2>$null | Out-String | ConvertFrom-Json) | Where-Object { "$($_.id)".Split('@')[0] -eq 'ponytail' }) } catch { $false }
}
function Test-Present([string]$id) {
  switch ($id) {
    'rea' { Test-Cmd rea }
    'gstack' { Test-Path -LiteralPath $gstackDir }
    'ponytail' { (Test-Cmd claude) -and (Test-PonytailListed) }
    { $_ -in 'hookify', 'security-guidance' } { (Test-Cmd claude) -and (Test-PluginListed $id) }
  }
}

function Install-Rea {
  if ($state.rea -eq 'installed') { Say 'REA: already added by carapace.' }
  elseif ($reaBefore) { $state.rea = 'preexisting'; Say 'REA was here before carapace, so carapace leaves it alone.' }
  elseif (-not (Test-Cmd npm)) { Say 'REA: skipped, it needs npm (install Node.js, then run .\install.ps1 -With rea).' }
  else {
    & npm install --global rea-agents
    if ($LASTEXITCODE -eq 0) { & rea setup --client claude_code --yes --json | Out-Null }
    if ($LASTEXITCODE -eq 0) { $state.rea = 'installed'; Say 'REA: added for Claude Code. Restart Claude Code to use it.' }
    else {
      if (Test-Cmd rea) { $state.rea = 'installed' }
      Say 'REA: the install did not finish. Run .\install.ps1 -With rea again, or npm install --global rea-agents.'
    }
  }
}
function Remove-Rea {
  if ($state.rea -eq 'installed') {
    & rea uninstall --purge-data | Out-Null
    Say $(if ($LASTEXITCODE -eq 0) { 'REA: removed from Claude Code.' } else { 'REA: its own uninstall failed. Run rea uninstall yourself.' })
    & npm uninstall --global rea-agents | Out-Null
    Say $(if ($LASTEXITCODE -eq 0) { 'REA: package removed.' } else { 'REA: npm could not remove the package. Run npm uninstall --global rea-agents.' })
    $state.rea = $null
  } elseif ($state.rea -eq 'preexisting') { Say 'REA was here before carapace, so carapace leaves it alone.' }
}

function Install-Gstack {
  if ($state.gstack -eq 'installed') { Say 'gstack: already added by carapace.' }
  elseif (Test-Path -LiteralPath $gstackDir) { $state.gstack = 'preexisting'; Say 'gstack was here before carapace, so carapace leaves it alone.' }
  elseif (-not (Test-Cmd git)) { Say 'gstack: skipped, it needs git.' }
  elseif (-not (Test-Cmd bun)) { Say 'gstack: skipped, it needs Bun (https://bun.sh). Install it, then run .\install.ps1 -With gstack.' }
  else {
    New-Item -ItemType Directory -Force -Path (Split-Path $gstackDir) | Out-Null
    & git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git $gstackDir
    if ($LASTEXITCODE -eq 0) { Push-Location $gstackDir; try { & bash ./setup } finally { Pop-Location } }
    if ($LASTEXITCODE -eq 0) {
      $state.gstack = 'installed'
      Say 'gstack: added. Restart Claude Code to use it.'
      try { Update-ClaudeMd 'add' } catch { Say 'gstack: could not update CLAUDE.md. Add the section yourself if you want it.' }
    } else {
      if (Test-Path -LiteralPath $gstackDir) { $state.gstack = 'installed' }
      Say 'gstack: the install did not finish. Run .\install.ps1 -Remove gstack, then .\install.ps1 -With gstack again.'
    }
  }
}
function Remove-Gstack {
  if ($state.gstack -eq 'installed') {
    $un = Join-Path (Join-Path $gstackDir 'bin') 'gstack-uninstall'
    if (Test-Path -LiteralPath $un) { & bash $un --force | Out-Null } else { $global:LASTEXITCODE = 1 }
    if ($LASTEXITCODE -eq 0) { Say 'gstack: removed.'; $state.gstack = $null }
    else { Say "gstack: its own uninstall failed. Run $un yourself." }
    try { Update-ClaudeMd 'remove' } catch { Say 'gstack: could not update CLAUDE.md.' }
  } elseif ($state.gstack -eq 'preexisting') { Say 'gstack was here before carapace, so carapace leaves it alone.' }
}

function Install-Ponytail {
  if ($state.ponytail -eq 'installed') { Say 'ponytail: already added by carapace.'; return }
  if (-not (Test-Cmd claude)) { Say 'ponytail: skipped, Claude Code is not on your PATH. Run .\install.ps1 -With ponytail once it is.'; return }
  if (Test-PonytailListed) { $state.ponytail = 'preexisting'; Say 'ponytail was here before carapace, so carapace leaves it alone.'; return }
  Say 'ponytail: a third-party plugin that makes Claude write less code. -NoPonytail skips it.'
  $added = $false
  if ((& claude plugin marketplace list --json 2>$null | Out-String) -notmatch '"name":\s*"ponytail"') {
    & claude plugin marketplace add DietrichGebert/ponytail --scope user | Out-Null
    if ($LASTEXITCODE -ne 0) { Say 'ponytail: could not add its marketplace. Run claude plugin marketplace add DietrichGebert/ponytail yourself.'; return }
    $added = $true
  }
  & claude plugin install ponytail@ponytail --scope user | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $state.ponytail = 'installed'
    if ($added) { $state.ponytailMarketplace = 'yes' }
    Say 'ponytail: added. Restart Claude Code to use it.'
  } else { Say 'ponytail: the install did not finish. Run claude plugin install ponytail@ponytail yourself.' }
}
function Remove-Ponytail {
  if ($state.ponytail -eq 'installed') {
    & claude plugin uninstall ponytail@ponytail --scope user | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Say 'ponytail: removed.'
      $state.ponytail = $null
      if ($state.ponytailMarketplace -eq 'yes') {
        & claude plugin marketplace remove ponytail | Out-Null
        if ($LASTEXITCODE -eq 0) { $state.ponytailMarketplace = $null } else { Say 'ponytail: could not remove its marketplace. Run claude plugin marketplace remove ponytail.' }
      }
    } else { Say 'ponytail: its uninstall failed. Run claude plugin uninstall ponytail@ponytail yourself.' }
  } elseif ($state.ponytail -eq 'preexisting') { Say 'ponytail was here before carapace, so carapace leaves it alone.' }
}

# ---- hookify and security-guidance: plugins of the official marketplace. Nothing here runs unless asked for (-With).
# The marketplace is added only when it is missing (state key officialMarketplace) and removed only when carapace added it
# and no other official add-on of carapace's still needs it.
$officialMp = 'claude-plugins-official'
function Test-PluginListed([string]$name) {
  try { [bool](@(& claude plugin list --json 2>$null | Out-String | ConvertFrom-Json) | Where-Object { "$($_.id)".Split('@')[0] -eq $name }) } catch { $false }
}
# hookify reads its rules only from .claude\hookify.*.local.md in the folder Claude Code runs in, so the writing rules go into
# .claude of the folder given with -Folder, or else the folder this installer runs in. The folder is recorded for removal.
# They are their own add-on (writing-rules): they need hookify to take effect, but installing hookify does not write them.
$ruleFiles = 'hookify.carapace-no-dashes.local.md', 'hookify.carapace-filler-words.local.md'
function Install-Writing-rules {
  if ($state.'writing-rules' -eq 'installed') { Say "writing-rules: already added by carapace in $($state.writingRulesDir)."; return }
  $base = if ($Folder) { (Resolve-Path -LiteralPath $Folder).Path } else { (Get-Location).Path }
  $dir = Join-Path $base '.claude'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $noDashes = "---`nname: carapace-no-dashes`nenabled: true`nevent: file`npattern: [\u2014\u2013]`naction: warn`n---`n`nWriting rule: no em dashes and no en dashes. Use a comma, a colon, a period or parentheses. Rewrite the sentence instead of swapping the mark.`n"
  $filler = "---`nname: carapace-filler-words`nenabled: true`nevent: file`npattern: \b(basically|essentially|simply|just|actually|obviously|clearly|of course|in order to|needless to say|at the end of the day|note that|worth noting|important to note)\b`naction: warn`n---`n`nWriting rule: no filler words. Delete the filler, or say it directly (`"in order to`" becomes `"to`").`n"
  Write-Atomic (Join-Path $dir $ruleFiles[0]) $noDashes
  Write-Atomic (Join-Path $dir $ruleFiles[1]) $filler
  $state.writingRulesDir = $dir
  $state.'writing-rules' = 'installed'
  Say "writing-rules: added carapace's writing rules to $dir. They apply when you run Claude Code in that folder with hookify (-With hookify)."
}
# Also clears the folder key older installs used (hookifyRulesDir).
function Remove-Writing-rules {
  foreach ($key in 'writingRulesDir', 'hookifyRulesDir') {
    $dir = $state[$key]
    if (-not $dir) { continue }
    foreach ($f in $ruleFiles) { Remove-Item -LiteralPath (Join-Path $dir $f) -Force -ErrorAction SilentlyContinue }
    $state[$key] = $null
    Say "writing-rules: removed carapace's writing rules from $dir."
  }
  $state.'writing-rules' = $null
}
function Install-Official([string]$id) {
  if ($state[$id] -eq 'installed') { Say "${id}: already added by carapace."; return }
  if (-not (Test-Cmd claude)) { Say "${id}: skipped, Claude Code is not on your PATH. Run .\install.ps1 -With $id once it is."; return }
  if (Test-PluginListed $id) { $state[$id] = 'preexisting'; Say "$id was here before carapace, so carapace leaves it alone."; return }
  $added = $false
  if ((& claude plugin marketplace list --json 2>$null | Out-String) -notmatch "`"name`":\s*`"$officialMp`"") {
    & claude plugin marketplace add anthropics/claude-plugins-official --scope user | Out-Null
    if ($LASTEXITCODE -ne 0) { Say "${id}: could not add the $officialMp marketplace. Run claude plugin marketplace add anthropics/claude-plugins-official yourself."; return }
    $added = $true
  }
  & claude plugin install "$id@$officialMp" --scope user | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $state[$id] = 'installed'
    if ($added) { $state.officialMarketplace = 'yes' }
    Say "${id}: added. Restart Claude Code to use it."
  } else { Say "${id}: the install did not finish. Run claude plugin install $id@$officialMp yourself." }
}
function Remove-Official([string]$id) {
  if ($state[$id] -eq 'installed') {
    & claude plugin uninstall "$id@$officialMp" --scope user | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Say "${id}: removed."
      $state[$id] = $null
      $other = if ($id -eq 'hookify') { 'security-guidance' } else { 'hookify' }
      if ($state.officialMarketplace -eq 'yes' -and $state[$other] -ne 'installed') {
        & claude plugin marketplace remove $officialMp | Out-Null
        if ($LASTEXITCODE -eq 0) { $state.officialMarketplace = $null } else { Say "${id}: could not remove the $officialMp marketplace. Run claude plugin marketplace remove $officialMp." }
      }
    } else { Say "${id}: its uninstall failed. Run claude plugin uninstall $id@$officialMp yourself." }
  } elseif ($state[$id] -eq 'preexisting') { Say "$id was here before carapace, so carapace leaves it alone." }
}
function Remove-Hookify { Remove-Official 'hookify' }
function Remove-Security-guidance { Remove-Official 'security-guidance' }

# -Remove <add-on> and -Manage <add-on>: one add-on only, then done (this is what the Shipyard's buttons run).
if ($Remove -or $Manage) {
  $id = if ($Remove) { $Remove } else { $Manage }
  if ($Remove) {
    if (-not $state[$id]) { Say "${id}: carapace did not add it, so there is nothing to remove." }
    & "Remove-$((Get-Culture).TextInfo.ToTitleCase($id))"
  } elseif ($state[$id] -eq 'installed') { Say "${id}: carapace already manages it." }
  elseif (Test-Present $id) { $state[$id] = 'installed'; Say "${id}: carapace now manages it. Uninstalling carapace removes it too." }
  else { Say "${id}: not found, nothing to manage." }
  Write-State
  $notes | ForEach-Object { Write-Output $_ }
  exit 0
}

# Claude Code older than the minimum lacks events the mods use: stop, unless -Force.
if (-not $Uninstall -and (Test-Cmd claude)) {
  $have = [regex]::Match("$(& claude --version 2>$null)", '\d+\.\d+\.\d+').Value
  if ($have -and [version]$have -lt $minVersion) {
    if ($Force) { Write-Output "Claude Code $have is older than $minVersion. Continuing because of -Force; some mods may not work." }
    else { [Console]::Error.WriteLine("Claude Code $have is older than $minVersion, so carapace was not installed. Update it (claude update), or run .\install.ps1 -Force to install anyway."); exit 1 }
  }
}

$data = [ordered]@{}
if (Test-Path $settings) {
  # A broken or non-object settings file stops here, untouched.
  # -InputObject keeps a JSON list a list; every value passes `-is [pscustomobject]`, so the type is checked by name.
  $parsed = ConvertFrom-Json -InputObject (Get-Content $settings -Raw -Encoding UTF8).TrimStart([char]0xFEFF)
  if ($null -eq $parsed -or $parsed.GetType().FullName -ne 'System.Management.Automation.PSCustomObject') { throw "$settings is not a JSON object. Nothing was changed." }
  foreach ($p in $parsed.PSObject.Properties) { $data[$p.Name] = $p.Value }
  Copy-Item $settings "$settings.bak" -Force
  # The copy from before the first install, never overwritten.
  if (-not (Test-Path "$settings.carapace-orig")) { Copy-Item $settings "$settings.carapace-orig" }
}

$envBlock = [ordered]@{}
if ($data.Contains('env') -and $data['env']) {
  foreach ($p in $data['env'].PSObject.Properties) { $envBlock[$p.Name] = $p.Value }
}
$current = @()
if ($envBlock.Contains('CLAUDE_CODE_PLUGIN_DIRS')) {
  $current = "$($envBlock['CLAUDE_CODE_PLUGIN_DIRS'])".Split($sep) | Where-Object { $_ }
}
# Drop this repo and anything inside it (older installs listed each mod), then add the repo once.
$kept = @($current | Where-Object { $_ -ne $repo -and -not $_.StartsWith($repo + [IO.Path]::DirectorySeparatorChar) })
$new = if ($Uninstall) { $kept } else { $kept + $repo }

if ($new.Count -gt 0) { $envBlock['CLAUDE_CODE_PLUGIN_DIRS'] = ($new -join $sep) } else { $envBlock.Remove('CLAUDE_CODE_PLUGIN_DIRS') }

if (-not $Uninstall) {
  foreach ($key in $limits.Keys) {
    if (-not $envBlock.Contains($key)) {
      $envBlock[$key] = $limits[$key]
      if ($state.limits -notcontains $key) { $state.limits += $key }
    }
  }
  # The status line command feeds the footer's cache countdown. Set only where the person has no status line of their own.
  if (-not $data.Contains('statusLine')) {
    $data['statusLine'] = [ordered]@{ type = 'command'; command = $statusCommand }
    $state.statusLine = $statusCommand
  }
  $currentTheme = if ($data.Contains('theme')) { $data['theme'] } else { $null }
  if ($currentTheme -ne $theme) {
    if (-not $state.hasThemeBefore) { $state.themeBefore = $currentTheme; $state.hasThemeBefore = $true }
    $data['theme'] = $theme
  }
} else {
  foreach ($key in $state.limits) {
    if ($envBlock.Contains($key) -and "$($envBlock[$key])" -eq $limits[$key]) { $envBlock.Remove($key) }
  }
  if ($state.statusLine -and $data.Contains('statusLine') -and $data['statusLine'] -and $data['statusLine'].command -eq $state.statusLine) { $data.Remove('statusLine') }
  if ($data.Contains('theme') -and $data['theme'] -eq $theme) {
    if ($state.themeBefore) { $data['theme'] = $state.themeBefore } else { $data.Remove('theme') }
  }
}
if ($envBlock.Count -gt 0) { $data['env'] = $envBlock } else { $data.Remove('env') }

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$json = $data | ConvertTo-Json -Depth 100
Write-Atomic $settings ($json + "`n")

# Windows Terminal: a color scheme and profile defaults in its settings.json.
function Find-TerminalSettings {
  $candidates = @()
  if ($env:CARAPACE_WT_SETTINGS) {
    $candidates = @($env:CARAPACE_WT_SETTINGS)
  } elseif ($env:LOCALAPPDATA) {
    $candidates = @(
      Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'
      Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json'
      Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json'
    )
  }
  $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

# Windows Terminal writes JSON with comments and trailing commas. Plain ConvertFrom-Json is tried first,
# then the comments and trailing commas are removed. Strings are matched first, so "//" inside a value stays.
function Read-TerminalSettings([string]$path) {
  $text = Get-Content $path -Raw -Encoding UTF8
  try { $root = ConvertFrom-Json -InputObject $text } catch {
    $clean = [regex]::Replace($text, '("(?:\\.|[^"\\])*")|//[^\r\n]*|/\*[\s\S]*?\*/', '$1')
    $clean = [regex]::Replace($clean, '("(?:\\.|[^"\\])*")|,(?=\s*[\]}])', '$1')
    $root = ConvertFrom-Json -InputObject $clean
  }
  if ($null -eq $root -or $root.GetType().FullName -ne 'System.Management.Automation.PSCustomObject') { throw 'the file is not a JSON object' }
  $root
}

$deepSeaScheme = [ordered]@{
  name = 'Deep Sea'; background = '#06121C'; foreground = '#D8ECF7'; cursorColor = '#3FE0F0'; selectionBackground = '#1B4F66'
  black = '#0B1B2A'; red = '#FF5C7A'; green = '#3DDC97'; yellow = '#E8B44A'; blue = '#8EA7FF'; purple = '#FF5FD2'; cyan = '#3FE0F0'; white = '#D8ECF7'
  brightBlack = '#5E7E96'; brightRed = '#FF8FA3'; brightGreen = '#7EF0BE'; brightYellow = '#F5D08A'; brightBlue = '#B5C6FF'; brightPurple = '#FF9BE4'; brightCyan = '#8FF3FA'; brightWhite = '#FFFFFF'
}

# Applies Deep Sea. $record holds what each changed key was before (kept from the first install), so -Uninstall can put it back.
function Set-TerminalDeepSea([string]$path, $record) {
  $root = Read-TerminalSettings $path  # a broken file throws here, before anything is written
  $imageSrc = Join-Path (Join-Path $repo 'terminal') 'deep-sea-bg.png'
  $imageOk = Test-Path $imageSrc
  if (-not $record) {
    $record = [pscustomobject]@{ path = $path; defaults = [pscustomobject]@{}; scheme = $null; imageCopied = $false }
    Copy-Item $path "$path.bak" -Force
  }

  # The scheme replaces a "Deep Sea" that is already there, in place. Its earlier value is kept.
  $schemes = [System.Collections.ArrayList]::new()
  foreach ($s in @(Get-Prop $root 'schemes')) { if ($s) { [void]$schemes.Add($s) } }
  $index = -1
  for ($i = 0; $i -lt $schemes.Count; $i++) { if ((Get-Prop $schemes[$i] 'name') -eq 'Deep Sea') { $index = $i; break } }
  if (-not $record.scheme) {
    $prior = if ($index -ge 0) { $schemes[$index] } else { $null }
    $record.scheme = [pscustomobject]@{ present = ($index -ge 0); value = $prior }
  }
  $scheme = [pscustomobject]$deepSeaScheme
  if ($index -ge 0) { $schemes[$index] = $scheme } else { [void]$schemes.Add($scheme) }
  Set-Prop $root 'schemes' $schemes.ToArray()

  if (-not (Test-Prop $root 'profiles')) { Set-Prop $root 'profiles' ([pscustomobject]@{}) }
  $profiles = Get-Prop $root 'profiles'
  if (-not (Test-Prop $profiles 'defaults')) { Set-Prop $profiles 'defaults' ([pscustomobject]@{}) }
  $defaults = Get-Prop $profiles 'defaults'

  $wanted = [ordered]@{ colorScheme = 'Deep Sea'; cursorShape = 'underscore'; opacity = 100; useAcrylic = $false }
  if ($imageOk) {
    $imageDst = Join-Path $env:LOCALAPPDATA 'carapace\deep-sea-bg.png'
    New-Item -ItemType Directory -Force -Path (Split-Path $imageDst) | Out-Null
    Copy-Item $imageSrc $imageDst -Force
    $record.imageCopied = $true
    $wanted['backgroundImage'] = $imageDst
    $wanted['backgroundImageOpacity'] = 1.0
    $wanted['backgroundImageStretchMode'] = 'uniformToFill'
  }
  foreach ($name in $wanted.Keys) {
    if (-not (Test-Prop $record.defaults $name)) {
      Set-Prop $record.defaults $name ([pscustomobject]@{ present = (Test-Prop $defaults $name); value = (Get-Prop $defaults $name) })
    }
    Set-Prop $defaults $name $wanted[$name]
  }

  Write-Atomic $path (($root | ConvertTo-Json -Depth 100) + "`n")
  $record
}

function Restore-TerminalDeepSea($record) {
  $path = Get-Prop $record 'path'
  if (-not (Test-Path $path)) { return "Windows Terminal: $path not found, nothing restored." }
  $root = Read-TerminalSettings $path

  $defaults = Get-Prop (Get-Prop $root 'profiles') 'defaults'
  if ($defaults) {
    foreach ($p in @($record.defaults.PSObject.Properties)) {
      if ($p.Value.present) { Set-Prop $defaults $p.Name $p.Value.value }
      elseif (Test-Prop $defaults $p.Name) { $defaults.PSObject.Properties.Remove($p.Name) }
    }
  }

  $schemes = [System.Collections.ArrayList]::new()
  foreach ($s in @(Get-Prop $root 'schemes')) { if ($s -and (Get-Prop $s 'name') -ne 'Deep Sea') { [void]$schemes.Add($s) } }
  if ($record.scheme.present) { [void]$schemes.Add($record.scheme.value) }
  if ((Test-Prop $root 'schemes') -or $schemes.Count -gt 0) { Set-Prop $root 'schemes' $schemes.ToArray() }

  if ($record.imageCopied) { Remove-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'carapace\deep-sea-bg.png') -Force -ErrorAction SilentlyContinue }
  Write-Atomic $path (($root | ConvertTo-Json -Depth 100) + "`n")
  "Windows Terminal: your settings are back in $path."
}

$mods = @(Get-ChildItem (Join-Path $repo 'mods') -Directory | Where-Object Name -ne 'shared' | ForEach-Object Name)
if (-not $Uninstall) {
  Write-Output "carapace registered in $settings with $($mods.Count) mod(s): $($mods -join ', ')"
  # The Crew runs as many helpers as the lower of the two limits allows, yours where you set your own.
  $crew = ($limits.Keys | ForEach-Object {
      $value = "$($envBlock[$_])"
      if ($value -match '^\d+$' -and [int]$value -gt 0) { [int]$value } else { [int]$limits[$_] }
    } | Measure-Object -Minimum).Minimum
  Write-Output "Theme: Deep Sea. Crew: up to $crew helpers at once."
}

$terminalNote = $null
$terminalFailed = $false
if ($Uninstall) {
  if ($state.terminal) {
    try {
      $terminalNote = Restore-TerminalDeepSea $state.terminal
      $state.terminal = $null
    } catch {
      $terminalFailed = $true
      $terminalNote = "Windows Terminal not restored: $($_.Exception.Message). Fix the file and run -Uninstall again."
    }
  }
} else {
  # Only a settings file changes, so Windows Terminal is dressed by default; -NoTerminal skips it.
  $dress = -not $NoTerminal
  if ($dress -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
    if ((Read-Host 'Make Deep Sea the Windows Terminal color scheme for every profile? [Y/n]') -match '^[nN]') {
      $dress = $false
      $terminalNote = 'Windows Terminal: left alone. Run .\install.ps1 again to set it up.'
    }
  }
  $wtPath = if ($dress) { Find-TerminalSettings }
  if ($dress -and -not $wtPath) {
    $terminalNote = 'Windows Terminal: no settings.json found, skipped.'
  } elseif ($dress) {
    try {
      $state.terminal = Set-TerminalDeepSea $wtPath $state.terminal
      $terminalNote = "Windows Terminal: Deep Sea applied to $wtPath. The original is in settings.json.bak; comments in that file are not kept."
    } catch {
      $terminalNote = "Windows Terminal left untouched: $($_.Exception.Message)"
    }
  }
}

if (-not $Uninstall) {
  if (-not $NoPonytail -or ($wanted -contains 'ponytail')) { Install-Ponytail }
  if ($wanted -contains 'gstack') { Install-Gstack }
  if ($wanted -contains 'rea') { Install-Rea }
  if ($wanted -contains 'hookify') { Install-Official 'hookify' }
  if ($wanted -contains 'security-guidance') { Install-Official 'security-guidance' }
  if ($wanted -contains 'writing-rules') { Install-Writing-rules }
} else {
  Remove-Ponytail
  Remove-Gstack
  Remove-Rea
  Remove-Hookify
  Remove-Security-guidance
  Remove-Writing-rules
}

if ($Uninstall) {
  if ((Test-Path $statePath) -and -not $terminalFailed) { Remove-Item $statePath -Force }
  Write-Output "Removed carapace from $settings and put your theme back."
  if (Test-Path "$settings.carapace-orig") { Write-Output "The copy from before the first install is kept as $settings.carapace-orig (known good)." }
} else {
  Write-State
}
if ($terminalNote) { Write-Output $terminalNote }
$notes | ForEach-Object { Write-Output $_ }
# Offer only the add-ons that are neither recorded nor already on the machine (installed by hand counts as there).
function Test-AddonPresent([string]$id) {
  switch ($id) {
    'rea' { Test-Cmd 'rea' }
    'gstack' { Test-Path -LiteralPath $gstackDir }
    'writing-rules' { $false }
    default { Test-PluginListed $id }
  }
}
$missing = @('rea', 'gstack', 'hookify', 'security-guidance', 'writing-rules') | Where-Object { -not $state[$_] -and -not (Test-AddonPresent $_) }
if (-not $Uninstall -and $missing) {
  $names = ($missing | ForEach-Object { if ($_ -eq 'rea') { 'REA' } else { $_ } }) -join ', '
  Write-Output "Optional add-ons: $names. Add them from the Shipyard (/mods) or with -With $($missing -join ',')."
}
if ($Uninstall) { Write-Output 'Start a new Claude Code session (or claude --resume) to apply the change.' }
else { Write-Output 'Open a new Claude Code session. Setup asks a few questions the first time.' }
