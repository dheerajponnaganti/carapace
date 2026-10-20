import { GLYPH } from '../shared/look'

/** One tool the Shipyard holds. `action` is for a tool that is added before it can be pinned: REA. */
export type Tool = { id: string; glyph: string; label: string; desc: string; action?: string }

/** The single list of tools. Order here is the order of rows in the Shipyard. */
export const TOOLS: readonly Tool[] = [
  { id: 'crew', glyph: GLYPH.dock, label: 'Crew', desc: 'Your helpers and what they are doing' },
  { id: 'report', glyph: GLYPH.report, label: 'Work Report', desc: 'What got done today and this year' },
  { id: 'refine', glyph: GLYPH.upgrade, label: 'Refine', desc: 'Sharpen a prompt before you send it' },
  { id: 'clean', glyph: GLYPH.clean, label: 'Clean View', desc: 'Hide technical details' },
  { id: 'logbook', glyph: GLYPH.logbook, label: 'Logbook', desc: 'Your work\'s memory in an Obsidian vault' },
  { id: 'rea', glyph: GLYPH.rea, label: 'REA', desc: 'Reverse engineer apps', action: 'Add' },
]

export const MAX_PINS = 5
/** In bar order. */
export const DEFAULT_PINS: readonly string[] = ['crew', 'refine', 'clean', 'logbook', 'report']
export const PINS_KEY = 'deckPins'
export const FULL_TEXT = `The bar holds ${MAX_PINS} pins. Unpin one first.`

const ALIASES: Record<string, string> = {
  dock: 'crew',
  'agent-dock': 'crew',
  'work-report': 'report',
  workreport: 'report',
  upgrade: 'refine',
  prompt: 'refine',
  'prompt-upgrade': 'refine',
  'clean-view': 'clean',
  cleanview: 'clean',
}

/** A typed tool name to its id, or null when it is not a tool. */
export function toolId(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, '-')
  const id = ALIASES[key] ?? key

  return TOOLS.some(t => t.id === id) ? id : null
}

/** What was stored, or the defaults when nothing was. Unknown names and repeats are dropped; the cap holds. */
export function readPins(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [...DEFAULT_PINS]
  const known = stored.filter((id, i): id is string => typeof id === 'string' && TOOLS.some(t => t.id === id) && stored.indexOf(id) === i)

  return known.slice(0, MAX_PINS)
}

/** Store key: set once the new Logbook pin was offered, so unpinning it sticks. */
export const LOGBOOK_PIN_KEY = 'logbookPinOffered'

/** Pins an existing setup gets once when Logbook arrives: Logbook goes last when a slot is free. */
export function withLogbook(pins: readonly string[]): string[] {
  return pins.includes('logbook') || pins.length >= MAX_PINS ? [...pins] : [...pins, 'logbook']
}

/** Store key: set once the fifth slot brought Report back to an existing bar, so unpinning it sticks. */
export const REPORT_PIN_KEY = 'reportPinOffered'

/** Pins an existing setup gets once when the bar grows to five: Report goes last when a slot is free. */
export function withReport(pins: readonly string[]): string[] {
  return pins.includes('report') || pins.length >= MAX_PINS ? [...pins] : [...pins, 'report']
}

export type PinResult = { pins: string[]; outcome: 'pinned' | 'unpinned' | 'already' | 'not pinned' | 'full' }

/** Pins or unpins one tool. A new pin goes last; a fifth is refused. */
export function setPin(pins: readonly string[], id: string, isPinned: boolean): PinResult {
  const has = pins.includes(id)
  if (isPinned) {
    if (has) return { pins: [...pins], outcome: 'already' }
    if (pins.length >= MAX_PINS) return { pins: [...pins], outcome: 'full' }

    return { pins: [...pins, id], outcome: 'pinned' }
  }

  return has ? { pins: pins.filter(p => p !== id), outcome: 'unpinned' } : { pins: [...pins], outcome: 'not pinned' }
}

export const togglePin = (pins: readonly string[], id: string): PinResult => setPin(pins, id, !pins.includes(id))

/** The one-line answer for a pin result. */
export function pinText(id: string, outcome: PinResult['outcome'], label = TOOLS.find(t => t.id === id)?.label ?? id): string {

  return outcome === 'full' ? FULL_TEXT : `${label}: ${outcome === 'already' ? 'already pinned' : outcome === 'not pinned' ? 'is not pinned' : outcome}.`
}

/** The pins that fit `avail` cells (a one-cell gap between buttons), dropping from the end. */
export function fitPins(pins: readonly string[], avail: number, widthOf: (id: string) => number): string[] {
  const kept = [...pins]
  const total = () => kept.reduce((n, id) => n + widthOf(id) + 1, 0)
  while (kept.length > 0 && total() > avail) kept.pop()

  return kept
}

/** True when a tree from beneath holds something of another mod's: core's own drawing is an engine node, and an empty box or text shows nothing. */
export function drawsSomething(el: unknown): boolean {
  if (el === null || el === undefined || el === false || el === '') return false
  if (typeof el === 'string' || typeof el === 'number') return true
  if (Array.isArray(el)) return el.some(drawsSomething)
  const node = el as { type?: unknown; props?: { children?: unknown }; children?: unknown }
  if (node.type === 'engine') return false
  if (node.type === 'Box' || node.type === 'Text') return drawsSomething(node.children ?? node.props?.children)

  return true
}
