import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { PromptUpgradeEntry, PromptUpgradeFlow } from '../../types'

import { bigNumber } from '../shared/big-number'
import { spaced } from '../shared/look'
import type { Palette } from '../shared/look'
import { titleLit } from '../shared/ui'

import { blanksIn, marks } from './marks'
import { fit } from '../shared/look'

export type PaneActions = {
  compose: (text: string) => Promise<void>
  choose: (index: number, option: string) => Promise<void>
  skip: (index: number) => Promise<void>
  other: (index: number) => Promise<void>
  otherText: (index: number, text: string) => Promise<void>
  skipRest: () => Promise<void>
  run: () => Promise<void>
  edit: () => Promise<void>
  saveEdit: (text: string) => Promise<void>
  copy: (surface: RenderSurface) => Promise<void>
  cancel: () => Promise<void>
  retry: () => Promise<void>
  sendOriginal: () => Promise<void>
  reopen: (entry: PromptUpgradeEntry) => Promise<void>
  fill: () => Promise<void>
  setBlank: (placeholder: string, value: string) => Promise<void>
}

type Els = Elements[RenderSurface]
type Draw = {
  flow: PromptUpgradeFlow | null
  history: readonly PromptUpgradeEntry[]
  columns: number
  surface: RenderSurface
  actions: PaneActions
  pal: Palette
  isFocused?: boolean
}

const STEPS = ['Your prompt', 'Questions', 'Rewrite', 'Review'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// One trimming rule for every mod: the shared one keeps spaced titles' word gaps.
export { fit }

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function when(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stepIndex(flow: PromptUpgradeFlow): number {
  if (flow.step === 'compose' || flow.step === 'reading') return 0
  if (flow.step === 'asking' || flow.step === 'questions') return 1
  if (flow.step === 'rewriting') return 2
  if (flow.step === 'error') return flow.failedStep === 'rewriting' ? 2 : 1

  return 3
}

export function drawPane(els: Els, draw: Draw): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const { flow, actions, pal } = draw
  // The shared palette under the names this file grew up with.
  const LOOK = { gold: pal.accent, hairline: pal.hairline, slate: pal.slate, muted: pal.muted, text: pal.text, good: pal.good, warn: pal.warn, ink: pal.onAccent, highlight: pal.highlight }
  const cols = Math.max(22, draw.columns - 2)

  const chip = (key: string, label: string, kind: 'gold' | 'slate' | 'quiet' | 'picked', onPress: () => void) => {
    const room = Math.max(4, cols - 2)
    const text = fit(label, room)
    if (kind === 'quiet') {
      return (
        <Button key={key} plain label={text} onPress={onPress}>
          <Text color={LOOK.muted}>{text}</Text>
        </Button>
      )
    }
    const isGold = kind === 'gold' || kind === 'picked'

    return (
      <Button key={key} plain label={text} onPress={onPress}>
        <Text backgroundColor={isGold ? LOOK.gold : LOOK.slate} color={isGold ? LOOK.ink : LOOK.text} bold={isGold}>
          {` ${text} `}
        </Text>
      </Button>
    )
  }

  const heading = (label: string) => {
    const caps = fit(label.toUpperCase(), cols - 2)

    return (
      <Box flexDirection="row">
        <Text color={LOOK.muted}>{caps} </Text>
        <Text color={LOOK.hairline}>{'─'.repeat(Math.max(0, cols - caps.length - 1))}</Text>
      </Box>
    )
  }

  const card = (key: string, title: string, body: string, border: string, width: number, titleColor: string) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} width={width}>
      <Text color={titleColor}>{fit(title.toUpperCase(), Math.max(1, width - 4))}</Text>
      <Text color={LOOK.text}>{body}</Text>
    </Box>
  )

  const title = spaced('REFINE')
  const head = (
    <Box flexDirection="column">
      <Text>
        {titleLit(els, pal, fit(title, draw.isFocused ? Math.max(1, cols - 6) : cols), draw.isFocused)}
      </Text>
      <Box flexDirection="row">
        <Text color={LOOK.gold}>{'━'.repeat(Math.min(title.length, cols))}</Text>
        <Text color={LOOK.hairline}>{'─'.repeat(Math.max(0, cols - title.length))}</Text>
      </Box>
    </Box>
  )

  const tracker = (current: number) => {
    const full = STEPS.reduce((n, s) => n + s.length + 2, 0) + (STEPS.length - 1) * 4
    if (cols < full) {
      return (
        <Text color={LOOK.muted}>
          {fit(`Step ${current + 1} of 4 · `, cols)}
          <Text color={LOOK.gold} bold>
            {STEPS[current]}
          </Text>
        </Text>
      )
    }

    return (
      <Box flexDirection="row">
        {STEPS.map((step, i) => (
          <Text key={`step-${i}`} color={i < current ? LOOK.good : i === current ? LOOK.gold : LOOK.muted} bold={i === current}>
            {i < current ? '✓' : i === current ? '●' : '○'} {step}
            <Text color={LOOK.hairline}>{i < STEPS.length - 1 ? ' ── ' : ''}</Text>
          </Text>
        ))}
      </Box>
    )
  }

  const page = (...rows: (RenderElement | RenderElement[] | null | false)[]) => (
    <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
      {head}
      {rows}
    </Box>
  )

  const cancelChip = chip('cancel', 'Cancel', 'quiet', () => void actions.cancel())

  if (flow === null) {
    return page(<Text color={LOOK.muted}>{fit('Nothing to refine. Type /refine followed by a prompt.', cols)}</Text>)
  }

  if (flow.step === 'history') {
    const rows = draw.history.map(entry => {
      const stamp = when(entry.at)

      return (
        <Button key={`history-${entry.id}`} plain label={fit(entry.original, cols)} onPress={() => void actions.reopen(entry)}>
          <Text color={LOOK.muted}>{stamp}  </Text>
          <Text color={LOOK.text}>{fit(entry.original, Math.max(4, cols - stamp.length - 2))}</Text>
        </Button>
      )
    })

    return page(
      heading('Last 20 refined prompts'),
      rows.length > 0 ? (
        <Box flexDirection="column">{rows}</Box>
      ) : (
        <Text color={LOOK.muted}>{fit('No refined prompts yet. Try /refine followed by a prompt.', cols)}</Text>
      ),
      chip('close', 'Close', 'quiet', () => void actions.cancel()),
    )
  }

  const current = stepIndex(flow)

  if (flow.step === 'compose') {
    return page(
      tracker(current),
      heading('Your prompt'),
      Input ? (
        <Input
          key="compose"
          placeholder="Type or paste your prompt"
          value={flow.original}
          submitLabel="Refine"
          autoFocus
          onSubmit={value => void actions.compose(value)}
        />
      ) : (
        <Text color={LOOK.muted}>{fit('Type /refine followed by your prompt.', cols)}</Text>
      ),
      cancelChip,
    )
  }

  if (flow.step === 'reading' || flow.step === 'asking' || flow.step === 'rewriting') {
    const line =
      flow.step === 'reading'
        ? 'Reading your prompt.'
        : flow.step === 'asking'
          ? 'Finding the questions that would help most.'
          : 'Writing the refined prompt with your answers.'

    return page(
      tracker(current),
      card('original', 'Your prompt', flow.original, LOOK.hairline, cols, LOOK.muted),
      <Text color={LOOK.muted}>{fit(line, cols)}</Text>,
      cancelChip,
    )
  }

  if (flow.step === 'error') {
    return page(
      tracker(current),
      <Box flexDirection="column" borderStyle="round" borderColor={LOOK.warn} paddingX={1} width={cols}>
        <Text color={LOOK.warn} bold>
          {fit('Something went wrong.', cols - 4)}
        </Text>
        <Text color={LOOK.text}>Your prompt is safe. {flow.error ?? ''}</Text>
      </Box>,
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {chip('retry', 'Try again', 'gold', () => void actions.retry())}
        {chip('send-original', 'Send my original', 'slate', () => void actions.sendOriginal())}
        {cancelChip}
      </Box>,
    )
  }

  if (flow.step === 'questions') {
    const answered = flow.answers.filter(a => a.state !== 'open').length
    const blocks = flow.questions.map((q, i) => {
      const a = flow.answers[i] ?? { state: 'open', value: '' }
      const badge =
        a.state === 'answered' ? (
          <Text backgroundColor={LOOK.good} color={LOOK.ink} bold>
            {' ✓ '}
          </Text>
        ) : (
          <Text backgroundColor={a.state === 'skipped' ? LOOK.slate : LOOK.gold} color={a.state === 'skipped' ? LOOK.muted : LOOK.ink} bold>
            {` ${i + 1} `}
          </Text>
        )
      const isOther = a.state === 'answered' && !q.options.includes(a.value)

      return (
        <Box key={`q-${i}`} flexDirection="column">
          <Box flexDirection="row">
            {badge}
            <Text color={a.state === 'skipped' ? LOOK.muted : LOOK.text}> {fit(q.question, cols - 4)}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={4}>
            {q.options.map((option, j) =>
              chip(`q-${i}-o-${j}`, option, a.state === 'answered' && a.value === option ? 'picked' : 'slate', () =>
                void actions.choose(i, option),
              ),
            )}
            {chip(`q-${i}-other`, isOther ? fit(a.value, 28) : 'Other (type it)', isOther ? 'picked' : 'slate', () => void actions.other(i))}
            {chip(`q-${i}-skip`, a.state === 'skipped' ? 'Skipped' : 'Skip', 'quiet', () => void actions.skip(i))}
          </Box>
          {flow.otherFor === i && Input ? (
            <Box paddingLeft={4}>
              <Input
                key={`q-${i}-input`}
                placeholder="Type your answer"
                submitLabel="Use this"
                autoFocus
                onSubmit={value => void actions.otherText(i, value)}
              />
            </Box>
          ) : null}
        </Box>
      )
    })

    return page(
      tracker(current),
      heading(`Questions · ${answered} of ${flow.questions.length} answered`),
      <Box flexDirection="column" gap={1}>
        {blocks}
      </Box>,
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {chip('skip-rest', 'Skip the rest, refine now', 'gold', () => void actions.skipRest())}
        {cancelChip}
      </Box>,
    )
  }

  // Review.
  const before = words(flow.original)
  const after = words(flow.rewrite)
  const tile = (key: string, n: number, label: string, color: string) => {
    const digits = bigNumber(n)

    return (
      <Box key={key} flexDirection="column" alignItems="center" borderStyle="round" borderColor={LOOK.hairline} paddingX={1}>
        {digits.map((row, i) => (
          <Text key={`${key}-${i}`} color={color}>
            {row}
          </Text>
        ))}
        <Text color={LOOK.muted}>{label}</Text>
      </Box>
    )
  }
  const numbers =
    cols >= 60 ? (
      <Box flexDirection="row" columnGap={1}>
        {tile('before', before, 'WORDS BEFORE', LOOK.muted)}
        {tile('after', after, 'WORDS AFTER', LOOK.gold)}
        {tile('added', flow.added.length, 'DETAILS ADDED', LOOK.good)}
      </Box>
    ) : (
      <Text color={LOOK.text}>
        {fit(`${before} → ${after} words · ${flow.added.length} details added`, cols)}
      </Text>
    )

  const blanks = blanksIn(flow.rewrite)
  const buttons = (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {chip('run', 'Use it', 'gold', () => void actions.run())}
      {blanks.length > 0 ? chip('fill', `Fill blanks (${blanks.length})`, 'slate', () => void actions.fill()) : null}
      {chip('edit', 'Edit', 'slate', () => void actions.edit())}
      {chip('copy', flow.isCopied ? 'Copied' : 'Copy', 'slate', () => void actions.copy(draw.surface))}
      {cancelChip}
    </Box>
  )

  const added =
    flow.added.length > 0 ? (
      <Box flexDirection="column">
        {heading('What I added')}
        {flow.added.map((note, i) => (
          <Text key={`added-${i}`} color={LOOK.text}>
            <Text color={LOOK.good}>{'+ '}</Text>
            {fit(note, cols - 2)}
          </Text>
        ))}
      </Box>
    ) : null

  // One card: the upgrade, with every added phrase underlined and every unknown left as a blank to fill.
  const summary = `your ${before} words became ${after} · ${flow.added.length} details added${blanks.length > 0 ? ` · ${blanks.length} blanks to fill` : ''}`
  const filling =
    flow.isFilling && Input && blanks.length > 0 ? (
      <Box flexDirection="column">
        {heading('Fill the blanks')}
        {blanks.map((blank, i) => (
          <Box key={`blank-${i}`} flexDirection="column">
            <Text color={LOOK.highlight}>{fit(blank, cols)}</Text>
            <Input key={`blank-input-${i}`} placeholder="Type what goes here" submitLabel="Fill" autoFocus={i === 0 ? true : undefined} onSubmit={value => void actions.setBlank(blank, value)} />
          </Box>
        ))}
      </Box>
    ) : null
  const upgrade =
    flow.isEditing && Input ? (
      <Box key="upgrade" flexDirection="column" borderStyle="round" borderColor={LOOK.gold} paddingX={1} width={cols}>
        <Text color={LOOK.gold}>{fit('REFINED · EDITING', cols - 4)}</Text>
        <Input key="edit" value={flow.rewrite} submitLabel="Use it" autoFocus onSubmit={value => void actions.saveEdit(value)} />
        <Text color={LOOK.muted}>{fit('Enter runs it.', cols - 4)}</Text>
      </Box>
    ) : (
      <Box key="upgrade" flexDirection="column" borderStyle="round" borderColor={LOOK.gold} paddingX={1} width={cols}>
        <Text color={LOOK.gold}>{fit('REFINED', cols - 4)}</Text>
        <Text color={LOOK.text}>
          {marks(flow.original, flow.rewrite).map((mark, i) =>
            mark.kind === 'same' ? (
              mark.text
            ) : (
              <Text key={`mark-${i}`} color={mark.kind === 'blank' ? LOOK.highlight : LOOK.gold} underline={mark.kind === 'added'} bold={mark.kind === 'blank'}>
                {mark.text}
              </Text>
            ),
          )}
        </Text>
        <Text color={LOOK.muted}>{fit(`from: ${flow.original}`, cols - 4)}</Text>
      </Box>
    )

  return page(
    tracker(current),
    numbers,
    <Text color={LOOK.muted}>{fit(summary, cols)}</Text>,
    buttons,
    filling,
    upgrade,
    added,
  )
}
