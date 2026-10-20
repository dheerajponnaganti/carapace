// What the upgrade added, marked in place. No `$` here, so tests import it directly.

export type Mark = { text: string; kind: 'same' | 'added' | 'blank' }

const BLANK = /\[[^\]\n]{1,60}\]/g

/** The placeholders still in the text, in order, each once. */
export function blanksIn(text: string): string[] {
  return [...new Set(text.match(BLANK) ?? [])]
}

/** Puts `value` in every copy of `placeholder`. */
export function fillBlank(text: string, placeholder: string, value: string): string {
  return text.split(placeholder).join(value.trim())
}

const norm = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * The rewrite as runs of kept words, added words and placeholders. A word counts as kept when it lines up
 * with the original in a longest common subsequence of words, so reordered or repeated words read as added.
 */
export function marks(original: string, rewrite: string): Mark[] {
  const before = (original.match(/\S+/g) ?? []).map(norm).filter(Boolean)
  const pieces: { text: string; isBlank: boolean }[] = []
  let last = 0
  for (const match of rewrite.matchAll(BLANK)) {
    const at = match.index ?? 0
    if (at > last) pieces.push({ text: rewrite.slice(last, at), isBlank: false })
    pieces.push({ text: match[0], isBlank: true })
    last = at + match[0].length
  }
  if (last < rewrite.length) pieces.push({ text: rewrite.slice(last), isBlank: false })

  const words: { text: string; key: string; piece: number }[] = []
  pieces.forEach((piece, i) => {
    if (!piece.isBlank) for (const w of piece.text.match(/\s*\S+\s*/g) ?? [piece.text]) words.push({ text: w, key: norm(w), piece: i })
  })
  // ponytail: quadratic LCS; prompts are a few hundred words at most.
  const n = before.length
  const m = words.length
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i] as number[]
      const down = table[i + 1] as number[]
      row[j] = words[j]?.key !== '' && before[i] === words[j]?.key ? (down[j + 1] ?? 0) + 1 : Math.max(down[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const kept = new Set<number>()
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (words[j]?.key !== '' && before[i] === words[j]?.key) {
      kept.add(j)
      i += 1
      j += 1
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) i += 1
    else j += 1
  }

  const out: Mark[] = []
  const push = (text: string, kind: Mark['kind']) => {
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind) prev.text += text
    else out.push({ text, kind })
  }
  let w = 0
  pieces.forEach((piece, i) => {
    if (piece.isBlank) {
      push(piece.text, 'blank')
      return
    }
    while (w < words.length && words[w]?.piece === i) {
      const word = words[w] as { text: string; key: string }
      push(word.text, word.key === '' || kept.has(w) ? 'same' : 'added')
      w += 1
    }
  })

  return out
}
