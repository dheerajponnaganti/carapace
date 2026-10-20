// The deck's health line, as pure logic. No `$` here.
import type { AgentDockMission, CleanViewChecklist } from '../../types'

/** The mods on the deck. Bubbles and Theme are settings, not mods. */
export const DECK_MODS = 4

/** The first problem a mod reports, or null. A stuck helper beats a stuck Clean View, which beats a question. */
export function deckProblem(mission: AgentDockMission | null, checklist: CleanViewChecklist | null): string | null {
  const stuck = mission?.cards.filter(c => c.status === 'stuck').length ?? 0
  if (stuck > 0) return `${stuck} ${stuck === 1 ? 'helper' : 'helpers'} stuck`
  if (checklist?.phase === 'stuck') return 'Clean View stuck'
  if (checklist?.phase === 'needsYou') return 'needs you'

  return null
}

/** The deck's health line: "4 mods · all well", or "4 mods · 1 helper stuck". */
export function deckHealth(mission: AgentDockMission | null, checklist: CleanViewChecklist | null): { text: string; isWell: boolean } {
  const problem = deckProblem(mission, checklist)

  return { text: `${DECK_MODS} mods · ${problem ?? 'all well'}`, isWell: problem === null }
}
