// The setup questions: what only the person knows and what changes carapace for them. Pure, no `$` here.
import type { SetupDraft } from '../../types'

import { DEFAULT_PINS, MAX_PINS } from './tools'

export type { SetupDraft }

export type Work = SetupDraft['work'][number]
export type Pay = SetupDraft['pay']
export type Helpers = SetupDraft['helpers']
export type BudgetPeriod = SetupDraft['budget']['period']

/** Store key: set once setup was saved, so the bar stops asking. */
export const SETUP_DONE_KEY = 'setupDone'
/** Store key: set by Later. Setup stops opening by itself, but the bar keeps asking until Save. */
export const SETUP_LATER_KEY = 'setupLater'
/** Store key: the whole draft as last saved, so /setup opens with the same answers. */
export const SETUP_ANSWERS_KEY = 'setupAnswers'
export const SETUP_SAVED = 'Setup saved. /setup changes it.'
export const SETUP_PANE = 'carapace-setup'

export const WORK: readonly { id: Work; label: string }[] = [
  { id: 'coding', label: 'Coding' },
  { id: 'writing', label: 'Writing and documents' },
  { id: 'emails', label: 'Emails' },
  { id: 'research', label: 'Research' },
  { id: 'media', label: 'Images and media' },
]
export const PAY: readonly { id: Pay; label: string }[] = [
  { id: 'sub', label: 'Subscription' },
  { id: 'api', label: 'API credits' },
  { id: 'budget', label: 'API credits with a budget' },
]
export const HELPERS: readonly { id: Helpers; label: string }[] = [
  { id: 'cost', label: 'Lowest cost' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'quality', label: 'Best quality' },
]
export const PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month']

/** The Crew's helper model for each answer: cheapest per task, chosen per task, or the main model. */
export const HELPER_MODEL: Record<Helpers, 'fast' | 'auto' | 'same'> = { cost: 'fast', balanced: 'auto', quality: 'same' }

/** The answer the current helper model stands for. */
export function helpersOf(model: unknown): Helpers {
  return model === 'fast' ? 'cost' : model === 'same' ? 'quality' : 'balanced'
}

/**
 * The bar's pins for the kinds of work picked: coding wants the Crew and Clean View, writing, emails and media want
 * Refine, research wants the Crew, and anything but coding wants the Work Report. Memory adds Logbook. The defaults
 * fill what is left, up to five.
 */
export function pinsFor(work: readonly Work[], memory: boolean): string[] {
  const has = (w: Work) => work.includes(w)
  const wanted = [
    ...(has('coding') ? ['crew', 'clean'] : []),
    ...(has('writing') || has('emails') || has('media') ? ['refine'] : []),
    ...(has('research') ? ['crew'] : []),
    ...(work.some(w => w !== 'coding') ? ['report'] : []),
    ...(memory ? ['logbook'] : []),
    ...DEFAULT_PINS.filter(id => memory || id !== 'logbook'),
  ]

  return wanted.filter((id, i) => wanted.indexOf(id) === i).slice(0, MAX_PINS)
}

/** A money amount as typed: "75", "$75", "1,200", "75/hr", "$20 a day". Null when there is no positive number. */
export function parseAmount(text: string): number | null {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(text)
  const n = m ? Number(m[0].replace(/,/g, '')) : NaN

  return Number.isFinite(n) && n > 0 ? n : null
}

/** The saved answers that no live setting holds (the kinds of work, memory) laid over the live settings. */
export function withSaved(live: SetupDraft, saved: unknown): SetupDraft {
  if (typeof saved !== 'object' || saved === null) return live
  const s = saved as Partial<SetupDraft>

  return {
    ...live,
    work: Array.isArray(s.work) && s.work.every(w => WORK.some(k => k.id === w)) ? s.work : live.work,
    memory: typeof s.memory === 'boolean' ? s.memory : live.memory,
  }
}
