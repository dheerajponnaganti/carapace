# carapace's status line command (Windows). Same job as statusline.py: keep the session id, prompt_cache and
# rate_limits in ~/.claude/carapace/statusline.json (atomic write) for the footer, and print nothing.
try {
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $keep = [ordered]@{}
  foreach ($k in 'session_id', 'prompt_cache', 'rate_limits') { if ($data.PSObject.Properties[$k]) { $keep[$k] = $data.$k } }
  $folder = Join-Path (Join-Path $HOME '.claude') 'carapace'
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $tmp = Join-Path $folder "statusline.json.$PID.tmp"
  [IO.File]::WriteAllText($tmp, ($keep | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination (Join-Path $folder 'statusline.json') -Force
} catch { }
