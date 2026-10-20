// Pure helpers for Clean View. Nothing here calls the engine, so tests import it directly.

// Shell commands that can destroy data or open the machine up. A warning only: nothing is blocked.
const RISKY: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+-\S*[rR]\S*[fF]|\brm\s+-\S*[fF]\S*[rR]/, label: 'rm -rf' },
  { pattern: /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:\/|~)(?!\S)/, label: 'rm -r on /' },
  { pattern: /\bgit\s+push\b.*\s(?:--force|-f)(?!\S)/, label: 'git push --force' },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
  { pattern: /\bgit\s+clean\b.*\s-\S*f/, label: 'git clean -f' },
  { pattern: /\bsudo\b/, label: 'sudo' },
  { pattern: /\bchmod\s+-R\s+777\b/, label: 'chmod -R 777' },
  { pattern: /\bmkfs(?:\.\w+)?\b/, label: 'mkfs' },
  { pattern: /\bdd\s+if=/, label: 'dd if=' },
  { pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/, label: 'curl or wget piped into a shell' },
  { pattern: /\bDROP\s+TABLE\b/i, label: 'DROP TABLE' },
  { pattern: /(?:^|[;&|]\s*)truncate\b|\bTRUNCATE\s+TABLE\b/i, label: 'truncate' },
]

/** The name of the first risky pattern a shell command matches, or null when none does. */
export function riskyReason(command: unknown): string | null {
  if (typeof command !== 'string') return null
  const hit = RISKY.find(({ pattern }) => pattern.test(command))

  return hit ? hit.label : null
}

/** The osascript argv that raises a macOS notification. Backslashes and double quotes in the text are escaped. */
export function osaNotifyArgv(text: string, title = 'carapace'): string[] {
  const BS = String.fromCharCode(92)
  const DQ = String.fromCharCode(34)
  const esc = (raw: string) => raw.split(BS).join(BS + BS).split(DQ).join(BS + DQ)
  const quoted = (raw: string) => DQ + esc(raw) + DQ

  return ['osascript', '-e', 'display notification ' + quoted(text) + ' with title ' + quoted(title)]
}
