import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import type { PromptUpgradeFlow as Flow } from '../../types'

const PANE = 'prompt-upgrade'
const ROUGH = 'make a landing page for my bakery'
const QUESTIONS = JSON.stringify({
  questions: [
    { question: 'Who is the page for?', options: ['Local walk-ins', 'Online orders', 'Wholesale cafes'] },
    { question: 'What should it include?', options: ['Menu and prices', 'Story and photos'] },
    { question: 'Broken question', options: ['only one'] },
  ],
})
const REWRITE =
  'Here you go:\n```json\n' +
  JSON.stringify({
    prompt: 'Build a one-page landing page for my bakery, [bakery name], for local walk-in customers. Done when it has a hero, hours and a map.',
    added: ['A clear goal', 'Who it is for', 'What done looks like'],
  }) +
  '\n```'

// False: the window is too narrow for an unasked pane, as on a 120-column terminal.
let canPlace = true

type World = {
  flow: () => Flow | null
  submitted: { text: string; origin: PromptOrigin; context?: readonly string[] }[]
  filled: string[]
  closed: string[]
  person: () => unknown
  settle: () => Promise<void>
}

// The engine beneath carapace: every call the mods make is answered here.
async function world($: Engine, on: On, models: { questions?: string; rewrite?: string } = {}): Promise<World> {
  let flow: Flow | null = null
  canPlace = true
  let person: unknown = null
  const submitted: World['submitted'] = []
  const filled: string[] = []
  const closed: string[] = []
  mock.store(on)
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: canPlace } }) as never)
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, origin: e.origin, context: e.context })
    return { text: e.text }
  })
  on('model.complete', ($, e) => ({
    value: {
      isAnswered: true as const,
      text: e.model === 'haiku' ? (models.questions ?? QUESTIONS) : (models.rewrite ?? REWRITE),
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('state.set', { plugin: 'carapace', key: 'promptUpgradeFlow' }, ($, e, next) => {
    flow = e.value as Flow | null
    return next(e)
  })
  on('state.set', { plugin: 'carapace', key: 'personPrompt' }, ($, e, next) => {
    person = e.value
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return {
    flow: () => flow,
    submitted,
    filled,
    closed,
    person: () => person,
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await clock.settle()
    },
  }
}

const composer: PromptOrigin = { kind: 'composer' }

function typed($: Engine, text: string, extra: Record<string, unknown> = {}) {
  return $.prompt.submit({ text, wait: false, origin: composer, ...extra } as never)
}

function pane($: Engine, columns: number) {
  return $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Refine', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
}

test('automatic mode intercepts real prompts and lets the rest through', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'refine', args: 'on' } as never)

  const kept = await typed($, ROUGH)
  expect(kept.drop).toContain('Refine')
  expect(w.flow()?.original).toBe(ROUGH)

  expect((await typed($, '/help')).text).toBe('/help')
  expect((await typed($, 'yes')).text).toBe('yes')
  expect((await typed($, 'keep going')).text).toBe('keep going')
  expect((await typed($, ROUGH, { attachments: [{ kind: 'image' }] })).drop).toBeUndefined()
  expect((await typed($, ROUGH, { turnId: 'turn-1' })).drop).toBeUndefined()
  expect((await typed($, `> ${ROUGH}`)).text).toBe(ROUGH)
  const fromMod = await $.prompt.submit({ text: ROUGH, wait: false, origin: { kind: 'plugin', name: 'carapace', asUser: true } } as never)
  expect(fromMod.drop).toBeUndefined()
})

test('a > escape records the stripped text as the person prompt', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'refine', args: 'on' } as never)
  await typed($, '> fix the footer')

  expect((w.person() as { text: string } | null)?.text).toBe('fix the footer')
})

test('reads the questions and drops malformed ones', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'refine', args: ROUGH } as never)
  await w.settle()
  const flow = w.flow()

  expect(flow?.step).toBe('questions')
  expect(flow?.questions.map(q => q.question)).toEqual(['Who is the page for?', 'What should it include?'])
  expect(flow?.questions[0].options).toEqual(['Local walk-ins', 'Online orders', 'Wholesale cafes'])
})

test('reads the rewrite, even wrapped in prose, and goes straight there when no question helps', async ($, on) => {
  const w = await world($, on, { questions: '{"questions":[]}' })
  await $.command.run({ command: 'refine', args: ROUGH } as never)
  await w.settle()
  const flow = w.flow()

  expect(flow?.step).toBe('review')
  expect(flow?.rewrite).toContain('[bakery name]')
  expect(flow?.added).toEqual(['A clear goal', 'Who it is for', 'What done looks like'])
})

test('full flow: /refine, answer, review, Use it puts the upgrade in the box', async ($, on) => {
  const w = await world($, on)
  const reply = await $.command.run({ command: 'refine', args: ROUGH } as never)
  expect(reply.text).toContain('Enter sends it')
  await w.settle()

  const ui = await pane($, 120)
  await ui.press({ key: 'q-0-o-0' })
  await ui.press({ key: 'q-1-skip' })
  await w.settle()
  expect(w.flow()?.step).toBe('review')
  expect(w.flow()?.answers.map(a => a.state)).toEqual(['answered', 'skipped'])

  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(texts).toContain('WORDS BEFORE')
  expect(texts).toContain('What done looks like')
  await ui.press({ key: 'run' })

  // Use it puts the upgrade in the box; nothing is sent until Enter.
  expect(w.submitted).toHaveLength(0)
  expect(w.filled.at(-1)).toContain('[bakery name]')
  expect(w.closed).toContain(PANE)
  expect(w.flow()).toBeNull()
})

test('Cancel puts the original prompt back in the box', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'refine', args: ROUGH } as never)
  await w.settle()
  const ui = await pane($, 80)
  await ui.press({ key: 'cancel' })

  expect(w.filled).toEqual([ROUGH])
  expect(w.submitted).toHaveLength(0)
  expect(w.flow()).toBeNull()
})

test('the on and off switch', async ($, on) => {
  const w = await world($, on)
  expect((await typed($, ROUGH)).drop).toBeUndefined()

  await $.command.run({ command: 'refine', args: 'on' } as never)
  expect((await typed($, ROUGH)).drop).toBeDefined()

  await $.command.run({ command: 'refine', args: 'off' } as never)
  expect((await typed($, 'write a launch email for the new menu')).drop).toBeUndefined()
  expect(w.submitted.length).toBeGreaterThan(0)
})

test('every drawn line fits a narrow and a wide pane', async ($, on) => {
  const w = await world($, on, { questions: '{"questions":[]}' })
  await $.command.run({ command: 'refine', args: ROUGH } as never)
  await w.settle()
  const prose = [w.flow()?.original ?? '', w.flow()?.rewrite ?? '']
  for (const columns of [48, 132]) {
    const ui = await pane($, columns)
    const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(lines.length).toBeGreaterThan(0)
    // Prose wraps inside its card; every other line is sized to the pane.
    // Prose (the prompt, the upgrade, and the marked phrases inside it) wraps inside its card.
    for (const line of lines) if (!prose.some(p => p.includes(line))) expect(line.length).toBeLessThanOrEqual(columns)
    await ui.unmount()
  }
})

test('a reload drops an empty Refine pane instead of reopening it, so Enter goes to the chat', async ($, on) => {
  // The other mods' start hooks read the environment; answered here so Refine's own start hook runs too.
  mock.env(on, { HOME: '/h' })
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const w = await world($, on)
  await $.command.run({ command: 'refine', args: '' } as never)
  expect(w.flow()?.step).toBe('compose')
  // A hot reload (an update, a saved file) raises session.start again.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await w.settle()
  expect(w.flow()).toBeNull()
  await typed($, 'please write the release notes for this week')
  expect(w.submitted.at(-1)?.text).toBe('please write the release notes for this week')
})

test('automatic mode with no room for the pane sends the prompt to the chat instead of catching it again', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'refine', args: 'on' } as never)
  canPlace = false
  await typed($, 'please write the release notes for this week')
  expect(w.submitted.at(-1)?.text).toBe('please write the release notes for this week')
  expect(w.flow()).toBeNull()
  expect(w.filled).toEqual([])
})

test('Use it in automatic mode: the upgrade goes in the box, Enter sends it as the person, with the crew instruction', async ($, on) => {
  mock.env(on, { HOME: '/h' })
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 's1' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const w = await world($, on)
  await $.command.run({ command: 'crew', args: '3' } as never)
  await w.settle()
  await $.command.run({ command: 'refine', args: 'on' } as never)
  await typed($, ROUGH)
  await w.settle()
  const ui = await pane($, 120)
  await ui.press({ key: 'q-0-o-0' })
  await ui.press({ key: 'q-1-skip' })
  await w.settle()
  await ui.press({ key: 'run' })
  const upgrade = w.filled.at(-1) as string
  expect(upgrade).toContain('[bakery name]')
  // The person presses Enter: automatic mode lets the upgrade through, and the Crew adds its split.
  await typed($, upgrade)
  expect(w.submitted.at(-1)?.text).toBe(upgrade.trim())
  expect(w.submitted.at(-1)?.origin.kind).toBe('composer')
  expect((w.submitted.at(-1)?.context ?? []).join('\n')).toContain('exactly 3 independent pieces')
})
