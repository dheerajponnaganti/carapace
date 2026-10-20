// Pure helpers for Logbook: where a vault can live, what the index block holds, and how a Build Log line is written.

export const HOME_NOTE = '00 Home.md'
export const LOG_NOTE = '02 Build Log.md'
export const PENDING_NOTE = '09 Pending Work.md'
export const INDEX_WARN_LINES = 80
export const MAX_OPEN = 40
export const MAX_INDEX_TOKENS = 2500
const MAX_NAMES = 5

export type Place = { id: string; label: string; dir: string }

/**
 * Where a new vault can live: cloud folders found on this machine, then this computer. `exists` answers for the
 * folders in `candidates(home)`; `cloudStorage` is the names in ~/Library/CloudStorage (macOS keeps Google Drive,
 * OneDrive and Dropbox there).
 */
export function places(home: string, exists: (dir: string) => boolean, cloudStorage: readonly string[]): Place[] {
  const mac = `${home}/Library`
  const found: Place[] = []
  const add = (id: string, label: string, root: string, sub = '/carapace-vaults', isListed = false) => {
    if ((isListed || exists(root)) && !found.some(p => p.id === id)) found.push({ id, label, dir: `${root}${sub}` })
  }
  // Obsidian on iPhone and iPad only sees vaults in its own iCloud folder, so that one comes first.
  add('icloud', 'iCloud (Obsidian)', `${mac}/Mobile Documents/iCloud~md~obsidian/Documents`, '')
  add('icloud', 'iCloud Drive', `${mac}/Mobile Documents/com~apple~CloudDocs`)
  add('icloud', 'iCloud Drive', `${home}/iCloudDrive`)
  for (const name of cloudStorage) {
    // Listed by the folder itself, so they exist.
    if (name.startsWith('GoogleDrive-')) add('gdrive', 'Google Drive', `${mac}/CloudStorage/${name}/My Drive`, '/carapace-vaults', true)
    else if (name.startsWith('OneDrive')) add('onedrive', 'OneDrive', `${mac}/CloudStorage/${name}`, '/carapace-vaults', true)
    else if (name.startsWith('Dropbox')) add('dropbox', 'Dropbox', `${mac}/CloudStorage/${name}`, '/carapace-vaults', true)
  }
  add('gdrive', 'Google Drive', `${home}/My Drive`)
  add('gdrive', 'Google Drive', `${home}/Google Drive`)
  add('onedrive', 'OneDrive', `${home}/OneDrive`)
  add('dropbox', 'Dropbox', `${home}/Dropbox`)
  found.push({ id: 'local', label: 'This computer only', dir: `${home}/Documents/carapace-vaults` })

  return found
}

/** The folders `places` checks before cloudStorage entries, for the caller to test. */
export function candidates(home: string): string[] {
  const mac = `${home}/Library`

  return [
    `${mac}/Mobile Documents/iCloud~md~obsidian/Documents`,
    `${mac}/Mobile Documents/com~apple~CloudDocs`,
    `${home}/iCloudDrive`,
    `${home}/My Drive`,
    `${home}/Google Drive`,
    `${home}/OneDrive`,
    `${home}/Dropbox`,
  ]
}

/** The project's name as a folder name: the last part of its path. */
export function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/[^\w .-]+/g, '-') || 'project'
}

/** The unchecked `- [ ]` lines of a note, trimmed, at most `max`. */
export function openItems(text: string, max = MAX_OPEN): string[] {
  return text
    .split('\n')
    .filter(l => /^\s*- \[ \] /.test(l))
    .map(l => l.trim())
    .slice(0, max)
}

export const estTokens = (text: string) => Math.ceil(text.length / 4)

export type Index = { text: string; lines: number; tokens: number; isWhole: boolean; open: number }

/** The block Claude gets at the start: Home in full, then the open items, cut at the token cap. */
export function indexBlock(vault: string, home: string, items: readonly string[]): Index {
  const lines = home.trimEnd().split('\n').length
  const head = `The user's Logbook: an Obsidian vault at ${vault}. Its Home note (the index) follows. Read a linked note (as "${vault}/<name>.md") when the work touches it. The code and the files on disk win over a note.`
  const open = items.length > 0 ? `\n\nOpen items from ${PENDING_NOTE.replace(/\.md$/, '')}:\n${items.join('\n')}` : ''
  const full = `${head}\n\n${home.trimEnd()}${open}`
  const cap = MAX_INDEX_TOKENS * 4
  const isWhole = full.length <= cap
  const text = isWhole ? full : `${full.slice(0, cap)}\n[cut: the index is over ${MAX_INDEX_TOKENS} tokens; shorten ${HOME_NOTE}]`

  return { text, lines, tokens: estTokens(text), isWhole, open: items.length }
}

/** The one dim line shown at session start. */
export function loadedLine(notes: number, ix: Index): string {
  const size = ix.tokens >= 1000 ? `${(ix.tokens / 1000).toFixed(1)}k` : String(ix.tokens)
  const warn = ix.lines > INDEX_WARN_LINES ? ` · Home is over ${INDEX_WARN_LINES} lines` : ''

  return `logbook: ${notes} notes · index ${ix.lines} lines · ${ix.open} open items · ${size} tokens · ${ix.isWhole ? 'loaded whole' : 'CUT, see /logbook'}${warn}`
}

/** What carapace saw during a job. Nothing here comes from Claude's own words. */
export type Facts = { wrote: string[]; fetched: string[]; checks: { command: string; isPass: boolean }[]; commits: string[] }

export const noFacts = (): Facts => ({ wrote: [], fetched: [], checks: [], commits: [] })

/** Short jobs that changed nothing are not logged. */
export const isWorthLogging = (f: Facts) => f.wrote.length > 0 || f.fetched.length > 0 || f.commits.length > 0

/** A path relative to the project when it is inside it. */
export function shortPath(path: string, cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '') + '/'

  return path.startsWith(base) ? path.slice(base.length) : path
}

const names = (list: readonly string[]) => {
  const uniq = [...new Set(list)]

  return uniq.slice(0, MAX_NAMES).join(', ') + (uniq.length > MAX_NAMES ? ` +${uniq.length - MAX_NAMES} more` : '')
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** One Build Log bullet: time, job, steps, then facts only, tagged observed. */
export function logLine(time: string, title: string, done: number, total: number, f: Facts): string {
  const parts = [time, oneLine(title).slice(0, 80) || 'Work']
  if (total > 0) parts.push(`${done} of ${total} steps`)
  if (f.wrote.length > 0) parts.push(`changed: ${names(f.wrote)}`)
  const pages = new Set(f.fetched).size
  if (pages > 0) parts.push(`fetched: ${pages} page${pages === 1 ? '' : 's'}`)
  // The last run of each command is its result.
  const last = new Map(f.checks.map(c => [oneLine(c.command).slice(0, 40), c.isPass]))
  const checks = [...last].slice(-2).map(([c, ok]) => `${c} ${ok ? 'passed' : 'failed'}`)
  if (checks.length > 0) parts.push(`checks: ${checks.join(', ')}`)
  if (f.commits.length > 0) parts.push(`commit ${[...new Set(f.commits)].join(', ')}`)
  parts.push('observed')

  return `- ${parts.join(' · ')}`
}

/** The short sha from `git commit` output (`[main a1b2c3d] message`), or null. */
export function commitSha(stdout: string): string | null {
  return /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]/m.exec(stdout)?.[1] ?? null
}

/**
 * The Build Log with `line` as the newest bullet under `## date`. A missing day goes above the newest day; with no
 * days at all it goes at the end. Every other line stays byte for byte.
 */
export function insertLog(text: string, date: string, line: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.trimEnd() === `## ${date}`)
  if (at >= 0) {
    let i = at + 1
    while (i < lines.length && lines[i]?.trim() === '') i++
    // A day heading straight after this one: the day was empty.
    if (i >= lines.length || lines[i]?.startsWith('#')) lines.splice(at + 1, i - at - 1, '', line, '')
    else lines.splice(i, 0, line)

    return lines.join('\n')
  }
  const day = lines.findIndex(l => /^## \d{4}-\d{2}-\d{2}\s*$/.test(l))
  if (day >= 0) {
    lines.splice(day, 0, `## ${date}`, '', line, '')

    return lines.join('\n')
  }
  const body = text.replace(/\n*$/, '')

  return `${body}${body === '' ? '' : '\n\n'}## ${date}\n\n${line}\n`
}

/** A new vault's three notes. */
export function starterNotes(project: string, date: string): Record<string, string> {
  return {
    [HOME_NOTE]: `# ${project}\n\nThe index of this Logbook. Keep it short: one line per note, with a link.\n\n- [[02 Build Log]]: what got done, newest first (Logbook writes it)\n- [[09 Pending Work]]: what is still open\n`,
    [LOG_NOTE]: `# Build Log\n\nNewest first. Lines tagged observed are written by Logbook from what it saw.\n\n## ${date}\n\n- Logbook set up.\n`,
    [PENDING_NOTE]: `# Pending Work\n\nOpen items (\`- [ ]\`) load with the index at the start of each session.\n\n`,
  }
}

/** obsidian:// link that opens the vault folder in Obsidian. */
export const obsidianUrl = (vault: string) => `obsidian://open?path=${encodeURIComponent(vault)}`
