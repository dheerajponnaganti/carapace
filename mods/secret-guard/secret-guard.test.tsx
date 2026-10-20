import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bashSecretFile, isSecretPath, maskSecrets, secretTarget } from './secret-logic'

// Fake shapes built at run time so no real-looking key sits in the source.
const fake = {
  openai: 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
  gh: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  pat: 'github_pat_' + '11ABCDEFG0abcdefghij_klmnop',
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  slack: 'xoxb-' + '1234567890-abcdefghij',
  google: 'AIza' + 'SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P67',
  bearer: 'Bearer ' + 'eyJhbGciOiJIUzI1NiJ9x7Qz3Kp9LmN2vB4tR8yW1',
}

test('secret paths are caught, safe look-alikes are not', () => {
  for (const p of ['.env', 'app/.env.local', '.env.production', 'k/server.pem', 'a.key', '/h/.ssh/id_rsa', 'id_ed25519', '.npmrc', '.pypirc', 'credentials.json', '/h/.aws/credentials', '.netrc'])
    expect(isSecretPath(p)).toBe(true)
  for (const p of ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'environment.ts', 'keyboard.ts', 'monkey.txt', 'credentials.md', 'aws/credentials', 'README.md', 'src/env.ts'])
    expect(isSecretPath(p)).toBe(false)
})

test('shell commands that print secret files', () => {
  expect(bashSecretFile('cat .env')).toBe('.env')
  expect(bashSecretFile('echo hi && tail -n 5 "config/.env.local"')).toBe('config/.env.local')
  expect(bashSecretFile('grep TOKEN ~/.aws/credentials')).toBe('~/.aws/credentials')
  expect(bashSecretFile('FOO=1 /bin/cat id_rsa | head')).toBe('id_rsa')
  expect(bashSecretFile('less < .netrc')).toBe('.netrc')
  expect(bashSecretFile('cat .env.example')).toBeNull()
  expect(bashSecretFile('ls -la ~/.ssh')).toBeNull()
  expect(bashSecretFile('echo .env')).toBeNull()
  expect(bashSecretFile('npm run build')).toBeNull()
  // Writing a secret file prints nothing; reading one and writing elsewhere still counts.
  expect(bashSecretFile("cat > .env <<'EOF'")).toBeNull()
  expect(bashSecretFile('cat >> .env')).toBeNull()
  expect(bashSecretFile('cat .env > out.txt')).toBe('.env')
})

test('tool inputs', () => {
  expect(secretTarget('Read', { file_path: '/p/.env' })).toBe('/p/.env')
  expect(secretTarget('Read', { file_path: '/p/.env.example' })).toBeNull()
  expect(secretTarget('Grep', { pattern: 'x', path: '/p/.env' })).toBe('/p/.env')
  expect(secretTarget('Grep', { pattern: 'x', glob: '**/*.pem' })).toBe('**/*.pem')
  expect(secretTarget('Grep', { pattern: 'x', path: 'src' })).toBeNull()
  expect(secretTarget('Edit', { file_path: '/p/.env' })).toBeNull()
})

test('masking true positives', () => {
  const block = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END ' + 'OPENSSH PRIVATE KEY-----'
  for (const s of [fake.openai, fake.gh, fake.pat, fake.aws, fake.slack, fake.google, block]) {
    const r = maskSecrets(`key: ${s} end`)
    expect(r.text).toBe('key: [secret masked] end')
    expect(r.count).toBe(1)
  }
  expect(maskSecrets(`Authorization: ${fake.bearer}`).text).toBe('Authorization: Bearer [secret masked]')
})

test('masking leaves ordinary text alone', () => {
  for (const s of ['the task-force-assessment-framework-for-everyone', 'sk-short', 'Bearer token', 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'AKIA lowercase words here', 'ghp_short', 'const risk-averse = 1', '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----'])
    expect(maskSecrets(s)).toEqual({ text: s, count: 0 })
})

let result: unknown = { stdout: 'ok' }
async function world($: Engine, on: On) {
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.toast', 'ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clean', args: 'off' } as never)
}

test('blocks a secret read, allows it once, then blocks again', async ($, on) => {
  await world($, on)
  const call = () => $.tool.call({ tool: 'Read', tool_use_id: 'a', file_path: '/p/.env' } as never)
  const first = await call()
  expect(first.deny).toContain('/secrets allow /p/.env')
  await $.command.run({ command: 'secrets', args: 'allow /p/.env' } as never)
  expect((await call()).deny).toBeUndefined()
  expect((await call()).deny).toBeDefined()
  const bash = await $.tool.call({ tool: 'Bash', tool_use_id: 'b', command: 'cat .env.example' } as never)
  expect(bash.deny).toBeUndefined()
})

test('masks secrets in a result and counts them; off turns the guard off', async ($, on) => {
  await world($, on)
  result = { stdout: `token ${fake.gh}` }
  const ran = await $.tool.call({ tool: 'Bash', tool_use_id: 'c', command: 'env' } as never)
  expect(JSON.stringify(ran.result)).toContain('[secret masked]')
  expect(JSON.stringify(ran.result)).not.toContain(fake.gh)
  expect((await $.command.run({ command: 'secrets', args: '' } as never)).text).toContain('1 masked')
  await $.command.run({ command: 'secrets', args: 'off' } as never)
  expect(JSON.stringify((await $.tool.call({ tool: 'Bash', tool_use_id: 'd', command: 'env' } as never)).result)).toContain(fake.gh)
  expect((await $.tool.call({ tool: 'Read', tool_use_id: 'e', file_path: '.env' } as never)).deny).toBeUndefined()
  result = { stdout: 'ok' }
})
