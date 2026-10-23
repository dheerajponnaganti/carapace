import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { ReportDetails } from '../../types'

import { newFlow } from '../prompt-upgrade/prompt-upgrade'
import { GLYPH, PALETTES, cells, fit, spaced, WORDS } from '../shared/look'
import type { Palette } from '../shared/look'
import { chip, heading, paneTitle, titleLit } from '../shared/ui'
import { deckHealth } from './health'
import { ADDONS, OFFICIAL_ADDONS, PONYTAIL_UPDATED, PONYTAIL_YOURS, addonExtra, addonKind, addonStatus, manifestVersion, pluginVersion, ponytailUpdate, reachMeaning, reachTags } from './addons'
import type { AddonId } from './addons'
import { NO_REA, RESTART_ADDED, RESTART_UPDATED, parseVersion, reaKind, reaStatus, reaUpdate, updateBadge } from './rea-logic'
import { commandFile, commandName, groupRepeats, parseHistory } from './repeats'
import { DEFAULT_PINS, LOGBOOK_PIN_KEY, PINS_KEY, REPORT_PIN_KEY, drawsSomething, fitPins, pinText, readPins, setPin, toolId, withLogbook, withReport } from './tools'
import { HELPERS, HELPER_MODEL, PAY, PERIODS, SETUP_ANSWERS_KEY, SETUP_DONE_KEY, SETUP_LATER_KEY, SETUP_PANE, SETUP_SAVED, WORK, helpersOf, parseAmount, pinsFor, withSaved } from './setup'
import type { SetupDraft } from './setup'
import { DEFAULT_SETTINGS } from '../work-report/report-logic'
import { ACCOUNT_KIND_KEY } from '../shared/budget-logic'
import { LOGBOOK_PANE, NO_LOGBOOK } from '../logbook/logbook'
import { GLYPHS_KEY } from '../glyphs/glyphs'
import { wantsSafe } from '../shared/safe-glyphs'
import { isDue, parseCount, changes, updateNotice, updatedText } from './update-logic'

import { COUNT_KEY, HINT_KEY, SHOWN_LINES, appendLine, count, errorLine, hintText, issueUrl, logPath, openArgv, osName, queueLog, reportMarkdown, reportPath, tail } from '../shared/errlog'

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
    const line = errorLine(await $.clock.now(), 'deck', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('deck'), { timeoutMs: 8000 })
    }
  })
}

const PANE = 'carapace-deck'
const REPORT_PANE = 'carapace-report'
const updateAtom = atom({ plugin: 'carapace', key: 'deckUpdate' } as const, null)
const reaAtom = atom({ plugin: 'carapace', key: 'deckRea' } as const, NO_REA)
const ponytailAtom = atom({ plugin: 'carapace', key: 'deckPonytail' } as const, NO_REA)
const gstackAtom = atom({ plugin: 'carapace', key: 'deckGstack' } as const, NO_REA)
const hookifyAtom = atom({ plugin: 'carapace', key: 'deckHookify' } as const, NO_REA)
const securityAtom = atom({ plugin: 'carapace', key: 'deckSecurityGuidance' } as const, NO_REA)
const repeatsAtom = atom({ plugin: 'carapace', key: 'deckRepeats' } as const, [])
const repeatsPendingAtom = atom({ plugin: 'carapace', key: 'deckRepeatsPending' } as const, null)
const updateArmedAtom = atom({ plugin: 'carapace', key: 'deckUpdateArmed' } as const, null)
const setupMetaAtom = atom({ plugin: 'carapace', key: 'deckSetupMeta' } as const, { detected: null, bad: [] })
const PONYTAIL_MANIFEST = 'https://raw.githubusercontent.com/DietrichGebert/ponytail/main/.claude-plugin/plugin.json'
const UPDATE_CHECKED_KEY = 'carapaceUpdateCheckedAt'
const pinsAtom = atom({ plugin: 'carapace', key: 'deckPins' } as const, [...DEFAULT_PINS])
// Other mods' state, read only, so each row can say how its mod is doing.
const badgeAtom = atom({ plugin: 'carapace', key: 'sessionBadge' } as const, null)
const sizeAtom = atom({ plugin: 'carapace', key: 'agentDockSize' } as const, 1)
const missionAtom = atom({ plugin: 'carapace', key: 'agentDockMission' } as const, null)
const daysAtom = atom({ plugin: 'carapace', key: 'workReportDays' } as const, {})
const autoAtom = atom({ plugin: 'carapace', key: 'promptUpgradeAuto' } as const, false)
const cleanAtom = atom({ plugin: 'carapace', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'carapace', key: 'checklist' } as const, null)
// Written by the launcher when it opens a pane, the same way each mod's own command does.
const dockFoldedAtom = atom({ plugin: 'carapace', key: 'agentDockFolded' } as const, false)
const dockOpenAtom = atom({ plugin: 'carapace', key: 'agentDockIsOpen' } as const, false)
const flowAtom = atom({ plugin: 'carapace', key: 'promptUpgradeFlow' } as const, null)
const reportTextAtom = atom({ plugin: 'carapace', key: 'reportText' } as const, '')
const reportNoteAtom = atom({ plugin: 'carapace', key: 'reportNote' } as const, '')
const reportShowAtom = atom({ plugin: 'carapace', key: 'reportShowLog' } as const, false)
const reportDetailsAtom = atom({ plugin: 'carapace', key: 'reportDetails' } as const, null)
const bubblesAtom = atom({ plugin: 'carapace', key: 'cleanViewBubbles' } as const, true)
const othersAtom = atom({ plugin: 'carapace', key: 'deckOthersShown' } as const, false)
const OTHERS_KEY = 'deckOthersShown'
// Other plugins' rows above the prompt stay hidden unless the person turns them on (/mods more on).
const othersOnAtom = atom({ plugin: 'carapace', key: 'deckOthersOn' } as const, false)
const OTHERS_ON_KEY = 'deckOthersOn'
const glyphsAtom = atom({ plugin: 'carapace', key: 'glyphsSafe' } as const, false)
const logbookAtom = atom({ plugin: 'carapace', key: 'logbookStatus' } as const, NO_LOGBOOK)
const setupDraftAtom = atom({ plugin: 'carapace', key: 'deckSetupDraft' } as const, null)
const setupDoneAtom = atom({ plugin: 'carapace', key: 'deckSetupDone' } as const, false)
// The settings setup writes, each in the form its own mod reads and stores it.
const reportSettingsAtom = atom({ plugin: 'carapace', key: 'workReportSettings' } as const, DEFAULT_SETTINGS)
const budgetAtom = atom({ plugin: 'carapace', key: 'budgetConfig' } as const, null)
const helperModelAtom = atom({ plugin: 'carapace', key: 'agentDockHelperModel' } as const, 'auto')

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// The launcher. Claude Code never runs a plugin's own hooks for a command the plugin itself runs,
// so the bar and the deck open each mod's pane here instead of calling /dock, /report or /refine.
// A pane counts as asked for (placed at any width) only when $.ui.open is the press's first call.

/** Opens the Crew pane, or folds it when it is open: what /crew does. `isOpen` is read when the button draws. */
/** Why a pane did not draw, with the numbers when the engine gave them ("the floor it fell under and the width now"). */
function narrowText(name: string, reason: string, floor: number): string {
  const [need, now] = reason.match(/\d+/g) ?? []

  return need && now ? `${name} needs a window at least ${need} columns wide; this one is ${now}.` : `${name} needs a wider window. Widen it to at least ${floor} columns.`
}

async function toggleDock($: Engine, isOpen: boolean, title: string): Promise<void> {
  if (isOpen) {
    await $.ui.close({ id: 'agent-dock' })
    await update($, dockFoldedAtom, () => true)
    await update($, dockOpenAtom, () => false)
    return
  }
  const opened = await $.ui.open({ id: 'agent-dock', title, columns: 78 })
  await update($, dockFoldedAtom, () => false)
  await update($, dockOpenAtom, () => opened.isPlaced)
  if (!opened.isPlaced) $.ui.toast(narrowText(title, opened.reason, 110))
}

/** Opens the Work Report: what /report does. */
async function openReport($: Engine): Promise<void> {
  const opened = await $.ui.open({ id: 'work-report', title: 'Work Report' })
  if (!opened.isPlaced) $.ui.toast(narrowText('Work Report', opened.reason, 110))
}

/** Shows or folds what other mods draw above the prompt; remembered across sessions. */
async function toggleOthers($: Engine): Promise<void> {
  const next = !(await read($, othersAtom))
  await update($, othersAtom, () => next)
  await $.store.set(OTHERS_KEY, next)
}

/** Opens Logbook: its setup before a vault is chosen, its status after. What /logbook does. */
async function openLogbook($: Engine, title: string): Promise<void> {
  const opened = await $.ui.open({ id: LOGBOOK_PANE, title, focus: true, closeOnEscape: true })
  if (!opened.isPlaced) $.ui.toast(narrowText(title, opened.reason, 110))
}

/** Opens Refine on an empty prompt box: what /refine does. A typed prompt is never Refine's unless automatic mode is on. */
async function openRefine($: Engine): Promise<void> {
  const opening = $.ui.open({ id: 'prompt-upgrade', title: 'Refine', focus: true, closeOnEscape: true })
  const typed = (await $.prompt.read()).text.trim()
  // On Windows the bar can keep the keyboard after a pane closes, so the Enter meant for a typed prompt presses this
  // button. With automatic mode off a typed prompt goes to Claude as typed; /refine <prompt> refines one on purpose.
  if (typed !== '' && !(await read($, autoAtom))) {
    await opening
    await $.ui.close({ id: 'prompt-upgrade' })
    if (typed.startsWith('/')) {
      $.ui.toast('Your command is still in the prompt box. Click the box, then press Enter.', { timeoutMs: 5000 })

      return
    }
    await $.prompt.fill({ text: '' })
    await $.prompt.submit({ text: typed, asUser: true })
    $.ui.log('Refine button pressed with a typed prompt while automatic mode is off: the prompt was sent as typed.')

    return
  }
  // A refine already under way (a prompt automatic mode took) is shown, never replaced: its words would be lost.
  const isNew = (await read($, flowAtom)) === null
  if (isNew) await update($, flowAtom, () => newFlow(typed, 'compose'))
  const opened = await opening
  if (opened.isPlaced) return
  if (isNew) await update($, flowAtom, () => null)
  $.ui.toast(narrowText('Refine', opened.reason, 110))
}

/** The report details: versions, setup and the last log lines. Nothing from the conversation. */
async function readDetails($: Engine): Promise<ReportDetails> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const commit = await $.process.run(['git', '-C', $.plugin.root, 'rev-parse', '--short', 'HEAD'], { cwd: $.plugin.root, timeoutMs: 5000 }).then(r => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '')
  const claude = await $.session.version().then(v => v.version, () => 'unknown')
  const log = home === '' ? '' : await $.fs.read(logPath(home)).then(String, () => '')
  const mods = ['Crew', 'Work Report', 'Refine', 'Footer', (await read($, cleanAtom)) ? 'Clean View' : null].filter(Boolean).join(', ')

  return { carapace: commit || 'unknown', claude, os: osName(home), terminal: (await $.env.get('TERM_PROGRAM')) ?? 'unknown', mods, lines: tail(log, SHOWN_LINES) }
}

/** Opens the report panel: what /mods problem does. The pane opens first, then the details load. */
async function openReportPanel($: Engine): Promise<void> {
  const opening = $.ui.open({ id: REPORT_PANE, title: 'Report a problem', focus: true, closeOnEscape: true })
  await update($, reportTextAtom, () => '')
  await update($, reportNoteAtom, () => '')
  await update($, reportShowAtom, () => false)
  await update($, reportDetailsAtom, () => null)
  await opening
  const details = await readDetails($)
  await update($, reportDetailsAtom, () => details)
}

/** Back to no errors: the bar's report button goes until the next one. */
async function clearErrors($: Engine): Promise<void> {
  await update($, errorsAtom, () => 0)
  await $.store.set(COUNT_KEY, 0)
}

/** Open on GitHub (isSave false) or Save to file: builds the same report, then clears the error count. */
async function sendReport($: Engine, isSave: boolean): Promise<void> {
  const details = await read($, reportDetailsAtom)
  if (details === null) return
  const info = { ...details, description: await read($, reportTextAtom) }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  try {
    if (isSave) {
      const path = reportPath(home, await $.clock.now())
      await $.fs.write(path, reportMarkdown(info))
      await update($, reportNoteAtom, () => `Saved to ${path}`)
    } else {
      const run = await $.process.run(openArgv(details.os, issueUrl(info)), { cwd: $.plugin.root, timeoutMs: 5000 })
      if (run.exitCode !== 0) throw new Error(`browser exit ${run.exitCode}`)
      await update($, reportNoteAtom, () => 'Opened in your browser. Press Submit there.')
    }
    await clearErrors($)
  } catch (err) {
    logError($, isSave ? 'save the report' : 'open the browser', err)
    await update($, reportNoteAtom, () => (isSave ? 'Could not save the report.' : 'Could not open the browser. Use Save to file.'))
  }
}

/** Turns Clean View on or off: what /clean does. */
async function toggleClean($: Engine): Promise<void> {
  const isOn = !(await read($, cleanAtom))
  await update($, cleanAtom, () => isOn)
  await $.store.set('cleanViewEnabled', isOn)
  $.ui.toast(isOn ? 'Clean View on: a checklist replaces tool calls.' : 'Clean View off: every tool call shows.', { timeoutMs: 2500 })
}

/** Turns the bar's bubbles on or off: what /clean bubbles does. */
async function toggleBubbles($: Engine): Promise<void> {
  const isOn = !(await read($, bubblesAtom))
  await update($, bubblesAtom, () => isOn)
  await $.store.set('cleanViewBubbles', isOn)
  const name = WORDS.bubbles
  $.ui.toast(isOn ? `${name} on` : `${name} off: the bar stays still`, { timeoutMs: 2500 })
}

/** Reads the installer's state file (who put REA there) and `rea --version`. Quiet when REA is absent. */
async function loadRea($: Engine): Promise<void> {
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '') + '/.claude'
  const recorded = reaKind(await $.fs.read(`${home}/carapace-install.json`).then(String, () => ''))
  const run = recorded === 'yours' ? null : await $.process.run(['rea', '--version'], { cwd: $.plugin.root, timeoutMs: 5000 }).catch(() => null)
  const version = run && run.exitCode === 0 ? parseVersion(run.stdout) : ''
  // Installed by the person, never through carapace: not in the state file, but there.
  const kind = recorded === 'none' && version !== '' ? 'yours' : recorded
  await update($, reaAtom, prev => ({ kind, version, latest: kind === 'ours' ? prev.latest : '' }))
}

/** Asks npm for REA's latest version. Offline or missing npm means no news. Only for REA that carapace added. */
async function checkRea($: Engine): Promise<void> {
  await loadRea($)
  if ((await read($, reaAtom)).kind !== 'ours') return
  const run = await $.process.run(['npm', 'view', 'rea-agents', 'version'], { cwd: $.plugin.root, timeoutMs: 20000 }).catch(() => null)
  const latest = run && run.exitCode === 0 ? parseVersion(run.stdout) : ''
  await update($, reaAtom, prev => ({ ...prev, latest }))
}

/** Reads the installer's state file, `claude plugin list --json` (ponytail) and gstack's VERSION file. Quiet when an add-on is absent. */
async function loadAddons($: Engine): Promise<void> {
  await loadRea($)
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '') + '/.claude'
  const stateText = await $.fs.read(`${home}/carapace-install.json`).then(String, () => '')
  const listed = await $.process.run(['claude', 'plugin', 'list', '--json'], { cwd: $.plugin.root, timeoutMs: 15000 }).catch(() => null)
  const pony = listed && listed.exitCode === 0 ? pluginVersion(listed.stdout, 'ponytail') : null
  const ponyKind = addonKind(stateText, 'ponytail')
  // Installed by the person after carapace ran: not in the state file, but there.
  const kind = ponyKind === 'none' && pony !== null ? 'yours' : ponyKind
  await update($, ponytailAtom, prev => ({ kind, version: pony ?? '', latest: kind === 'none' ? '' : prev.latest }))
  for (const id of OFFICIAL_ADDONS) {
    const found = listed && listed.exitCode === 0 ? pluginVersion(listed.stdout, id) : null
    const recorded = addonKind(stateText, id)
    const officialKind = recorded === 'none' && found !== null ? 'yours' : recorded
    const next = { kind: officialKind, version: found ?? '', latest: '' }
    if (id === 'hookify') await update($, hookifyAtom, () => next)
    else await update($, securityAtom, () => next)
  }
  const gRecorded = addonKind(stateText, 'gstack')
  const gVersion = parseVersion(await $.fs.read(`${home}/skills/gstack/VERSION`).then(String, () => ''))
  const gKind = gRecorded === 'none' && gVersion !== '' ? 'yours' : gRecorded
  await update($, gstackAtom, () => ({ kind: gKind, version: gVersion, latest: '' }))
}

/** Fetches ponytail's latest version from its repo. Offline means no news. */
async function checkPonytail($: Engine): Promise<void> {
  await loadAddons($)
  if ((await read($, ponytailAtom)).kind === 'none') return
  const res = await $.http.fetch(PONYTAIL_MANIFEST).catch(() => null)
  await update($, ponytailAtom, prev => ({ ...prev, latest: res?.ok ? manifestVersion(res.text) : '' }))
}

type Flag = 'with' | 'remove' | 'manage'

/** Runs the carapace installer for one add-on: --with, --remove or --manage. Slow: downloads and setup. */
async function runInstaller($: Engine, flag: Flag, id: AddonId) {
  const isWindows = /^[A-Za-z]:[\\/]/.test($.plugin.root)
  const argv = isWindows
    ? ['powershell', '-ExecutionPolicy', 'Bypass', '-File', `${$.plugin.root}\\install.ps1`, `-${flag[0]?.toUpperCase()}${flag.slice(1)}`, id]
    : [`${$.plugin.root}/install.sh`, `--${flag}`, id, '--no-terminal']
  // Run in the session's folder, as add-ons that write there expect.
  const cwd = await $.session.cwd().catch(() => undefined)

  return $.process.run(argv, cwd ? { timeoutMs: 240000, cwd } : { timeoutMs: 240000 }).catch(err => (logError($, `${flag} ${id}`, err), null))
}

const stateOf = async ($: Engine, id: AddonId) => (id === 'rea' ? read($, reaAtom) : id === 'gstack' ? read($, gstackAtom) : id === 'hookify' ? read($, hookifyAtom) : id === 'security-guidance' ? read($, securityAtom) : read($, ponytailAtom))
const labelOf = (id: AddonId) => ADDONS.find(a => a.id === id)?.label ?? id

/** Adds an add-on through the installer, then says what happened. */
async function addAddon($: Engine, id: AddonId): Promise<void> {
  const label = labelOf(id)
  $.ui.toast(`Adding ${label}...`, { timeoutMs: 3000 })
  const run = await runInstaller($, 'with', id)
  await loadAddons($)
  const kind = (await stateOf($, id)).kind
  if (run && run.exitCode === 0 && kind !== 'none') {
    $.ui.toast(kind === 'yours' ? `${label} was here before carapace, so carapace leaves it alone.` : id === 'rea' ? RESTART_ADDED : `${label} added. Restart Claude Code to use it.`, { timeoutMs: 8000 })
    return
  }
  if (run) logError($, `add ${label}`, new Error(`installer exit ${run.exitCode}: ${(run.stderr || run.stdout).trim().split('\n').pop() ?? ''}`))
  const why = run?.stdout.split('\n').find(l => l.startsWith(`${label}: skipped`))
  $.ui.toast(why ?? `${label} was not added. Run install.sh --with ${id} in the carapace folder to see why.`, { timeoutMs: 8000 })
}

/** Removes an add-on carapace owns. */
async function removeAddon($: Engine, id: AddonId): Promise<void> {
  const label = labelOf(id)
  $.ui.toast(`Removing ${label}...`, { timeoutMs: 3000 })
  const run = await runInstaller($, 'remove', id)
  await loadAddons($)
  const done = run !== null && run.exitCode === 0 && (await stateOf($, id)).kind !== 'ours'
  if (!done && run) logError($, `remove ${label}`, new Error(`installer exit ${run.exitCode}`))
  $.ui.toast(done ? `${label} removed.` : `${label} was not removed. Run install.sh --remove ${id} in the carapace folder to see why.`, { timeoutMs: 8000 })
}

/** Hands an add-on that was the person's to carapace, so uninstalling carapace removes it too. */
async function manageAddon($: Engine, id: AddonId): Promise<void> {
  const label = labelOf(id)
  const run = await runInstaller($, 'manage', id)
  await loadAddons($)
  const done = run !== null && run.exitCode === 0 && (await stateOf($, id)).kind === 'ours'
  if (!done && run) logError($, `manage ${label}`, new Error(`installer exit ${run.exitCode}`))
  $.ui.toast(done ? `${label} is now managed by carapace. Uninstalling carapace removes it.` : `${label} could not be handed over. Run install.sh --manage ${id} to see why.`, { timeoutMs: 8000 })
}

/** Pins or unpins a tool, saves the list and answers in one line. */
async function pinTool($: Engine, id: string, isPinned: boolean): Promise<string> {
  const words = WORDS
  if (id === 'rea' && isPinned && (await read($, reaAtom)).kind === 'none') return `REA: add it first (${words.hub}, Add).`
  const result = setPin(await read($, pinsAtom), id, isPinned)
  if (result.outcome === 'pinned' || result.outcome === 'unpinned') {
    await update($, pinsAtom, () => result.pins)
    await $.store.set(PINS_KEY, result.pins)
  }

  return pinText(id, result.outcome, id === 'crew' ? words.crew : id === 'logbook' ? words.memory : undefined)
}

/** Claude Code's config folder. */
async function configHome($: Engine): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '') + '/.claude'
}

/** Reads Claude Code's prompt history (history.jsonl in the config folder), locally, and keeps the three most repeated prompts. */
async function loadRepeats($: Engine): Promise<void> {
  const text = await $.fs.read(`${await configHome($)}/history.jsonl`).then(String, () => '')
  await update($, repeatsAtom, () => groupRepeats(parseHistory(text)))
}

/** The Make /command press: the first one shows the prompt, the second writes ~/.claude/commands/<name>.md. */
async function makeCommand($: Engine, index: number): Promise<void> {
  const group = (await read($, repeatsAtom))[index]
  if (!group) return
  const pending = await read($, repeatsPendingAtom)
  const dir = `${await configHome($)}/commands`
  const taken = (await $.fs.list(dir).catch(() => [])).map(f => f.name.replace(/\.md$/, ''))
  const name = commandName(group.text, taken)
  if (pending !== index) {
    await update($, repeatsPendingAtom, () => index)
    $.ui.toast(`/${name} would send: ${group.text.length > 400 ? group.text.slice(0, 400) + '...' : group.text} Press Make /command again to save it as ${dir}/${name}.md.`, { timeoutMs: 15000 })

    return
  }
  await update($, repeatsPendingAtom, () => null)
  await $.fs.write(`${dir}/${name}.md`, commandFile(group.text))
  $.ui.toast(`Saved /${name}. It shows in the slash menu in new sessions.`, { timeoutMs: 8000 })
}

/** Opens the Shipyard. */
function openShipyard($: Engine, title: string): void {
  // The open goes first: after any other $ call the pane counts as unasked and needs 144 columns.
  void $.ui.open({ id: PANE, title, focus: true, closeOnEscape: true })
  void loadRepeats($).catch(err => logError($, 'read prompt history', err))
}

/** Opens setup with the saved answers, or the person's current settings where nothing was saved: what /setup and the bar's Set up do. */
async function openSetup($: Engine, title: string, isAsked = true): Promise<void> {
  const opening = $.ui.open({ id: SETUP_PANE, title, focus: true, closeOnEscape: true })
  if (isAsked) {
    const opened = await opening
    if (!opened.isPlaced) $.ui.toast(narrowText('Setup', opened.reason, 110), { timeoutMs: 8000 })
  } else {
    // Unasked on a narrow window the open never settles, and the waiting pane would keep a later /setup or Set up
    // press from placing it. So it is closed, and the bar's Set up opens it.
    void opening.catch(err => logError($, 'open setup', err))
    const pane = (await $.ui.panes()).find(p => p.id === SETUP_PANE)
    if (!pane?.isPlaced) {
      await $.ui.close({ id: SETUP_PANE })
      $.ui.toast('carapace setup needs a wider window. Press ◎ Set up on the bar to open it.', { timeoutMs: 8000 })
      return
    }
  }
  const budget = await read($, budgetAtom)
  const kind = await $.store.get(ACCOUNT_KIND_KEY)
  const detected: 'sub' | 'api' | null = kind === 'api' ? 'api' : kind === 'subscriber' ? 'sub' : null
  const live: SetupDraft = {
    rate: (await read($, reportSettingsAtom)).rate,
    work: ['coding'],
    pay: budget ? 'budget' : detected ?? 'sub',
    budget: budget && budget.unit === 'usd' && budget.period !== 'session' ? { amount: budget.amount, period: budget.period } : { amount: 20, period: 'day' },
    helpers: helpersOf(await read($, helperModelAtom)),
    view: (await read($, cleanAtom)) ? 'checklist' : 'steps',
    memory: true,
  }
  const draft = withSaved(live, await $.store.get(SETUP_ANSWERS_KEY))
  await update($, setupMetaAtom, () => ({ detected, bad: [], start: draft }))
  await update($, setupDraftAtom, () => draft)
}

/** Saves every answer where its mod reads it, then opens Logbook's own setup when memory is wanted and not set up. */
async function saveSetup($: Engine, d: SetupDraft, memoryTitle: string, needsVault: boolean): Promise<void> {
  // Opened first, so the Logbook pane counts as asked for.
  if (d.memory && needsVault) void openLogbook($, memoryTitle)
  const before = (await $.store.get(SETUP_ANSWERS_KEY)) as Partial<SetupDraft> | undefined
  // The view is written only when changed in the pane: a /clean while it was open stays.
  const start = (await read($, setupMetaAtom)).start ?? null
  const isChanged = (key: 'view') => start === null || start[key] !== d[key]
  const settings = { ...(await read($, reportSettingsAtom)), rate: d.rate }
  await update($, reportSettingsAtom, () => settings)
  await $.store.set('workReport:settings', settings)
  // Pins change only when the work or memory answer did, so pins added by hand since survive a re-run.
  if (!before || before.memory !== d.memory || JSON.stringify(before.work) !== JSON.stringify(d.work)) {
    const pins = pinsFor(d.work, d.memory)
    await update($, pinsAtom, () => pins)
    await $.store.set(PINS_KEY, pins)
  }
  await $.store.set(ACCOUNT_KIND_KEY, d.pay === 'sub' ? 'subscriber' : 'api')
  const budget = d.pay === 'budget' ? { unit: 'usd' as const, amount: d.budget.amount, period: d.budget.period } : null
  await update($, budgetAtom, () => budget)
  await $.store.set('budgetConfig', budget)
  await update($, helperModelAtom, () => HELPER_MODEL[d.helpers])
  await $.store.set('agentDockHelperModel', HELPER_MODEL[d.helpers])
  if (isChanged('view')) {
    await update($, cleanAtom, () => d.view === 'checklist')
    await $.store.set('cleanViewEnabled', d.view === 'checklist')
  }
  await $.store.set(SETUP_ANSWERS_KEY, d)
  await update($, setupDoneAtom, () => true)
  await $.store.set(SETUP_DONE_KEY, true)
  await closeSetup($)
  $.ui.toast(SETUP_SAVED, { timeoutMs: 8000 })
}

/** Later: nothing is saved or marked done. Setup stops opening by itself, and the bar keeps asking. */
async function putOffSetup($: Engine): Promise<void> {
  await $.store.set(SETUP_LATER_KEY, true)
  await closeSetup($)
  $.ui.toast('Setup put off. Press ◎ Set up on the bar or run /setup when you are ready.', { timeoutMs: 4000 })
}

async function closeSetup($: Engine): Promise<void> {
  await update($, setupDraftAtom, () => null)
  await $.ui.close({ id: SETUP_PANE })
}

/** An amount box takes what is typed as it is typed; a bad entry keeps the last good value and shows a note. */
async function typeAmount($: Engine, field: 'rate' | 'budget', value: string): Promise<void> {
  const n = parseAmount(value)
  const isBad = n === null && value.trim() !== ''
  await update($, setupMetaAtom, m => ({ ...m, bad: isBad ? [...m.bad.filter(f => f !== field), field] : m.bad.filter(f => f !== field) }))
  if (n !== null) await editSetup($, x => (field === 'rate' ? { ...x, rate: n } : { ...x, budget: { ...x.budget, amount: n } }))
}

/** Changes one answer in the open setup pane. */
async function editSetup($: Engine, change: (d: SetupDraft) => SetupDraft): Promise<void> {
  await update($, setupDraftAtom, d => (d ? change(d) : d))
}

/** The deck closes once a row has opened its mod. */
async function closeDeck($: Engine): Promise<void> {
  await $.ui.close({ id: PANE })
}

/** The clone's top folder, or null when carapace was not installed from git. */
async function repoTop($: Engine): Promise<string | null> {
  const run = await $.process.run(['git', '-C', $.plugin.root, 'rev-parse', '--show-toplevel'], { cwd: $.plugin.root, timeoutMs: 5000 })

  return run.exitCode === 0 ? run.stdout.trim() : null
}

/** Asks GitHub, quietly, whether there are new commits. A failed fetch (offline, no access) changes nothing. */
async function checkForUpdate($: Engine, isForced: boolean): Promise<string> {
  const now = await $.clock.now()
  if (!isForced && !isDue(await $.store.get(UPDATE_CHECKED_KEY), now)) return ''
  await checkRea($).catch(err => logError($, 'REA check', err))
  await checkPonytail($).catch(err => logError($, 'ponytail check', err))
  const top = await repoTop($)
  if (top === null) return 'carapace was not installed from git, so it cannot check for updates.'
  const fetched = await $.process.run(['git', '-C', top, 'fetch', '--quiet'], { cwd: $.plugin.root, timeoutMs: 20000 })
  // Only a check that reached GitHub counts, so an offline start tries again at the next chat.
  if (fetched.exitCode !== 0) return 'Could not reach GitHub to check for updates. Try /mods check later.'
  await $.store.set(UPDATE_CHECKED_KEY, now)
  const counted = await $.process.run(['git', '-C', top, 'rev-list', '--count', 'HEAD..@{u}'], { cwd: $.plugin.root, timeoutMs: 5000 })
  if (counted.exitCode !== 0) return `Cannot check for updates: the branch in ${top} does not follow a GitHub branch.`
  const behind = parseCount(counted.stdout)
  if (behind === 0) {
    await update($, updateAtom, () => null)
    return 'carapace is up to date.'
  }
  const subject = (await $.process.run(['git', '-C', top, 'log', '-1', '--format=%s', '@{u}'], { cwd: $.plugin.root, timeoutMs: 5000 })).stdout.trim()
  const info = { behind, subject, checkedAt: now }
  const before = await read($, updateAtom)
  await update($, updateAtom, () => info)
  if (before?.behind !== behind) $.ui.toast(updateNotice(info), { timeoutMs: 8000 })

  return updateNotice(info)
}

/** Downloads the new commits. Refuses when the clone has local edits, so nothing of yours is lost. */
async function applyCarapaceUpdate($: Engine): Promise<string> {
  const top = await repoTop($)
  if (top === null) return 'carapace was not installed from git, so it cannot update itself.'
  const dirty = await $.process.run(['git', '-C', top, 'status', '--porcelain', '--untracked-files=no'], { cwd: $.plugin.root, timeoutMs: 5000 })
  if (dirty.stdout.trim() !== '') return `Not updated: ${top} has local edits. Commit or stash them, then try /mods update again.`
  const old = (await $.process.run(['git', '-C', top, 'rev-parse', 'HEAD'], { cwd: $.plugin.root, timeoutMs: 5000 })).stdout.trim()
  const pulled = await $.process.run(['git', '-C', top, 'pull', '--ff-only', '--quiet'], { cwd: $.plugin.root, timeoutMs: 60000 })
  if (pulled.exitCode !== 0) return `Not updated: git could not fast-forward (${(pulled.stderr || pulled.stdout).trim().split('\n')[0] || 'unknown reason'}).`
  const now = (await $.process.run(['git', '-C', top, 'rev-parse', 'HEAD'], { cwd: $.plugin.root, timeoutMs: 5000 })).stdout.trim()
  await update($, updateAtom, () => null)
  if (now === old) return 'carapace is already up to date.'
  const count = parseCount((await $.process.run(['git', '-C', top, 'rev-list', '--count', `${old}..${now}`], { cwd: $.plugin.root, timeoutMs: 5000 })).stdout)
  const files = (await $.process.run(['git', '-C', top, 'diff', '--name-only', old, now], { cwd: $.plugin.root, timeoutMs: 5000 })).stdout

  return updatedText(count, files, top)
}

/** What is waiting, in a line: carapace's changes with the latest subject, then REA and ponytail. */
function waitingText(pending: { behind: number; subject: string } | null, rea: Parameters<typeof reaUpdate>[0], ponytail: Parameters<typeof ponytailUpdate>[0]): string {
  return [pending && pending.behind > 0 ? `${changes(pending.behind)}${pending.subject ? `: ${pending.subject}` : ''}` : '', reaUpdate(rea) ? `REA ${reaUpdate(rea)}` : '', ponytailUpdate(ponytail) ? `ponytail ${ponytailUpdate(ponytail)}` : ''].filter(Boolean).join(' · ')
}

/** The Update press: the first shows what is new and arms it, a second within 30 seconds installs. True once it installed. */
async function pressUpdate($: Engine): Promise<boolean> {
  const now = await $.clock.now()
  const armed = await read($, updateArmedAtom)
  if (armed === null || now - armed > 30_000) {
    const waiting = waitingText(await read($, updateAtom), await read($, reaAtom), await read($, ponytailAtom))
    await update($, updateArmedAtom, () => now)
    $.ui.toast(`${waiting}. Press Update again to install.`, { timeoutMs: 30000 })

    return false
  }
  await update($, updateArmedAtom, () => null)
  $.ui.toast(await applyUpdate($).catch(err => (logError($, 'update', err), 'The update did not finish. Try /mods update again.')), { timeoutMs: 8000 })

  return true
}

/** The carapace update (when there is one, or no add-on has one), then `rea update` and `claude plugin update ponytail@ponytail` for what is waiting. */
async function applyUpdate($: Engine): Promise<string> {
  const reaWaiting = reaUpdate(await read($, reaAtom))
  const pony = await read($, ponytailAtom)
  const ponyWaiting = ponytailUpdate(pony)
  const info = await read($, updateAtom)
  const base = !(reaWaiting || ponyWaiting) || (info?.behind ?? 0) > 0 ? await applyCarapaceUpdate($) : ''
  const parts = [base]
  if (reaWaiting) {
    const run = await $.process.run(['rea', 'update'], { cwd: $.plugin.root, timeoutMs: 120000 }).catch(() => null)
    await loadRea($)
    const ok = run !== null && run.exitCode === 0
    if (!ok) logError($, 'rea update', new Error(`exit ${run?.exitCode ?? 'none'}`))
    parts.push(ok ? RESTART_UPDATED : 'REA was not updated. Run rea update in a terminal to see why.')
  }
  if (ponyWaiting && pony.kind === 'yours') {
    parts.push(PONYTAIL_YOURS(ponyWaiting))
  } else if (ponyWaiting) {
    const run = await $.process.run(['claude', 'plugin', 'update', 'ponytail@ponytail'], { cwd: $.plugin.root, timeoutMs: 120000 }).catch(() => null)
    await loadAddons($)
    const ok = run !== null && run.exitCode === 0
    if (!ok) logError($, 'ponytail update', new Error(`exit ${run?.exitCode ?? 'none'}`))
    parts.push(ok ? PONYTAIL_UPDATED : 'ponytail was not updated. Run claude plugin update ponytail@ponytail in a terminal to see why.')
  }

  return parts.filter(Boolean).join(' ')
}

export function registerDeck(on: On): void {
  // The deck only matters where something draws, so its session.start is scoped to a surface.
  on('session.start', { surface: ['terminal', 'desktop', 'vscode', 'mobile'] }, async ($, e, next) => {
    const errorCount = Number((await $.store.get(COUNT_KEY)) ?? 0)
    const storedPins = await $.store.get(PINS_KEY)
    const storedOthers = (await $.store.get(OTHERS_KEY)) === true
    const othersOn = (await $.store.get(OTHERS_ON_KEY)) === true
    const setupDone = (await $.store.get(SETUP_DONE_KEY)) === true
    let pins = readPins(storedPins)
    // Once, when Logbook arrives: pinned if a slot is free, with a hint that says where to find it.
    if ((await $.store.get(LOGBOOK_PIN_KEY)) !== true) {
      await $.store.set(LOGBOOK_PIN_KEY, true)
      pins = withLogbook(pins)
      if (storedPins !== undefined && storedPins !== null) await $.store.set(PINS_KEY, pins)
      const words = WORDS
      $.ui.toast(pins.includes('logbook') ? `New: ${words.memory} keeps your work's memory in Obsidian. Press ${words.memory} to set it up.` : `New: ${words.memory} keeps your work's memory in Obsidian. Find it in ${words.hubGlyph} ${words.hub}.`, { timeoutMs: 8000 })
    }
    // Once, when the bar grew to five: Report comes back if a slot is free.
    if ((await $.store.get(REPORT_PIN_KEY)) !== true) {
      await $.store.set(REPORT_PIN_KEY, true)
      pins = withReport(pins)
      if (storedPins !== undefined && storedPins !== null) await $.store.set(PINS_KEY, pins)
    }
    await update($, errorsAtom, () => errorCount)
    await update($, othersAtom, () => storedOthers)
    await update($, othersOnAtom, () => othersOn)
    await update($, setupDoneAtom, () => setupDone)
    // A new install asks its setup questions in the first session with a person at the prompt.
    if (!setupDone && !(await $.store.get(SETUP_LATER_KEY)) && e.isInteractive) void openSetup($, 'Setup', false).catch(err => logError($, 'open setup', err))
    await update($, pinsAtom, () => pins)
    // In the background, at most every six hours: a slow or failed fetch never holds up the chat.
    void loadAddons($).catch(err => logError($, 'read add-ons', err))
    void loadRepeats($).catch(err => logError($, 'read prompt history', err))
    void checkForUpdate($, false).catch(err => logError($, 'update check', err))

    return next(e)
  })

  // The commands exist in every session, a headless one too: /mods check, update and pin need no screen.
  on('session.start', { cwd: /[\s\S]/ }, async ($, e, next) => {
    await $.command.register({ name: 'mods', description: 'Open the Shipyard, pin tools to the bar, check for and apply carapace updates, or report a problem', argumentHint: '[pin|unpin <tool>|update|check|problem|more on|off|glyphs on|off|auto]' })
    await $.command.register({ name: 'setup', description: 'Set carapace up for you: your hourly rate, the work you do, how you pay, helpers, what you see and memory' })

    return next(e)
  })

  on('command.run', { command: 'mods' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'update') return { text: await applyUpdate($).catch(err => (logError($, 'update', err), 'The update did not finish. Try /mods update again.')) }
    if (arg === 'problem') {
      void openReportPanel($)

      return { text: 'Opening the problem report.' }
    }
    const glyphs = /^glyphs(?:\s+(on|off|auto))?$/.exec(arg)
    if (glyphs) {
      const choice = glyphs[1] ?? 'auto'
      await $.store.set(GLYPHS_KEY, choice)
      const env = { os: await $.env.get('OS'), wt: await $.env.get('WT_SESSION'), term: await $.env.get('TERM_PROGRAM'), ascii: await $.env.get('CARAPACE_ASCII') }
      const isSafe = wantsSafe(choice, env)
      await update($, glyphsAtom, () => isSafe)

      return { text: `Symbols: ${choice}. carapace draws ${isSafe ? 'plain one-cell symbols (- = * o)' : 'its box lines and shapes'}. /mods glyphs on, off or auto.` }
    }
    const more = /^more(?:\s+(on|off))?$/.exec(arg)
    if (more) {
      const isOn = more[1] === undefined ? !(await read($, othersOnAtom)) : more[1] === 'on'
      await update($, othersOnAtom, () => isOn)
      await $.store.set(OTHERS_ON_KEY, isOn)

      return { text: isOn ? 'Other plugins\' rows above the prompt fold behind ⋯ More on the bar. /mods more off hides them.' : 'Other plugins\' rows above the prompt are hidden. /mods more on brings them back behind ⋯ More.' }
    }
    if (arg === 'check') return { text: await checkForUpdate($, true).catch(err => (logError($, 'update check', err), 'Could not check for updates. Try again later.')) }
    const pin = /^(pin|unpin)\s+(.+)$/.exec(arg)
    if (pin) {
      const id = toolId(pin[2] ?? '')
      if (id === null) return { text: 'Tools: clean, crew, logbook, rea, refine, report.' }

      return { text: await pinTool($, id, pin[1] === 'pin') }
    }
    try {
      openShipyard($, WORDS.hub)

      return { text: `Opening the ${WORDS.hub}.` }
    } catch (err) {
      logError($, '/mods', err)
      return { text: 'The Shipyard could not open. Try /mods again.' }
    }
  })

  on('command.run', { command: 'setup' }, async $ => {
    try {
      // Opened inside the command's own dispatch, so it counts as asked for.
      void openSetup($, 'Setup').catch(err => logError($, 'open setup', err))

      return { text: 'Opening setup.' }
    } catch (err) {
      logError($, '/setup', err)
      return { text: 'Setup could not open. Try /setup again.' }
    }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => next({ ...e, props: { ...e.props, word: WORDS.spinner[e.props.mode] ?? e.props.word } }))
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => next({ ...e, props: { ...e.props, word: WORDS.done } }))

  // The bar's buttons. Clean View's bar hook sits above this one and places what it answers inside the bar.
  on('ui.render', { component: 'AbovePrompt', surface: ['terminal', 'desktop'] }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const pal: Palette = PALETTES.deep
    const words = WORDS
    const isOn = await read($, cleanAtom)
    const isDockOpen = await read($, dockOpenAtom)
    const updateInfo = await read($, updateAtom)
    const rea = await read($, reaAtom)
    const ponytail = await read($, ponytailAtom)
    const errorCount = await read($, errorsAtom)
    const sessionBadge = await read($, badgeAtom)
    const isAuto = await read($, autoAtom)
    const working = (await read($, missionAtom))?.cards.filter(c => c.status === 'working').length ?? 0
    const logbook = await read($, logbookAtom)
    const days = await read($, daysAtom)
    const today = days[dayKey(new Date(await $.clock.now()))]
    const tasksToday = today ? Object.values(today.kinds).reduce((s, n) => s + (n ?? 0), 0) : 0

    // One chip per mod, each with its live count. Each matches its slash command and its key in /mods.
    const button = (key: string, glyph: string, glyphColor: string, label: string, badge: string, onPress: () => void) => (
      // The keyed Box is what the pointer hovers: the chip glows with the halo under it.
      <Box key={`${key}-glow`}>
        <Button key={key} plain label={label} onPress={onPress} hover={{ backgroundColor: pal.halo }}>
          <Text backgroundColor={pal.slate} color={glyphColor}>{` ${glyph} `}</Text>
          <Text backgroundColor={pal.slate} color={pal.text}>
            {label}
          </Text>
          <Text backgroundColor={pal.slate} color={pal.accent} bold>
            {badge ? ` ${badge} ` : ' '}
          </Text>
        </Button>
      </Box>
    )

    // Alerts come first and never depend on pins. Pinned tools follow, then the Shipyard button.
    type Spec = { glyph: string; color: string; label: string; badge: string; press: () => void }
    const specs: Record<string, Spec> = {
      crew: { glyph: GLYPH.dock, color: pal.highlight, label: words.crew, badge: working > 0 ? String(working) : '', press: () => void toggleDock($, isDockOpen, words.crew) },
      report: { glyph: GLYPH.report, color: pal.accent, label: 'Report', badge: tasksToday > 0 ? String(tasksToday) : '', press: () => void openReport($) },
      refine: { glyph: GLYPH.upgrade, color: pal.warn, label: 'Refine', badge: isAuto ? 'auto' : '', press: () => void openRefine($) },
      ...(rea.kind === 'none' ? {} : { rea: { glyph: GLYPH.rea, color: pal.accent, label: 'REA', badge: rea.version, press: () => $.ui.toast(reaStatus(rea), { timeoutMs: 4000 }) } }),
      clean: { glyph: isOn ? GLYPH.clean : '○', color: isOn ? pal.good : pal.muted, label: isOn ? 'Clean: on' : 'Clean: off', badge: '', press: () => void toggleClean($) },
      logbook: { glyph: logbook.vault !== null && logbook.isOn ? GLYPH.logbook : '▢', color: logbook.vault !== null && logbook.isOn ? pal.accent : pal.muted, label: words.memory, badge: logbook.vault === null ? '· set up' : logbook.isOn ? String(logbook.notes) : 'off', press: () => void openLogbook($, words.memory) },
    }
    // Glyphs like ◆ ● ✦ ⌬ are ambiguous width: some Windows terminals and fonts draw them two cells wide, so count two.
    const widthOf = (s: Spec) => 2 + Math.max(2, cells(s.glyph)) + cells(s.label) + cells(s.badge ? ` ${s.badge} ` : ' ')
    const problem: Spec = { glyph: '⚑', color: pal.warn, label: 'Problem', badge: '', press: () => void openReportPanel($) }
    const upd: Spec = { glyph: '↑', color: pal.good, label: 'Update', badge: updateBadge(updateInfo?.behind ?? 0, rea, ponytail), press: () => {} }
    const hasUpdate = Boolean((updateInfo && updateInfo.behind > 0) || reaUpdate(rea) || ponytailUpdate(ponytail))
    const shipyard: Spec = { glyph: words.hubGlyph, color: pal.accent, label: words.hub, badge: '', press: () => {} }
    const alerts = {
      problem: errorCount > 0 ? button('bar-problem', problem.glyph, problem.color, problem.label, '', problem.press) : null,
      update: hasUpdate
        ? button('bar-update', '↑', pal.good, 'Update', upd.badge, () => {
            void pressUpdate($).catch(err => logError($, 'update', err))
          })
        : null,
    }
    // Until setup is saved or put off, the bar asks for it first.
    const isSetupDone = await read($, setupDoneAtom)
    const setup: Spec = { glyph: '◎', color: pal.highlight, label: 'Set up', badge: '', press: () => void openSetup($, 'Setup') }
    const barWidth = Math.max(4, e.props.bodyColumns)
    // Other mods' bands above the prompt stay folded behind one chip unless the person opens them.
    const rest = await next(e)
    const drawsOthers = drawsSomething(rest)
    // Off (the default): other plugins' rows are not drawn and the More chip is gone.
    const hasOthers = drawsOthers && (await read($, othersOnAtom))
    const isOthersShown = await read($, othersAtom)
    const more: Spec = { glyph: '⋯', color: pal.muted, label: isOthersShown ? 'Less' : 'More', badge: '', press: () => void toggleOthers($) }
    // The session badge and its gap sit before the buttons.
    const reserved = (sessionBadge ? Math.max(2, cells(sessionBadge.glyph)) + 1 : 0) + widthOf(shipyard) + 1 + (errorCount > 0 ? widthOf(problem) + 1 : 0) + (hasUpdate ? widthOf(upd) + 1 : 0) + (hasOthers ? widthOf(more) + 1 : 0) + (isSetupDone ? 0 : widthOf(setup) + 1)
    const pinned = (await read($, pinsAtom)).filter(id => specs[id])
    const shown = fitPins(pinned, barWidth - 2 - reserved, id => widthOf(specs[id] as Spec))
    const tools: Record<string, { node: ReturnType<typeof button> }> = {}
    for (const id of shown) {
      const sp = specs[id] as Spec
      tools[id] = { node: button(`bar-${id === 'crew' ? 'dock' : id}`, sp.glyph, sp.color, sp.label, sp.badge, sp.press) }
    }

    // The buttons on the bar's surface, then, when opened with More, whatever other mods draw above the prompt.
    // Clean View places this outside its sized Box: an engine node may not sit inside a Box with a width.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={barWidth} backgroundColor={pal.surface} paddingX={1}>
        {sessionBadge ? <Text key="bar-badge" color={pal[sessionBadge.color]} bold>{sessionBadge.glyph}</Text> : null}
        {isSetupDone ? null : button('bar-setup', setup.glyph, setup.color, setup.label, '', setup.press)}
        {alerts.problem}
        {alerts.update}
        {shown.map(id => tools[id]?.node)}
        {/* Too narrow for the word: the Shipyard keeps its symbol. */}
        {button('bar-shipyard', words.hubGlyph, pal.accent, barWidth - 2 < widthOf(shipyard) + (sessionBadge ? 3 : 0) ? '' : words.hub, '', () => openShipyard($, words.hub))}
        {hasOthers ? button('bar-more', more.glyph, more.color, more.label, '', more.press) : null}
        </Box>
        {drawsOthers && !(hasOthers && isOthersShown) ? ({ type: 'engine', ref: 0 } as unknown as typeof rest) : rest}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const pal: Palette = PALETTES.deep
    const words = WORDS
    const cols = Math.max(30, e.props.bodyColumns - 2)
    const size = await read($, sizeAtom)
    const mission = await read($, missionAtom)
    const days = await read($, daysAtom)
    const isAuto = await read($, autoAtom)
    const isClean = await read($, cleanAtom)
    const checklist = await read($, checklistAtom)
    const isDockOpen = await read($, dockOpenAtom)
    const pending = await read($, updateAtom)
    const rea = await read($, reaAtom)
    const ponytail = await read($, ponytailAtom)
    const gstack = await read($, gstackAtom)
    const hookify = await read($, hookifyAtom)
    const security = await read($, securityAtom)
    const repeats = await read($, repeatsAtom)
    const repeatsPending = await read($, repeatsPendingAtom)
    const isBubbling = await read($, bubblesAtom)
    const today = days[dayKey(new Date(await $.clock.now()))]
    const tasksToday = today ? Object.values(today.kinds).reduce((s, n) => s + (n ?? 0), 0) : 0
    const working = mission?.cards.filter(c => c.status === 'working').length ?? 0
    const step = checklist ? checklist.tasks.findIndex(t => t.status === 'active') + 1 : 0
    const isFocused = Boolean(e.props.isFocused)
    const health = deckHealth(mission, checklist)
    const pins = await read($, pinsAtom)
    const logbook = await read($, logbookAtom)

    const rows: { key: string; tool?: string; extra?: { label: string; run: () => void }; glyph: string; color: string; name: string; state: string; action: string; run: () => void }[] = [
      {
        key: 'c', tool: 'crew',
        glyph: GLYPH.dock,
        color: pal.highlight,
        name: words.crew,
        state: working > 0 ? `${working} helpers working` : `${words.crew.toLowerCase()} of ${size}`,
        action: 'open',
        run: () => void toggleDock($, isDockOpen, words.crew).then(() => closeDeck($)),
      },
      { key: 'w', tool: 'report', glyph: GLYPH.report, color: pal.accent, name: 'Work Report', state: `${tasksToday} tasks today`, action: 'open', run: () => void openReport($).then(() => closeDeck($)) },
      {
        key: 'r', tool: 'refine',
        glyph: GLYPH.upgrade,
        color: pal.warn,
        name: 'Refine',
        state: `automatic mode ${isAuto ? 'on' : 'off'}`,
        action: 'refine one',
        run: () => void openRefine($).then(() => closeDeck($)),
      },
      {
        key: 'v', tool: 'clean',
        glyph: GLYPH.clean,
        color: pal.good,
        name: 'Clean View',
        state: isClean ? (checklist && step > 0 ? `on · step ${step} of ${checklist.tasks.length}` : 'on') : 'off',
        action: isClean ? 'turn off' : 'turn on',
        run: () => void toggleClean($),
      },
      {
        key: 'l', tool: 'logbook',
        glyph: GLYPH.logbook,
        color: pal.accent,
        name: words.memory,
        state: logbook.vault === null ? 'not set up' : `${logbook.isOn ? 'on' : 'off'} · ${logbook.notes} notes`,
        action: logbook.vault === null ? 'set up' : 'open',
        run: () => void openLogbook($, words.memory).then(() => closeDeck($)),
      },
      {
        key: 'm',
        glyph: '∘',
        color: pal.accentDeep,
        name: 'Motion',
        state: isBubbling ? `on · ${words.rise} while a job works` : 'off',
        action: isBubbling ? 'turn off' : 'turn on',
        run: () => void toggleBubbles($),
      },
      ...((pending && pending.behind > 0) || reaUpdate(rea) || ponytailUpdate(ponytail)
        ? [
            {
              key: 'u',
              glyph: '↑',
              color: pal.good,
              name: 'Update',
              state: waitingText(pending, rea, ponytail),
              action: 'update now',
              run: () => void pressUpdate($).then(isDone => (isDone ? closeDeck($) : undefined)),
            },
          ]
        : []),
      {
        key: 's',
        glyph: '◎',
        color: pal.highlight,
        name: 'Setup',
        state: (await read($, setupDoneAtom)) ? 'done' : 'not done yet',
        action: 'open',
        run: () => void openSetup($, 'Setup').then(() => closeDeck($)),
      },
      {
        key: 'p',
        glyph: '↻',
        color: pal.warn,
        name: 'Repeated prompts',
        state: repeats.length > 0 ? 'prompts you typed more than once' : 'none yet · prompts you typed more than once',
        action: 'about',
        run: () => $.ui.toast('Prompts you typed more than once, from Claude Code\'s history on this machine. Nothing leaves it. Claude Code\'s own /insights command shows more.', { timeoutMs: 8000 }),
      },
      ...repeats.map((g, i) => ({
        key: String(i + 1),
        glyph: ' ',
        color: pal.warn,
        name: `  ×${g.count}`,
        state: g.text.replace(/\s+/g, ' '),
        action: repeatsPending === i ? 'Press again' : 'Make /command',
        run: () => void makeCommand($, i).catch(err => logError($, 'make command', err)),
      })),
    ]

    const addonRows: typeof rows = ADDONS.map(a => {
      const st = a.id === 'rea' ? rea : a.id === 'gstack' ? gstack : a.id === 'hookify' ? hookify : a.id === 'security-guidance' ? security : ponytail
      const extra = addonExtra(st)
      const isOfficial = OFFICIAL_ADDONS.includes(a.id)
      const status = addonStatus(a.label, st, a.id === 'gstack', isOfficial)

      return {
        key: a.key,
        tool: a.id === 'rea' ? 'rea' : undefined,
        glyph: a.id === 'rea' ? GLYPH.rea : a.id === 'gstack' ? GLYPH.gstack : isOfficial ? '◇' : GLYPH.ponytail,
        color: pal.accent,
        name: a.label,
        state: `${status} · ${reachTags(a.id)}`,
        action: st.kind === 'none' ? 'Add' : 'status',
        run: () => (st.kind === 'none' ? void addAddon($, a.id).then(() => closeDeck($)) : void $.ui.toast(`${status}. It ${reachMeaning(a.id).split(' ').slice(1).join(' ')}`, { timeoutMs: 8000 })),
        extra: extra ? { label: extra, run: () => void (extra === 'Manage' ? manageAddon($, a.id) : removeAddon($, a.id)) } : undefined,
      }
    })
    const sections = [
      { name: 'Tools', rows },
      { name: 'Add-ons', rows: addonRows },
    ]

    const title = `${GLYPH.deck}  ${spaced(words.hub.toUpperCase())}`
    // The engine draws each hotkey as "d: " before the row. Wide panes fit a row on one line; narrow ones put the state under the name.
    const isWide = cols >= 60
    const nameW = 18
    const actionW = 14
    const pinMark = (row: { tool?: string }) => {
      if (!row.tool || (row.tool === 'rea' && rea.kind === 'none')) return null
      const id = row.tool
      const isPinned = pins.includes(id)

      return (
        <Button key={`deck-pin-${id}`} plain label={isPinned ? 'unpin' : 'pin'} onPress={() => void pinTool($, id, !isPinned).then(text => $.ui.toast(text, { timeoutMs: 2500 }))} hover={{ backgroundColor: pal.halo2 }}>
          <Text color={isPinned ? pal.good : pal.muted}>{isPinned ? ' ◉ pinned' : ' ○ pin'}</Text>
        </Button>
      )
    }
    const pinW = 10
    const extraMark = (row: (typeof rows)[number]) =>
      row.extra ? (
        <Button key={`deck-${row.extra.label.toLowerCase()}-${row.key}`} plain label={row.extra.label} onPress={row.extra.run} hover={{ backgroundColor: pal.halo2 }}>
          <Text color={pal.muted}>{` [${row.extra.label}]`}</Text>
        </Button>
      ) : null
    const stateW = Math.max(6, cols - 3 - 2 - nameW - actionW - pinW - 9)

    return (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              <Text color={pal.accent}>{`${GLYPH.deck}  `}</Text>
              {titleLit(els, pal, spaced(words.hub.toUpperCase()), isFocused)}
            </Text>
            <Text color={health.isWell ? pal.good : pal.warn}>{fit(health.text, Math.max(6, cols - 12))}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color={pal.accent}>{'━'.repeat(Math.min(title.length, cols))}</Text>
            <Text color={pal.hairline}>{'─'.repeat(Math.max(0, cols - title.length))}</Text>
          </Box>
        </Box>
        {sections.map(section => (
        <Box key={`deck-section-${section.name}`} flexDirection="column" gap={isWide ? 0 : 1}>
          <Text color={pal.muted} bold>{section.name}</Text>
          {section.rows.map(row => (
            <Box key={`deck-${row.key}`} flexDirection="column">
              <Box flexDirection="row">
              <Button key={`deck-press-${row.key}`} plain label={row.name} hotkey={row.key} onPress={row.run} hover={{ backgroundColor: pal.halo2 }}>
                <Text color={row.color}>{`${row.glyph} `}</Text>
                <Text color={pal.text} bold>
                  {isWide ? row.name.padEnd(nameW) : fit(row.name, cols - 5)}
                </Text>
                {isWide ? <Text color={pal.muted}>{fit(row.state, stateW).padEnd(stateW)}</Text> : null}
                {isWide ? <Text color={pal.accent}>{row.action.padEnd(actionW)}</Text> : null}
              </Button>
              {isWide ? pinMark(row) : null}
              {isWide ? extraMark(row) : null}
              </Box>
              {isWide ? null : (
                <Box flexDirection="row">
                  <Text>
                    <Text color={pal.muted}>{`     ${fit(row.state, Math.max(4, cols - 8 - row.action.length - (row.tool ? pinW : 0)))}`}</Text>
                    <Text color={pal.accent}>{` · ${row.action}`}</Text>
                  </Text>
                  {pinMark(row)}
                  {extraMark(row)}
                </Box>
              )}
            </Box>
          ))}
        </Box>
        ))}
        <Text color={pal.muted}>{fit('press a letter · ○ pin puts a tool on the bar · esc closes', cols)}</Text>
      </Box>
    )
  })

  // Setup: every question on one page, each answer a chip; Save writes them all.
  on('ui.render', { component: 'Pane', requestId: SETUP_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Input = 'Input' in els ? els.Input : undefined
    const pal: Palette = PALETTES.deep
    const words = WORDS
    const cols = Math.max(30, e.props.bodyColumns - 2)
    const d = await read($, setupDraftAtom)
    const logbook = await read($, logbookAtom)
    const meta = await read($, setupMetaAtom)
    if (d === null) {
      return (
        <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
          {paneTitle(els, pal, 'Setup', cols, undefined, Boolean(e.props.isFocused))}
          <Text color={pal.muted}>{fit('Setup is saved. Run /setup to change it.', cols)}</Text>
        </Box>
      )
    }
    const pick = (key: string, label: string, isOn: boolean, run: () => void) => <Box key={`${key}-box`}>{chip(els, pal, key, label, isOn ? 'primary' : 'secondary', run)}</Box>
    const question = (key: string, text: string, chips: ReturnType<typeof pick>[], note?: string) => (
      <Box key={key} flexDirection="column">
        {heading(els, pal, text, cols)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {chips}
        </Box>
        {note ? <Text color={pal.muted} wrap="wrap">{note}</Text> : null}
      </Box>
    )
    const set = (change: (x: SetupDraft) => SetupDraft) => () => void editSetup($, change).catch(err => logError($, 'change setup', err))

    return (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        {paneTitle(els, pal, 'Setup', cols, undefined, Boolean(e.props.isFocused))}
        <Text color={pal.muted} wrap="wrap">A few answers make carapace yours. Change them any time with /setup.</Text>
        
        {question('setup-view', 'What do you want to see while Claude works?', [
          pick('setup-view-steps', 'Every tool call', d.view === 'steps', set(x => ({ ...x, view: 'steps' }))),
          pick('setup-view-checklist', 'A checklist of steps', d.view === 'checklist', set(x => ({ ...x, view: 'checklist' }))),
        ])}
        {question('setup-work', 'What do you mostly use Claude for? Pick any.', WORK.map(w => pick(`setup-work-${w.id}`, w.label, d.work.includes(w.id), set(x => ({ ...x, work: x.work.includes(w.id) ? x.work.filter(k => k !== w.id) : [...x.work, w.id] })))), 'This picks the buttons on your bar.')}
        {question('setup-memory', 'Should Claude remember your work between sessions?', [
          pick('setup-memory-yes', `Yes, keep ${words.memory}`, d.memory, set(x => ({ ...x, memory: true }))),
          pick('setup-memory-no', 'No', !d.memory, set(x => ({ ...x, memory: false }))),
        ], d.memory ? (logbook.vault === null ? 'After Save you pick where the vault lives.' : `Already kept in ${logbook.vault}.`) : undefined)}
        <Box flexDirection="column">
          {question('setup-pay', 'How do you pay for Claude?', PAY.map(p => pick(`setup-pay-${p.id}`, p.label, d.pay === p.id, set(x => ({ ...x, pay: p.id })))), [meta.detected ? `Detected: ${meta.detected === 'sub' ? 'subscription' : 'API credits'}.` : '', d.pay === 'sub' ? `The bar shows your plan's limit as ${words.limit}.` : d.pay === 'api' ? 'The bar shows tokens and spend.' : ''].filter(Boolean).join(' ') || undefined)}
          {d.pay === 'budget' ? (
            <Box flexDirection="column">
              <Text color={pal.text}>{fit(`Budget: $${d.budget.amount} a ${d.budget.period}. The bar warns as it runs out; nothing is blocked.`, cols)}</Text>
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {PERIODS.map(period => pick(`setup-period-${period}`, `a ${period}`, d.budget.period === period, set(x => ({ ...x, budget: { ...x.budget, period } }))))}
              </Box>
              {Input ? <Input key="setup-budget" label="Budget: $" placeholder={String(d.budget.amount)} onInput={value => void typeAmount($, 'budget', value).catch(err => logError($, 'set the budget', err))} onSubmit={value => void typeAmount($, 'budget', value).catch(err => logError($, 'set the budget', err))} /> : null}
              {meta.bad.includes('budget') ? <Text color={pal.warn}>Type a number, like 20.</Text> : null}
            </Box>
          ) : null}
        </Box>
        {question('setup-helpers', `When Claude splits work across ${words.crew.toLowerCase()}, what matters more?`, HELPERS.map(h => pick(`setup-helpers-${h.id}`, h.label, d.helpers === h.id, set(x => ({ ...x, helpers: h.id })))))}
        <Box flexDirection="column">
          {heading(els, pal, 'What is an hour of your time worth?', cols)}
          <Text color={pal.text}>{fit(`$${d.rate} an hour: the Work Report values the time Claude saves you at this rate.`, cols)}</Text>
          {Input ? <Input key="setup-rate" label="Hourly rate: $" placeholder={String(d.rate)} onInput={value => void typeAmount($, 'rate', value).catch(err => logError($, 'set the rate', err))} onSubmit={value => void typeAmount($, 'rate', value).catch(err => logError($, 'set the rate', err))} /> : null}
          {meta.bad.includes('rate') ? <Text color={pal.warn}>Type a number, like 75.</Text> : null}
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {chip(els, pal, 'setup-save', 'Save', 'primary', () => void saveSetup($, d, words.memory, logbook.vault === null).catch(err => logError($, 'save setup', err)))}
          {chip(els, pal, 'setup-later', 'Later', 'secondary', () => void putOffSetup($).catch(err => logError($, 'put off setup', err)))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: REPORT_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const pal: Palette = PALETTES.deep
    const cols = Math.max(30, e.props.bodyColumns - 2)
    const details = await read($, reportDetailsAtom)
    const note = await read($, reportNoteAtom)
    const isShown = await read($, reportShowAtom)
    const line = (text: string, color: string = pal.text) => <Text color={color}>{fit(text, cols)}</Text>
    const lines = details?.lines ?? []

    return (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        {paneTitle(els, pal, 'Report a problem', cols, undefined, Boolean(e.props.isFocused))}
        {Input ? <Input key="report-text" label="What went wrong? " placeholder="Say it in a sentence or two" rows={3} submitLabel="ok" autoFocus onInput={value => void update($, reportTextAtom, () => value)} onSubmit={value => void update($, reportTextAtom, () => value)} /> : null}
        <Box flexDirection="column">
          {line('Sent with it:', pal.muted)}
          {line(`  carapace ${details?.carapace ?? '...'} · Claude Code ${details?.claude ?? '...'}`)}
          {line(`  ${details?.os ?? '...'} · ${details?.terminal ?? '...'}`)}
          {line(`  mods on: ${details?.mods ?? '...'}`)}
          <Button key="report-log" plain label="show the log" onPress={() => void update($, reportShowAtom, v => !v)}>
            <Text color={pal.accent}>{fit(`  ${count(lines.length)} logged ${isShown ? '▾ hide' : '▸ show'}`, cols)}</Text>
          </Button>
          {isShown ? lines.map((l, i) => <Text key={`report-line-${i}`} color={pal.muted}>{fit(`    ${l}`, cols)}</Text>) : null}
        </Box>
        {line('Never sent: your prompts, replies, files.', pal.muted)}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {chip(els, pal, 'report-github', 'Open on GitHub', 'primary', () => void sendReport($, false))}
          {chip(els, pal, 'report-save', 'Save to file', 'secondary', () => void sendReport($, true))}
          {chip(els, pal, 'report-close', '✕', 'quiet', () => void clearErrors($).then(() => $.ui.close({ id: REPORT_PANE })))}
        </Box>
        {note ? line(note, pal.good) : null}
      </Box>
    )
  })
}
