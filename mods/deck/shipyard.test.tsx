import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { REACH, addonExtra, addonKind, addonStatus, manifestVersion, pluginVersion, ponytailUpdate, reachMeaning, reachTags } from './addons'
import { updateBadge } from './rea-logic'

type W = { state?: string; pony?: string; latest?: string; gstackVersion?: string; rea?: string; history?: string; hookify?: string }
let calls: string[][] = []
let toasts: string[] = []
let writes: [string, string][] = []

// The engine beneath carapace with stubbed git, claude and the installer. `state` is the installer's state file;
// the installer stub changes it the way the real one does: --with adds, --remove clears, --manage takes ownership.
async function world($: Engine, on: On, w: W = {}) {
  calls = []
  toasts = []
  writes = []
  let state = w.state
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.status', 'ui.log', 'ui.close'] as const) on(op, () => ({ value: undefined }))
  on('fs.write', (_$, e) => (writes.push([e.path, e.text]), { value: undefined }))
  on('fs.list', () => ({ value: [{ name: 'taken.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_$, e) =>
    e.url.endsWith('DietrichGebert/ponytail/main/.claude-plugin/plugin.json') && w.latest
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ name: 'ponytail', version: w.latest }) } }
      : { value: { status: 404, ok: false, headers: {}, text: '' } },
  )
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('carapace-install.json') && state !== undefined) return { value: state }
    if (e.path.endsWith('history.jsonl') && w.history !== undefined) return { value: w.history }
    if (e.path.endsWith('skills/gstack/VERSION') && w.gstackVersion) return { value: `${w.gstackVersion}\n` }

    return { deny: 'ENOENT' }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'claude' && argv[1] === 'plugin' && argv[2] === 'list') return out(JSON.stringify([...(w.pony ? [{ id: 'ponytail@ponytail', version: w.pony }] : []), ...(w.hookify ? [{ id: 'hookify@claude-plugins-official', version: w.hookify }] : [])]))
    if (argv[0] === 'claude' && argv[1] === 'plugin' && argv[2] === 'update') return out('updated\n')
    if (argv[0] === 'rea' && argv[1] === '--version') return w.rea ? out(`rea ${w.rea}\n`) : out('', 127)
    if (argv[0]?.endsWith('install.sh')) {
      const id = argv[2] ?? ''
      const cur = state ? (JSON.parse(state) as Record<string, string>) : {}
      if (argv[1] === '--with') cur[id] = 'installed'
      if (argv[1] === '--remove') delete cur[id]
      if (argv[1] === '--manage') cur[id] = 'installed'
      state = JSON.stringify(cur)
      return out('done\n')
    }
    if (argv[0] === 'git' && argv[3] === 'rev-parse' && argv[4] === '--show-toplevel') return out('/home/test/carapace\n')
    if (argv[0] === 'git' && argv[3] === 'rev-list') return out('0\n')
    return out('', argv[0] === 'git' ? 0 : 1)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 80))
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80))
const texts = async (m: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await m.findAll({ type: 'Text' })).map(t => t.text).join('|')
const band = ($: Engine) =>
  $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
const pane = ($: Engine) =>
  $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'Pane', requestId: 'carapace-deck', props: { title: 'Shipyard', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
const installer = () => calls.find(c => c[0]?.endsWith('install.sh'))
const installers = () => calls.filter(c => c[0]?.endsWith('install.sh'))

test('pure: add-on owner, plugin version, manifest version, status words, buttons, badge', () => {
  expect(addonKind('{"gstack":"installed","ponytail":"preexisting"}', 'gstack')).toBe('ours')
  expect(addonKind('{"gstack":"installed","ponytail":"preexisting"}', 'ponytail')).toBe('yours')
  expect(addonKind('{}', 'gstack')).toBe('none')
  expect(addonKind('nope', 'rea')).toBe('none')
  expect(pluginVersion('[{"id":"ponytail@ponytail","version":"5.3.2"}]', 'ponytail')).toBe('5.3.2')
  expect(pluginVersion('[{"id":"other@x","version":"1.0.0"}]', 'ponytail')).toBeNull()
  expect(pluginVersion('not json', 'ponytail')).toBeNull()
  expect(manifestVersion('{"name":"ponytail","version":"5.4.0"}')).toBe('5.4.0')
  expect(manifestVersion('<html>')).toBe('')
  const ours = { kind: 'ours', version: '5.3.2', latest: '5.4.0' } as const
  const yours = { kind: 'yours', version: '5.3.2', latest: '5.4.0' } as const
  expect(addonStatus('ponytail', { kind: 'none', version: '', latest: '' })).toBe('not installed')
  expect(addonStatus('ponytail', ours)).toBe('ponytail 5.3.2 · 5.4.0 waiting')
  expect(addonStatus('ponytail', { ...ours, latest: '5.3.2' })).toBe('ponytail 5.3.2 · up to date')
  expect(addonStatus('ponytail', yours)).toBe('ponytail 5.3.2 (yours) · 5.4.0 waiting')
  expect(addonStatus('ponytail', { ...yours, latest: '' })).toBe('ponytail 5.3.2 (yours)')
  expect(addonStatus('gstack', { kind: 'ours', version: '1.9.0', latest: '' }, true)).toBe('gstack 1.9.0 · updates itself')
  expect(addonStatus('gstack', { kind: 'yours', version: '', latest: '' }, true)).toBe('gstack (yours)')
  expect(addonExtra(yours)).toBe('Manage')
  expect(addonExtra(ours)).toBe('Remove')
  expect(addonExtra({ kind: 'none', version: '', latest: '' })).toBe('')
  expect(ponytailUpdate(yours)).toBe('5.4.0')
  expect(ponytailUpdate({ ...ours, latest: '5.3.2' })).toBe('')
  expect(updateBadge(2, { kind: 'none', version: '', latest: '' }, ours)).toBe('2 · ponytail 5.4.0')
})

test('the Shipyard has a Tools section and an Add-ons section with REA, gstack and ponytail', async ($, on) => {
  await world($, on)
  const t = await texts(await pane($))
  expect(t).toMatch(/Tools[\s\S]*Crew[\s\S]*Work Report[\s\S]*Refine[\s\S]*Clean View[\s\S]*Add-ons[\s\S]*REA[\s\S]*gstack[\s\S]*ponytail/)
  expect(t.split('Add-ons')[0]).not.toContain('gstack')
  expect(t.split('Add-ons')[1]).not.toContain('Crew')
  expect(t).toContain('Add')
})

test('gstack Add runs the installer with --with gstack and says to restart', async ($, on) => {
  await world($, on)
  await (await pane($)).press({ key: 'deck-press-g' })
  await settle()
  expect(installer()).toEqual(expect.arrayContaining(['--with', 'gstack']))
  expect(toasts).toContain('Adding gstack...')
  expect(toasts.at(-1)).toBe('gstack added. Restart Claude Code to use it.')
})

test('gstack that carapace owns shows its version, updates itself, and has Remove', async ($, on) => {
  await world($, on, { state: '{"gstack":"installed"}', gstackVersion: '1.91.135.0' })
  const p = await pane($)
  expect(await texts(p)).toContain('gstack 1.91.135 · updates itself')
  await p.press({ key: 'deck-remove-g' })
  await settle()
  expect(installer()).toEqual(expect.arrayContaining(['--remove', 'gstack']))
  expect(toasts.at(-1)).toBe('gstack removed.')
})

test('ponytail that is yours shows (yours) and Manage hands it to carapace', async ($, on) => {
  await world($, on, { state: '{"ponytail":"preexisting"}', pony: '5.3.2' })
  const p = await pane($)
  const t = await texts(p)
  expect(t).toContain('ponytail 5.3.2 (yours)')
  expect(t).toContain('Manage')
  expect(t).not.toContain('Remove')
  await p.press({ key: 'deck-manage-n' })
  await settle()
  expect(installer()).toEqual(expect.arrayContaining(['--manage', 'ponytail']))
  expect(await texts(p)).toContain('Remove')
})

test('REA keeps its Add and gains Remove once added', async ($, on) => {
  await world($, on, { state: '{"rea":"installed"}' })
  const p = await pane($)
  await p.press({ key: 'deck-remove-e' })
  await settle()
  expect(installer()).toEqual(expect.arrayContaining(['--remove', 'rea']))
})

test('a ponytail update waiting shows on the bar and pressing it runs the plugin update', async ($, on) => {
  await world($, on, { state: '{"ponytail":"installed"}', pony: '5.3.2', latest: '5.4.0' })
  const b = await band($)
  expect(await texts(b)).toContain('ponytail 5.4.0')
  await b.press({ key: 'bar-update' })
  await settle()
  expect(toasts.at(-1)).toBe('ponytail 5.4.0. Press Update again to install.')
  await b.press({ key: 'bar-update' })
  await settle()
  expect(calls).toContainEqual(['claude', 'plugin', 'update', 'ponytail@ponytail'])
  expect(toasts.at(-1)).toContain('Restart Claude Code')
})

test('ponytail that is yours: the update shows but is never run, and the text points to /plugin', async ($, on) => {
  await world($, on, { state: '{"ponytail":"preexisting"}', pony: '5.3.2', latest: '5.4.0' })
  const b = await band($)
  expect(await texts(b)).toContain('ponytail 5.4.0')
  await b.press({ key: 'bar-update' })
  await settle()
  expect(calls.some(c => c[0] === 'claude' && c[2] === 'update')).toBe(false)
  await b.press({ key: 'bar-update' })
  await settle()
  expect(toasts.at(-1)).toContain('Update it with /plugin')
})

test('ponytail that is current: no update button', async ($, on) => {
  await world($, on, { state: '{"ponytail":"installed"}', pony: '5.3.2', latest: '5.3.2' })
  expect(await texts(await band($))).not.toContain('Update')
  expect(await texts(await pane($))).toContain('ponytail 5.3.2 · up to date')
})

test('gstack and REA installed before carapace, with no install record, show (yours), not Add', async ($, on) => {
  await world($, on, { gstackVersion: '1.91.135.0', rea: '6.7.0' })
  const ui = await pane($)
  await settle()
  const text = await texts(ui)
  expect(text).toContain('gstack 1.91.135 (yours)')
  expect(text).toMatch(/REA[^|]*\(yours\)/)
})

test('pure: reach tags come from one table, short in the row and full in the toast', () => {
  expect(Object.keys(REACH).sort()).toEqual(['gstack', 'hookify', 'ponytail', 'rea', 'security-guidance'])
  expect(reachTags('hookify')).toBe('files prompts hooks')
  expect(reachTags('rea')).toBe('network files server')
  expect(reachMeaning('ponytail')).toBe('ponytail writes files on this machine, sees the prompts you send, runs hooks on Claude Code events.')
  expect(addonStatus('hookify', { kind: 'ours', version: '1.0.0', latest: '' }, false, true)).toBe('hookify 1.0.0')
})

test('every add-on row carries its reach tags, and pressing an installed row toasts what it can reach', async ($, on) => {
  await world($, on, { state: '{"ponytail":"preexisting"}', pony: '5.3.2' })
  const p = await pane($)
  const t = await texts(p)
  for (const [id, tags] of Object.entries(REACH)) expect(t).toContain(tags.length > 0 ? reachTags(id as keyof typeof REACH) : id)
  await p.press({ key: 'deck-press-n' })
  expect(toasts.at(-1)).toContain('ponytail 5.3.2 (yours). It writes files on this machine, sees the prompts you send, runs hooks on Claude Code events.')
})

test('hookify and security-guidance rows show Add, and Add runs the installer with --with', async ($, on) => {
  await world($, on)
  const p = await pane($)
  const t = await texts(p)
  expect(t).toMatch(/hookify[\s\S]*Add[\s\S]*security-guidance[\s\S]*Add/)
  await p.press({ key: 'deck-press-h' })
  await settle()
  expect(installer()).toEqual(expect.arrayContaining(['--with', 'hookify']))
  expect(toasts.at(-1)).toBe('hookify added. Restart Claude Code to use it.')
})

test('hookify that is yours shows (yours) and Manage; security-guidance that carapace owns has Remove', async ($, on) => {
  await world($, on, { state: '{"security-guidance":"installed"}', hookify: '1.2.0' })
  const p = await pane($)
  const t = await texts(p)
  expect(t).toContain('hookify 1.2.0 (yours)')
  await p.press({ key: 'deck-manage-h' })
  await settle()
  expect(installer()).toEqual(expect.arrayContaining(['--manage', 'hookify']))
  await p.press({ key: 'deck-remove-i' })
  await settle()
  expect(installers().at(-1)).toEqual(expect.arrayContaining(['--remove', 'security-guidance']))
})

const HIST = [
  ...Array.from({ length: 4 }, (_, i) => JSON.stringify({ display: `run the tests and fix whatever fails (${i})`, timestamp: i })),
  ...Array.from({ length: 2 }, () => JSON.stringify({ display: 'write a changelog entry for the last commit', timestamp: 9 })),
  JSON.stringify({ display: 'something I asked once only, a long one', timestamp: 1 }),
].join('\n')

test('Repeated prompts row lists the top repeats with counts and the /insights link', async ($, on) => {
  await world($, on, { history: HIST })
  const p = await pane($)
  await settle()
  const t = await texts(p)
  expect(t).toContain('Repeated prompts')
  expect(t).toContain('prompts you typed more than once')
  expect(t).toContain('×4')
  expect(t).toContain('×2')
  expect(t).toContain('Make /command')
  expect(t).not.toContain('asked once only')
})

test('Make /command shows the prompt first, then writes a user command file on the second press', async ($, on) => {
  await world($, on, { history: HIST })
  const p = await pane($)
  await settle()
  await p.press({ key: 'deck-press-1' })
  expect(writes.filter(w => w[0].includes('/commands/'))).toEqual([])
  expect(toasts.at(-1)).toContain('would send: run the tests and fix whatever fails')
  await p.press({ key: 'deck-press-1' })
  await settle()
  const made = writes.filter(w => w[0].includes('/commands/'))
  expect(made).toHaveLength(1)
  expect(made[0]?.[0]).toBe('/home/test/.claude/commands/run-the-tests.md')
  expect(made[0]?.[1]).toContain('run the tests and fix whatever fails')
  expect(toasts.at(-1)).toBe('Saved /run-the-tests. It shows in the slash menu in new sessions.')
})
