// The repeat-prompt miner, without `$`: reads Claude Code's prompt history, groups near-duplicates, names a slash command.

export type RepeatGroup = { text: string; count: number }

const MIN_CHARS = 20
const MAX_CHARS = 1500
const SAME = 0.7
// shortcut: only the most recent prompts are grouped (pairwise comparison), raise it only with a faster grouping.
const RECENT = 400

/** The prompts in a history.jsonl text (one JSON object per line, the prompt in `display`). Slash commands, short and pasted-size entries are dropped. */
export function parseHistory(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    try {
      const shown = String((JSON.parse(line) as { display?: unknown }).display ?? '').trim()
      if (shown.length >= MIN_CHARS && shown.length <= MAX_CHARS && !shown.startsWith('/')) out.push(shown)
    } catch {
      // a half-written or blank line
    }
  }

  // The whole history can hold thousands of prompts; grouping all of them stalled the hooks worker past its 5 s heartbeat.
  return out.slice(-RECENT)
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])

/** Word overlap of two prompts, 0 to 1 (shared words over all words). */
export function similarity(a: string, b: string): number {
  return overlap(words(a), words(b))
}

function overlap(x: Set<string>, y: Set<string>): number {
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++

  return shared / (x.size + y.size - shared)
}

/** Groups prompts whose word overlap is 0.7 or more, keeps groups of two or more, biggest first. A group shows its most recent wording (the list is oldest first). */
export function groupRepeats(prompts: readonly string[], top = 3): RepeatGroup[] {
  // Each prompt is split into words once; a group compares against the words of its first prompt.
  const groups: (RepeatGroup & { set: Set<string> })[] = []
  for (const p of prompts) {
    const set = words(p)
    const hit = groups.find(g => overlap(g.set, set) >= SAME)
    if (hit) {
      hit.count++
      hit.text = p
    } else {
      groups.push({ text: p, count: 1, set })
    }
  }

  return groups.filter(g => g.count > 1).sort((a, b) => b.count - a.count).slice(0, top).map(({ text, count }) => ({ text, count }))
}

/** A command name from the prompt's first few words, free of every name in `taken`. */
export function commandName(prompt: string, taken: readonly string[]): string {
  const base = [...(prompt.toLowerCase().match(/[a-z0-9]+/g) ?? [])].slice(0, 3).join('-') || 'prompt'
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`

  return name
}

/** The text of the slash command file: a one-line description, then the prompt. */
export function commandFile(prompt: string): string {
  const description = prompt.replace(/\s+/g, ' ').slice(0, 60).replace(/:/g, ' ').trim()

  return `---\ndescription: ${description}\n---\n\n${prompt}\n`
}
