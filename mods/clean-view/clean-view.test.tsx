import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { CleanViewChecklist as Checklist } from '../../types'

const PLAN = 'mcp__carapace__plan_steps'
const PROGRESS = 'mcp__carapace__report_progress'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

let calls = 0
let saved: Checklist | null = null

// The engine beneath the plugin: every call the mod makes is answered here.
const registered: string[] = []
async function world($: Engine, on: On, extra?: () => void, isInteractive = true) {
  saved = null
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  registered.length = 0
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__carapace__${e.name}` } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'Build my landing page',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('state.set', { plugin: 'carapace', key: 'checklist' }, ($, e, next) => {
    saved = e.value as Checklist | null
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Notification', () => ({}))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  extra?.()
  await $.session.start({ cwd: '/', surface: isInteractive ? 'terminal' : null, isInteractive })

  return clock
}

function call($: Engine, tool: string, input: Record<string, unknown>) {
  calls += 1

  return $.tool.call({ tool, tool_use_id: `call-${calls}`, ...input } as never)
}

// The last checklist the mod wrote, as the state hook beneath it saw it.
async function checklist(_: Engine) {
  return saved
}

async function bandText($: Engine, surface: (typeof SURFACES)[number]) {
  const band = await $.ui.mount({ plugin: 'carapace', surface, component: 'AbovePrompt', props: BAND })
  const texts = await band.findAll({ type: 'Text' })
  const buttons = await band.findAll({ type: 'Button' })

  return [...texts, ...buttons].map(found => found.text).join('\n')
}

test('names are cleaned to plain English', async ($, on) => {
  await world($, on)
  await call($, PLAN, {
    steps: [
      'Build the pricing section in `src/Pricing.tsx`',
      'update the hero in src/components/Hero.tsx today',
      'Make the whole marketing site faster for people opening it on slow phones',
    ],
  })
  const names = (await checklist($))?.tasks.map(task => task.name) ?? []

  expect(names[0]).toBe('Build the pricing section in')
  expect(names[1]).toBe('Update the hero in today')
  expect(names[2].length).toBeLessThanOrEqual(40)
  expect(names[2].endsWith('…')).toBe(true)
})

test('a to-do list and a 60% report draw done, current, next and up next rows', async ($, on) => {
  await world($, on)
  await call($, 'TodoWrite', {
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await call($, PROGRESS, { task: 'Build the pricing section', percent: 60 })

  for (const surface of SURFACES) {
    const text = await bandText($, surface)
    expect(text).toContain('✓')
    expect(text).toContain('Done')
    expect(text).toContain('▸')
    expect(text).toContain('60%')
    expect(text).toContain('Next')
    expect(text).not.toContain('Up next')
    expect(text).toContain('● Clean')
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  const clock = await world($, on)
  await $.prompt.submit({ text: 'Build my landing page with a pricing section', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Build my landing page with a pricing section', turnId: 'turn-1' })
  await clock.settle()
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })

  expect((await checklist($))?.phase).toBe('needsYou')
  expect(await bandText($, 'terminal')).toContain('Needs you')
})

test('/clean off hides the checklist and keeps the button', async ($, on) => {
  await world($, on)
  await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.command.run({ command: 'clean', args: 'off' } as never)

  const text = await bandText($, 'terminal')
  expect(text).toContain('○ Clean')
  expect(text).not.toContain('▶')
  expect(text).not.toContain('Build the pricing section')
})

test('reporting 100 checks off step one and starts step two', async ($, on) => {
  await world($, on)
  await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
  await call($, PROGRESS, { task: 'Read your brand notes', percent: 100 })
  const statuses = (await checklist($))?.tasks.map(task => task.status)

  expect(statuses).toEqual(['done', 'active', 'upcoming'])
})

test('tools are refused before a plan and allowed after', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'Fix my contact form', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Fix my contact form', turnId: 'turn-2' })
  const before = await call($, 'Bash', { command: 'ls' })
  expect(before.deny ?? before.text ?? '').toContain('plan')
  expect((await call($, 'Read', { file_path: '/tmp/a' })).deny).toBeUndefined()
  expect((await call($, 'Edit', { file_path: '/tmp/a', old_string: 'a', new_string: 'b' })).deny ?? '').toContain('plan')

  await call($, PLAN, { steps: ['Look at your contact form', 'Fix what is broken'] })
  const after = await call($, 'Bash', { command: 'ls' })
  expect(after.deny).toBeUndefined()
  expect(after.isError).toBeUndefined()
})

test('a headless run (claude -p, CI) has no plan gate: no one sees the checklist', async ($, on) => {
  await world($, on, () => {
    mock.env(on, { HOME: '/home/test' })
    on('session.id', () => ({ value: 'headless-1' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('fs.exists', () => ({ value: false }))
    on('fs.list', () => ({ value: [] }))
    on('ui.panes', () => ({ value: [] }))
  }, false)
  await $.prompt.submit({ text: 'Fix my contact form', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Fix my contact form', turnId: 'turn-h' })
  expect((await call($, 'Bash', { command: 'ls' })).deny).toBeUndefined()
  expect(registered).not.toContain('plan_steps')
})

test('a quick answer needs no plan and still ends as All done', async ($, on) => {
  await world($, on)
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [PLAN, 'ToolSearch'], outputStyle: null, traits: [] })
  const rules = composed.sections.map(section => section.text).join('\n')
  expect(rules).toContain('no tools at all, answer directly')

  await $.prompt.submit({ text: 'What does Clean View do for me', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'What does Clean View do for me', turnId: 'turn-q' })
  await $.turn.complete({ answer: 'It hides tool rows.', durationMs: 900, isAborted: false, turnId: 'turn-q', reason: 'answer' } as never)
  expect((await checklist($))?.phase).toBe('done')
})

test('a helper\'s result arriving as its own turn keeps the job', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'Fix my contact form', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Fix my contact form', turnId: 'turn-h1' })
  const startedAt = (await checklist($))?.startedAt
  // The engine delivers a background helper's answer as a turn with text, but no prompt from the person.
  await $.turn.start({ text: 'Message from @general-purpose: the form posts to the wrong URL', turnId: 'turn-h2' })
  expect((await checklist($))?.startedAt).toBe(startedAt)
})

test('the bar draws a tide, dive-log depths when wide, and the short connectors when narrow', async ($, on) => {
  await world($, on)
  await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
  const wide = await bandText($, 'terminal')
  expect(wide).toContain(' 0 m')
  expect(wide).toContain('12 m')
  expect(wide).toContain('─┬─')
  expect(wide).toContain('└─')
  expect(wide).toMatch(/[▁▂▃▄▅]/)

  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 50 } })
  const narrow = [...(await band.findAll({ type: 'Text' })), ...(await band.findAll({ type: 'Button' }))].map(found => found.text).join('\n')
  expect(narrow).not.toContain(' 0 m')
  expect(narrow).toContain('┬─')
})

test('a reworded report ticks the active planned step instead of adding a row', async ($, on) => {
  await world($, on)
  await call($, PLAN, { steps: ['Read notes', 'Build page', 'Ship it'] })
  await call($, PROGRESS, { task: 'Doing the reading', percent: 100 })

  const tasks = (await checklist($))?.tasks ?? []
  expect(tasks.map(t => t.name)).toEqual(['Read notes', 'Build page', 'Ship it'])
  expect(tasks.map(t => t.status)).toEqual(['done', 'active', 'upcoming'])
})

test('two steps that clean to the same name are both reachable', async ($, on) => {
  await world($, on)
  await call($, PLAN, { steps: ['Edit src/a.ts', 'Edit src/b.ts'] })
  await call($, PROGRESS, { task: 'Edit src/a.ts', percent: 100 })
  await call($, PROGRESS, { task: 'Edit src/b.ts', percent: 100 })

  expect((await checklist($))?.tasks.map(t => t.status)).toEqual(['done', 'done'])
})

test('a second plan keeps finished steps done', async ($, on) => {
  await world($, on)
  await call($, PLAN, { steps: ['Read notes', 'Build page'] })
  await call($, PROGRESS, { task: 'Read notes', percent: 100 })
  await call($, PLAN, { steps: ['Read notes', 'Build page', 'Ship it'] })

  expect((await checklist($))?.tasks.map(t => t.status)).toEqual(['done', 'active', 'upcoming'])
})

test('an ask verdict alone does not turn the job to Needs you', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' as const }))
  const clock = await world($, on)
  await $.prompt.submit({ text: 'Build my landing page with a pricing section', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Build my landing page with a pricing section', turnId: 'turn-1' })
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'c1' } as never)

  expect((await checklist($))?.phase).not.toBe('needsYou')
})

const START = (text: string, turnId: string, extra: Record<string, unknown> = {}) => ({ text, turnId, ...extra }) as never
const COMPLETE = (answer: string, turnId: string) =>
  ({ answer, durationMs: 1000, isAborted: false, turnId, reason: 'answer' }) as never

test('a helper turn start leaves a waiting job alone', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'Build my landing page', origin: { kind: 'composer' } } as never)
  await $.turn.start(START('Build my landing page', 't1'))
  await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  await $.turn.start(START('helper work', 't2', { agentId: 'agent-1' }))

  expect((await checklist($))?.phase).toBe('needsYou')
})

test('a follow-up turn that is not the person revives a finished job', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'Build my landing page', origin: { kind: 'composer' } } as never)
  await $.turn.start(START('Build my landing page', 't1'))
  await call($, PLAN, { steps: ['Read your brand notes'] })
  await $.turn.complete(COMPLETE('Done.', 't1'))
  expect((await checklist($))?.phase).toBe('done')
  await $.turn.start(START('A helper finished', 't2'))

  const job = await checklist($)
  expect(job?.phase).toBe('working')
  expect(job?.title).toBe('Build my landing page')
})

test('a normal finish leaves an unticked step open and is done, a closing question waits', async ($, on) => {
  await world($, on)
  await $.prompt.submit({ text: 'Build my landing page', origin: { kind: 'composer' } } as never)
  await $.turn.start(START('Build my landing page', 't1'))
  await call($, PLAN, { steps: ['Read your brand notes', 'Build the pricing section'] })
  await $.turn.complete(COMPLETE('All set.', 't1'))
  const done = await checklist($)
  expect(done?.phase).toBe('done')
  expect(done?.tasks.some(task => task.status === 'done')).toBe(false)

  await $.prompt.submit({ text: 'Now the footer', origin: { kind: 'composer' } } as never)
  await $.turn.start(START('Now the footer', 't2'))
  await call($, PLAN, { steps: ['Read the footer', 'Write the footer'] })
  await $.turn.complete(COMPLETE('Which colour do you want?', 't2'))
  expect((await checklist($))?.phase).toBe('needsYou')
})

test('the turn flag lives in state, so a hot reload keeps it', async ($, on) => {
  const seen: unknown[] = []
  await world($, on, () =>
    on('state.set', { plugin: 'carapace', key: 'cleanViewTurnRunning' }, ($, e, next) => {
      seen.push(e.value)
      return next(e)
    }),
  )
  await $.turn.start(START('Build my landing page', 't1'))
  await $.turn.complete(COMPLETE('Done.', 't1'))

  expect(seen).toEqual([true, false])
})

test('the ping and rise start before the notice finishes sending', async ($, on) => {
  const clock = await world($, on, () => on('ui.notify', () => new Promise(() => undefined)))
  await $.prompt.submit({ text: 'Fix my contact form', origin: { kind: 'composer' } } as never)
  await $.turn.start(START('Fix my contact form', 't1'))
  await clock.advance(61_000)
  await $.turn.complete(COMPLETE('Done.', 't1'))

  expect((await checklist($))?.phase).toBe('done')
})

const todos = (count: number, activeAt: number) =>
  Array.from({ length: count }, (_, i) => ({
    content: `Step number ${i + 1} of the job`,
    status: i < activeAt ? 'completed' : i === activeAt ? 'in_progress' : 'pending',
    activeForm: 'Working',
  }))

test('twelve steps keep every depth label the same width', async ($, on) => {
  const clock = await world($, on)
  await call($, 'TodoWrite', { todos: todos(12, 3) })
  await clock.advance(5_000)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const labels = (await band.findAll({ type: 'Text' })).map(found => found.text).filter(text => /^ *\d+ m $/.test(text))

  expect(labels.length).toBe(12)
  expect(new Set(labels.map(label => label.length)).size).toBe(1)
  expect(labels[11]).toBe('132 m ')
})

test('a long list shows a window around the active step with +N more lines', async ($, on) => {
  const clock = await world($, on)
  await call($, 'TodoWrite', { todos: todos(30, 15) })
  await clock.advance(5_000)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, maxRows: 10 } })
  const text = (await band.findAll({ type: 'Text' })).map(found => found.text).join('\n')

  expect(text).toContain('Step number 16 of the job')
  expect(text).not.toContain('Step number 1 of the job')
  expect(text).toMatch(/\+\d+ more/)
  expect(text).toContain('Working')
  expect((text.match(/Step number \d+ of/g) ?? []).length).toBeLessThanOrEqual(8)
})
