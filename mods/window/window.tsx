import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { bandFor, isOwnedProfile, profileFor } from './window-logic'

import { COUNT_KEY, HINT_KEY, appendLine, errorLine, hintText, logPath, queueLog } from '../shared/errlog'

type Engine = EngineInterface

const errorsAtom = atom({ plugin: 'carapace', key: 'reportErrors' } as const, 0)

/**
 * Records one failure in ~/.claude/carapace/log.txt (time, mod, what failed, the error's first line, never any content),
 * counts it for the bar's report button and shows the one-time hint. Fire and forget: it never throws or holds a hook.
 * The same helper sits in every mod, because `$` cannot cross an import.
 */
function logError($: Engine, what: string, err: unknown): void {
  void queueLog(async () => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const version = await $.session.version().then(v => v.version, () => '')
    const line = errorLine(await $.clock.now(), 'window', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('window'), { timeoutMs: 8000 })
    }
  })
}

const contextAtom = atom({ plugin: 'carapace', key: 'cleanViewContext' } as const, 0)

// Finds the tty of the Claude Code process: the first ancestor of this hook's shell that has a terminal.
const TTY_SCRIPT = [
  'pid=$PPID; i=0',
  'while [ "$i" -lt 8 ] && [ "$pid" -gt 1 ] 2>/dev/null; do',
  '  t=$(ps -o tty= -p "$pid" | tr -d " ")',
  '  case "$t" in ""|"??"|"?") ;; *) echo "$t"; exit 0 ;; esac',
  '  pid=$(ps -o ppid= -p "$pid" | tr -d " "); i=$((i+1))',
  'done',
].join('\n')

// Sets the tab on this tty to the profile, only when that tab wears one of carapace's profiles.
const PAINT_SCRIPT = [
  'on run argv',
  '  set target to item 1 of argv',
  '  set theTTY to item 2 of argv',
  '  set owned to {"Deep Sea", "Deep Sea · Deep", "Deep Sea · Crush"}',
  '  tell application "Terminal"',
  '    repeat with w in windows',
  '      repeat with t in tabs of w',
  '        if (tty of t) is theTTY then',
  '          set currentName to name of current settings of t',
  '          if owned contains currentName and currentName is not target then',
  '            set current settings of t to (first settings set whose name is target)',
  '            return "set " & target',
  '          end if',
  '          return "kept " & currentName',
  '        end if',
  '      end repeat',
  '    end repeat',
  '  end tell',
  '  return "no tab"',
  'end run',
].join('\n')

async function paintTab($: Engine, profile: string): Promise<void> {
  const { stdout } = await $.process.run(['sh', '-c', TTY_SCRIPT], { cwd: '/', timeoutMs: 5000 })
  const tty = stdout.trim()
  if (!/^ttys\d+$/.test(tty)) return
  await $.process.run(['osascript', '-e', PAINT_SCRIPT, profile, `/dev/${tty}`], { cwd: '/', timeoutMs: 10000 })
}

// The profile the last sync chose. A module variable: a reload repaints once, which is harmless.
let lastProfile: string | null = null

/** Picks the profile for the current band, and paints the tab only when that choice changed. */
async function sync($: Engine): Promise<void> {
  if ((await $.env.get('TERM_PROGRAM')) !== 'Apple_Terminal') return
  if ((await $.env.get('HOME'))?.startsWith('/Users/') !== true) return
  const profile = profileFor(bandFor(await read($, contextAtom)))
  if (profile === lastProfile || !isOwnedProfile(profile)) return
  lastProfile = profile
  await paintTab($, profile)
}

export function registerWindow(on: On): void {
  // Terminal.app only. Each event runs the same sync; it acts only when the chosen profile changes.
  on('session.start', { surface: ['terminal'] }, async ($, e, next) => {
    try {
      await sync($)
    } catch (err) {
      logError($, 'tab look at start', err)
      // The window's look is optional: a failed check never stops the session.
    }

    return next(e)
  })

  on('turn.start', { turnId: /[\s\S]+/ }, async ($, e, next) => {
    try {
      await sync($)
    } catch (err) {
      logError($, 'tab look', err)
      // Optional, as above.
    }

    return next(e)
  })

  // The context moves when a turn ends, so the band is checked here.
  on('turn.complete', { turnId: /[\s\S]/ }, async ($, e, next) => {
    try {
      await sync($)
    } catch (err) {
      logError($, 'tab look', err)
      // Optional, as above.
    }

    return next(e)
  })
}
