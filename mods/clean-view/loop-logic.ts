// Pure loop detection for Clean View's bar. Nothing here calls the engine, so tests import it directly.

export type LoopKind = 'command' | 'error' | 'edit'

/** One finished tool call. `command` is set for Bash, `file` and `after` for Edit and Write. */
export type LoopEvent = { tool: string; isError: boolean; text: string; command?: string; file?: string; after?: string }
export type Loop = { kind: LoopKind; tries: number; line: string }

const TRIES = 3
const SAME = 0.8
const KEEP = 40

/** Numbers, timestamps, hashes and paths replaced by placeholders, so two runs of one failure compare equal. */
export function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '<time>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hash>')
    .replace(/(?:~|\.{0,2})?\/[^\s'"`:()]+/g, '<path>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Share of words two texts have in common, 0 to 1. A simple word-set measure: order is ignored. */
export function similarity(a: string, b: string): number {
  const left = new Set(normalise(a).split(' ').filter(Boolean))
  const right = new Set(normalise(b).split(' ').filter(Boolean))
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1

  return shared / (left.size + right.size - shared)
}

/** The first non-empty line of an error, trimmed. */
export function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

/** The history after one more call. Callers keep it per agent (the main session, or an agentId) and clear it when the turn ends. */
export function push(history: readonly LoopEvent[], event: LoopEvent): LoopEvent[] {
  return [...history, event].slice(-KEEP)
}

/** The loop the newest event belongs to, or null. A newer result that does not extend a loop clears it. */
export function detect(history: readonly LoopEvent[]): Loop | null {
  const last = history[history.length - 1]
  if (!last) return null

  if (last.file !== undefined && last.after !== undefined) {
    const afters = history.filter(ev => ev.file === last.file && ev.after !== undefined).map(ev => ev.after)
    const n = afters.length
    if (n >= 4 && afters[n - 1] === afters[n - 3] && afters[n - 2] === afters[n - 4] && afters[n - 1] !== afters[n - 2]) {
      return { kind: 'edit', tries: n >= 4 ? flips(afters) : 0, line: `${last.file} keeps flipping between two versions` }
    }

    return null
  }

  if (!last.isError) return null
  const line = firstLine(last.text)
  if (last.command !== undefined) {
    const key = normalise(last.command)
    const same = history.filter(ev => ev.isError && ev.command !== undefined && normalise(ev.command) === key).length
    if (same >= TRIES) return { kind: 'command', tries: same, line }
  }
  let run = 0
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const ev = history[i]
    if (!ev || !ev.isError || similarity(ev.text, last.text) < SAME) break
    run += 1
  }

  return run >= TRIES ? { kind: 'error', tries: run, line } : null
}

// Edits in the trailing A,B,A,B... chain.
function flips(afters: readonly (string | undefined)[]): number {
  let n = 2
  while (n < afters.length && afters[afters.length - 1 - n] === afters[afters.length - 1 - (n % 2)]) n += 1

  return n
}
