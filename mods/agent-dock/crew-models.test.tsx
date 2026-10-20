import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { capModel, modelMix, tierOf } from './dock-logic'
import { autoRule, categorize, lowerEffort, parseRules, pickModel, rulesText, suggestions } from './categories'
import type { CrewLogEntry } from './categories'

// The engine beneath carapace, recording which model each helper was launched on.
async function world($: Engine, on: On, main: string, store: Record<string, unknown> = {}) {
  const launched: Record<string, string | undefined> = {}
  mock.store(on, store)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.toast', 'ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: main }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: `agent-${e.tool_use_id}` }))
  on('tool.call', ($, e) => {
    launched[e.tool_use_id] = (e as { model?: string }).model
    return { result: { status: 'completed' } }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clean', args: 'off' } as never)

  return launched
}

const helper = ($: Engine, id: string, description: string, model?: string) =>
  $.tool.call({ tool: 'Agent', tool_use_id: id, description, prompt: `Do: ${description}`, ...(model ? { model } : {}) } as never)

test('the word rules: lookups on Haiku, hard thinking on Opus, the rest on Sonnet', () => {
  expect(pickModel('Find bakery prices')).toBe('haiku')
  expect(pickModel('Read the reviews')).toBe('haiku')
  expect(pickModel('Write the landing page')).toBe('sonnet')
  expect(pickModel('Debug the checkout flow')).toBe('opus')
  expect(pickModel('Design the database schema')).toBe('opus')
  expect(pickModel('Review the code for bugs')).toBe('opus')
  expect(tierOf('claude-opus-5-5')).toBe('opus')
  expect(capModel('fable', 'claude-opus-5-5')).toBe('opus')
  expect(capModel('opus', 'claude-sonnet-5-5')).toBe('sonnet')
  expect(capModel('haiku', 'claude-opus-5-5')).toBe('haiku')
  expect(modelMix(['haiku', 'opus', 'haiku', null])).toBe('2 Haiku 1 Opus')
  expect(autoRule({})).toContain('Lookup (find, search, list, read): "haiku"')
  expect(pickModel('Design a one-line slogan for a bakery')).toBe('sonnet')
})

test('Auto picks per helper, keeps Claude\'s pick, and never goes above your model', async ($, on) => {
  const launched = await world($, on, 'claude-opus-5-5')
  await helper($, 'a', 'Find bakery prices')
  await helper($, 'b', 'Write the landing page')
  await helper($, 'c', 'Debug the checkout flow')
  await helper($, 'd', 'Anything at all', 'sonnet')
  await helper($, 'e', 'Big thinking', 'fable')
  expect(launched).toEqual({ a: 'haiku', b: 'sonnet', c: 'opus', d: 'sonnet', e: 'opus' })
})

test('on Sonnet, a hard task stays on Sonnet', async ($, on) => {
  const launched = await world($, on, 'claude-sonnet-5-5')
  await helper($, 'a', 'Design the database schema')
  expect(launched.a).toBe('sonnet')
})

test('Same as me leaves the model alone', async ($, on) => {
  const same = await world($, on, 'claude-opus-5-5', { agentDockHelperModel: 'same' })
  await helper($, 'a', 'Find bakery prices')
  expect(same.a).toBe(undefined)
})

test('Fast & Cheap puts every helper on Haiku', async ($, on) => {
  const fast = await world($, on, 'claude-opus-5-5', { agentDockHelperModel: 'fast' })
  await helper($, 'a', 'Design the database schema')
  expect(fast.a).toBe('haiku')
})

const compose = ($: Engine) =>
  $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Agent'], outputStyle: null, traits: [] })

test('on Auto, Claude\'s standing instructions carry the model rule', async ($, on) => {
  await world($, on, 'claude-opus-5-5')
  expect((await compose($)).sections.map(x => x.text).join('\n')).toContain('Crew is on Auto')
})

test('Same as me adds no model rule', async ($, on) => {
  await world($, on, 'claude-opus-5-5', { agentDockHelperModel: 'same' })
  expect((await compose($)).sections.map(x => x.text).join('\n')).not.toContain('Crew is on Auto')
})

test('categories: each task lands in its kind, and your rules change the model', () => {
  expect(categorize('Find bakery prices')).toBe('lookup')
  expect(categorize('Summarize the PDF')).toBe('extract')
  expect(categorize('Run the tests')).toBe('check')
  expect(categorize('Draft the launch email')).toBe('write')
  expect(categorize('Fix the login page')).toBe('code')
  expect(categorize('Compare three hosting options')).toBe('research')
  expect(categorize('Design the database schema')).toBe('design')
  expect(categorize('Debug the search results')).toBe('debug')
  expect(pickModel('Fix the login page', { code: 'opus' })).toBe('opus')
  expect(autoRule({ code: 'opus' })).toContain('Code (build, fix, refactor): "opus"')
  expect(lowerEffort('high', 'low')).toBe('low')
  expect(lowerEffort('low', 'high')).toBe(undefined)
  expect(parseRules('')).toEqual({ kind: 'show' })
  expect(parseRules('code opus')).toEqual({ kind: 'set', category: 'code', tier: 'opus' })
  expect(parseRules('reset')).toEqual({ kind: 'reset' })
  expect(parseRules('dance opus').kind).toBe('error')
  expect(rulesText({ code: 'opus' }, [])).toContain('(yours)')
})

test('the Crew learns: stuck Haiku lookups suggest Sonnet; a clean record suggests a cheaper model', () => {
  const run = (category: CrewLogEntry['category'], tier: CrewLogEntry['tier'], isStuck: boolean): CrewLogEntry => ({ category, tier, ms: 1000, isStuck, at: 0 })
  const shaky = [...Array.from({ length: 9 }, () => run('lookup', 'haiku', false)), ...Array.from({ length: 4 }, () => run('lookup', 'haiku', true))]
  expect(suggestions(shaky, {})[0]).toContain('/crew rules lookup sonnet')
  const steady = Array.from({ length: 20 }, () => run('code', 'sonnet', false))
  expect(suggestions(steady, {})[0]).toContain('/crew rules code haiku')
  expect(suggestions(shaky.slice(0, 5), {})).toEqual([])
})

test('/crew rules shows the table, changes a row, and the next helper follows it', async ($, on) => {
  const launched = await world($, on, 'claude-opus-5-5')
  expect((await $.command.run({ command: 'crew', args: 'rules' } as never)).text).toContain('Crew rules on Auto')
  expect((await $.command.run({ command: 'crew', args: 'rules code opus' } as never)).text).toContain('(yours)')
  await helper($, 'a', 'Fix the login page')
  expect(launched.a).toBe('opus')
  await $.command.run({ command: 'crew', args: 'rules reset' } as never)
  await helper($, 'b', 'Fix the login page')
  expect(launched.b).toBe('sonnet')
})
