// The carapace design system: one token set per skin, one glyph per meaning. No `$` here.

/** The one look so far; more are coming. Palettes are keyed by it so a new look slots in. */
export type Skin = 'deep'

/**
 * The words carapace uses: the spinner by mode, the word under a finished reply, the context gauge's levels, and the
 * names on screen. Slash commands never change (/crew, /mods, /logbook); only labels, pane titles and hints do.
 */
export const WORDS = {
  spinner: { requesting: 'Descending', thinking: 'Echolocating', responding: 'Surfacing', 'tool-input': 'Diving', 'tool-use': 'Diving' } as Record<string, string>,
  done: 'Dove', low: 'shallow', high: 'deep', full: 'crush',
  crew: 'Crew', hub: 'Shipyard', hubGlyph: '⌬', memory: 'Logbook', limit: 'O₂', unit: ' m', first: 0, step: 12,
  home: '⚓', changed: '≈', detached: 'adrift', bubbles: 'Bubbles', rise: 'rise',
}
export type Words = typeof WORDS

export type Palette = {
  accent: string
  accentDeep: string
  highlight: string
  good: string
  warn: string
  bad: string
  text: string
  muted: string
  hairline: string
  slate: string
  surface: string
  /** The halo: a dim ring one cell out from whatever is lit, then a dimmer one. */
  halo: string
  halo2: string
  onAccent: string
  seats: readonly string[]
  kinds: { code: string; emails: string; media: string; documents: string; research: string; other: string }
}

export const PALETTES: Record<Skin, Palette> = {
  deep: {
    accent: '#3FE0F0',
    accentDeep: '#1B8FA6',
    highlight: '#FF5FD2',
    good: '#3DDC97',
    warn: '#E8B44A',
    bad: '#FF5C7A',
    text: '#D8ECF7',
    muted: '#5E7E96',
    hairline: '#23425A',
    slate: '#12283A',
    surface: '#0B1B2A',
    halo: '#0F4B5C',
    halo2: '#0A3341',
    onAccent: '#03101A',
    seats: ['#3FE0F0', '#FF5FD2', '#3DDC97', '#E8B44A', '#8EA7FF', '#5CC8B4', '#C79BFF', '#FF9E7A'],
    kinds: { code: '#8EA7FF', emails: '#FF5FD2', media: '#3DDC97', documents: '#E8B44A', research: '#3FE0F0', other: '#5E7E96' },
  },
}

export const GLYPH = {
  done: '✓',
  active: '▸',
  waiting: '‖',
  queued: '○',
  stuck: '✕',
  deck: '◇',
  gstack: '◧',
  ponytail: '∿',
  dock: '◆',
  report: '▤',
  upgrade: '✦',
  clean: '●',
  theme: '◐',
  model: '◈',
  rea: '⌖',
  logbook: '▥',
} as const

/** "AGENT DOCK" becomes "A G E N T   D O C K": pane titles only. */
export function spaced(text: string): string {
  return text
    .split(' ')
    .map(word => word.split('').join(' '))
    .join('   ')
}

const SEGMENTER = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Grapheme clusters of a text; code points when Intl.Segmenter is missing. */
function graphemes(text: string): string[] {
  return SEGMENTER ? Array.from(SEGMENTER.segment(text), s => s.segment) : Array.from(text)
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

/** Terminal cells one grapheme takes: 0 for marks and controls, 2 for emoji and wide characters, else 1. */
function graphemeCells(g: string): number {
  if (/^[\p{Control}\p{Mark}\u200b-\u200d\u2060\ufe00-\ufe0f]+$/u.test(g)) return 0
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|\u200d|\ufe0f/u.test(g) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)) return 2
  for (const ch of g) if (isWide(ch.codePointAt(0) ?? 0)) return 2

  return 1
}

/** How many terminal cells a text takes. */
export function cells(text: string): number {
  return graphemes(text).reduce((n, g) => n + graphemeCells(g), 0)
}

/** The longest start of `text` that fits `width` cells, never splitting a grapheme. */
export function cutCells(text: string, width: number): string {
  let used = 0
  let out = ''
  for (const g of graphemes(text)) {
    const w = graphemeCells(g)
    if (used + w > width) break
    used += w
    out += g
  }

  return out
}

/** Pad with spaces on the right to `width` cells. */
export function padCells(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cells(text)))
}

/** Pad with spaces on the left to `width` cells. */
export function padStartCells(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - cells(text))) + text
}

export function fit(text: string, width: number): string {
  // Line breaks and tabs become one space; runs of spaces stay, so spaced titles keep their word gaps.
  const one = text.replace(/\s*[\r\n\t]+\s*/g, ' ').trim()
  if (width <= 1) return cutCells(one, Math.max(0, width))

  return cells(one) > width ? cutCells(one, width - 1) + '…' : one
}

export function seatColor(palette: Palette, seat: number): string {
  const n = palette.seats.length

  return palette.seats[((seat % n) + n) % n] ?? palette.accent
}

/** A color between two hex colors, `t` from 0 to 1. */
export function mix(from: string, to: string, t: number): string {
  const a = from.match(/\w\w/g)?.map(x => parseInt(x, 16)) ?? [0, 0, 0]
  const b = to.match(/\w\w/g)?.map(x => parseInt(x, 16)) ?? [0, 0, 0]
  const k = Math.min(1, Math.max(0, t))

  return '#' + a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * k).toString(16).padStart(2, '0')).join('')
}

/** A live mark breathes once a second: the accent, then a paler accent. */
export function breathe(palette: Palette, frame: number): string {
  return frame % 2 === 0 ? palette.accent : mix(palette.accent, palette.text, 0.6)
}
