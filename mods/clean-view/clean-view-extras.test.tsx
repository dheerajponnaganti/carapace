import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const notes: string[] = []

// The engine beneath the plugin: a context reading, a clock, and the calls the mod makes.
let reading = 10
let isEveryRefused = false
const eases: number[] = []
let ticks = 0
type Saved = { phase: string; tasks: { status: string }[]; startedAt: number } | null
let saved: Saved = null

async function world($: Engine, on: On, usedPercent = 10) {
  reading = usedPercent
  isEveryRefused = false
  eases.length = 0
  ticks = 0
  saved = null
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('*', (_, e, next) => {
    if (isEveryRefused && next.is('clock.every', e)) throw new Error('refused')

    return next(e)
  })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__carapace__' + e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', ($, e) => {
    notes.push(String((e as unknown as { text: string }).text))
    return { value: { isSent: true as const, channel: 'test' } }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Notification', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('session.usage', () => ({ value: { context: { percent: reading }, rateLimits: [] } } as never))
  on('state.set', { plugin: 'carapace', key: 'checklist' }, ($, e, next) => {
    saved = e.value as Saved
    return next(e)
  })
  on('state.set', { plugin: 'carapace', key: 'tick' }, ($, e, next) => {
    ticks += 1
    return next(e)
  })
  on('state.set', { plugin: 'carapace', key: 'cleanViewContextEase' }, ($, e, next) => {
    eases.push((e.value as { from: number } | null)?.from ?? -1)
    return next(e)
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] } as never))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return clock
}


function bandButtons(band: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) {
  return band.findAll({ type: 'Button' }).then(found => found.map(button => button.text).join('|'))
}

test('the compact button shows at crush depth and waits while a turn runs', async ($, on) => {
  await world($, on, 90)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandButtons(band)).toContain('compact now')
  await $.turn.start({ text: 'Fix my contact form', turnId: 'turn-c' })
  const busy = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandButtons(busy)).not.toContain('compact now')
})

test('no compact button below crush depth', async ($, on) => {
  await world($, on, 40)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandButtons(band)).not.toContain('compact now')
})


test('with Clean View off, a risky command row warns and a finished call shows its time', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'clean', args: 'off' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'call-risky', command: 'rm -rf build' } as never)
  const row = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'ToolUse', props: { tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'call-risky', isRunning: false, isErrored: false, isInterrupted: false, output: {} } })
  const text = (await row.findAll({ type: 'Text' })).map(found => found.text).join(' ')
  expect(text).toContain('✕ hull breach')
  expect(text).toContain('◎')
})

test('with Clean View off, a folded group row warns about a risky command and shows its time', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'clean', args: 'off' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'g-1', command: 'git push --force' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'g-2', file_path: 'README.md' } as never)
  const calls = [
    { tool: 'Bash', input: { command: 'git push --force' }, tool_use_id: 'g-1', isRunning: false, isErrored: false, isInterrupted: false },
    { tool: 'Read', input: { file_path: 'README.md' }, tool_use_id: 'g-2', isRunning: false, isErrored: false, isInterrupted: false },
  ]
  const row = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'ToolGroup', props: { calls, isActive: false, isExpanded: false } })
  const text = (await row.findAll({ type: 'Text' })).map(found => found.text).join(' ')
  expect(text).toContain('✕ hull breach')
  expect(text).toContain('◎')
})

test('a long job sends a notice, and /clean notify off stops it', async ($, on) => {
  const clock = await world($, on)
  notes.length = 0
  await $.prompt.submit({ text: 'Fix my contact form', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Fix my contact form', turnId: 'turn-n1' })
  await clock.advance(61_000)
  await $.turn.complete({ answer: 'Done.', durationMs: 61000, isAborted: false, turnId: 'turn-n1', reason: 'answer' } as never)
  expect(notes).toEqual(['Surfaced · Fix my contact form · 1m 1s'])

  await $.command.run({ command: 'clean', args: 'notify off' } as never)
  await $.prompt.submit({ text: 'Fix my contact form again', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Fix my contact form again', turnId: 'turn-n2' })
  await clock.advance(61_000)
  await $.turn.complete({ answer: 'Done.', durationMs: 61000, isAborted: false, turnId: 'turn-n2', reason: 'answer' } as never)
  expect(notes.length).toBe(1)
})

async function markColor($: Engine) {
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const found = await band.findAll({ type: 'Text', text: /^◇ $/ })

  return String(found.find(f => f.props.color)?.props.color)
}

async function startJob($: Engine) {
  await $.prompt.submit({ text: 'Build my landing page', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Build my landing page', turnId: 'turn-t' })
  await $.tool.call({ tool: 'mcp__carapace__plan_steps', tool_use_id: 'plan', steps: ['Read your notes', 'Build the page'] } as never)
}

test('the breathing mark steps once a second even while a quick frame runs', async ($, on) => {
  const clock = await world($, on)
  await startJob($)
  await clock.advance(1000)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls' } as never)
  reading = 30
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c2', command: 'ls' } as never)
  const colors = [await markColor($)]
  for (let i = 0; i < 3; i += 1) {
    await clock.advance(250)
    colors.push(await markColor($))
  }

  expect(new Set(colors).size).toBe(1)
})

test('a second reading mid-ease starts from the value on screen', async ($, on) => {
  const clock = await world($, on)
  await startJob($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls' } as never)
  reading = 50
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c2', command: 'ls' } as never)
  await clock.advance(500)
  reading = 90
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c3', command: 'ls' } as never)

  expect(eases.at(-1)).toBeLessThan(50)
})

test('an interval the engine ended is started again', async ($, on) => {
  const clock = await world($, on)
  await startJob($)
  isEveryRefused = true
  await clock.advance(3000)
  isEveryRefused = false
  await clock.advance(5000)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'ls' } as never)
  const before = ticks
  await clock.advance(3000)

  expect(ticks).toBeGreaterThan(before)
})

test('a stopped interval restarts within 10 s with no event at all', async ($, on) => {
  const clock = await world($, on)
  await startJob($)
  isEveryRefused = true
  await clock.advance(20_000)
  isEveryRefused = false
  await clock.advance(10_000)
  const before = ticks
  await clock.advance(3000)

  expect(ticks).toBeGreaterThan(before)
})

async function headText($: Engine) {
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  return (await band.findAll({ type: 'Text' })).map(found => found.text).join('')
}

async function current(_: Engine) {
  return saved
}

test('an answer that is a statement leaves open steps open and does not say All done', async ($, on) => {
  const clock = await world($, on)
  await startJob($)
  await $.turn.complete({ answer: 'I could not finish step 2, the tests fail.', durationMs: 900, isAborted: false, turnId: 'turn-t', reason: 'answer' } as never)
  const list = await current($)
  expect(list?.phase).toBe('done')
  expect(list?.tasks.filter(task => task.status === 'done').length).toBe(0)
  const text = await headText($)
  expect(text).not.toContain('All done')
  expect(text).toContain('Finished · 0 of 2 steps')

  const startedAt = list?.startedAt
  await clock.advance(1000)
  await $.prompt.submit({ text: 'Try again', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Try again', turnId: 'turn-t2' })
  expect((await current($))?.startedAt).not.toBe(startedAt)
})

test('a job with every step done still says All done', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'Build my landing page', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Build my landing page', turnId: 'turn-t' })
  await $.tool.call({ tool: 'mcp__carapace__plan_steps', tool_use_id: 'plan', steps: ['Read your notes'] } as never)
  await $.tool.call({ tool: 'mcp__carapace__report_progress', tool_use_id: 'rp', task: 'Read your notes', percent: 100 } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 900, isAborted: false, turnId: 'turn-t', reason: 'answer' } as never)
  expect(await headText($)).toContain('All done')
})

test('a short follow-up turn on an old job neither surfaces nor notifies', async ($, on) => {
  const clock = await world($, on)
  notes.length = 0
  await $.prompt.submit({ text: 'Fix my contact form', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Fix my contact form', turnId: 'turn-f1' })
  await clock.advance(61_000)
  await $.turn.complete({ answer: 'Done.', durationMs: 61000, isAborted: false, turnId: 'turn-f1', reason: 'answer' } as never)
  expect(notes.length).toBe(1)
  await clock.advance(3_600_000)
  await $.turn.start({ text: 'Message from @general-purpose: all good', turnId: 'turn-f2' })
  await clock.advance(5_000)
  expect(await headText($)).toContain('5s')
  await $.turn.complete({ answer: 'Noted.', durationMs: 5000, isAborted: false, turnId: 'turn-f2', reason: 'answer' } as never)
  expect(notes.length).toBe(1)
  expect(await headText($)).not.toContain('Surfaced')
})

test('an answer with no plan at all still says All done', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'What is a tide line?', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'What is a tide line?', turnId: 'turn-q' })
  await $.turn.complete({ answer: 'A line drawn by the tide.', durationMs: 900, isAborted: false, turnId: 'turn-q', reason: 'answer' } as never)

  expect(await headText($)).toContain('All done')
})

test('open steps of a finished job read Not done, not Working', async ($, on) => {
  await world($, on)
  await startJob($)
  await $.turn.complete({ answer: 'Stopping early.', durationMs: 900, isAborted: false, turnId: 'turn-t', reason: 'answer' } as never)
  const text = await headText($)

  expect(text).toContain('Not done')
  expect(text).not.toContain('Working')
})

test('a compaction empties the depth gauge', async ($, on) => {
  const clock = await world($, on, 90)
  const deep = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandButtons(deep)).toContain('compact now')
  // The engine still reports the old fill here: it has none until the next response.
  // As /compact dispatches it: core hands over the transcript.
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] } as never)
  await clock.advance(2000)
  const after = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandButtons(after)).not.toContain('compact now')
})

test('the compact button empties the depth gauge', async ($, on) => {
  const clock = await world($, on, 90)
  const deep = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await deep.press({ key: 'compact-now' })
  await clock.advance(2000)
  const after = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await bandButtons(after)).not.toContain('compact now')
})
