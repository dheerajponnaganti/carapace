import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ACCOUNT_UNKNOWN, EMPTY_LEDGER, accountOf, knownKind, coldNote, compactTokens, headerView, localDate, money, parseBudget, record, resetOf, spentIn, warnStep } from '../shared/budget-logic'
import type { Account, Budget } from '../shared/budget-logic'

const NOW = new Date(2026, 9, 18, 15, 0, 0).getTime()
const API: Account = { kind: 'api', gateway: null }
const SUB: Account = { kind: 'subscriber', gateway: null }
const DAY = 86_400_000
const BAND = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }

test('account type: five_hour is a subscriber, spend_limit a company budget, else API once money is spent', () => {
  expect(accountOf([{ kind: 'five_hour', percentUsed: 10 }], 0, { kind: 'unknown', gateway: null }).kind).toBe('subscriber')
  expect(accountOf([], 1, { kind: 'unknown', gateway: null }).kind).toBe('api')
  expect(accountOf([], 0, { kind: 'unknown', gateway: null }).kind).toBe('unknown')
  expect(accountOf([], 5, SUB).kind).toBe('subscriber')
  const cap = accountOf([{ kind: 'spend_limit', percentUsed: 40, resetsAt: '2026-11-01T00:00:00Z' }], 0, { kind: 'unknown', gateway: null })
  expect(cap.gateway?.percentUsed).toBe(40)
})

test('number formats: 950, 12k, 1.2M and dollars', () => {
  expect([950, 12_000, 1_200_000, 1500].map(compactTokens)).toEqual(['950', '12k', '1.2M', '1.5k'])
  expect([3.4, 0.09, 120.4].map(money)).toEqual(['$3.40', '$0.09', '$120'])
})

test('/budget words: dollars by default, tokens, off, show, errors', () => {
  expect(parseBudget('$20 day')).toEqual({ kind: 'set', budget: { unit: 'usd', amount: 20, period: 'day' } })
  expect(parseBudget('20 month')).toEqual({ kind: 'set', budget: { unit: 'usd', amount: 20, period: 'month' } })
  expect(parseBudget('5M tokens week')).toEqual({ kind: 'set', budget: { unit: 'tokens', amount: 5_000_000, period: 'week' } })
  expect(parseBudget('$20 session')).toMatchObject({ kind: 'set' })
  expect(parseBudget('off')).toEqual({ kind: 'off' })
  expect(parseBudget('')).toEqual({ kind: 'show' })
  expect(parseBudget('$20 year').kind).toBe('error')
  expect(parseBudget('lots day').kind).toBe('error')
})

test('periods: week is the last 7 days, month the calendar month, resets at local midnight', () => {
  let ledger = EMPTY_LEDGER
  for (const back of [0, 3, 6, 7, 20]) ledger = record(ledger, `s${back}`, 1, 100, NOW - back * DAY)
  const b = (period: Budget['period'], unit: Budget['unit'] = 'usd'): Budget => ({ unit, amount: 10, period })
  expect(spentIn(ledger, b('day'), 's0', NOW)).toBe(1)
  expect(spentIn(ledger, b('week'), 's0', NOW)).toBe(3)
  expect(spentIn(ledger, b('week', 'tokens'), 's0', NOW)).toBe(300)
  expect(spentIn(ledger, b('month'), 's0', NOW)).toBe(4)
  expect(spentIn(ledger, b('session'), 's3', NOW)).toBe(1)
  expect(resetOf('day', NOW)).toBe(new Date(2026, 9, 19).getTime())
  expect(resetOf('month', NOW)).toBe(new Date(2026, 10, 1).getTime())
  expect(resetOf('session', NOW)).toBe(null)
})

test('accounting: a reload or a resumed session never counts a total twice, /clear restarts, old days are pruned', () => {
  let l = record(EMPTY_LEDGER, 'a', 2, 50, NOW)
  l = record(l, 'a', 2, 0, NOW)
  l = record(l, 'a', 3, 0, NOW)
  expect(l.days[localDate(NOW)]).toEqual({ usd: 3, tokens: 50 })
  l = record(l, 'a', 0.5, 0, NOW)
  expect(l.days[localDate(NOW)]?.usd).toBe(3.5)
  const resumed = record(EMPTY_LEDGER, 'old', 40, 0, NOW, true)
  expect(resumed.days[localDate(NOW)]?.usd).toBe(0)
  expect(record(resumed, 'old', 41, 0, NOW).days[localDate(NOW)]?.usd).toBe(1)
  expect(Object.keys(record(record(EMPTY_LEDGER, 'x', 1, 0, NOW - 70 * DAY), 'y', 1, 0, NOW).days)).toEqual([localDate(NOW)])
})

test('day rollover at local midnight starts a new day', () => {
  const before = new Date(2026, 9, 18, 23, 59).getTime()
  const after = new Date(2026, 9, 19, 0, 1).getTime()
  const l = record(record(EMPTY_LEDGER, 'a', 4, 0, before), 'a', 5, 0, after)
  const day: Budget = { unit: 'usd', amount: 10, period: 'day' }
  expect(spentIn(l, day, 'a', before)).toBe(4)
  expect(spentIn(l, day, 'a', after)).toBe(1)
})

test('the header: subscriber never money; API shows tokens and spend; a budget shows what is left', () => {
  const l = record(EMPTY_LEDGER, 'a', 3.4, 1_200_000, NOW)
  expect(headerView(SUB, { unit: 'usd', amount: 20, period: 'day' }, l, 'a', NOW)).toBe(null)
  expect(headerView(API, null, l, 'a', NOW)?.text).toBe('⛁ 1.2M tok · $3.40')
  expect(headerView(API, { unit: 'usd', amount: 20, period: 'day' }, l, 'a', NOW)).toMatchObject({ text: 'O₂ 83% · $16.60 left', level: 'ok' })
  expect(headerView(API, { unit: 'tokens', amount: 3_000_000, period: 'week' }, l, 'a', NOW)?.text).toBe('O₂ 60% · 1.8M tok left')
  expect(headerView(API, { unit: 'usd', amount: 4, period: 'day' }, l, 'a', NOW)?.level).toBe('amber')
  expect(headerView(API, { unit: 'usd', amount: 3, period: 'day' }, l, 'a', NOW)).toMatchObject({ level: 'red', text: 'O₂ 0% · $0.00 left' })
  expect(headerView({ kind: 'api', gateway: { percentUsed: 62, resetsAt: null } }, null, l, 'a', NOW)?.text).toBe('O₂ 38% · company budget')
})

test('80 and 100 percent fire once, and again in a new period', () => {
  const a = warnStep(null, 'd1', 'ok')
  const b = warnStep(a.next, 'd1', 'amber')
  const c = warnStep(b.next, 'd1', 'amber')
  const d = warnStep(c.next, 'd1', 'red')
  const e = warnStep(d.next, 'd1', 'red')
  expect([a.toast, b.toast, c.toast, d.toast, e.toast]).toEqual([null, 'amber', null, 'red', null])
  expect(warnStep(e.next, 'd2', 'amber').toast).toBe('amber')
})

test('cold-cache toasts by case, and a subscriber never gets a dollar sign', () => {
  const sub = coldNote(SUB, 45_000, 0.00001, { unit: 'usd', amount: 10, period: 'day' })
  expect(sub).toBe('The cache went cold. This send re-reads about 45k tokens; it counts against your 5-hour limit.')
  expect(sub).not.toContain('$')
  expect(coldNote(API, 45_000, 0.000002, null)).toBe('The cache went cold. This send costs about $0.09 to re-cache.')
  expect(coldNote(API, 45_000, null, null)).toBe('The cache went cold. This send re-reads about 45k tokens.')
  expect(coldNote(API, 45_000, 0.000002, { unit: 'usd', amount: 9, period: 'day' })).toBe("The cache went cold. This send costs about $0.09, 1% of today's budget.")
})

let usage: { rateLimits: unknown[]; cost?: { usd: number } } = { rateLimits: [] }
const toasts: string[] = []
const registered: string[] = []

async function world($: Engine, on: On, id = 'sess-1') {
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: NOW })
  toasts.length = 0
  on('prompt.submit', () => ({ text: '' }) as never)
  on('session.measure', () => ({ changed: [] }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('fs.read', (_$, e) => (e.path.endsWith('statusline.json') ? { value: JSON.stringify({ session_id: id, prompt_cache: { caching_observed: true, expires_at: NOW / 1000 - 5, recache_tokens_if_cold: 45000 } }) } : { deny: 'ENOENT' }))
  for (const op of ['ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { tokens: 10, window: 100, percent: 10 }, ...usage } }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
}

const measure = async ($: Engine, rateLimits: unknown[], usd: number) => {
  usage = { rateLimits, cost: { usd } }
  await $.session.measure({ context: { window: 100 }, rateLimits, cost: { usd } } as never)
  await new Promise(resolve => setTimeout(resolve, 30))
}
const bar = async ($: Engine) => {
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const text = [...(await band.findAll({ type: 'Text' })), ...(await band.findAll({ type: 'Button' }))].map(t => t.text).join('\n')
  await band.unmount()
  return text
}
const send = async ($: Engine, text = 'hi') => {
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await new Promise(resolve => setTimeout(resolve, 20))
}

test('/budget is in the slash menu', async ($, on) => {
  await world($, on)
  expect(registered).toContain('budget')
})

test('render: a subscriber sees O2 and no dollar anywhere', async ($, on) => {
  usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 3_600_000).toISOString() }] }
  await world($, on)
  await measure($, [{ kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 3_600_000).toISOString() }], 3.4)
  await $.command.run({ command: 'budget', args: '$20 day' } as never)
  const text = await bar($)
  expect(text).toContain('O₂ 62%')
  expect(text).not.toContain('$')
  expect(text).not.toContain('⛁')
  await send($)
  expect(toasts.join('\n')).toContain('counts against your 5-hour limit')
  expect(toasts.join('\n')).not.toContain('$')
})

test('render: API without a budget shows tokens and spend, and a toast with no limit talk', async ($, on) => {
  await world($, on, 'api-1')
  await measure($, [], 3.4)
  await $.turn.complete?.({ turnId: 't1', answer: 'ok', reason: 'answer', usage: { model: 'm', input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as never)
  const text = await bar($)
  expect(text).toContain('⛁')
  expect(text).toContain('$3.40')
  expect(text).not.toContain('O₂')
  await send($)
  expect(toasts.join('\n')).toContain('This send re-reads about 45k tokens.')
  expect(toasts.join('\n')).not.toContain('5-hour')
})

test('render: API with a budget shows O2 budget left, warns once at 80, and every send past 100', async ($, on) => {
  await world($, on, 'api-2')
  await measure($, [], 0.5)
  await $.command.run({ command: 'budget', args: '$10 day' } as never)
  await measure($, [], 2)
  expect(await bar($)).toContain('O₂ 80% · $8.00 left')
  await measure($, [], 8.5)
  await measure($, [], 8.6)
  expect(toasts.filter(t => t.includes('budget is used')).length).toBe(1)
  await measure($, [], 11.2)
  expect(toasts.filter(t => t.startsWith('Over your daily budget by $1.20')).length).toBe(1)
  await send($)
  await send($)
  expect(toasts.filter(t => t.startsWith('Over your daily budget by $1.20')).length).toBe(3)
  const shown = await $.command.run({ command: 'budget', args: '' } as never)
  expect(JSON.stringify(shown)).toContain('$10.00 per day')
})

test('before the first reply a budget is not stored; the last seen account kind carries to a new session', async ($, on) => {
  await world($, on, 'fresh-1')
  expect(JSON.stringify(await $.command.run({ command: 'budget', args: '$5 day' } as never))).toContain(ACCOUNT_UNKNOWN)
  expect(await bar($)).not.toContain('$5')
  expect(knownKind({ kind: 'unknown', gateway: null }, 'subscriber')).toBe('subscriber')
  expect(knownKind({ kind: 'unknown', gateway: null }, 'nonsense')).toBe('unknown')
  expect(knownKind({ kind: 'api', gateway: null }, 'subscriber')).toBe('api')
})
