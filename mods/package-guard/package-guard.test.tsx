import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { npmFacts, packagesIn, pypiFacts, reasons } from './package-logic'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const names = (c: string) => packagesIn(c).map(p => `${p.eco}:${p.name}`)

test('finds the packages a line installs, and skips lockfile installs, paths, URLs and flag values', () => {
  expect(names('npm install lodash @types/node@20 react@^18 -D')).toEqual(['npm:lodash', 'npm:@types/node', 'npm:react'])
  expect(names('cd app && pnpm add zod && yarn add left-pad; bun add hono')).toEqual(['npm:zod', 'npm:left-pad', 'npm:hono'])
  expect(names('pip install "requests[socks]>=2" Django==5.0 -r req.txt zope.interface')).toEqual(['pypi:requests', 'pypi:django', 'pypi:zope-interface'])
  expect(names('python3 -m pip install --index-url https://x numpy && uv add httpx && poetry add rich')).toEqual(['pypi:numpy', 'pypi:httpx', 'pypi:rich'])
  for (const c of ['npm install', 'npm ci', 'yarn', 'pip install -e .', 'pip install ./dist/a.whl', 'npm i github:a/b', 'npm i file:../x', 'echo npm install evil', 'npm run add', 'git add .'])
    expect(names(c)).toEqual([])
})

test('reasons: unknown, brand new, barely used and deprecated are held; a healthy package is not', () => {
  const npm = { eco: 'npm' as const, name: 'x' }
  expect(reasons(npm, { found: false, ageDays: null, weekly: null, deprecated: null })[0]).toContain('does not exist on npm')
  expect(reasons(npm, { found: true, ageDays: 3, weekly: 12, deprecated: 'use y' })).toEqual(['it was first published 3 days ago', 'it had only 12 downloads last week', 'it is deprecated: use y'])
  expect(reasons(npm, { found: true, ageDays: 400, weekly: 90_000, deprecated: null })).toEqual([])
  expect(reasons(npm, { found: true, ageDays: null, weekly: null, deprecated: null })).toEqual([])
})

test('registry answers become facts', () => {
  const day = (d: string, n: number) => ({ day: d, downloads: n })
  const old = { downloads: [day('2025-10-20', 5), ...Array.from({ length: 7 }, (_, i) => day(`2026-10-1${i}`, 10))] }
  expect(npmFacts(old, { deprecated: 'gone' }, NOW)).toEqual({ found: true, ageDays: null, weekly: 70, deprecated: 'gone' })
  const fresh = { downloads: [day('2025-10-20', 0), day('2026-10-16', 0), day('2026-10-17', 4), day('2026-10-18', 9)] }
  expect(npmFacts(fresh, {}, NOW)).toMatchObject({ ageDays: 2, weekly: 13, deprecated: null })
  expect(pypiFacts({ releases: { '1.0': [{ upload_time_iso_8601: '2026-10-09T12:00:00Z' }], '0.1': [] } }, 40, NOW)).toEqual({ found: true, ageDays: 10, weekly: 40, deprecated: null })
})

// The engine beneath: registries answer from this table; no network.
let pages: Record<string, { status: number; body?: unknown }> = {}
let ran: string[] = []
let offline = false
async function world($: Engine, on: On) {
  pages = {}
  ran = []
  offline = false
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: NOW })
  on('http.fetch', (_$, e) => {
    if (offline) return { deny: 'offline' }
    const p = pages[e.url] ?? { status: 404 }
    return { value: { status: p.status, ok: p.status === 200, headers: {}, text: JSON.stringify(p.body ?? {}) } }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.toast', 'ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', (_$, e) => (ran.push(String((e as { command?: unknown }).command)), { result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clean', args: 'off' } as never)
}
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', tool_use_id: 't', command } as never) as Promise<{ deny?: string }>
const healthy = (name: string) => {
  pages[`https://api.npmjs.org/downloads/range/last-year/${name}`] = { status: 200, body: { downloads: [{ day: '2025-10-20', downloads: 900 }, ...Array.from({ length: 7 }, () => ({ day: '2026-10-18', downloads: 5000 }))] } }
  pages[`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`] = { status: 200, body: { version: '1.0.0' } }
}

test('a made-up npm name is held before it runs; /packages allow lets it through', async ($, on) => {
  await world($, on)
  healthy('zod')
  const held = await bash($, 'npm install zod reakt-dom-utils')
  expect(held.deny).toContain('reakt-dom-utils: it does not exist on npm')
  expect(held.deny).not.toContain('zod:')
  expect(held.deny).toContain('/packages allow reakt-dom-utils')
  expect(ran).toEqual([])
  await $.command.run({ command: 'packages', args: 'allow reakt-dom-utils' } as never)
  expect((await bash($, 'npm install zod reakt-dom-utils')).deny).toBeUndefined()
  expect(ran).toEqual(['npm install zod reakt-dom-utils'])
})

test('healthy packages, other commands, an offline registry and /packages off all run untouched', async ($, on) => {
  await world($, on)
  healthy('@types/node')
  expect((await bash($, 'npm i -D @types/node@20')).deny).toBeUndefined()
  expect((await bash($, 'ls -la')).deny).toBeUndefined()
  offline = true
  expect((await bash($, 'pip install brand-new-thing')).deny).toBeUndefined()
  offline = false
  await $.command.run({ command: 'packages', args: 'off' } as never)
  expect((await bash($, 'npm install not-a-real-pkg-xyz')).deny).toBeUndefined()
  expect(ran).toEqual(['npm i -D @types/node@20', 'ls -la', 'pip install brand-new-thing', 'npm install not-a-real-pkg-xyz'])
})

test('a PyPI package first published days ago is held', async ($, on) => {
  await world($, on)
  pages['https://pypi.org/pypi/fresh-pkg/json'] = { status: 200, body: { releases: { '0.1': [{ upload_time_iso_8601: '2026-10-15T00:00:00Z' }] } } }
  pages['https://pypistats.org/api/packages/fresh-pkg/recent'] = { status: 200, body: { data: { last_week: 7 } } }
  const held = await bash($, 'pip install fresh-pkg')
  expect(held.deny).toContain('fresh-pkg: it was first published 4 days ago; it had only 7 downloads last week')
  expect((await $.command.run({ command: 'packages', args: '' } as never)).text).toContain('1 checked, 1 held')
})
