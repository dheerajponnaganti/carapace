// The update check, without `$`: when to look, how to read git's answers, what to tell the person.

/** Look for updates at most this often, at the start of a chat. `/mods check` looks right away. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export type UpdateInfo = { behind: number; subject: string; checkedAt: number }

export function isDue(lastCheckAt: unknown, now: number): boolean {
  return typeof lastCheckAt !== 'number' || now - lastCheckAt >= CHECK_EVERY_MS
}

/** `git rev-list --count HEAD..@{u}` prints one number; anything else counts as nothing new. */
export function parseCount(stdout: string): number {
  const n = Number.parseInt(stdout.trim(), 10)

  return Number.isFinite(n) && n > 0 ? n : 0
}

export function changes(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`
}

export function updateNotice(info: UpdateInfo): string {
  const latest = info.subject ? ` Latest: ${info.subject}.` : ''

  return `carapace update ready: ${changes(info.behind)}.${latest} Press ↑ Update in the bar or type /mods update.`
}

/** Files whose change needs the installer run again; mods, themes and notes reload by themselves. */
export function needsInstaller(changedFiles: string): boolean {
  return changedFiles.split('\n').some(f => /^(install\.(sh|ps1)|terminal\/)/.test(f.trim()))
}

/** The installer command for the clone at `top`: install.ps1 on Windows (a drive letter), install.sh elsewhere. */
export function installerCommand(top: string): string {
  return /^[A-Za-z]:[\\/]/.test(top)
    ? `powershell -ExecutionPolicy Bypass -File "${top}\\install.ps1"`
    : `${top}/install.sh`
}

/** What the person reads after an update. */
export function updatedText(count: number, changedFiles: string, top: string): string {
  const base = `carapace updated: ${changes(count)}. The mods reload by themselves.`

  return needsInstaller(changedFiles) ? `${base} The installer changed too: run ${installerCommand(top)} once to apply it.` : base
}
