import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, On } from 'claude-code'

import type { LogbookStatus } from '../../types'
import { COUNT_KEY, appendLine, errorLine, logPath, openArgv, osName, queueLog } from '../shared/errlog'
import { PALETTES, fit, WORDS } from '../shared/look'
import type { Palette } from '../shared/look'
import { chip, heading, paneTitle } from '../shared/ui'
import { isRunCommand } from '../trimmer/trimmer-logic'
import { repoHash } from '../work-report/time-machine-logic'
import {
  HOME_NOTE,
  LOG_NOTE,
  PENDING_NOTE,
  candidates,
  commitSha,
  indexBlock,
  insertLog,
  isWorthLogging,
  loadedLine,
  logLine,
  noFacts,
  obsidianUrl,
  openItems,
  places,
  projectName,
  shortPath,
  starterNotes,
} from './logbook-logic'
import type { Facts } from './logbook-logic'

export const LOGBOOK_PANE = 'logbook'
const VAULTS_KEY = 'logbookVaults'
// Vaults turned off with /logbook off: per vault, so one project's switch never reaches another's.
const OFF_KEY = 'logbookOffVaults'
const MAX_WALK = 2000

export const NO_LOGBOOK: LogbookStatus = { vault: null, isOn: true, notes: 0, open: 0, lastLine: '', places: [], cwd: '', note: '', isAsking: false }
const statusAtom = atom({ plugin: 'carapace', key: 'logbookStatus' } as const, NO_LOGBOOK)
const checklistAtom = atom({ plugin: 'carapace', key: 'checklist' } as const, null)
const personAtom = atom({ plugin: 'carapace', key: 'personPrompt' } as const, null)
const errorsAtom = atom({ plugin: 'carapace', key: 'reportErrors' } as const, 0)

/** Same helper as every mod's: `$` cannot cross an import. Never throws. */
function logError($: Engine, what: string, err: unknown): void {
  void queueLog(async () => {
    const home = await homeDir($)
    const version = await $.session.version().then(v => v.version, () => '')
    const line = errorLine(await $.clock.now(), 'logbook', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
  })
}

const homeDir = async ($: Engine) => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const timeOf = (ms: number) => {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function offVaults($: Engine): Promise<string[]> {
  const v = await $.store.get(OFF_KEY)

  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

async function vaultsMap($: Engine): Promise<Record<string, string>> {
  const v = await $.store.get(VAULTS_KEY)

  return v && typeof v === 'object' ? (v as Record<string, string>) : {}
}

/** The vault for a folder: its own, or the nearest parent folder's. */
function vaultFor(map: Record<string, string>, cwd: string): string | null {
  const hit = Object.keys(map)
    // Windows paths use backslashes: a folder beneath matches with either separator.
    .filter(dir => cwd === dir || [`/`, `\\`].some(sep => cwd.startsWith(dir.replace(/[\\/]+$/, '') + sep)))
    .sort((a, b) => b.length - a.length)[0]

  return hit === undefined ? null : (map[hit] ?? null)
}

/** Markdown notes in the vault, skipping dot folders, bounded. */
async function countNotes($: Engine, dir: string, depth = 0, seen = { n: 0 }): Promise<number> {
  if (depth > 4 || seen.n >= MAX_WALK) return 0
  const entries = await $.fs.list(dir).catch(() => [])
  let notes = 0
  for (const f of entries) {
    if (++seen.n >= MAX_WALK) break
    if (f.name.startsWith('.')) continue
    if (f.kind === 'dir') notes += await countNotes($, `${dir}/${f.name}`, depth + 1, seen)
    else if (f.name.endsWith('.md')) notes++
  }

  return notes
}

let cwd = ''
let vault: string | null = null
let isOn = true
// The index Claude gets: sent with the first message and again after a compaction or /clear.
let indexText = ''
// Set up mid-session: the next prompt carries the index once.
let pendingIndex = ''
let facts: Facts = noFacts()
// One log write at a time.
let writing = Promise.resolve()

/** Reads the vault's index and refreshes the bar's state. Returns the loaded line, or '' when nothing loads. */
async function load($: Engine): Promise<string> {
  vault = vaultFor(await vaultsMap($), cwd)
  isOn = vault === null || !(await offVaults($)).includes(vault)
  const home = await homeDir($)
  const storage = await $.fs.list(`${home}/Library/CloudStorage`).then(l => l.map(f => f.name), () => [] as string[])
  const real = new Set<string>()
  for (const dir of candidates(home)) if (await $.fs.exists(dir).catch(() => false)) real.add(dir)
  const where = places(home, d => real.has(d), storage)
  if (vault === null || !isOn) {
    indexText = ''
    await update($, statusAtom, s => ({ ...s, vault, isOn, cwd, places: where, notes: 0, open: 0 }))

    return ''
  }
  const homeText = await $.fs.read(`${vault}/${HOME_NOTE}`).then(String, () => '')
  const items = openItems(await $.fs.read(`${vault}/${PENDING_NOTE}`).then(String, () => ''))
  const ix = indexBlock(vault, homeText, items)
  indexText = homeText === '' && items.length === 0 ? '' : ix.text
  const notes = await countNotes($, vault)
  await update($, statusAtom, s => ({ ...s, vault, isOn, cwd, places: where, notes, open: items.length }))

  return loadedLine(notes, ix)
}

/** Points this folder at a vault, creating the starter notes it lacks, and loads it. */
async function adopt($: Engine, dir: string, isNew: boolean): Promise<string> {
  const clean = dir.replace(/[\\/]+$/, '')
  if (!isNew && !(await $.fs.exists(clean).catch(() => false))) return `No folder at ${clean}.`
  const now = await $.clock.now()
  const notes = starterNotes(projectName(cwd), dayOf(now))
  for (const name of Object.keys(notes)) {
    // An adopted vault keeps its own notes: only missing ones are made.
    if (!(await $.fs.exists(`${clean}/${name}`).catch(() => false))) await $.fs.write(`${clean}/${name}`, notes[name] ?? '')
  }
  await $.store.set(VAULTS_KEY, { ...(await vaultsMap($)), [cwd]: clean })
  await $.store.set(OFF_KEY, (await offVaults($)).filter(v => v !== clean))
  const line = await load($)
  pendingIndex = indexText
  $.ui.invalidate('prompt.context')
  const name = WORDS.memory
  await update($, statusAtom, s => ({ ...s, isAsking: false, note: `${name} set up at ${clean}. Claude reads its index from your next message.` }))

  return line
}

async function setOn($: Engine, value: boolean): Promise<void> {
  const off = (await offVaults($)).filter(v => v !== vault)
  await $.store.set(OFF_KEY, value || vault === null ? off : [...off, vault])
  await load($)
  pendingIndex = value ? indexText : ''
  $.ui.invalidate('prompt.context')
}

/** Adds one observed line to today's section of the Build Log. A backup of the file is kept once a day. */
async function writeLog($: Engine, line: string): Promise<void> {
  if (vault === null) return
  const now = await $.clock.now()
  const path = `${vault}/${LOG_NOTE}`
  const read = await $.fs.read(path).then(String, () => null)
  // A log that exists but cannot be read (cloud file not downloaded, no permission, too big) is never replaced.
  if (read === null && (await $.fs.exists(path).catch(() => true))) throw new Error(`could not read ${LOG_NOTE}; nothing written`)
  const old = read ?? ''
  const home = await homeDir($)
  // The vault's whole path in the name: two vaults in folders of the same name each get their own backup.
  const backup = `${home}/.claude/carapace/logbook-backups/${dayOf(now)}-${repoHash(vault)}.md`
  if (home !== '' && old !== '' && !(await $.fs.exists(backup).catch(() => false))) await $.fs.write(backup, old)
  await $.fs.write(path, insertLog(old === '' ? '# Build Log\n' : old, dayOf(now), line))
  await update($, statusAtom, s => ({ ...s, lastLine: line }))
}

export function registerLogbook(on: On): void {
  on('session.start', { isInteractive: [false, true] }, async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'logbook', description: 'Logbook: your work\'s memory in a folder of Markdown notes (Obsidian optional). Open, on, off, or use <vault folder>', argumentHint: '[on|off|use <folder>]' })
    const line = await load($).catch(err => (logError($, 'load the vault', err), ''))
    if (line !== '') $.ui.log(line)

    return next(e)
  })

  on('prompt.context', async ($, e, next) => {
    const res = await next(e)

    return indexText === '' ? res : { ...res, blocks: [...res.blocks, { name: 'logbook', text: indexText }] }
  })

  on('prompt.submit', { text: /[\s\S]/ }, async ($, e, next) => {
    if (pendingIndex === '') return next(e)
    const text = pendingIndex
    pendingIndex = ''

    return next({ ...e, context: [...(e.context ?? []), text] })
  })

  // Facts only: files written, pages fetched, check runs and commits, from the tool calls themselves.
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    if (vault === null || !isOn || ran.deny !== undefined) return ran
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown; url?: unknown; command?: unknown }
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null
    if (path !== null && !ran.isError) facts.wrote.push(shortPath(path, cwd))
    else if (e.tool === 'WebFetch' && typeof input.url === 'string' && !ran.isError) facts.fetched.push(input.url)
    else if (e.tool === 'Bash' && typeof input.command === 'string') {
      const stdout = (ran as { result?: { stdout?: unknown } }).result?.stdout
      if (isRunCommand(input.command)) facts.checks.push({ command: input.command, isPass: !ran.isError })
      const sha = /\bgit\b[^\n]*\bcommit\b/.test(input.command) && typeof stdout === 'string' && !ran.isError ? commitSha(stdout) : null
      if (sha !== null) facts.commits.push(sha)
    }

    return ran
  }).catch(($, e, next) => next(e)) // a Logbook bug must never stop a tool

  on('turn.complete', { reason: ['answer', 'aborted', 'error'] }, async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    // Every turn starts fresh, so a check from an earlier turn never lands in a later job's line.
    const seen = facts
    facts = noFacts()
    if (vault === null || !isOn || !isWorthLogging(seen)) return res
    const list = await read($, checklistAtom)
    const person = await read($, personAtom)
    const done = list?.tasks.filter(t => t.status === 'done').length ?? 0
    // 'Working on it' is the bar's placeholder until a job has a name.
    const named = list?.title && list.title !== 'Working on it' ? list.title : ''
    const title = named || person?.text || list?.tasks[0]?.name || 'Work'
    const line = logLine(timeOf(await $.clock.now()), title, done, list?.tasks.length ?? 0, seen)
    writing = writing.then(() => writeLog($, line)).catch(err => logError($, 'write the Build Log', err))

    return res
  })

  on('command.run', { command: 'logbook' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    // The pane opens before any other $ call, so it counts as asked for.
    const isOpening = verb !== 'on' && verb !== 'off' && verb !== 'use'
    if (isOpening) void $.ui.open({ id: LOGBOOK_PANE, title: 'Logbook', focus: true, closeOnEscape: true })
    const name = WORDS.memory
    const arg = rest.join(' ').replace(/^~(?=[\\/])/, await homeDir($))
    if (verb === 'on' || verb === 'off') {
      if (vault === null) return { text: `${name} is not set up for this folder yet. Run /logbook to set it up.` }
      await setOn($, verb === 'on')

      return { text: verb === 'on' ? `${name} is on: Claude reads the index from your next message, and jobs are logged.` : `${name} is off: nothing loads or logs. Your notes stay where they are.` }
    }
    if (verb === 'use') {
      if (arg === '') return { text: 'Say which folder: /logbook use <vault folder>.' }
      const line = await adopt($, arg, false)

      return { text: line.startsWith('No folder') ? line : `${name} uses ${arg} for this folder. ${line}` }
    }
    if (name !== 'Logbook') void $.ui.open({ id: LOGBOOK_PANE, title: name, focus: true, closeOnEscape: true })

    return { text: vault === null ? `Opening ${name} setup.` : `${name} ${isOn ? 'is on' : 'is off'}: ${vault}.` }
  })

  on('ui.render', { component: 'Pane', requestId: LOGBOOK_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Input = 'Input' in els ? els.Input : undefined
    const pal: Palette = PALETTES.deep
    const name = WORDS.memory
    const cols = Math.max(30, e.props.bodyColumns - 2)
    const st = await read($, statusAtom)
    const line = (text: string, color: string = pal.text) => <Text color={color}>{fit(text, cols)}</Text>
    // Sentences that must be read whole wrap instead of being cut at the pane's edge.
    const para = (text: string, color: string) => <Text color={color} wrap="wrap">{text}</Text>
    const close = chip(els, pal, 'logbook-close', '✕', 'quiet', () => void $.ui.close({ id: LOGBOOK_PANE }))
    const project = projectName(st.cwd)
    const make = (dir: string) => () =>
      void adopt($, dir, true)
        .then(l => (l !== '' ? $.ui.log(l) : undefined))
        .catch(err => logError($, 'set up the vault', err))

    if (st.vault === null) {
      return (
        <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
          {paneTitle(els, pal, name, cols, undefined, Boolean(e.props.isFocused))}
          {para(`${name} keeps your work's memory in a folder of Markdown notes (Obsidian optional): a short index Claude reads at the start of each session, and a Build Log of what got done, written from what carapace saw.`, pal.muted)}
          <Box flexDirection="column">
            {heading(els, pal, 'Outside this project (recommended, private)', cols)}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {st.places.map((p, i) => <Box key={`logbook-place-${p.id}`}>{chip(els, pal, `logbook-place-${p.id}-chip`, p.label, i === 0 ? 'primary' : 'secondary', make(`${p.dir}/${project}`))}</Box>)}
            </Box>
            {st.places[0] ? line(`New vault: ${st.places[0].dir}/${project}`, pal.muted) : null}
          </Box>
          <Box flexDirection="column">
            {heading(els, pal, 'Inside this project (shared)', cols)}
            {chip(els, pal, 'logbook-inside', 'Inside this project', 'secondary', make(`${st.cwd}/logbook`))}
            {para('The notes are committed with the project and anyone with the repo can read them.', pal.warn)}
          </Box>
          <Box flexDirection="column">
            {heading(els, pal, 'Use an existing vault', cols)}
            {st.isAsking && Input ? (
              <Input key="logbook-path" label="Vault folder: " placeholder="~/path/to/vault" submitLabel="use" autoFocus onSubmit={value => void homeDir($).then(h => adopt($, value.trim().replace(/^~(?=[\\/])/, h), false)).then(l => update($, statusAtom, s => ({ ...s, note: l.startsWith('No folder') ? l : s.note }))).catch(err => logError($, 'use a vault', err))} />
            ) : (
              chip(els, pal, 'logbook-existing', 'Pick a folder', 'secondary', () => void update($, statusAtom, s => ({ ...s, isAsking: true })))
            )}
            {line('Or type /logbook use <folder>.', pal.muted)}
          </Box>
          {st.note ? line(st.note, pal.good) : null}
          {close}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        {paneTitle(els, pal, name, cols, undefined, Boolean(e.props.isFocused))}
        <Box flexDirection="column">
          {line(`${st.isOn ? 'On' : 'Off'} · ${st.notes} notes · ${st.open} open items`, st.isOn ? pal.good : pal.muted)}
          {line(st.vault, pal.muted)}
          {st.lastLine ? line(`Last log: ${st.lastLine.replace(/^- /, '')}`) : line('Nothing logged this session yet. Jobs that change files or fetch pages are logged.', pal.muted)}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {chip(els, pal, 'logbook-toggle', st.isOn ? 'Turn off' : 'Turn on', st.isOn ? 'secondary' : 'primary', () => void setOn($, !st.isOn).catch(err => logError($, 'turn Logbook on or off', err)))}
          {chip(els, pal, 'logbook-obsidian', 'Open in Obsidian', 'primary', () => void homeDir($).then(h => $.process.run(openArgv(osName(h), obsidianUrl(st.vault ?? '')), { timeoutMs: 5000 })).catch(err => logError($, 'open Obsidian', err)))}
          {close}
        </Box>
        {st.note ? line(st.note, pal.good) : null}
      </Box>
    )
  })
}
