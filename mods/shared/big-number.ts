// Three-row numerals in heavy box-drawing strokes, shared by every carapace pane.
const GLYPHS: Record<string, readonly [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '╻'],
  ',': [' ', ' ', '┓'],
  $: ['┏╋╸', '┗╋┓', '╺╋┛'],
}

/** The three rows of `text` (digits, ".", ",", "$"); unknown characters are left out. */
export function bigText(text: string): [string, string, string] {
  const glyphs = text.split('').flatMap(ch => (GLYPHS[ch] ? [GLYPHS[ch]] : []))

  return [0, 1, 2].map(row => glyphs.map(g => g[row] ?? '').join(' ')) as [string, string, string]
}

export function bigNumber(n: number): [string, string, string] {
  return bigText(String(Math.max(0, Math.round(n))))
}

/** How many cells wide the big form of `text` is. */
export function bigWidth(text: string): number {
  return bigText(text)[0].length
}
