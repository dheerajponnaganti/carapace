// The Shipyard's add-ons (REA, gstack, ponytail), without `$`: ids, who owns each, the words shown.
import { isNewer, parseVersion } from './rea-logic'
import type { ReaState } from './rea-logic'

export type AddonId = 'rea' | 'gstack' | 'ponytail' | 'hookify' | 'security-guidance'

/** In row order. `key` is the row's hotkey. */
export const ADDONS: readonly { id: AddonId; label: string; key: string }[] = [
  { id: 'rea', label: 'REA', key: 'e' },
  { id: 'gstack', label: 'gstack', key: 'g' },
  { id: 'ponytail', label: 'ponytail', key: 'n' },
  { id: 'hookify', label: 'hookify', key: 'h' },
  { id: 'security-guidance', label: 'security-guidance', key: 'i' },
]

/** The add-ons that are plugins of the official marketplace, installed as `<id>@claude-plugins-official`. Not installed by default. */
export const OFFICIAL_ADDONS: readonly AddonId[] = ['hookify', 'security-guidance']

/** What an add-on can reach. `tag` is the short word in the row, `meaning` the full sentence for the toast. */
export const REACH_KINDS = {
  network: { tag: 'network', meaning: 'talks to the internet' },
  files: { tag: 'files', meaning: 'writes files on this machine' },
  prompts: { tag: 'prompts', meaning: 'sees the prompts you send' },
  hooks: { tag: 'hooks', meaning: 'runs hooks on Claude Code events' },
  server: { tag: 'server', meaning: 'runs a server' },
} as const
export type Reach = keyof typeof REACH_KINDS

/** The data table behind the reach tags, one entry per add-on, from what each one installs and runs. */
export const REACH: Record<AddonId, readonly Reach[]> = {
  rea: ['network', 'files', 'server'],
  gstack: ['network', 'files', 'hooks', 'server'],
  ponytail: ['files', 'prompts', 'hooks'],
  hookify: ['files', 'prompts', 'hooks'],
  'security-guidance': ['network', 'files', 'prompts', 'hooks'],
}

/** The short tags for a row, like "network files hooks". */
export const reachTags = (id: AddonId): string => REACH[id].map(r => REACH_KINDS[r].tag).join(' ')

/** The full meaning, for the toast when a row is pressed. */
export const reachMeaning = (id: AddonId): string => `${id} ${REACH[id].map(r => REACH_KINDS[r].meaning).join(', ')}.`

/** The installer's state file says who put an add-on there: "installed" (carapace) or "preexisting" (the person). */
export function addonKind(stateText: string, id: AddonId): ReaState['kind'] {
  try {
    const v = (JSON.parse(stateText) as Record<string, unknown>)[id]

    return v === 'installed' ? 'ours' : v === 'preexisting' ? 'yours' : 'none'
  } catch {
    return 'none'
  }
}

/** The version of a plugin in `claude plugin list --json` output: null when it is not listed, '' when listed without a version. */
export function pluginVersion(listJson: string, pluginId: string): string | null {
  try {
    const list = JSON.parse(listJson) as { id?: unknown; version?: unknown }[]
    const hit = list.find(p => typeof p.id === 'string' && p.id.split('@')[0] === pluginId)

    return hit ? parseVersion(String(hit.version ?? '')) : null
  } catch {
    return null
  }
}

/** The version in a repo's `.claude-plugin/plugin.json`, or ''. */
export function manifestVersion(text: string): string {
  try {
    return parseVersion(String((JSON.parse(text) as { version?: unknown }).version ?? ''))
  } catch {
    return ''
  }
}

/** The ponytail version waiting. Shown for ponytail that is the person's too, but only carapace's is updated. */
export function ponytailUpdate(s: ReaState): string {
  return s.kind !== 'none' && isNewer(s.latest, s.version) ? s.latest : ''
}

export const PONYTAIL_YOURS = (latest: string) => `ponytail ${latest} is waiting. Update it with /plugin.`
export const PONYTAIL_UPDATED = 'ponytail updated. Restart Claude Code to use it.'

/** The status line of an add-on row. `selfUpdates` is for gstack, which updates itself; `isUnchecked` is for add-ons whose latest version carapace does not look up. */
export function addonStatus(label: string, s: ReaState, selfUpdates = false, isUnchecked = false): string {
  if (s.kind === 'none') return 'not installed'
  const name = s.version ? `${label} ${s.version}` : label
  const waiting = !selfUpdates && isNewer(s.latest, s.version) && (s.kind === 'ours' || label === 'ponytail')
  const tail = selfUpdates ? 'updates itself' : waiting ? `${s.latest} waiting` : 'up to date'
  if (s.kind === 'yours') return waiting ? `${name} (yours) · ${s.latest} waiting` : `${name} (yours)`
  if (isUnchecked) return name

  return `${name} · ${tail}`
}

/** The small second button of a row: Manage for the person's own, Remove for carapace's. */
export function addonExtra(s: ReaState): 'Manage' | 'Remove' | '' {
  return s.kind === 'yours' ? 'Manage' : s.kind === 'ours' ? 'Remove' : ''
}
