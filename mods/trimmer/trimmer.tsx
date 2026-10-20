import { atom, update } from 'claude-code'
import type { EngineInterface as Engine, On } from 'claude-code'

import { maskSecrets } from '../secret-guard/secret-logic'
import { osName } from '../shared/errlog'
import { estTokens, hasSkipWord, isLong, isRunCommand, logName, savedText, trimText } from './trimmer-logic'

const OFF_KEY = 'trimmer:off'
const SKIP_KEY = 'trimmer:skip'
const KEEP_LOGS = 30
const savedAtom = atom({ plugin: 'carapace', key: 'trimmerSaved' } as const, { tokens: 0, runs: 0 })

export function registerTrimmer(on: On): void {
  let tokens = 0
  let runs = 0

  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await $.command.register({ name: 'trim', description: 'Trimmer: shortens test output. Status, on, off, skip <word>, unskip <word>', argumentHint: '[on|off|skip <word>|unskip <word>]' })

    return next(e)
  })

  // Scope is Bash only; the test-run check on the command happens inside. Other mods hook other matchers.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = (e as unknown as { command?: unknown }).command
    if (ran.deny !== undefined || typeof command !== 'string') return ran
    if ((await $.store.get(OFF_KEY)) === true || command.includes('# no-trim') || !isRunCommand(command)) return ran
    const skip = (await $.store.get(SKIP_KEY)) as string[] | undefined
    if (hasSkipWord(command, Array.isArray(skip) ? skip : [])) return ran
    // A failing run arrives as error text, not as stdout: the runs the trimmer is for.
    const failed = ran.isError ? (typeof ran.result === 'string' ? ran.result : ran.text) : undefined
    const res = (ran.isError ? {} : (ran as { result?: { stdout?: unknown; stderr?: unknown } }).result) ?? {}
    const stdout = typeof failed === 'string' ? failed : res.stdout
    if (typeof stdout !== 'string') return ran
    const stderr = typeof res.stderr === 'string' ? res.stderr : ''
    if (!isLong(stdout) && !isLong(stderr)) return ran
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    if (home === '') return ran
    const dir = `${home}/.claude/carapace/logs`
    const path = `${dir}/${logName(await $.clock.now(), command)}`
    // The log is plain text on disk, so secrets are masked there too.
    const full = stderr === '' ? stdout : `${stdout}\n--- stderr ---\n${stderr}`
    try {
      await $.fs.write(path, maskSecrets(full).text)
    } catch {
      return ran
    }
    const out = isLong(stdout) ? trimText(stdout, path) : null
    const err = isLong(stderr) ? trimText(stderr, path) : null
    if (out === null && err === null) return ran
    tokens += estTokens(stdout.length + stderr.length - (out ?? stdout).length - (err ?? stderr).length)
    runs++
    await update($, savedAtom, () => ({ tokens, runs }))
    void prune($, dir, home).catch(() => undefined)

    // Drop core's ref so the rewritten result is the one used.
    // Drop core's text too: it holds the untrimmed output.
    const { ref: _ref, text: _text, ...rest } = ran as typeof ran & { ref?: number; text?: string }
    // Core checks a replaced result against Bash's own record shape, so a failure's text goes back as its stdout; its first line keeps "Exit code N".
    if (typeof failed === 'string') return { ...rest, result: { stdout: out ?? stdout, stderr: '', interrupted: false } } as typeof ran

    return { ...rest, result: { ...res, stdout: out ?? stdout, stderr: err ?? stderr } } as typeof ran
  }).catch(($, e, next) => next(e)) // a trimmer bug must not stop Bash; fails open

  on('command.run', { command: 'trim' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = '', ...rest] = args.split(/\s+/)
    const word = rest.join(' ')
    const skip = (((await $.store.get(SKIP_KEY)) as string[] | undefined) ?? []).filter(Boolean)
    if (verb === 'on' || verb === 'off') await $.store.set(OFF_KEY, verb === 'off')
    else if (verb === 'skip' && word !== '') await $.store.set(SKIP_KEY, [...new Set([...skip, word])])
    else if (verb === 'unskip' && word !== '') await $.store.set(SKIP_KEY, skip.filter(w => w !== word))
    const isOn = (await $.store.get(OFF_KEY)) !== true
    const now = (((await $.store.get(SKIP_KEY)) as string[] | undefined) ?? []).filter(Boolean)

    return { text: `Trimmer is ${isOn ? 'on' : 'off'}. ${savedText(tokens, runs)}. Never trimmed: ${now.length ? now.join(', ') : 'nothing extra'} (or add # no-trim to a command).` }
  })
}

async function prune($: Engine, dir: string, home: string): Promise<void> {
  const names = (await $.fs.list(dir)).map(f => f.name).filter(f => f.endsWith('.log')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const old = names.slice(0, Math.max(0, names.length - KEEP_LOGS)).map(f => `${dir}/${f}`)
  if (old.length === 0) return
  // Windows has no rm; its del wants backslashes.
  const argv = osName(home) === 'Windows' ? ['cmd', '/c', 'del', '/f', '/q', ...old.map(p => p.replace(/\//g, '\\'))] : ['rm', '-f', ...old]
  await $.process.run(argv, { cwd: dir, timeoutMs: 3000 })
}
