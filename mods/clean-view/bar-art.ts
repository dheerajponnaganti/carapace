// Pure pieces of the Clean View bar: the tide, the rise, the dive log, the wipe, the easing and the refill time. No engine calls here.
import { cells as textCells, cutCells } from '../shared/look'

export const TIDE_GLYPHS = ['▁', '▂', '▃', '▄', '▅'] as const
export type TideCell = { glyph: string; high: boolean }

const RIPPLE = 0.9
const HIGH_CELL = 3.2
const TIDE_TOP = 4.4

/** The tide's level: an empty context sits low, a full one sits high. */
export function tideLevel(context: number): number {
  return 0.6 + (Math.min(100, Math.max(0, context)) / 100) * 3.2
}

/** One wave per column: its height is the level plus a sine ripple that rolls with `phase`. `high` marks the crest cells. */
export function tide(width: number, level: number, phase: number): TideCell[] {
  return Array.from({ length: Math.max(0, width) }, (_, i) => {
    const height = level + Math.sin((i + phase) / 3.2) * RIPPLE
    const index = Math.min(4, Math.max(0, Math.round(height)))

    return { glyph: TIDE_GLYPHS[index] ?? '▁', high: height > HIGH_CELL }
  })
}

export const RISE_FRAMES = 8
export const RISE_FRAME_MS = 250

/** Which of the eight surfacing frames is showing, from the time since the rise began. */
export function riseStep(elapsedMs: number): number {
  return Math.min(RISE_FRAMES, Math.max(0, Math.floor(elapsedMs / RISE_FRAME_MS)))
}

export function riseLevel(step: number): number {
  return Math.min(TIDE_TOP, step * 0.6)
}

export function riseDots(step: number): string {
  return '·'.repeat(step * 5)
}

/** A look's checklist ruler: the first mark, the step between rows, and the unit (0 m, 12 m, 24 m). */
export type Ruler = { first: number; step: number; unit: string }
const SEA_RULER: Ruler = { first: 0, step: 12, unit: ' m' }

/** Cells the ruler needs for a list of this many rows: four, or more once a label like 108 m appears. */
export function depthLabelWidth(count: number, ruler: Ruler = SEA_RULER): number {
  return Math.max(4, String(ruler.first + Math.max(0, count - 1) * ruler.step).length + ruler.unit.length)
}

/** The ruler label before a checklist row, right-aligned in `width` cells, then a space. */
export function depthLabel(row: number, width = 4, ruler: Ruler = SEA_RULER): string {
  return `${String(ruler.first + row * ruler.step).concat(ruler.unit).padStart(width)} `
}

/** Merges runs of adjacent cells with the same color into one piece, so a row draws a few Text nodes, not one per cell. */
export function mergeRuns(cells: { text: string; color: string | undefined }[]): { text: string; color: string | undefined }[] {
  const runs: { text: string; color: string | undefined }[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color) last.text += cell.text
    else runs.push({ ...cell })
  }

  return runs
}

/** The wide connector: the first row hangs from the top, the last row closes, a single row runs straight. */
export function diveConnector(row: number, count: number): string {
  if (count <= 1) return '──  '
  if (row === 0) return '─┬─ '
  if (row === count - 1) return ' └─ '

  return ' ├─ '
}

/** The narrow connector, three cells wide. The first row joins the top. */
export function narrowConnector(row: number, count: number): string {
  if (row === 0 && count > 1) return '┬─ '

  return row === count - 1 ? '└─ ' : '├─ '
}

export const WIPE_MS = 500

/** A new step draws in from left to right: the first part of its name shows until the wipe ends. */
export function wipeName(name: string, addedAt: number | undefined, now: number): string {
  if (addedAt === undefined || now - addedAt >= WIPE_MS) return name

  return cutCells(name, Math.ceil((textCells(name) * Math.max(0, now - addedAt)) / WIPE_MS))
}

export const EASE_MS = 1000

/** The gauge value part way through an ease from `from` to `to`, slowing as it lands. */
export function easedValue(from: number, to: number, elapsedMs: number, durationMs = EASE_MS): number {
  const t = Math.min(1, Math.max(0, elapsedMs / durationMs))

  return from + (to - from) * (1 - (1 - t) ** 3)
}

/** The local clock time a refill comes, as "4:10 pm". Empty when the time is missing or unreadable. */
export function refillTime(iso: string | null): string {
  if (iso === null) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const hour = at.getHours()
  const minute = String(at.getMinutes()).padStart(2, '0')

  return String(hour % 12 || 12) + ':' + minute + ' ' + (hour < 12 ? 'am' : 'pm')
}
