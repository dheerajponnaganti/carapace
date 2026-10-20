// Pure helpers for the test-output trimmer: which commands are runs, and which lines of a long log to keep.
import { isCheckCommand } from '../shared/checks'

export const MAX_LINES = 60
export const MAX_CHARS = 4000
const CONTEXT_BEFORE = 3
const CONTEXT_AFTER = 8
const HEAD = 3
const TAIL = 15
const KEEP_CAP = 150

/** True when some step of the shell line is a known test, build or lint run: the shared list, so every mod agrees. */
export const isRunCommand = isCheckCommand

/** True when the command contains one of the person's skip words or phrases, as whole words. */
export function hasSkipWord(command: string, words: string[]): boolean {
  const have = ` ${command.split(/[\s;&|]+/).join(' ')} `

  return words.some(w => w.trim() !== '' && have.includes(` ${w.trim().split(/\s+/).join(' ')} `))
}

export function isLong(text: string): boolean {
  return text.length > MAX_CHARS || text.split('\n').length > MAX_LINES
}

const STRICT = /\b(?:FAIL|FAILED|ERROR)\b|Error:|error\[|panicked|Traceback|AssertionError|expect\(|✗|✕|×|^not ok/

function isSignal(line: string): boolean {
  return STRICT.test(line) || /deprecated|warning:/i.test(line)
}

const n = (x: number) => x.toLocaleString('en-US')

/** Keeps failure lines with context, the first and last lines, and collapses the rest. Null when trimming would not shrink it. */
export function trimText(text: string, logPath: string): string | null {
  const lines = text.split('\n')
  const hits: number[] = []
  const strict: number[] = []
  const soft: number[] = []
  lines.forEach((l, i) => {
    if (!isSignal(l)) return
    hits.push(i)
    ;(STRICT.test(l) ? strict : soft).push(i)
  })
  // Real failures before warnings, so early warnings never push a failure out.
  const ranked = [...strict, ...soft]
  const build = (use: number[]) => {
    const keep = new Array<boolean>(lines.length).fill(false)
    const mark = (a: number, b: number) => {
      for (let i = Math.max(0, a); i <= Math.min(lines.length - 1, b); i++) keep[i] = true
    }
    mark(0, HEAD - 1)
    mark(lines.length - TAIL, lines.length - 1)
    for (const i of use) mark(i - CONTEXT_BEFORE, i + CONTEXT_AFTER)

    return keep
  }
  const kept = (n: number) => build(ranked.slice(0, n)).filter(Boolean).length
  // The most signal lines that still fit the cap.
  let lo = 0
  let hi = ranked.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (kept(mid) <= KEEP_CAP) lo = mid
    else hi = mid - 1
  }
  const used = ranked.slice(0, lo)
  const keep = build(used)
  const out: string[] = []
  let hidden = 0
  const flush = () => {
    if (hidden > 0) out.push(`… ${n(hidden)} lines hidden (full log: ${logPath}) …`)
    hidden = 0
  }
  lines.forEach((l, i) => {
    if (keep[i]) {
      flush()
      out.push(l)
    } else hidden++
  })
  flush()
  if (used.length < hits.length) out.push(`… ${n(hits.length - used.length)} more failure lines hidden (full log: ${logPath}) …`)
  const res = out.join('\n')

  return res.length < text.length ? res : null
}

export function logName(at: number, command: string): string {
  const short = command.trim().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'run'

  return `${at}-${short}.log`
}

export const estTokens = (chars: number) => Math.round(chars / 4)

export function savedText(tokens: number, runs: number): string {
  const t = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

  return `saved ~${t} tokens this session (${runs} run${runs === 1 ? '' : 's'})`
}
