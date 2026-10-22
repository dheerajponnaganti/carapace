import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptSubmitInput } from 'claude-code'

import type { PromptUpgradeEntry, PromptUpgradeFlow, PromptUpgradeQuestion } from '../../types'

import { PALETTES, cells, cutCells } from '../shared/look'

import { blanksIn, fillBlank } from './marks'
import { drawPane } from './view'
import type { PaneActions } from './view'

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
    const line = errorLine(await $.clock.now(), 'prompt-upgrade', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('prompt-upgrade'), { timeoutMs: 8000 })
    }
  })
}

const PANE = 'prompt-upgrade'
const TITLE = 'Refine'
const AUTO_KEY = 'promptUpgradeAuto'
const HISTORY_KEY = 'promptUpgradeHistory'
const HISTORY_SIZE = 20
const QUESTION_MODEL = 'haiku'
const REWRITE_MODEL = 'sonnet'
const SHORT_REPLY = /^(?:y|yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank you|continue|keep going|go on|go ahead|do it|proceed|next|stop|done|looks good|lgtm)[.!]*$/i

const autoAtom = atom({ plugin: 'carapace', key: 'promptUpgradeAuto' } as const, false)
const flowAtom = atom({ plugin: 'carapace', key: 'promptUpgradeFlow' } as const, null)
// The last prompt a person sent.
const personPromptAtom = atom({ plugin: 'carapace', key: 'personPrompt' } as const, null)
const historyAtom = atom({ plugin: 'carapace', key: 'promptUpgradeHistory' } as const, [])
const typedAtom = atom({ plugin: 'carapace', key: 'promptUpgradeTyped' } as const, {})

// Model calls in flight, by flow id and step. A reload empties it, so session.start resumes the step.
const inFlight = new Set<string>()
let counter = 0
// Automatic mode, mirrored here so the prompt hook can open the pane before any other call (see openPane).
// Undefined after a hot reload until the state is read once.
let isAutoKnown: boolean | undefined
// The upgrade Use it put in the box: when it is sent, automatic mode lets it through instead of upgrading it again.
let refined = ''

const QUESTIONS_SYSTEM = [
  'You help a person sharpen a rough prompt before they send it to an AI assistant.',
  'Ask only what the prompt leaves open and what would most change the result.',
  'Return JSON only, no prose: {"questions":[{"question":"...","options":["...","..."]}]}',
  'At most 3 questions. Each question under 90 characters. Each has 2 to 4 options under 30 characters.',
  'If no question would clearly help, return {"questions":[]}.',
].join('\n')

const REWRITE_SYSTEM = [
  "Rewrite the person's rough prompt as one clear request they could have typed themselves, in plain language.",
  'Rules:',
  '- Keep exactly what they meant. Do not change the task.',
  '- Add a clear goal, who it is for, the format of the result, and what "done" looks like.',
  '- Use their answers. Leave out anything they skipped.',
  '- Never invent facts, names, numbers or prices. Where something is unknown, write a [placeholder] in square brackets.',
  'Return JSON only, no prose: {"prompt":"...","added":["...", "..."]}',
  '"added" lists 2 to 6 short notes, each under 60 characters, on what you added.',
].join('\n')

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function jsonIn(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()

  return cells(clean) > max ? cutCells(clean, max - 1).trimEnd() + '…' : clean
}

/** Reads the question model's answer: at most 3 questions of 2 to 4 options; anything malformed is dropped. */
export function parseQuestions(text: string): PromptUpgradeQuestion[] {
  const data = jsonIn(text) as { questions?: unknown } | undefined
  if (!data || !Array.isArray(data.questions)) return []

  return data.questions
    .flatMap((raw): PromptUpgradeQuestion[] => {
      const item = raw as { question?: unknown; options?: unknown }
      if (typeof item?.question !== 'string' || !Array.isArray(item.options)) return []
      const options = [
        ...new Set(item.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map(o => clip(o, 30))),
      ].slice(0, 4)

      return item.question.trim() !== '' && options.length >= 2 ? [{ question: clip(item.question, 90), options }] : []
    })
    .slice(0, 3)
}

/** Reads the rewrite model's answer, or undefined when it holds no usable prompt. */
export function parseRewrite(text: string): { prompt: string; added: string[] } | undefined {
  const data = jsonIn(text) as { prompt?: unknown; added?: unknown } | undefined
  if (!data || typeof data.prompt !== 'string' || data.prompt.trim() === '') return undefined
  const added = Array.isArray(data.added)
    ? data.added.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => clip(a, 60)).slice(0, 6)
    : []

  return { prompt: data.prompt.trim(), added }
}

/** Why a typed prompt goes straight to Claude in automatic mode, or null when the pane should take it. */
export function passThrough(e: Pick<PromptSubmitInput, 'text' | 'attachments' | 'turnId' | 'origin'>): string | null {
  const text = e.text.trim()
  if (e.origin.kind !== 'composer') return 'not typed'
  if (text === '') return 'empty'
  if (text.startsWith('/')) return 'command'
  if (text.startsWith('>')) return 'escaped'
  if ((e.attachments?.length ?? 0) > 0) return 'attachments'
  if (e.turnId !== undefined) return 'working'
  if (wordCount(text) < 4 || SHORT_REPLY.test(text)) return 'short'

  return null
}

export function newFlow(original: string, step: PromptUpgradeFlow['step']): PromptUpgradeFlow {
  counter += 1

  return {
    id: `${Date.now().toString(36)}-${counter}`,
    step,
    original,
    questions: [],
    answers: [],
    otherFor: null,
    rewrite: '',
    added: [],
    error: null,
    failedStep: null,
    isEditing: false,
    isFilling: false,
    isCopied: false,
  }
}

async function setFlow($: Engine, fn: (flow: PromptUpgradeFlow) => PromptUpgradeFlow): Promise<void> {
  await update($, flowAtom, flow => (flow ? fn(flow) : flow))
}

/** Writes a model call's outcome only when the flow it was made for is still on the same step. */
function forStep(id: string, step: PromptUpgradeFlow['step'], fn: (flow: PromptUpgradeFlow) => PromptUpgradeFlow) {
  return (flow: PromptUpgradeFlow) => (flow.id === id && flow.step === step ? fn(flow) : flow)
}

function failure(result: { isAnswered: false; reason: string; status?: number | null }): string {
  if (result.reason === 'aborted') return 'The model took too long to answer.'
  if (result.status === 429) return 'You hit your usage limit for now.'
  if (result.status === 529 || (result.status ?? 0) >= 500) return "Claude's servers are busy right now."

  return 'The model could not be reached.'
}

/** Starts the pane open. Call it before any other `$` call of a command or prompt: only then does the pane count as asked for and show at any width. */
function beginOpen($: Engine): Promise<{ isPlaced: boolean }> {
  return $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

async function openPane($: Engine, original: string, opening: Promise<{ isPlaced: boolean }> = beginOpen($)): Promise<void> {
  const opened = await opening
  if (opened.isPlaced) return
  await update($, flowAtom, () => null)
  if (original.trim() !== '') await $.prompt.fill({ text: original })
  $.ui.log('Refine needs a wider window. Your prompt is back in the box.')
}

async function askQuestions($: Engine, flow: PromptUpgradeFlow): Promise<void> {
  const job = `${flow.id}:asking`
  if (inFlight.has(job)) return
  inFlight.add(job)
  try {
    const answer = await $.model.complete({
      model: QUESTION_MODEL,
      effort: 'low',
      maxTokens: 600,
      timeoutMs: 30000,
      system: QUESTIONS_SYSTEM,
      prompt: flow.original,
    })
    if (!answer.isAnswered) {
      const error = failure(answer)
      await setFlow($, forStep(flow.id, 'asking', f => ({ ...f, step: 'error', error, failedStep: 'asking' })))

      return
    }
    const questions = parseQuestions(answer.text)
    if (questions.length === 0) {
      await setFlow($, forStep(flow.id, 'asking', f => ({ ...f, step: 'rewriting' })))
      await runStep($)

      return
    }
    const answers = questions.map(() => ({ state: 'open' as const, value: '' }))
    await setFlow($, forStep(flow.id, 'asking', f => ({ ...f, step: 'questions', questions, answers })))
  } finally {
    inFlight.delete(job)
  }
}

async function writeRewrite($: Engine, flow: PromptUpgradeFlow): Promise<void> {
  const job = `${flow.id}:rewriting`
  if (inFlight.has(job)) return
  inFlight.add(job)
  try {
    const answered = flow.questions
      .map((q, i) => (flow.answers[i]?.state === 'answered' ? `- ${q.question} ${flow.answers[i].value}` : ''))
      .filter(Boolean)
    const prompt = `Rough prompt:\n${flow.original}\n\nTheir answers:\n${answered.length > 0 ? answered.join('\n') : '(none)'}`
    const answer = await $.model.complete({ model: REWRITE_MODEL, maxTokens: 2000, timeoutMs: 90000, system: REWRITE_SYSTEM, prompt })
    if (!answer.isAnswered) {
      const error = failure(answer)
      await setFlow($, forStep(flow.id, 'rewriting', f => ({ ...f, step: 'error', error, failedStep: 'rewriting' })))

      return
    }
    const parsed = parseRewrite(answer.text)
    if (parsed === undefined) {
      await setFlow(
        $,
        forStep(flow.id, 'rewriting', f => ({ ...f, step: 'error', error: "The model's answer was not usable.", failedStep: 'rewriting' })),
      )

      return
    }
    await setFlow($, forStep(flow.id, 'rewriting', f => ({ ...f, step: 'review', rewrite: parsed.prompt, added: parsed.added })))
    const entry: PromptUpgradeEntry = { id: flow.id, at: await $.clock.now(), original: flow.original, rewrite: parsed.prompt, added: parsed.added }
    const history = [entry, ...(await read($, historyAtom)).filter(old => old.id !== entry.id)].slice(0, HISTORY_SIZE)
    await update($, historyAtom, () => history)
    await $.store.set(HISTORY_KEY, history)
  } finally {
    inFlight.delete(job)
  }
}

/** Runs whatever model call the current step waits on; safe to call again (after a reload, a retry). */
async function runStep($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null) return
  if (flow.step === 'reading') {
    await setFlow($, forStep(flow.id, 'reading', f => ({ ...f, step: 'asking' })))
    await runStep($)
  } else if (flow.step === 'asking') {
    await askQuestions($, flow)
  } else if (flow.step === 'rewriting') {
    await writeRewrite($, flow)
  }
}

function inBackground($: Engine, work: () => Promise<void>): void {
  $.clock.after(0, () => {
    void work().catch(async err => {
      logError($, 'upgrade step', err)
      await setFlow($, f => ({ ...f, step: 'error', error: 'Something went wrong on our side.', failedStep: f.failedStep ?? 'asking' }))
    })
  })
}

/** Starts an upgrade of `original`: the pane opens now (inside the caller's dispatch), the model work runs after. */
async function start($: Engine, original: string): Promise<void> {
  const opening = beginOpen($)
  await update($, flowAtom, () => newFlow(original, 'reading'))
  void openPane($, original, opening)
  inBackground($, () => runStep($))
}

async function close($: Engine): Promise<void> {
  await update($, flowAtom, () => null)
  await $.ui.close({ id: PANE })
}

async function cancel($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  await close($)
  if (flow !== null && flow.original.trim() !== '') await $.prompt.fill({ text: flow.original })
}

async function send($: Engine, text: string): Promise<void> {
  await close($)
  // The upgrade goes in the prompt box, not straight out: carapace's own prompt hooks never see a submit the plugin
  // makes, so the Crew's split, Logbook's index and the Work Report's count would miss it. One Enter sends it as typed.
  refined = text.trim()
  await $.prompt.fill({ text: refined })
  $.ui.toast('Your refined prompt is in the box. Press Enter to send it.', { timeoutMs: 6000 })
}

function actions($: Engine): PaneActions {
  const toRewrite = async () => {
    await setFlow($, f =>
      f.step === 'questions'
        ? { ...f, step: 'rewriting', otherFor: null, answers: f.answers.map(a => (a.state === 'open' ? { state: 'skipped', value: '' } : a)) }
        : f,
    )
    inBackground($, () => runStep($))
  }
  const answer = async (index: number, state: 'answered' | 'skipped', value: string) => {
    await setFlow($, f => {
      if (f.step !== 'questions') return f
      const answers = f.answers.map((a, i) => (i === index ? { state, value } : a))

      return { ...f, answers, otherFor: null }
    })
    const flow = await read($, flowAtom)
    if (flow?.step === 'questions' && flow.answers.every(a => a.state !== 'open')) await toRewrite()
  }

  return {
    compose: async text => {
      if (text.trim() === '') return
      await update($, typedAtom, () => ({}))
      await start($, text.trim())
    },
    type: async (field, text) => {
      // Keyed by the flow, so a new /refine never starts from an old draft.
      const flow = await read($, flowAtom)
      if (flow) await update($, typedAtom, t => ({ ...t, [`${flow.id}:${field}`]: text }))
    },
    choose: (index, option) => answer(index, 'answered', option),
    skip: index => answer(index, 'skipped', ''),
    other: async index => setFlow($, f => ({ ...f, otherFor: index })),
    otherText: async (index, text) => {
      if (text.trim() !== '') await answer(index, 'answered', clip(text, 120))
    },
    skipRest: toRewrite,
    run: async () => {
      const flow = await read($, flowAtom)
      if (flow?.step === 'review') await send($, flow.rewrite)
    },
    edit: async () => setFlow($, f => ({ ...f, isEditing: true, isCopied: false })),
    saveEdit: async text => {
      if (text.trim() === '') return
      await update($, typedAtom, () => ({}))
      await send($, text.trim())
    },
    copy: async surface => {
      const flow = await read($, flowAtom)
      if (flow === null) return
      const copied = await $.ui.copy({ text: flow.rewrite, surface })
      await setFlow($, f => ({ ...f, isCopied: copied.isCopied }))
    },
    cancel: () => cancel($),
    retry: async () => {
      await setFlow($, f => (f.step === 'error' && f.failedStep ? { ...f, step: f.failedStep, error: null } : f))
      inBackground($, () => runStep($))
    },
    sendOriginal: async () => {
      const flow = await read($, flowAtom)
      if (flow !== null) await send($, flow.original)
    },
    fill: async () => setFlow($, f => ({ ...f, isFilling: true, isEditing: false })),
    setBlank: async (placeholder, value) => {
      if (value.trim() === '') return
      await setFlow($, f => {
        const rewrite = fillBlank(f.rewrite, placeholder, value)

        return { ...f, rewrite, isFilling: blanksIn(rewrite).length > 0 }
      })
    },
    reopen: async entry => {
      await update($, flowAtom, () => ({ ...newFlow(entry.original, 'review'), id: entry.id, rewrite: entry.rewrite, added: entry.added }))
    },
  }
}

async function setAuto($: Engine, isOn: boolean): Promise<void> {
  isAutoKnown = isOn
  await update($, autoAtom, () => isOn)
  await $.store.set(AUTO_KEY, isOn)
}

async function better($: Engine, args: string): Promise<string> {
  const arg = args.trim()
  const word = arg.toLowerCase()
  if (word === 'on' || word === 'off') {
    await setAuto($, word === 'on')

    return word === 'on'
      ? 'Refine is on: prompts you type open in the pane first. Start one with > to send it as is.'
      : 'Refine is off: prompts go straight to Claude. Use /refine <prompt> any time.'
  }
  if (word === 'history') {
    const opening = beginOpen($)
    await update($, flowAtom, () => newFlow('', 'history'))
    void openPane($, '', opening)

    return 'Opened your refined prompts.'
  }
  if (arg === '') {
    const opening = beginOpen($)
    // An upgrade already under way is shown, never replaced: its words would be lost.
    if ((await read($, flowAtom)) === null) await update($, flowAtom, () => newFlow('', 'compose'))
    void openPane($, '', opening)

    return 'Type or paste your prompt in the pane.'
  }
  await start($, arg)

  return 'Refining your prompt in the pane. Use it puts the refined prompt in the box; Enter sends it.'
}

export function registerPromptUpgrade(on: On): void {
  // Clean View holds the unfiltered session.start; this mod only matters where a person types.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const saved = await $.store.get(AUTO_KEY)
    if (typeof saved === 'boolean') await update($, autoAtom, () => saved)
    isAutoKnown = typeof saved === 'boolean' ? saved : false
    const history = await $.store.get(HISTORY_KEY)
    if (Array.isArray(history)) await update($, historyAtom, () => (history as PromptUpgradeEntry[]).slice(0, HISTORY_SIZE))
    await $.command.register({
      name: 'refine',
      description: 'Refine a rough prompt before it is sent',
      argumentHint: '<prompt> | on | off | history',
    })
    // A reload mid-upgrade brings the pane back without taking the keyboard, so Enter still sends to the chat.
    // A pane left at an empty box, the history or an error is dropped: reopening it would catch the next prompt typed.
    const flow = await read($, flowAtom)
    if (flow !== null && (flow.step === 'compose' || flow.step === 'history' || flow.step === 'error')) await update($, flowAtom, () => null)
    else if (flow !== null) {
      const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (!isOpen) void $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })
      inBackground($, () => runStep($))
    }

    return next(e)
  })

  on('command.run', { command: 'refine' }, async ($, e) => {
    try {
      return { text: await better($, e.args) }
    } catch (err) {
      logError($, '/refine', err)
      return { text: 'Refine could not start. Your prompt is safe; try /refine again.' }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    isAutoKnown ??= await read($, autoAtom)
    if (refined !== '' && e.text.trim() === refined) {
      refined = ''

      return next(e)
    }
    if (!isAutoKnown) return next(e)
    const reason = passThrough(e)
    if (reason === 'escaped') {
      // The turn carries the text without the >, so that is the person's request the other mods look for.
      const text = e.text.trim().slice(1).trimStart()
      const at = await $.clock.now()
      await update($, personPromptAtom, () => ({ text, at }))

      return next({ ...e, text })
    }
    if (reason !== null) return next(e)
    // Taken only when the pane can open: an unplaced pane would hand the words back and catch the next Enter forever.
    const opened = await beginOpen($)
    if (!opened.isPlaced) {
      $.ui.log('Refine needs a wider window, so this prompt went straight to Claude.')

      return next(e)
    }
    await update($, flowAtom, () => newFlow(e.text.trim(), 'reading'))
    inBackground($, () => runStep($))

    return { drop: 'Opened in Refine. Use it puts the refined prompt in the box, or start a prompt with > to skip.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    // Esc or the close mark: same as Cancel, so the words are never lost.
    if (e.origin.kind === 'person') {
      const flow = await read($, flowAtom)
      await update($, flowAtom, () => null)
      if (flow !== null && flow.step !== 'history' && flow.original.trim() !== '') await $.prompt.fill({ text: flow.original })
    }

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const flow = await read($, flowAtom)
    const history = flow?.step === 'history' ? await read($, historyAtom) : []

    const pal = PALETTES.deep

    return drawPane(els, { flow, history, typed: await read($, typedAtom), columns: e.props.bodyColumns, surface: e.surface, actions: actions($), pal, isFocused: e.props.isFocused })
  })
}
