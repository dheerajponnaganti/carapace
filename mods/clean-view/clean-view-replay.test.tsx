import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TranscriptRow } from './checklist-logic'

type Saved = { phase: string; tasks: { name: string; status: string }[] } | null
let saved: Saved = null
let rows: TranscriptRow[] = []

// The engine beneath the plugin, answering $.session.messages() with `rows`: the main conversation's record.
async function world($: Engine, on: On) {
  saved = null
  rows = []
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__carapace__' + e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'test' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: rows }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Notification', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('session.usage', () => ({ value: { context: { percent: 10 }, rateLimits: [] } } as never))
  on('state.set', { plugin: 'carapace', key: 'checklist' }, ($, e, next) => {
    saved = e.value as Saved
    return next(e)
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

const PROMPT = 'Build my landing page'
const PLAN = ['Read your brand notes', 'Build the pricing section', 'Check it on a phone']
const use = (id: string, tool: string, input: Record<string, unknown>, text = 'ok') => ({ tool_use_id: id, tool, input, text })

// The record of the job: the prompt, the plan, and one finished step.
function record(): TranscriptRow[] {
  return [
    { role: 'user', text: PROMPT, toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        use('p', 'mcp__carapace__plan_steps', { steps: PLAN }),
        use('r1', 'mcp__carapace__report_progress', { task: 'Read your brand notes', percent: 100 }),
      ],
    },
  ]
}

async function startJob($: Engine) {
  await $.prompt.submit({ text: PROMPT, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: PROMPT, turnId: 't1' })
  await $.tool.call({ tool: 'mcp__carapace__plan_steps', tool_use_id: 'p', steps: PLAN } as never)
  await $.tool.call({ tool: 'mcp__carapace__report_progress', tool_use_id: 'r1', task: 'Read your brand notes', percent: 100 } as never)
}

test('a forked helper ticking the main plan is undone at the turn end, from the record', async ($, on) => {
  await world($, on)
  await startJob($)
  // A forked skill's progress arrives with no agentId and ticks the main plan, but it is not in the main record.
  await $.tool.call({ tool: 'mcp__carapace__report_progress', tool_use_id: 'fork-1', task: 'Gather the code under review', percent: 100 } as never)
  expect(saved?.tasks.map(t => t.status)).toEqual(['done', 'done', 'active'])
  rows = record()
  await $.turn.complete({ answer: 'Which colour do you want?', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  expect(saved?.tasks.map(t => t.status)).toEqual(['done', 'active', 'upcoming'])
})

test('after a hot reload the steps match the record', async ($, on) => {
  await world($, on)
  await startJob($)
  rows = [
    ...record(),
    { role: 'assistant', text: '', toolUses: [use('r2', 'mcp__carapace__report_progress', { task: 'Build the pricing section', percent: 100 })] },
  ]
  // The live event for r2 was lost in a reload; session.start runs again and lines the steps up.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(saved?.tasks.map(t => t.status)).toEqual(['done', 'done', 'active'])
})

test('a record that no longer reaches the job leaves the live steps alone', async ($, on) => {
  await world($, on)
  await startJob($)
  rows = [{ role: 'user', text: 'something else', toolUses: [] }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(saved?.tasks.map(t => t.status)).toEqual(['done', 'active', 'upcoming'])
})
