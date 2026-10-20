/** Pure matching for the secret guard: which files are secret, which commands print them, which strings to mask. */

export const MASK = '[secret masked]'

const SAFE_ENV = /\.(?:example|sample|template|dist)$/i
const PRIVATE_KEYS = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_[\w.-]+)?$/

/** True when the path names a file that holds secrets. Judged by name only; the file is never read. */
export function isSecretPath(path: string): boolean {
  const clean = path.trim().replace(/^["']|["']$/g, '')
  const parts = clean.split(/[\\/]/).filter(p => p !== '')
  const name = parts[parts.length - 1] ?? ''
  if (name === '') return false
  if (name === '.env' || (name.startsWith('.env.') && !SAFE_ENV.test(name))) return true
  if (/\.(?:pem|key)$/i.test(name)) return true
  if (PRIVATE_KEYS.test(name) && !name.endsWith('.pub')) return true
  if (['.npmrc', '.pypirc', '.netrc', 'credentials.json'].includes(name)) return true
  return name === 'credentials' && parts[parts.length - 2] === '.aws'
}

const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'grep', 'egrep', 'fgrep', 'rg', 'nl', 'tac', 'strings', 'xxd', 'od', 'cp', 'base64'])

/** Splits one command on whitespace, keeping quoted parts together. */
function words(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ''))
}

/** The first secret file a shell command would print, or null. Covers pipes, `;`, `&&` and `< file`. */
export function bashSecretFile(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const w = words(segment)
    const redirect = w.findIndex(x => x === '<' || /^<[^<]/.test(x))
    if (redirect !== -1) {
      const target = w[redirect] === '<' ? w[redirect + 1] : w[redirect]?.slice(1)
      if (target !== undefined && isSecretPath(target)) return target
    }
    const cmd = (w.find(x => !/^\w+=/.test(x)) ?? '').split('/').pop() ?? ''
    if (!READERS.has(cmd)) continue
    const args = w.slice(w.indexOf(w.find(x => !/^\w+=/.test(x)) ?? '') + 1)
    // A file after `>` or `>>` is written, not printed: `cat > .env <<EOF` makes a secret file and shows nothing.
    const hit = args.find((x, i) => !x.startsWith('-') && !/^\d?>/.test(x) && !/^\d?>>?$/.test(args[i - 1] ?? '') && isSecretPath(x))
    if (hit !== undefined) return hit
  }
  return null
}

/** The first secret file a Read, Grep or Bash call would reach, or null. */
export function secretTarget(tool: string, input: Record<string, unknown>): string | null {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (tool === 'Read') return isSecretPath(str('file_path')) ? str('file_path') : null
  if (tool === 'Grep') {
    for (const v of [str('path'), str('glob')]) if (v !== '' && isSecretPath(v.replace(/^\*\*\//, ''))) return v
    return null
  }
  if (tool === 'Bash') return bashSecretFile(str('command'))
  return null
}

export function denyReason(path: string): string {
  return `secret-guard blocked a read of ${path}, which looks like a secret file. To let the next read of this one path through, the person runs: /secrets allow ${path}`
}

function entropy(s: string): number {
  const n = new Map<string, number>()
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1)
  let h = 0
  for (const v of n.values()) h -= (v / s.length) * Math.log2(v / s.length)
  return h
}

const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const SHAPES = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[bp]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
]
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{32,})/gi

/** Replaces secret-looking strings with the mask and counts them. */
export function maskSecrets(text: string): { text: string; count: number } {
  let count = 0
  const hit = () => (count++, MASK)
  let out = text.replace(KEY_BLOCK, hit)
  for (const re of SHAPES) out = out.replace(re, hit)
  out = out.replace(BEARER, (m, pre: string, tok: string) => (/\d/.test(tok) && /[A-Za-z]/.test(tok) && entropy(tok) > 3.5 ? pre + hit() : m))
  return { text: out, count }
}

/** Masks every string inside a value (a tool result can be any shape). */
export function maskDeep<T>(value: T): { value: T; count: number } {
  let count = 0
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = maskSecrets(v)
      count += r.count
      return r.text
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return { value: walk(value) as T, count }
}
