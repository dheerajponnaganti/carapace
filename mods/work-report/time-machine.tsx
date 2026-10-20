// The edit time machine: a snapshot of the working tree after every file-changing tool call, kept in a hidden git store
// under ~/.claude/carapace/snapshots, so the project's own .git, index and branches are never touched.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import { fit } from '../shared/look'
import type { Palette } from '../shared/look'
import { chip, heading } from '../shared/ui'
import type { Els } from '../shared/ui'
import type { TimeSnap } from '../../types'

import { MAX_SNAPS, brokeBy, checkNote, fixedBy, groupByPrompt, isCheckCommand, labelOf, pruneDrop, sizeText, storeDir } from './time-machine-logic'

type Engine = EngineInterface
type CheckOutcome = 'new' | 'same' | 'flaky'

const snapsAtom = atom({ plugin: 'carapace', key: 'timeMachineSnaps' } as const, [])
const sizeAtom = atom({ plugin: 'carapace', key: 'timeMachineSize' } as const, null)
const confirmAtom = atom({ plugin: 'carapace', key: 'timeMachineConfirm' } as const, null)
const noteAtom = atom({ plugin: 'carapace', key: 'timeMachineNote' } as const, '')

const KEY = 'timeMachine:'
const GIT_TIMEOUT = 20_000
const IDENT = { GIT_AUTHOR_NAME: 'carapace', GIT_AUTHOR_EMAIL: 'carapace@localhost', GIT_COMMITTER_NAME: 'carapace', GIT_COMMITTER_EMAIL: 'carapace@localhost' }

// The prompt the next snapshots belong to, and the queue that keeps snapshots one at a time.
let prompt = { at: 0, text: '' }
let queue: Promise<unknown> = Promise.resolve()

/** Called by Work Report when a typed request starts; later snapshots are grouped under it. */
export function noteTimeMachinePrompt(at: number, text: string): void {
  prompt = { at, text: text.trim().replace(/\s+/g, ' ').slice(0, 60) }
}

async function git($: Engine, store: string, root: string, args: string[], extra: { stdin?: string; env?: Record<string, string> } = {}) {
  return $.process.run(['git', `--git-dir=${store}`, `--work-tree=${root}`, ...args], { cwd: root, timeoutMs: GIT_TIMEOUT, env: extra.env, stdin: extra.stdin })
}

async function home($: Engine): Promise<string> {
  return (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
}

async function loadSnaps($: Engine, store: string): Promise<TimeSnap[]> {
  const saved = (await $.store.get(KEY + store)) as TimeSnap[] | undefined

  return Array.isArray(saved) ? saved : []
}

async function measure($: Engine, store: string): Promise<number | null> {
  const du = await $.process.run(['du', '-sk', store], { timeoutMs: 5000 }).catch(() => null)
  const kib = du && du.exitCode === 0 ? Number(du.stdout.split(/\s+/)[0]) : NaN

  return Number.isFinite(kib) ? kib : null
}

/** Opens the current project's records into state. Quiet when this is not a git project. */
export async function loadTimeMachine($: Engine): Promise<void> {
  // No session root (a bare engine): there is nothing to show.
  const root = await $.session.root().catch(() => null)
  if (root === null) return
  const store = storeDir(await home($), root)
  const snaps = await loadSnaps($, store)
  const size = snaps.length > 0 ? await measure($, store) : null
  await update($, snapsAtom, () => snaps)
  await update($, sizeAtom, () => size)
}

/**
 * One snapshot, or nothing when the tree has not changed or the project is not a git repo. For a check on unchanged
 * files: 'flaky' when it contradicts the last result of the same command, 'same' when it repeats it.
 */
async function snapshot($: Engine, tool: string, label: string, check: 'pass' | 'fail' | undefined, command: string): Promise<CheckOutcome> {
  const root = await $.session.root()
  const store = storeDir(await home($), root)
  const inRepo = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 5000 })
  if (inRepo.exitCode !== 0) return 'new'
  if ((await $.process.run(['test', '-d', store], { timeoutMs: 5000 })).exitCode !== 0) {
    // A bare store made by path: git creates the missing ~/.claude/carapace/snapshots folders only this way.
    const init = await $.process.run(['git', 'init', '-q', '--bare', store], { timeoutMs: GIT_TIMEOUT })
    if (init.exitCode !== 0) {
      $.ui.log(`time machine: could not create the snapshot store: ${(init.stderr || init.stdout).trim().split('\n')[0] ?? ''}`, { to: 'debug' })
      return 'new'
    }
  }
  const snaps = await loadSnaps($, store)
  const last = snaps[snaps.length - 1]
  if ((await git($, store, root, ['add', '-A'])).exitCode !== 0) return 'new'
  const tree = (await git($, store, root, ['write-tree'])).stdout.trim()
  const lastTree = last ? (await git($, store, root, ['rev-parse', `${last.sha}^{tree}`])).stdout.trim() : ''
  let next = snaps
  let outcome: CheckOutcome = 'new'
  const now = await $.clock.now()
  if (tree !== '' && tree !== lastTree) {
    const made = await git($, store, root, ['commit-tree', tree, '-m', label], { env: IDENT })
    const sha = made.stdout.trim()
    if (made.exitCode !== 0 || sha === '') return 'new'
    await git($, store, root, ['update-ref', `refs/snap/${sha}`, sha])
    next = [...snaps, { sha, at: now, tool, label, prompt: prompt.at, promptText: prompt.text, ...(check ? { check, checkCommand: command } : {}) }]
  } else if (check && last) {
    // A check that changed nothing speaks for the snapshot it ran against.
    const isSame = (last.checkCommand ?? last.label) === command && last.check !== undefined
    outcome = !isSame ? 'new' : last.check === check ? 'same' : 'flaky'
    next = [...snaps.slice(0, -1), { ...last, check, checkCommand: command, ...(outcome === 'flaky' ? { flaky: true } : {}) }]
  } else return 'new'

  const drop = pruneDrop(next, now)
  if (drop.length > 0) {
    for (const s of drop) await git($, store, root, ['update-ref', '-d', `refs/snap/${s.sha}`])
    await git($, store, root, ['gc', '--prune=now', '-q'])
    const gone = new Set(drop.map(s => s.sha))
    next = next.filter(s => !gone.has(s.sha))
  }
  await $.store.set(KEY + store, next)
  await update($, snapsAtom, () => next)
  const size = await measure($, store)
  await update($, sizeAtom, () => size)

  return outcome
}

async function restore($: Engine, snap: TimeSnap): Promise<void> {
  const root = await $.session.root()
  const store = storeDir(await home($), root)
  // ponytail: files created after the snapshot stay; a delete pass if that ever matters.
  const done = await git($, store, root, ['checkout', '-f', snap.sha, '--', '.'])
  await update($, noteAtom, () => (done.exitCode === 0 ? `Restored the files to: ${snap.label}.` : 'The restore failed. Nothing was changed in your project history.'))
}

/** Store key: true when the person turned snapshots off with /report snapshots off. */
export const SNAPSHOTS_OFF_KEY = 'timeMachineOff'

export function registerTimeMachine(on: On): void {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || (await $.store.get(SNAPSHOTS_OFF_KEY)) === true) return result
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown; command?: unknown }
    const command = typeof input.command === 'string' ? input.command : ''
    const check = e.tool === 'Bash' && isCheckCommand(command) ? (result.deny !== undefined || result.isError ? 'fail' : 'pass') : undefined
    const label = labelOf(e.tool, input)
    // One at a time. An edit's snapshot is fire and forget; a check waits for its own, so Claude hears what it means.
    const task = queue.then(() => snapshot($, e.tool, label, check, command))
    queue = task.catch(() => undefined)
    if (check === undefined || result.deny !== undefined) return result
    const outcome = await task.catch(() => null)
    // The same result on the same files was already explained.
    if (outcome === null || outcome === 'same') return result
    const note = checkNote(await read($, snapsAtom), command, check, outcome === 'flaky')

    return note === null ? result : { ...result, context: [...(result.context ?? []), note] }
  })
}

/** The Timeline section for Today's tab. */
export async function timelineView($: Engine, els: Els, pal: Palette, cols: number, now: number): Promise<RenderElement> {
  const { Box, Text } = els
  const snaps = await read($, snapsAtom)
  const size = await read($, sizeAtom)
  const confirm = await read($, confirmAtom)
  const note = await read($, noteAtom)
  const dayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime()
  const groups = groupByPrompt(snaps, dayStart)
  const fixes = fixedBy(snaps)
  const broke = brokeBy(snaps)
  const byId = new Map(snaps.map(s => [s.sha, s]))
  const time = (at: number) => new Date(at).toTimeString().slice(0, 5)
  const sizeLine = `${snaps.length} of ${MAX_SNAPS} snapshots, 7 days${size === null ? '' : ', ' + sizeText(size)}`

  return (
    <Box flexDirection="column">
      {heading(els, pal, 'Timeline', cols)}
      {groups.length === 0 ? <Text color={pal.muted}>{fit('Snapshots work in git projects. One is taken after each edit.', cols)}</Text> : null}
      <Text color={pal.muted}>{fit('Copies live in ~/.claude/carapace/snapshots, apart from your project.', cols)}</Text>
      <Text color={pal.muted}>{fit('/report snapshots off stops them.', cols)}</Text>
      {groups.map(g => (
        <Box key={`tm-g-${g.prompt}`} flexDirection="column">
          <Text color={pal.text} bold>{fit(g.text === '' ? 'Earlier prompt' : g.text, cols)}</Text>
          {g.snaps.map(s => {
            const from = fixes[s.sha] ? byId.get(fixes[s.sha] as string) : undefined
            const mark = s.check === 'pass' ? '✓ ' : s.check === 'fail' ? '✗ ' : '  '

            return (
              <Box key={`tm-s-${s.sha}`} flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Text color={s.check === 'fail' ? pal.bad : s.check === 'pass' ? pal.good : pal.muted}>{`${time(s.at)} ${mark}${fit(s.label, Math.max(8, cols - 22))}`}</Text>
                  {chip(els, pal, `tm-restore-${s.sha}`, 'Restore', 'quiet', () => void update($, confirmAtom, () => s.sha))}
                </Box>
                {from ? <Text color={pal.good}>{fit(`  fixed by this: "${from.label}" failed before`, cols)}</Text> : null}
                {broke[s.sha] ? (
                  <Box flexDirection="row" columnGap={1}>
                    <Text color={pal.bad}>{fit(`  broke here: passed at ${time(broke[s.sha]?.good.at ?? 0)}, first change after: "${broke[s.sha]?.first.label ?? ''}"`, Math.max(8, cols - 22))}</Text>
                    {chip(els, pal, `tm-good-${s.sha}`, `Restore ${time(broke[s.sha]?.good.at ?? 0)}`, 'quiet', () => void update($, confirmAtom, () => broke[s.sha]?.good.sha ?? null))}
                  </Box>
                ) : null}
                {s.flaky ? <Text color={pal.warn}>{fit('  flaky: the same files gave both results', cols)}</Text> : null}
                {confirm === s.sha ? (
                  <Box flexDirection="row" columnGap={1}>
                    <Text color={pal.accent}>{fit('  Replace your files with this snapshot?', cols - 22)}</Text>
                    {chip(els, pal, `tm-yes-${s.sha}`, 'Yes, restore', 'primary', () => void (async () => { await update($, confirmAtom, () => null); await restore($, s) })())}
                    {chip(els, pal, `tm-no-${s.sha}`, 'Cancel', 'quiet', () => void update($, confirmAtom, () => null))}
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      ))}
      {note !== '' ? <Text color={pal.good}>{fit(note, cols)}</Text> : null}
      <Text color={pal.muted}>{fit(sizeLine, cols)}</Text>
      <Text color={pal.muted}>{fit('Restore changes files only. To rewind the conversation, use /rewind.', cols)}</Text>
    </Box>
  )
}
