// Crew categories: what kind of piece a helper has, the model and effort that kind needs,
// your own overrides, and what the Crew learns from finished helpers. No `$` here.
import { TIERS, TIER_NAMES } from './dock-logic'
import type { Tier } from './dock-logic'

export type Effort = 'low' | 'medium' | 'high'
export type Category = 'lookup' | 'extract' | 'check' | 'write' | 'code' | 'research' | 'design' | 'debug'
export type Rule = { tier: Tier; effort: Effort }
export type Overrides = Partial<Record<Category, Tier>>
export type CrewLogEntry = { category: Category; tier: Tier; ms: number; isStuck: boolean; at: number }

type Kind = { key: Category; label: string; examples: string; rule: Rule; words: RegExp }

// Checked in this order: the hard kinds first, so "debug the search" is Deep debug, not Lookup.
const KINDS: readonly Kind[] = [
  {
    key: 'debug',
    label: 'Deep debug',
    examples: 'root cause, code review, security',
    rule: { tier: 'opus', effort: 'high' },
    words: /\b(debug\w*|root cause|diagnos\w*|code review|review (?:the |my |this )?(?:code|diff|pr|changes)|security|audit\w*|race condition|memory leak)\b/i,
  },
  {
    key: 'design',
    label: 'Design',
    examples: 'system design, plans, architecture',
    rule: { tier: 'opus', effort: 'high' },
    words: /\b(design (?:the |a |an )?(?:system|architecture|schema|database|api|algorithm|data model|protocol)|architect\w*|plan (?:the |a )?(?:migration|architecture|rollout)|strateg\w*|trade-?offs?)\b/i,
  },
  {
    key: 'check',
    label: 'Check',
    examples: 'run tests, lint, validate',
    rule: { tier: 'haiku', effort: 'low' },
    words: /\b(run (?:the )?tests?|lint\w*|validat\w*|verif\w*|type-?check\w*|check\w*)\b/i,
  },
  {
    key: 'extract',
    label: 'Extract',
    examples: 'pull data, summarize a doc',
    rule: { tier: 'haiku', effort: 'low' },
    words: /\b(extract\w*|pull (?:out|the)|summari[sz]\w*|pars(?:e|es|ing)|scrap(?:e|es|ing)|convert\w*|transcrib\w*)\b/i,
  },
  {
    key: 'lookup',
    label: 'Lookup',
    examples: 'find, search, list, read',
    rule: { tier: 'haiku', effort: 'low' },
    words: /\b(search\w*|find\w*|look ?up|list\w*|read\w*|scan\w*|grep|locat\w*|fetch\w*|collect\w*|gather\w*|count\w*|prices?)\b/i,
  },
  {
    key: 'research',
    label: 'Research',
    examples: 'compare options, analyze',
    rule: { tier: 'sonnet', effort: 'high' },
    words: /\b(research\w*|compar\w*|analy[sz]\w*|evaluat\w*|investigat\w*|assess\w*|pros and cons)\b/i,
  },
  {
    key: 'code',
    label: 'Code',
    examples: 'build, fix, refactor',
    rule: { tier: 'sonnet', effort: 'high' },
    words: /\b(build\w*|implement\w*|fix\w*|refactor\w*|code|function|component|page|endpoint|migrat\w*|feature|script|module|tests?)\b/i,
  },
  {
    key: 'write',
    label: 'Write',
    examples: 'emails, copy, docs, slogans',
    rule: { tier: 'sonnet', effort: 'medium' },
    words: /\b(writ\w*|draft\w*|emails?|copy|slogans?|blog|posts?|captions?|translat\w*|docs?|documentation|readme|summary)\b/i,
  },
]
const ORDER: readonly Category[] = ['lookup', 'extract', 'check', 'write', 'code', 'research', 'design', 'debug']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high']

export function kindOf(key: Category): Kind {
  return KINDS.find(k => k.key === key) ?? (KINDS[KINDS.length - 1] as Kind)
}

export function isCategory(word: string): word is Category {
  return (ORDER as readonly string[]).includes(word)
}

/** The kind of piece a helper has, from its words. Nothing matched: Code, the middle of the road. */
export function categorize(task: string): Category {
  return KINDS.find(k => k.words.test(task))?.key ?? 'code'
}

/** Each category's model and effort, with your overrides on top. */
export function rulesWith(overrides: Overrides): Record<Category, Rule> {
  return Object.fromEntries(ORDER.map(c => [c, { tier: overrides[c] ?? kindOf(c).rule.tier, effort: kindOf(c).rule.effort }])) as Record<Category, Rule>
}

/** The model a helper's task needs, from its words and your rules. */
export function pickModel(task: string, overrides: Overrides = {}): Tier {
  return rulesWith(overrides)[categorize(task)].tier
}

/** The lower of two efforts, so a category never raises what the step already asked for. */
export function lowerEffort(asked: string | number | undefined, rule: Effort): Effort | undefined {
  if (typeof asked !== 'string') return undefined
  const a = EFFORTS.indexOf(asked as Effort)
  const r = EFFORTS.indexOf(rule)

  return a === -1 || r < a ? rule : undefined
}

/** Claude's standing rule while the Crew is on Auto: the category table, with your overrides. */
export function autoRule(overrides: Overrides): string {
  const rules = rulesWith(overrides)
  const rows = ORDER.map(c => `- ${kindOf(c).label} (${kindOf(c).examples}): "${rules[c].tier}"`)

  return [
    'Crew is on Auto. Whenever you launch a helper with the Agent tool, decide which category its piece is and set its model field from this table:',
    ...rows,
    'Never pick a stronger model than your own.',
  ].join('\n')
}

/** What /crew rules shows: the table, which rows you changed, and what the Crew suggests. */
export function rulesText(overrides: Overrides, tips: readonly string[]): string {
  const rules = rulesWith(overrides)
  const rows = ORDER.map(c => {
    const changed = overrides[c] !== undefined ? '  (yours)' : ''

    return `${kindOf(c).label.padEnd(11)} ${TIER_NAMES[rules[c].tier].padEnd(7)} ${rules[c].effort.padEnd(7)} ${kindOf(c).examples}${changed}`
  })

  return [
    'Crew rules on Auto: category, model, effort, examples.',
    ...rows,
    ...(tips.length > 0 ? ['', ...tips.map(t => `Suggestion: ${t}`)] : []),
    '',
    'Change one with /crew rules <category> <haiku|sonnet|opus|fable>, or /crew rules reset.',
  ].join('\n')
}

export type RulesCommand = { kind: 'show' } | { kind: 'reset' } | { kind: 'set'; category: Category; tier: Tier } | { kind: 'error'; text: string }

/** Reads what follows /crew rules. */
export function parseRules(args: string): RulesCommand {
  const [category, tier, extra] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (category === undefined) return { kind: 'show' }
  if (category === 'reset' && tier === undefined) return { kind: 'reset' }
  const key = category === 'deep' || category === 'debugging' ? 'debug' : category
  if (!isCategory(key)) return { kind: 'error', text: `No category "${category}". Use one of: ${ORDER.join(', ')}.` }
  if (tier === undefined || extra !== undefined || !(TIERS as readonly string[]).includes(tier)) {
    return { kind: 'error', text: `Pick a model for ${kindOf(key).label}: haiku, sonnet, opus or fable.` }
  }

  return { kind: 'set', category: key, tier: tier as Tier }
}

// The Crew learns from finished helpers. It only suggests; you decide.
const MIN_TO_RAISE = 12
const MIN_TO_LOWER = 20
const STUCK_SHARE = 0.25

/** What the log says about your rules: a category whose helpers keep getting stuck, or one that never does on a stronger model. */
export function suggestions(log: readonly CrewLogEntry[], overrides: Overrides): string[] {
  const rules = rulesWith(overrides)
  const tips: string[] = []
  for (const c of ORDER) {
    const tier = rules[c].tier
    const runs = log.filter(e => e.category === c && e.tier === tier)
    const stuck = runs.filter(e => e.isStuck).length
    const i = TIERS.indexOf(tier)
    const up = TIERS[i + 1]
    const down = TIERS[i - 1]
    if (runs.length >= MIN_TO_RAISE && stuck / runs.length >= STUCK_SHARE && up !== undefined) {
      tips.push(`${kindOf(c).label} helpers on ${TIER_NAMES[tier]} got stuck ${stuck} of ${runs.length} times. Try /crew rules ${c} ${up}.`)
    } else if (runs.length >= MIN_TO_LOWER && stuck === 0 && down !== undefined) {
      tips.push(`${kindOf(c).label} on ${TIER_NAMES[tier]} never got stuck in ${runs.length} runs. Try /crew rules ${c} ${down} to save.`)
    }
  }

  return tips.slice(0, 2)
}

/** The log keeps the newest entries only. */
export const LOG_SIZE = 500
