// REA (reverse-engineering tools, installed by carapace on request), without `$`: versions, state, the words shown.

import { addonStatus, ponytailUpdate } from './addons'

export type ReaState = { kind: 'none' | 'ours' | 'yours'; version: string; latest: string }

export const NO_REA: ReaState = { kind: 'none', version: '', latest: '' }

/** The first x.y.z in a command's output, or ''. */
export function parseVersion(stdout: string): string {
  return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? ''
}

/** True when `latest` is a higher x.y.z than `have`. Either one unreadable means no. */
export function isNewer(latest: string, have: string): boolean {
  const a = parseVersion(latest).split('.').map(Number)
  const b = parseVersion(have).split('.').map(Number)
  if (a.length !== 3 || b.length !== 3) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number)

  return false
}

/** The installer's state file says who put REA there: "installed" (carapace) or "preexisting" (the person). */
export function reaKind(stateText: string): ReaState['kind'] {
  try {
    const rea = (JSON.parse(stateText) as { rea?: unknown }).rea

    return rea === 'installed' ? 'ours' : rea === 'preexisting' ? 'yours' : 'none'
  } catch {
    return 'none'
  }
}

/** The version carapace could update to, or '' (never for REA that is the person's own). */
export function reaUpdate(s: ReaState): string {
  return s.kind === 'ours' && isNewer(s.latest, s.version) ? s.latest : ''
}

/** The status line of the Shipyard row. */
export const reaStatus = (s: ReaState): string => addonStatus('REA', s)

/** The badge of the bar's Update button: carapace's count, REA's version, ponytail's, or any of them. */
export function updateBadge(behind: number, s: ReaState, ponytail: ReaState = NO_REA): string {
  const rea = reaUpdate(s) ? `REA ${s.latest}` : ''
  const pony = ponytailUpdate(ponytail) ? `ponytail ${ponytail.latest}` : ''

  return [behind > 0 ? String(behind) : '', rea, pony].filter(Boolean).join(' · ')
}

export const RESTART_ADDED = 'REA added. Restart Claude Code to use it.'
export const RESTART_UPDATED = 'Restart Claude Code to use the new REA.'
