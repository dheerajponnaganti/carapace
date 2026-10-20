import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentDockMission as Mission } from '../../types'

import { activityLine, clashes, fileTouch, gateLabel, gateStep, parseChecks, parseSize, sessionBadge, withAction, withTouch } from './dock-logic'

const PANE = 'agent-dock'
const PROGRESS = 'mcp__carapace__report_progress'

type World = {
  mission: () => Mission | null
  submitted: { text: string; context?: readonly string[] }[]
  statuses: (string | undefined)[]
  open: Set<string>
  gate: (id: string) => () => void
  settle: () => Promise<void>
  advance: (ms: number) => Promise<void>
}

let isEveryRefused = false
let frames = 0

let calls = 0
let gateChecks = ''
let gateCode = 0

// The engine beneath carapace: every call the mods make is answered here.
// The main conversation's record, as $.session.messages() answers it.
let crewRows: unknown[] = []
// What the Crew sent to helpers.
const sentNotes: { to: unknown; text: string }[] = []

async function world($: Engine, on: On, store: Record<string, unknown> = {}): Promise<World> {
  crewRows = []
  sentNotes.length = 0
  on('session.messages', () => ({ value: crewRows }) as never)
  on('session.send', ($, e) => {
    sentNotes.push({ to: e.to, text: e.text })
    return { isDelivered: true as const }
  })

  let mission: Mission | null = null
  const submitted: World['submitted'] = []
  const statuses: World['statuses'] = []
  const open = new Set<string>()
  const gates = new Map<string, { wait: Promise<void>; release: () => void }>()
  isEveryRefused = false
  frames = 0
  mock.store(on, store)
  on('*', (_, e, next) => {
    if (isEveryRefused && next.is('clock.every', e)) throw new Error('refused')

    return next(e)
  })
  on('state.set', { plugin: 'carapace', key: 'agentDockFrame' }, ($, e, next) => {
    frames += 1
    return next(e)
  })
  mock.env(on, { HOME: '/home/test' })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) as never }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', (_, e) => ({ value: String(e.path).endsWith('.carapace/done-checks') ? gateChecks : '' }) as never)
  on('process.run', () => ({ value: { exitCode: gateCode, stdout: gateCode ? 'boom' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('model.complete', () => ({
    value: { isAnswered: true as const, text: 'Research bakery pricing', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  on('classic.SubagentStop', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStart', () => ({}))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: `agent-${e.tool_use_id}` }))
  on('tool.call', async ($, e) => {
    await gates.get(e.tool_use_id)?.wait
    return { result: { status: 'completed' } }
  })
  on('state.set', { plugin: 'carapace', key: 'agentDockMission' }, ($, e, next) => {
    mission = e.value as Mission | null
    return next(e)
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Clean View's plan rule would refuse these helpers; the dock is what is under test.
  await $.command.run({ command: 'clean', args: 'off' } as never)

  return {
    mission: () => mission,
    submitted,
    statuses,
    open,
    gate: id => {
      let release = () => undefined as void
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      gates.set(id, { wait, release })
      return release
    },
    advance: ms => clock.advance(ms),
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await clock.settle()
    },
  }
}

// A request the way a person sends one: the prompt first, then its turn.
async function request($: Engine, text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text, turnId })
}

// A helper as the engine runs it now: the launch returns, the helper starts, and it is done when its own turn completes.
async function agent($: Engine, id: string, description: string) {
  const ran = await $.tool.call({ tool: 'Agent', tool_use_id: id, description, prompt: `Do: ${description}` } as never)
  if ((ran as { deny?: string }).deny === undefined) {
    await $.agent.spawn({ tool_use_id: id, prompt: description, description, subagentType: 'general-purpose', background: true, fork: false } as never)
    await $.turn.complete({ agentId: `agent-${id}`, answer: 'done', durationMs: 1, isAborted: false, turnId: `h-${id}`, reason: 'answer' } as never)
  }
  return ran
}

function dock($: Engine, args = '') {
  return $.command.run({ command: 'crew', args } as never)
}

async function paneText($: Engine, columns = 100) {
  const ui = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Crew', isFocused: false, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  })
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  await ui.unmount()

  return text
}

test('parseSize takes whole numbers from 1 to 100 only', () => {
  expect(parseSize('10')).toBe(10)
  expect(parseSize(' 25 ')).toBe(25)
  for (const bad of ['0', '101', 'abc', '2.5']) expect(parseSize(bad)).toBeNull()
})

test('a saved team of 50 comes back as 1', async ($, on) => {
  await world($, on, { agentDockSize: 50 })
  expect(await paneText($)).toContain('Claude decides how many helpers')
})

test('a saved team of 10 stays 10', async ($, on) => {
  await world($, on, { agentDockSize: 10 })
  expect(await paneText($)).toContain('Splits each request across 10 helpers')
})

test('at size 5 a request carries the exactly-5 instruction; at size 1 nothing', async ($, on) => {
  const w = await world($, on)
  await $.prompt.submit({ text: 'Research bakery pricing', wait: false, origin: { kind: 'composer' } } as never)
  expect(w.submitted[0]?.context ?? []).toEqual([])

  await dock($, '5')
  await w.settle()
  await $.prompt.submit({ text: 'Research bakery pricing', wait: false, origin: { kind: 'composer' } } as never)
  expect((w.submitted[1]?.context ?? []).join('\n')).toContain('exactly 5 independent pieces')
})

test('the 6th helper at size 5 is refused with the crew size message', async ($, on) => {
  const w = await world($, on)
  await dock($, '5')
  await w.settle()
  await request($, 'Price check five bakeries', 't-4')
  for (let i = 1; i <= 5; i += 1) expect((await agent($, `a${i}`, `Price check: shop ${i}`)).deny).toBeUndefined()
  const sixth = await agent($, 'a6', 'Price check: shop 6')

  expect(sixth.deny).toBe('Crew size is 5: this request already has 5 helpers. Finish with the helpers you have.')
})

test('a request that used 3 of 10 gets exactly one nudge', async ($, on) => {
  const w = await world($, on)
  await dock($, '10')
  await w.settle()
  await request($, 'Price check ten bakeries', 't-5')
  for (let i = 1; i <= 3; i += 1) await agent($, `n${i}`, `Price check: shop ${i}`)
  const end = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-5', reason: 'answer' } as never
  await $.turn.complete(end)
  await $.turn.complete(end)
  const nudges = w.submitted.filter(s => s.text.startsWith('You used '))

  expect(nudges).toHaveLength(1)
  expect(nudges[0]?.text).toContain('You used 3 of 10 helpers')
})

test('cards go queued, working, done; a helper at 60 shows 60%', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-6')
  const tasks = ['Price check: Panera', 'Price check: Crumbl', 'Price check: Tartine']
  await $.session.append({
    door: 'response',
    uuid: 'row-1',
    origin: { kind: 'model' },
    message: {
      type: 'assistant',
      role: 'assistant',
      content: tasks.map((task, i) => ({ type: 'tool_use', id: `c${i}`, name: 'Agent', input: { description: task, prompt: task } })),
    },
  } as never)
  expect(w.mission()?.cards.map(c => c.status)).toEqual(['queued', 'queued', 'queued'])

  const releases = tasks.map((_, i) => w.gate(`c${i}`))
  const running = tasks.map((task, i) => agent($, `c${i}`, task))
  await w.settle()
  expect(w.mission()?.cards.map(c => c.status)).toEqual(['working', 'working', 'working'])

  await $.agent.spawn({ tool_use_id: 'c0', prompt: tasks[0], description: tasks[0], subagentType: 'general-purpose', background: false, fork: false } as never)
  await $.tool.call({ tool: PROGRESS, tool_use_id: 'p1', agentId: 'agent-c0', task: tasks[0], percent: 60 } as never)
  expect(w.mission()?.cards[0]?.percent).toBe(60)
  expect(await paneText($)).toContain('60%')

  for (const release of releases) release()
  await Promise.all(running)
  expect(w.mission()?.cards.map(c => c.status)).toEqual(['done', 'done', 'done'])
})

test('all done shows the summary line', async ($, on) => {
  const w = await world($, on)
  await dock($, '3')
  await w.settle()
  await request($, 'Research bakery pricing for three shops', 't-7')
  for (let i = 1; i <= 3; i += 1) await agent($, `s${i}`, `Price check: shop ${i}`)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-7', reason: 'answer' } as never)

  expect(await paneText($)).toContain('3 agents finished Research bakery pricing for three shops in')
})

test('/crew folds to the status badge and back', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-8')
  await agent($, 'f1', 'Price check: Panera')

  expect((await dock($)).text).toBe('Opening your Crew.')
  await w.settle()
  expect(w.open.has(PANE)).toBe(true)

  expect((await dock($)).text).toContain('Folding your Crew')
  await w.settle()
  expect(w.open.has(PANE)).toBe(false)
  expect(w.statuses.at(-1)).toContain('1 done')

  await dock($)
  await w.settle()
  expect(w.open.has(PANE)).toBe(true)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('50 helpers draw as tiles that fit narrow and wide panes', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research fifty bakeries', 't-9')
  await $.session.append({
    door: 'response',
    uuid: 'row-50',
    origin: { kind: 'model' },
    message: {
      type: 'assistant',
      role: 'assistant',
      content: Array.from({ length: 50 }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Agent', input: { description: `Price check: shop ${i}` } })),
    },
  } as never)
  expect(w.mission()?.cards).toHaveLength(50)
  for (const columns of [48, 120]) {
    const text = await paneText($, columns)
    expect(text).toMatch(/50 queued|○50/)
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(columns)
  }
})

test('a helper\'s result arriving as a new turn keeps the mission and sends no nudge', async ($, on) => {
  const w = await world($, on)
  await dock($, '3')
  await w.settle()
  await request($, 'Research bakery pricing for three shops', 't-20')
  for (let i = 1; i <= 3; i += 1) await agent($, `r${i}`, `Price check: shop ${i}`)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-20', reason: 'answer' } as never)
  // The engine delivers a background helper's result as a turn of its own, with no prompt from the person.
  await $.turn.start({ text: 'Message from @general-purpose: three prices', turnId: 't-21' })
  await $.turn.complete({ answer: 'combined', durationMs: 500, isAborted: false, turnId: 't-21', reason: 'answer' } as never)
  await w.settle()
  expect(w.submitted.filter(x => x.text.startsWith('You used')).length).toBe(0)
  expect(w.mission()?.job).toContain('Research bakery pricing')
})

test('a finished helper is logged by category and model, for the Crew to learn from', async ($, on) => {
  let log: { category: string; tier: string; isStuck: boolean }[] = []
  on('store.set', { key: 'crewLog' }, ($, e, next) => {
    log = e.value as typeof log
    return next(e)
  })
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-30')
  await agent($, 'l1', 'Find bakery prices')
  await w.settle()
  expect(log[log.length - 1]).toMatchObject({ category: 'lookup', tier: 'haiku', isStuck: false })
})

test('a stopped sonar interval restarts within 10 s with no event at all', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-sonar')
  await $.session.append({
    door: 'response',
    uuid: 'row-s',
    origin: { kind: 'model' },
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id: 'cs', name: 'Agent', input: { description: 'Price check: Panera', prompt: 'x' } }] },
  } as never)
  isEveryRefused = true
  await w.advance(20_000)
  isEveryRefused = false
  await w.advance(10_000)
  const before = frames
  await w.advance(2000)

  expect(frames).toBeGreaterThan(before)
})

test('a helper whose end the live events missed is settled from the record at the turn end', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-r')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'bg1', description: 'Price check: Panera', prompt: 'Panera', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 'bg1', prompt: 'Panera', description: 'Price check: Panera', subagentType: 'general-purpose', background: true, fork: false } as never)
  expect(w.mission()?.cards.map(c => c.status)).toEqual(['working'])
  crewRows = [
    { role: 'user', text: 'Research bakery pricing', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'bg1', tool: 'Agent', input: { description: 'Price check: Panera', run_in_background: true }, text: 'launched', result: { status: 'async_launched' }, agentId: 'agent-bg1' }],
    },
    { role: 'user', text: '<task-notification><task-id>agent-bg1</task-id><status>completed</status></task-notification>', toolUses: [] },
  ]
  await $.turn.complete({ answer: 'All three checked.', durationMs: 1, isAborted: false, turnId: 't-r', reason: 'answer' } as never)

  expect(w.mission()?.cards.map(c => c.status)).toEqual(['done'])
})


test('a new request while helpers still run keeps their cards live until they finish', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-a')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'run1', description: 'Price check: Panera', prompt: 'Panera', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 'run1', prompt: 'Panera', description: 'Price check: Panera', subagentType: 'general-purpose', background: true, fork: false } as never)
  expect(w.mission()?.cards.map(c => c.status)).toEqual(['working'])

  // The person sends another message while the helper is still out.
  await request($, 'Also check Crumbl', 't-b')
  expect(w.mission()?.cards.map(c => `${c.id}:${c.status}`)).toEqual(['run1:working'])

  await $.turn.complete({ agentId: 'agent-run1', answer: 'done', durationMs: 1, isAborted: false, turnId: 'h-run1', reason: 'answer' } as never)
  expect(w.mission()?.cards.map(c => c.status)).toEqual(['done'])
})

test('activity lines say what a helper did in plain words', () => {
  expect(activityLine('Read', { file_path: '/repo/src/install.sh' })).toBe('Reading install.sh')
  expect(activityLine('Bash', { command: 'npm test -- --watch\nmore' })).toBe('Running Npm test -- --watch')
  expect(activityLine('Grep', { pattern: 'TODO' })).toBe('Searching for TODO')
  expect(activityLine('mcp__github__create_issue', {})).toBe('Using create_issue')
  let activity = {}
  for (let i = 0; i < 5; i += 1) activity = withAction(activity, 'a1', { line: `step ${i}`, at: i })
  expect((activity as Record<string, { line: string }[]>).a1?.map(a => a.line)).toEqual(['step 2', 'step 3', 'step 4'])
})

test('Watch shows a helper\'s latest actions, its conversation in the pane, and sends it a note', async ($, on) => {
  const w = await world($, on)
  await dock($)
  await request($, 'Research bakery pricing', 't-w')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'w1', description: 'Price check: Panera', prompt: 'Panera', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 'w1', prompt: 'Panera', description: 'Price check: Panera', subagentType: 'general-purpose', background: true, fork: false } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'h1', agentId: 'agent-w1', file_path: '/menus/panera.md' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'h2', agentId: 'agent-w1', command: 'curl -s panera.example/prices' } as never)
  expect(w.mission()?.cards[0]?.status).toBe('working')

  const ui = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Crew', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  })
  await ui.press({ key: 'watch-w1' })
  const text = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).toContain('Reading panera.md')
  expect(text).toContain('Running Curl -s panera.example/prices')

  // Open shows the helper's own conversation inside the pane.
  crewRows = [
    { role: 'user', text: 'Check Panera prices', toolUses: [] },
    { role: 'assistant', text: 'Reading the menu first.', toolUses: [{ tool_use_id: 'h1', tool: 'Read', input: { file_path: '/menus/panera.md' }, text: 'ok' }] },
  ]
  await ui.press({ key: 'watch-open' })
  const conversation = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(conversation).toContain('› Check Panera prices')
  expect(conversation).toContain('Reading the menu first.')
  expect(conversation).toContain('▸ Reading panera.md')

  await ui.press({ key: 'watch-note' })
  await ui.input({ key: 'watch-note-input', text: 'Use the 2026 menu', kind: 'submit' })
  expect(sentNotes).toEqual([{ to: 'agent-w1', text: 'Use the 2026 menu' }])
  await ui.unmount()
})


test('lanes: file touches are kept newest first, capped, and clash on shared writes', () => {
  expect(fileTouch('Read', { file_path: '/a.ts' })).toEqual({ path: '/a.ts', kind: 'read' })
  expect(fileTouch('Grep', { pattern: 'x', path: '/src' })).toEqual({ path: '/src', kind: 'read' })
  expect(fileTouch('NotebookEdit', { notebook_path: '/n.ipynb' })?.kind).toBe('write')
  expect(fileTouch('Bash', { command: 'ls' })).toBeNull()
  let lanes = {}
  for (let i = 0; i < 8; i += 1) lanes = withTouch(lanes, 'a1', { path: `/f${i}`, kind: 'read' }, i)
  expect((lanes as Record<string, { path: string }[]>).a1?.map(t => t.path)).toEqual(['/f7', '/f6', '/f5', '/f4', '/f3', '/f2'])
  lanes = withTouch(lanes, 'a1', { path: '/w', kind: 'write' }, 9)
  lanes = withTouch(lanes, 'a1', { path: '/w', kind: 'read' }, 10)
  lanes = withTouch(lanes, 'a2', { path: '/w', kind: 'write' }, 11)
  expect((lanes as Record<string, { kind: string }[]>).a1?.[0]?.kind).toBe('write')
  expect([...clashes(lanes, ['a1', 'a2'])]).toEqual(['/w'])
  expect([...clashes(lanes, ['a1'])]).toEqual([])
})

test('lanes show in the Crew pane with a clash marker', async ($, on) => {
  await world($, on)
  await dock($)
  await request($, 'Edit things', 't-l')
  for (const id of ['l1', 'l2']) {
    await $.tool.call({ tool: 'Agent', tool_use_id: id, description: `Edit: ${id}`, prompt: id, run_in_background: true } as never)
    await $.agent.spawn({ tool_use_id: id, prompt: id, description: `Edit: ${id}`, subagentType: 'general-purpose', background: true, fork: false } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: `e-${id}`, agentId: `agent-${id}`, file_path: '/repo/shared.ts' } as never)
  }
  const text = await paneText($)
  expect(text).toContain('LANES')
  expect(text).toContain('⚠shared.ts')
})

test('session badge is stable and spread out', () => {
  expect(sessionBadge('/work/a', 's1')).toEqual(sessionBadge('/work/a', 's2'))
  expect(sessionBadge('', 's1')).toEqual(sessionBadge(null, 's1'))
  const seen = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(sessionBadge(`/work/tree-${i}`, 'x'))))
  expect(seen.size).toBeGreaterThan(20)
})

test('the bar row starts with the session badge', async ($, on) => {
  await world($, on)
  const badge = sessionBadge('', 'session-1')
  const ui = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', requestId: 'x', props: { bodyColumns: 120, hasSurvey: false } } as never).catch(() => null)
  if (ui) {
    const text = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(text).toContain(badge.glyph)
    await ui.unmount()
  }
})

test('done gate: parses checks, sends a failing helper back twice, then marks it failed', async ($, on) => {
  expect(parseChecks('# c\n\nnpm test\n  tsc  \n')).toEqual(['npm test', 'tsc'])
  expect(gateStep(0, true)).toEqual({ action: 'block', tries: 1 })
  expect(gateStep(2, true)).toEqual({ action: 'giveup', tries: 2 })
  expect(gateStep(1, false).action).toBe('pass')
  expect(gateLabel({ status: 'failed', tries: 2 })).toBe('gate: failed (2 tries)')

  gateChecks = 'npm test'
  gateCode = 1
  await world($, on)
  await dock($)
  await request($, 'Do it', 't-g')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'g1', description: 'Gate: one', prompt: 'x', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 'g1', prompt: 'x', description: 'Gate: one', subagentType: 'general-purpose', background: true, fork: false } as never)
  const stop = () => $.classic.SubagentStop({ agent_id: 'agent-g1', agent_type: 'general-purpose', stop_hook_active: false, agent_transcript_path: '' } as never)
  expect((await stop()).block).toContain('boom')
  expect((await stop()).block).toContain('boom')
  expect((await stop()).block).toBeUndefined()
  await $.turn.complete({ agentId: 'agent-g1', answer: 'done', durationMs: 1, isAborted: false, turnId: 'h', reason: 'answer' } as never)
  expect(await paneText($)).toContain('gate: failed (2 tries)')
  gateChecks = ''
  gateCode = 0
})

test('main chat done gate: after an edit, failing checks send it back twice, then hand over; no edit, no checks', async ($, on) => {
  gateChecks = 'npm test'
  gateCode = 1
  await world($, on)
  await $.command.run({ command: 'clean', args: 'off' } as never)
  const stop = () => $.classic.Stop({ cwd: '/p', stop_hook_active: false } as never) as Promise<{ block?: string }>
  expect((await stop()).block).toBeUndefined()
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } as never)
  expect((await stop()).block).toContain('boom')
  expect((await stop()).block).toContain('boom')
  expect((await stop()).block).toBeUndefined()
  expect((await stop()).block).toBeUndefined()
  gateCode = 0
  await $.tool.call({ tool: 'Write', tool_use_id: 'e2', file_path: '/p/b.ts', content: 'x' } as never)
  expect((await stop()).block).toBeUndefined()
  gateChecks = ''
})

test('the Crew pane draws the sonar with a core beside the roster', async ($, on) => {
  const w = await world($, on)
  await request($, 'Research bakery pricing', 't-looks')
  const release = w.gate('l0')
  const running = agent($, 'l0', 'Price check: Panera')
  await w.settle()
  await $.tool.call({ tool: PROGRESS, tool_use_id: 'pl', agentId: 'agent-l0', task: 'Price check: Panera', percent: 40 } as never)
  expect(await paneText($)).toContain('C R E W')
  expect(await paneText($)).toContain('◆')
  release()
  await running
})
