// A drawn tree as plain text, one line per row: what golden tests compare. Colors are left out, so a frame pins layout only.
import { cells } from '../shared/look'

type Node = string | number | null | undefined | boolean | { type?: string; props?: Record<string, unknown>; children?: unknown }

function kids(node: Node): Node[] {
  if (node === null || typeof node !== 'object') return []
  const own = (node as { children?: unknown }).children ?? node.props?.children
  if (own === undefined || own === null) return []

  return (Array.isArray(own) ? own.flat(Infinity) : [own]) as Node[]
}

/** The text a node shows on one line. */
function inline(node: Node): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node.type === 'Button') return `[ ${String(node.props?.label ?? '')} ]`

  return kids(node).map(inline).join('')
}

/** The lines a node takes: a column Box stacks its children, everything else is one line. */
function lines(node: Node): string[] {
  if (node === null || typeof node !== 'object') return inline(node) === '' ? [] : [inline(node)]
  const isColumn = node.type === 'Box' && node.props?.flexDirection !== 'row'
  if (!isColumn) return [inline(node)]

  return kids(node).flatMap(lines)
}

export function frame(tree: unknown): string {
  return lines(tree as Node).join('\n')
}

/** Lines wider than the band, which a terminal would wrap. */
export function overflowing(text: string, columns: number): string[] {
  return text.split('\n').filter(line => cells(line) > columns)
}
