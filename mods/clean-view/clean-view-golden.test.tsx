import { expect, mock, test } from 'claude-code/testing'
import { PALETTES, WORDS } from '../shared/look'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { frame, overflowing } from './frame'
import { GOLDEN } from './golden'

const BAND = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }

let isFailing = false

// The engine beneath the plugin, with a frozen clock and a fixed context reading.
async function world($: Engine, on: On) {
  mock.store(on, { setupDone: true })
  mock.env(on, { HOME: '/home/test' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: 'mcp__carapace__' + e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'test' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.Notification', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, ...(isFailing ? { isError: true, text: 'npm ERR! build failed at step 4\nmore' } : {}) }))
  on('session.usage', () => ({ value: { context: { percent: 30 }, rateLimits: [] } } as never))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return clock
}

async function job($: Engine, title: string, steps: string[]) {
  await $.prompt.submit({ text: title, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: title, turnId: 'turn-g' })
  await $.tool.call({ tool: 'mcp__carapace__plan_steps', tool_use_id: 'plan', steps } as never)
}

// Mods draw on the terminal and in the desktop app; the bar must lay out the same on both.
const SURFACES = ['terminal', 'desktop'] as const

async function check($: Engine, name: string, props: Partial<typeof BAND> = {}) {
  const shown = { ...BAND, ...props }
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'carapace', surface, component: 'AbovePrompt', props: shown })
    const text = frame(await band.drawn())
    expect(overflowing(text, shown.bodyColumns), `${name} on ${surface}: lines wider than ${shown.bodyColumns} cells`).toEqual([])
    expect(text, `${name} on ${surface}: the frame changed. If the change is right, save this frame in golden.ts:\n${JSON.stringify(text)}`).toBe(GOLDEN[name])
    await band.unmount()
  }
}

test('golden: a fresh job with a plan', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section', 'Check it on a phone'])
  await clock.advance(2000)
  await check($, 'fresh job')
})

test('golden: twenty rows in a short band show a window with +N more', async ($, on) => {
  const clock = await world($, on)
  await $.prompt.submit({ text: 'Check every row', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Check every row', turnId: 'turn-g' })
  for (let i = 1; i <= 20; i += 1) {
    await $.tool.call({ tool: 'mcp__carapace__report_progress', tool_use_id: `r${i}`, task: `Row ${i}`, percent: i < 20 ? 100 : 40 } as never)
  }
  await clock.advance(2000)
  await check($, 'twenty rows', { maxRows: 10 })
})

test('golden: a job that ends early says how far it got', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section', 'Check it on a phone'])
  await $.tool.call({ tool: 'mcp__carapace__report_progress', tool_use_id: 'p1', task: 'Read your brand notes', percent: 100 } as never)
  await clock.advance(2000)
  await $.turn.complete({ answer: 'Stopping early.', durationMs: 2000, isAborted: false, turnId: 'turn-g', reason: 'answer' } as never)
  await check($, 'ended early')
})

test('golden: a job waiting on a permission prompt', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })
  await clock.advance(2000)
  await check($, 'needs you')
})

test('golden: a narrow band', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  await clock.advance(2000)
  await check($, 'narrow', { bodyColumns: 40 })
})

test('golden: a long title with emoji and wide characters', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Fix the 漢字 login page 🔥 for every 🇮🇪 visitor today', ['Find the 漢字 bug 🔥', 'Fix it'])
  await clock.advance(2000)
  await check($, 'wide title', { bodyColumns: 60 })
})

test('golden: a loop of failing commands shows the stuck row, and Dismiss hides it', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  isFailing = true
  for (let i = 1; i <= 4; i += 1) await $.tool.call({ tool: 'Bash', tool_use_id: `f${i}`, command: 'npm run build' } as never)
  isFailing = false
  await clock.advance(2000)
  await check($, 'stuck row')
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'loop-dismiss' })
  expect(frame(await band.drawn())).not.toContain('stuck:')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ok', command: 'ls' } as never)
  const after = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(frame(await after.drawn())).not.toContain('stuck:')
})

test('a different result clears the stuck row, and Stop aborts the turn', async ($, on) => {
  const aborted: string[] = []
  on('turn.abort', (_, e) => { aborted.push(e.turnId); return { value: undefined } as never })
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes'])
  isFailing = true
  for (let i = 1; i <= 3; i += 1) await $.tool.call({ tool: 'Bash', tool_use_id: `f${i}`, command: 'npm run build' } as never)
  await clock.advance(1000)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(frame(await band.drawn())).toContain('stuck: 3 tries')
  await band.press({ key: 'loop-stop' })
  expect(aborted).toEqual(['turn-g'])
  isFailing = false
  await $.tool.call({ tool: 'Bash', tool_use_id: 'ok', command: 'ls' } as never)
  expect(frame(await band.drawn())).not.toContain('stuck:')
})

// Another installed mod that also draws above the prompt: carapace's bar and buttons must still show and work.
const RIVAL = {
  name: 'rival',
  register: (on: On) => {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const { Box, Text } = $.ui.resolve(e)
      const theirs = await next(e)

      return (
        <Box flexDirection="column">
          <Text>rival line</Text>
          {theirs}
        </Box>
      )
    })
  },
}

test('golden: another mod above the prompt is hidden by default; turned on, it folds behind More and the bar still works', { plugins: [RIVAL] }, async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  await clock.advance(2000)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // Off by default: no rival row and no More chip.
  const hidden = frame(await band.drawn())
  expect(hidden).not.toContain('rival line')
  expect(hidden).not.toContain('More')
  expect(overflowing(hidden, BAND.bodyColumns)).toEqual([])
  await $.command.run({ command: 'mods', args: 'more on' } as never)
  // Turned on, other mods' bands stay folded behind More, so their buttons never crowd the bar.
  const text = frame(await band.drawn())
  expect(text).not.toContain('rival line')
  expect(text).toContain('[ More ]')
  expect(text).toContain('Build my landing page')
  expect(text).toContain('[ Clean: on ]')
  expect(overflowing(text, BAND.bodyColumns)).toEqual([])
  await band.press({ key: 'bar-more' })
  const opened = frame(await band.drawn())
  expect(opened).toContain('rival line')
  expect(opened).toContain('[ Less ]')
  expect(overflowing(opened, BAND.bodyColumns)).toEqual([])
  await band.press({ key: 'bar-clean' })
  const after = frame(await band.drawn())
  expect(after).toContain('rival line')
  expect(after).not.toContain('Read your brand notes')
})


test('golden: with safe symbols on, the bar draws only one-cell characters and still fits', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  await clock.advance(2000)
  expect((await $.command.run({ command: 'mods', args: 'glyphs on' } as never)).text).toContain('plain one-cell symbols')
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const text = frame(await band.drawn())
  expect(text).toContain('Build my landing page')
  expect(text).not.toMatch(/[─━▁▂▃▄▅●○◆◇◉✓▸▼·⌬]/u)
  expect(overflowing(text, BAND.bodyColumns)).toEqual([])
  await $.command.run({ command: 'mods', args: 'glyphs off' } as never)
  expect(frame(await band.drawn())).toMatch(/━/u)
})

test('a band narrower than 26 columns never draws past its edge', async ($, on) => {
  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  await clock.advance(2000)
  for (const cols of [12, 20, 25]) {
    const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: cols } })
    const text = frame(await band.drawn())
    expect(overflowing(text, cols), `${cols} columns:\n${text}`).toEqual([])
    await band.unmount()
  }
})

test('Deep Sea: colors that read, its own gauge and spinner words, the m ruler', async ($, on) => {
  // Text stays readable on the background (WCAG AA, 4.5:1).
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)
  }
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number]; return (x + 0.05) / (y + 0.05) }
  expect(ratio(PALETTES.deep.text, PALETTES.deep.surface)).toBeGreaterThan(4.5)

  const clock = await world($, on)
  await job($, 'Build my landing page', ['Read your brand notes', 'Build the pricing section'])
  await clock.advance(2000)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const text = frame(await band.drawn())
  expect(text).toContain('shallow')
  expect(text).toContain(' 0 m')
  expect(text).toMatch(/[▂▃]/u)
  expect(overflowing(text, BAND.bodyColumns)).toEqual([])
  // The spinner hook reads this table; a mounted Spinner in tests skips plugin hooks, so the table is checked directly.
  expect(WORDS.spinner.thinking).toBe('Echolocating')
  expect(WORDS.done).toBe('Dove')
})
