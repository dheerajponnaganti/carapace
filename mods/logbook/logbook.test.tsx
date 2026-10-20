import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { repoHash } from '../work-report/time-machine-logic'
import { commitSha, indexBlock, insertLog, isWorthLogging, logLine, noFacts, openItems, places } from './logbook-logic'

test('setup offers only the cloud folders that exist, then this computer', () => {
  const home = '/Users/a'
  const have = new Set([`${home}/Library/Mobile Documents/com~apple~CloudDocs`, `${home}/Dropbox`])
  const got = places(home, d => have.has(d), ['GoogleDrive-a@b.com', 'OneDrive-Personal'])
  expect(got.map(p => p.id)).toEqual(['icloud', 'gdrive', 'onedrive', 'dropbox', 'local'])
  expect(got[0]?.dir).toBe(`${home}/Library/Mobile Documents/com~apple~CloudDocs/carapace-vaults`)
  expect(got[1]?.dir).toBe(`${home}/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/carapace-vaults`)
  expect(places(home, () => false, []).map(p => p.label)).toEqual(['This computer only'])
  // Obsidian's own iCloud folder wins over iCloud Drive, and holds vaults directly.
  const obs = `${home}/Library/Mobile Documents/iCloud~md~obsidian/Documents`
  expect(places(home, d => d === obs || have.has(d), [])[0]).toEqual({ id: 'icloud', label: 'iCloud (Obsidian)', dir: obs })
})

test('open items, the index cap and the log line', () => {
  expect(openItems('# P\n- [ ] one\n- [x] done\n  - [ ] nested\n- [ ]no space')).toEqual(['- [ ] one', '- [ ] nested'])
  expect(openItems(Array.from({ length: 50 }, (_, i) => `- [ ] ${i}`).join('\n'))).toHaveLength(40)
  const ix = indexBlock('/v', '# Home\n- a\n- b', ['- [ ] x'])
  expect(ix).toMatchObject({ lines: 3, open: 1, isWhole: true })
  expect(ix.text).toContain('Open items from 09 Pending Work:\n- [ ] x')
  const big = indexBlock('/v', 'x'.repeat(20_000), [])
  expect(big.isWhole).toBe(false)
  expect(big.tokens).toBeLessThan(2600)
  const f = { wrote: ['a.ts', 'a.ts', 'b.ts'], fetched: [], checks: [{ command: 'npm test', isPass: false }, { command: 'npm test', isPass: true }], commits: ['a1b2c3d'] }
  expect(logLine('14:32', 'Fix the login', 3, 3, f)).toBe('- 14:32 · Fix the login · 3 of 3 steps · changed: a.ts, b.ts · checks: npm test passed · commit a1b2c3d · observed')
  // A research job: no git, pages and a written note.
  expect(logLine('16:05', 'Compare vector databases', 4, 4, { ...noFacts(), fetched: ['u1', 'u2', 'u1'], wrote: ['Findings/DBs.md'] })).toBe('- 16:05 · Compare vector databases · 4 of 4 steps · changed: Findings/DBs.md · fetched: 2 pages · observed')
  expect(isWorthLogging({ ...noFacts(), checks: [{ command: 'npm test', isPass: true }] })).toBe(false)
  expect(commitSha('[mod/logbook 9f3e2a1] Add Logbook\n 3 files changed')).toBe('9f3e2a1')
  expect(commitSha('nothing to commit')).toBeNull()
})

const LOG = '# Build Log\n\nNewest first.\n\n## 2026-10-18\n\n- hand written, *keep* — exactly\n- second\n## 2026-10-15\n\n- older\n'

test('a log line goes under today, or a new day on top; every other line stays byte for byte', () => {
  const fresh = insertLog(LOG, '2026-10-19', '- new')
  expect(fresh).toBe('# Build Log\n\nNewest first.\n\n## 2026-10-19\n\n- new\n\n## 2026-10-18\n\n- hand written, *keep* — exactly\n- second\n## 2026-10-15\n\n- older\n')
  const same = insertLog(LOG, '2026-10-18', '- new')
  expect(same).toBe(LOG.replace('- hand written', '- new\n- hand written'))
  expect(same.split('\n').filter(l => l !== '- new').join('\n')).toBe(LOG)
  expect(insertLog('# Build Log\n', '2026-10-19', '- a')).toBe('# Build Log\n\n## 2026-10-19\n\n- a\n')
  expect(insertLog('## 2026-10-19\n## 2026-10-18\n- x\n', '2026-10-19', '- a')).toBe('## 2026-10-19\n\n- a\n\n## 2026-10-18\n- x\n')
})

// The mod with a fake vault held in memory, never the real one.
let files: Record<string, string> = {}
let toasts: string[] = []
let logs: string[] = []
let result: unknown = { stdout: '', stderr: '', interrupted: false }
let isError = false
let failWrite = false
let unreadable = ''
const VAULT = '/h/Library/Mobile Documents/iCloud~md~obsidian/Documents/proj'

async function world($: Engine, on: On, seed: Record<string, string> = {}) {
  files = { ...seed }
  toasts = []
  logs = []
  isError = false
  failWrite = false
  unreadable = ''
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: new Date(2026, 9, 19, 14, 32).getTime() })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => (toasts.push(String((e as { text?: unknown }).text ?? '')), { value: undefined }))
  on('ui.log', (_$, e) => (logs.push(String((e as { text?: unknown }).text ?? '')), { value: undefined }))
  for (const op of ['ui.status', 'ui.invalidate', 'ui.open', 'ui.close'] as const) on(op, () => ({ value: op === 'ui.open' ? { isPlaced: true } : undefined }) as never)
  on('fs.read', (_$, e) => (e.path in files && e.path !== unreadable ? { value: files[e.path] as string } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => (failWrite ? { deny: 'EACCES' } : ((files[e.path] = e.text), { value: undefined })))
  on('fs.exists', (_$, e) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$, e) => {
    const base = `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) if (f.startsWith(base)) {
      const rest = f.slice(base.length)
      names.set(rest.split('/')[0] as string, rest.includes('/') ? 'dir' : 'file')
    }

    return { value: [...names].map(([name, kind]) => ({ name, kind })) } as never
  })
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => (isError ? { result, isError } : { result }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
  // Clean View holds tools until a plan exists; these tests have none.
  await $.command.run({ command: 'clean', args: 'off' } as never)
}
const edit = ($: Engine, path: string) => $.tool.call({ tool: 'Edit', tool_use_id: 't', file_path: path, old_string: 'a', new_string: 'b' } as never)
const fetchPage = ($: Engine, url: string) => $.tool.call({ tool: 'WebFetch', tool_use_id: 't', url, prompt: 'x' } as never)
const end = ($: Engine) => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
const context = async ($: Engine) => ((await $.prompt.context({ blocks: [] } as never)) as { blocks: { name: string; text: string }[] }).blocks
const settle = () => new Promise(r => setTimeout(r, 20))

test('before setup nothing loads or logs', async ($, on) => {
  await world($, on, { '/h/Library/Mobile Documents/iCloud~md~obsidian/Documents/x.md': '' })
  expect(await context($)).toEqual([])
  await edit($, '/work/proj/a.ts')
  await end($)
  await settle()
  expect(Object.keys(files).filter(f => f.includes('Build Log'))).toEqual([])
  expect((await $.command.run({ command: 'logbook', args: 'off' } as never)).text).toContain('not set up')
})

test('adopting a vault keeps its notes, loads the index and logs a job', async ($, on) => {
  const own = '/vault'
  await world($, on, { [`${own}/00 Home.md`]: '# Home\n- [[A]]\n', [`${own}/09 Pending Work.md`]: '- [ ] ship it\n- [x] done\n', [`${own}/02 Build Log.md`]: LOG, [`${own}/Ideas/A.md`]: 'a' })
  const answer = (await $.command.run({ command: 'logbook', args: `use ${own}` } as never)).text
  expect(answer).toContain('4 notes · index 2 lines · 1 open items')
  expect(answer).toContain('loaded whole')
  expect(files[`${own}/00 Home.md`]).toBe('# Home\n- [[A]]\n')
  const blocks = await context($)
  expect(blocks[0]?.name).toBe('logbook')
  expect(blocks[0]?.text).toContain('- [ ] ship it')
  expect(blocks[0]?.text).not.toContain('done')

  await edit($, '/work/proj/src/a.ts')
  await fetchPage($, 'https://example.com')
  await end($)
  await settle()
  const log = files[`${own}/02 Build Log.md`] as string
  expect(log).toContain('## 2026-10-19\n\n- 14:32 · Work · changed: src/a.ts · fetched: 1 page · observed\n')
  expect(log).toBe(LOG.replace('## 2026-10-18', '## 2026-10-19\n\n- 14:32 · Work · changed: src/a.ts · fetched: 1 page · observed\n\n## 2026-10-18'))
  expect(files[`/h/.claude/carapace/logbook-backups/2026-10-19-${repoHash('/vault')}.md`]).toBe(LOG)

  // A turn that changed nothing writes nothing.
  const before = files[`${own}/02 Build Log.md`]
  await end($)
  await settle()
  expect(files[`${own}/02 Build Log.md`]).toBe(before)

  // Off stops loading and logging; the files stay.
  await $.command.run({ command: 'logbook', args: 'off' } as never)
  expect(await context($)).toEqual([])
  await edit($, '/work/proj/src/b.ts')
  await end($)
  await settle()
  expect(files[`${own}/02 Build Log.md`]).toBe(before)
})

test('a new vault gets the three starter notes; a failed write stays quiet', async ($, on) => {
  await world($, on)
  expect((await $.command.run({ command: 'logbook', args: 'use /nope' } as never)).text).toBe('No folder at /nope.')
  files[`${VAULT}/.keep`] = ''
  await $.command.run({ command: 'logbook', args: `use ${VAULT}` } as never)
  expect(Object.keys(files).filter(f => f.endsWith('.md')).sort()).toEqual([`${VAULT}/00 Home.md`, `${VAULT}/02 Build Log.md`, `${VAULT}/09 Pending Work.md`])
  const log = files[`${VAULT}/02 Build Log.md`]
  failWrite = true
  await edit($, '/work/proj/a.ts')
  await expect(end($)).resolves.toBeDefined()
  await settle()
  expect(files[`${VAULT}/02 Build Log.md`]).toBe(log)
})

test('the setup panel offers the places found and a press makes the vault there', async ($, on) => {
  await world($, on, { '/h/Dropbox/x': '' })
  const kit = await $.ui.mount({
    plugin: 'carapace', surface: 'terminal', component: 'Pane', requestId: 'logbook',
    props: { title: 'Logbook', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  const text = (await kit.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).toContain('Dropbox')
  expect(text).toContain('This computer only')
  expect(text).not.toContain('Google Drive')
  expect(text).toContain('New vault: /h/Dropbox/carapace-vaults/proj')
  await kit.press({ key: 'logbook-place-dropbox-chip' })
  await settle()
  expect(files['/h/Dropbox/carapace-vaults/proj/02 Build Log.md']).toContain('- Logbook set up.')
  expect((await context($))[0]?.text).toContain('/h/Dropbox/carapace-vaults/proj')
})

test('a Build Log that exists but cannot be read is never replaced; each turn starts with fresh facts', async ($, on) => {
  const own = '/vault'
  await world($, on, { [`${own}/00 Home.md`]: '# Home\n', [`${own}/02 Build Log.md`]: LOG })
  await $.command.run({ command: 'logbook', args: `use ${own}` } as never)
  // A check in a turn that changed nothing is not carried into the next job's line.
  isError = true
  await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'npm test' } as never)
  isError = false
  await end($)
  await edit($, '/work/proj/a.ts')
  await end($)
  await settle()
  expect(files[`${own}/02 Build Log.md`]).toContain('changed: a.ts · observed')
  expect(files[`${own}/02 Build Log.md`]).not.toContain('npm test')
  const before = files[`${own}/02 Build Log.md`]
  unreadable = `${own}/02 Build Log.md`
  await edit($, '/work/proj/b.ts')
  await end($)
  await settle()
  expect(files[`${own}/02 Build Log.md`]).toBe(before)
})
