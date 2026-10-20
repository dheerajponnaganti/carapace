// The Terminal window's look: which profile a tab wears. No `$` here.

/** How full the chat's context is, in three bands: calm under 50 percent, deep from 50, crush from 85. */
export type Band = 'calm' | 'deep' | 'crush'

export const PROFILE = {
  deep: 'Deep Sea',
  deepTint: 'Deep Sea · Deep',
  crush: 'Deep Sea · Crush',
} as const

/** Every profile carapace installs. A tab on any other profile is never touched. */
export const OWNED_PROFILES: readonly string[] = [PROFILE.deep, PROFILE.deepTint, PROFILE.crush]

export function bandFor(percent: number): Band {
  if (percent >= 85) return 'crush'
  if (percent >= 50) return 'deep'

  return 'calm'
}

/** One Deep Sea variant per band. */
export function profileFor(band: Band): string {
  if (band === 'crush') return PROFILE.crush
  if (band === 'deep') return PROFILE.deepTint

  return PROFILE.deep
}

export function isOwnedProfile(name: string): boolean {
  return OWNED_PROFILES.includes(name)
}
