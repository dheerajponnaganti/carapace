// Plain one-cell stand-ins for the symbols carapace draws. Some consoles (the old Windows console, Asian-language code
// pages, terminals set to draw "ambiguous width" characters wide) show box lines, blocks and shapes two cells wide while
// the layout counts one, so rows overflow, wrap, and the screen redraws them twice. No `$` here.

const SAFE: Record<string, string> = {
  '─': '-', '━': '=', '│': '|', '┃': '|', '┬': '+', '├': '+', '└': '`', '┏': '+', '┓': '+', '┗': '+', '┛': '+',
  '┣': '+', '┫': '+', '┻': '+', '╋': '+', '╸': '-', '╺': '-', '╹': '|', '╻': '|', '⎿': 'L',
  '▁': '_', '▂': '_', '▃': '-', '▄': '-', '▅': '=', '▆': '=', '▇': '#', '█': '#', '░': '.', '▒': ':', '▰': '#', '▱': '-',
  '●': '*', '○': 'o', '◆': '*', '◇': 'o', '◉': '@', '◎': '@', '◌': 'o', '■': '#', '▢': '[', '▤': '=', '▥': '=', '▣': '#',
  '▼': 'v', '▲': '^', '▾': 'v', '▸': '>', '◂': '<', '›': '>', '◐': 'o', '◈': '*', '◧': '#', '⬢': '*', '❖': '*', '♦': '*',
  '★': '*', '✦': '+', '✚': '+', '⌬': '#', '⌖': '+', '✓': 'v', '✕': 'x', '✗': 'x', '×': 'x', '•': '*', '·': '.', '∙': '.',
  '∘': 'o', '°': 'o', '…': '.', '⋯': '~', '‖': '|', '≈': '~', '∿': '~', '→': '>', '↑': '^', '↓': 'v', '↻': '@', '±': '+',
  '⚑': '!', '⚠': '!', '⚓': '&', '⛁': '$', '₂': '2', '◔': 'o', '◑': 'o', '◕': '@', '✧': '+', '✈': '>', '⌂': '^',
}
const PATTERN = new RegExp(`[${Object.keys(SAFE).join('')}]`, 'gu')

/** The text with every symbol a console may draw wide replaced by a one-cell stand-in. */
export function safeText(text: string): string {
  return text.replace(PATTERN, ch => SAFE[ch] ?? ch)
}

/** A drawing with every string inside it made safe; engine nodes and other values pass untouched. */
export function safeTree<T>(el: T): T {
  if (typeof el === 'string') return safeText(el) as T
  if (Array.isArray(el)) return el.map(safeTree) as T
  if (el === null || typeof el !== 'object') return el
  const node = el as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  if (node.type === 'engine') return el
  const props = node.props && typeof node.props.label === 'string' ? { ...node.props, label: safeText(node.props.label) } : node.props
  const out: Record<string, unknown> = { ...node, props }
  if ('children' in node) out.children = safeTree(node.children)
  if (props && 'children' in props) out.props = { ...props, children: safeTree(props.children) }

  return out as T
}

/** Whether to draw safe symbols: the person's choice, else the old Windows console (no Windows Terminal, no editor). */
export function wantsSafe(choice: unknown, env: { os?: string; wt?: string; term?: string; ascii?: string }): boolean {
  if (choice === 'on' || env.ascii === '1') return true
  if (choice === 'off' || env.ascii === '0') return false

  return env.os === 'Windows_NT' && !env.wt && !env.term
}
