// What the edit time machine decides without touching the engine. No `$` here, so tests import it directly.

import type { TimeSnap } from '../../types'

export const MAX_SNAPS = 200
export const MAX_AGE_MS = 7 * 86_400_000

// What counts as a check is shared with the trimmer and Logbook.
export { isCheckCommand } from '../shared/checks'

/** A short stable name for a project folder: its last folder name and a 32-bit hash of the whole path. */
export function repoHash(root: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < root.length; i++) h = Math.imul(h ^ root.charCodeAt(i), 0x01000193) >>> 0
  const name = (root.split('/').filter(Boolean).pop() ?? 'root').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24)

  return `${name}-${h.toString(16).padStart(8, '0')}`
}

export function storeDir(home: string, root: string): string {
  return `${home}/.claude/carapace/snapshots/${repoHash(root)}.git`
}

/** The label a snapshot carries: the file for a file tool, the first line of the command for Bash. */
export function labelOf(tool: string, input: { file_path?: unknown; notebook_path?: unknown; command?: unknown }): string {
  const raw = tool === 'Bash' ? input.command : (input.file_path ?? input.notebook_path)
  const text = typeof raw === 'string' ? (raw.split('\n')[0] ?? '') : ''
  const short = tool === 'Bash' ? text : (text.split('/').pop() ?? text)

  return `${tool} ${short.length > 48 ? short.slice(0, 47) + '…' : short}`.trim()
}

/** Which snapshots to drop: older than 7 days, then the oldest beyond 200. Oldest first in and out. */
export function pruneDrop(snaps: readonly TimeSnap[], now: number, maxCount = MAX_SNAPS, maxAge = MAX_AGE_MS): TimeSnap[] {
  const fresh = snaps.filter(s => now - s.at <= maxAge)
  const over = Math.max(0, fresh.length - maxCount)
  const keep = new Set(fresh.slice(over).map(s => s.sha))

  return snaps.filter(s => !keep.has(s.sha))
}

/** For each snapshot where a failing check first passed, the snapshot where the check last failed. */
export function fixedBy(snaps: readonly TimeSnap[]): Record<string, string> {
  const fixes: Record<string, string> = {}
  let failedAt: string | null = null
  for (const s of snaps) {
    if (s.check === 'fail') failedAt = s.sha
    else if (s.check === 'pass' && failedAt !== null) {
      fixes[s.sha] = failedAt
      failedAt = null
    }
  }

  return fixes
}

/** The command a snapshot's check result belongs to. */
const checkOf = (s: TimeSnap) => s.checkCommand ?? s.label

export type Broke = { good: TimeSnap; first: TimeSnap; edits: TimeSnap[] }

/**
 * When `command` fails on the last snapshot: the last snapshot where it passed, and the snapshots (edits) since. Null
 * when it never passed or nothing changed since (that is the flaky case).
 */
export function brokeSince(snaps: readonly TimeSnap[], command: string): Broke | null {
  let j = snaps.length - 2
  while (j >= 0 && !(snaps[j]?.check === 'pass' && checkOf(snaps[j] as TimeSnap) === command)) {
    // An earlier failure of the same command: the break is older than this run, and was named then.
    if (snaps[j]?.check === 'fail' && checkOf(snaps[j] as TimeSnap) === command) return null
    j--
  }
  if (j < 0) return null
  const edits = snaps.slice(j + 1)

  return edits.length > 0 ? { good: snaps[j] as TimeSnap, first: edits[0] as TimeSnap, edits } : null
}

/** For each snapshot where a passing check first failed: what broke it. */
export function brokeBy(snaps: readonly TimeSnap[]): Record<string, Broke> {
  const out: Record<string, Broke> = {}
  snaps.forEach((s, i) => {
    if (s.check !== 'fail') return
    const b = brokeSince(snaps.slice(0, i + 1), checkOf(s))
    if (b) out[s.sha] = b
  })

  return out
}

const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
const short = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s)

/** What Claude is told after a check: who broke it, or that the check is flaky. Null when there is nothing to say. */
export function checkNote(snaps: readonly TimeSnap[], command: string, check: 'pass' | 'fail', isFlaky: boolean): string | null {
  if (isFlaky) {
    const was = check === 'pass' ? 'failed' : 'passed'

    return `carapace: \`${short(command)}\` ${was} and now ${check === 'pass' ? 'passes' : 'fails'} with no project file changed in between: it is flaky, or it depends on something outside the files (time, network, leftover state). Do not change code to make it pass; tell the person.`
  }
  if (check !== 'fail') return null
  const b = brokeSince(snaps, command)
  if (b === null) return null
  const files = [...new Set(b.edits.map(e => e.label))]
  const list = files.slice(0, 6).join(', ') + (files.length > 6 ? ` and ${files.length - 6} more` : '')

  return `carapace: \`${short(command)}\` passed at ${hhmm(b.good.at)} and fails now. Changed since then: ${list}. The first change after the pass was "${b.first.label}" at ${hhmm(b.first.at)}; start there. The person can restore the ${hhmm(b.good.at)} snapshot from the Work Report Timeline.`
}

export type PromptGroup = { prompt: number; text: string; snaps: TimeSnap[] }

/** Snapshots from the given day, grouped by the prompt that led to them, newest prompt first. */
export function groupByPrompt(snaps: readonly TimeSnap[], dayStart: number): PromptGroup[] {
  const groups = new Map<number, PromptGroup>()
  for (const s of snaps) {
    if (s.at < dayStart) continue
    const g = groups.get(s.prompt) ?? { prompt: s.prompt, text: s.promptText, snaps: [] }
    g.snaps.push(s)
    groups.set(s.prompt, g)
  }

  return [...groups.values()].sort((a, b) => b.prompt - a.prompt)
}

export function sizeText(kib: number): string {
  return kib >= 1024 ? `${(kib / 1024).toFixed(1)} MB` : `${kib} KB`
}
