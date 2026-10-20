// Shared building blocks. Each takes the surface's elements and a palette, so every pane matches by construction.
// No `$` here: handlers arrive as plain functions from the mod that draws.
import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import { bigText, bigWidth } from './big-number'
import { fit, padCells, padStartCells, spaced } from './look'
import type { Palette } from './look'

export type Els = Elements[RenderSurface]
export type ChipKind = 'primary' | 'secondary' | 'quiet'

/** The halo around a focused title: '░▒ ' before it and ' ▒░' after, three cells each side. */
export function titleLit(els: Els, pal: Palette, label: string, isFocused?: boolean): RenderElement {
  const { Text } = els
  if (!isFocused) return <Text bold color={pal.text}>{label}</Text>

  return (
    <Text>
      <Text color={pal.halo2}>{'░'}</Text>
      <Text color={pal.halo}>{'▒'}</Text>
      <Text>{' '}</Text>
      <Text bold color={pal.text}>{label}</Text>
      <Text>{' '}</Text>
      <Text color={pal.halo}>{'▒'}</Text>
      <Text color={pal.halo2}>{'░'}</Text>
    </Text>
  )
}

/** A pane title in spaced capitals, an accent rule its width that fades into the halo, then a hairline to the edge. */
export function paneTitle(els: Els, pal: Palette, text: string, cols: number, right?: RenderElement, isFocused?: boolean): RenderElement {
  const { Box, Text } = els
  // A focused title gives up its six halo cells.
  const label = fit(spaced(text.toUpperCase()), isFocused ? Math.max(1, cols - 6) : cols)

  return (
    <Box flexDirection="column" width={cols}>
      <Box flexDirection="row" justifyContent="space-between">
        {titleLit(els, pal, label, isFocused)}
        {right ?? null}
      </Box>
      <Box flexDirection="row">
        <Text color={pal.accent}>{'━'.repeat(Math.min(label.length, cols))}</Text>
        <Text color={pal.halo}>{cols - label.length >= 1 ? '━' : ''}</Text>
        <Text color={pal.halo2}>{cols - label.length >= 2 ? '━' : ''}</Text>
        <Text color={pal.hairline}>{'─'.repeat(Math.max(0, cols - label.length - 2))}</Text>
      </Box>
    </Box>
  )
}

/** Small muted capitals, then a hairline to the edge. */
export function heading(els: Els, pal: Palette, text: string, cols: number): RenderElement {
  const { Box, Text } = els
  const caps = fit(text.toUpperCase(), cols - 2)

  return (
    <Box flexDirection="row">
      <Text color={pal.muted}>{caps} </Text>
      <Text color={pal.hairline}>{'─'.repeat(Math.max(0, cols - caps.length - 1))}</Text>
    </Box>
  )
}

/** A pressable chip: primary is filled with the accent, secondary sits on slate, quiet is muted text. */
export function chip(els: Els, pal: Palette, key: string, label: string, kind: ChipKind, onPress: () => void, hotkey?: string): RenderElement {
  const { Box, Button, Text } = els
  if (kind === 'quiet') {
    return (
      <Button key={key} plain label={label} hotkey={hotkey} onPress={onPress}>
        <Text color={pal.muted}>{label}</Text>
      </Button>
    )
  }
  const isPrimary = kind === 'primary'

  return (
    // The keyed Box is what the pointer hovers: the chip glows with the halo under it.
    <Box key={`${key}-glow`}>
      <Button key={key} plain label={label} hotkey={hotkey} onPress={onPress} hover={{ backgroundColor: isPrimary ? pal.text : pal.halo }}>
        {isPrimary ? (
          // The selected chip sits in a one-cell halo on each side.
          <Text>
            <Text backgroundColor={pal.halo}>{' '}</Text>
            <Text backgroundColor={pal.accent} color={pal.onAccent} bold>{` ${label} `}</Text>
            <Text backgroundColor={pal.halo}>{' '}</Text>
          </Text>
        ) : (
          <Text backgroundColor={pal.slate} color={pal.text}>
            {` ${label} `}
          </Text>
        )}
      </Button>
    </Box>
  )
}

/** A rounded tile with a three-row numeral, or plain bold text when the numeral will not fit. */
export function tile(els: Els, pal: Palette, key: string, value: string, label: string, color: string, width: number): RenderElement {
  const { Box, Text } = els
  const inner = Math.max(1, width - 4)

  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={pal.hairline} paddingX={1} width={width}>
      {bigWidth(value) <= inner ? (
        bigText(value).map((row, i) => (
          <Text key={`${key}-${i}`} color={color}>
            {row}
          </Text>
        ))
      ) : (
        <Text color={color} bold>
          {fit(value, inner)}
        </Text>
      )}
      <Text color={pal.muted}>{fit(label.toUpperCase(), inner)}</Text>
    </Box>
  )
}

/** Tiles in rows of three, then two, then one as the pane narrows. */
export function tileRow(els: Els, cols: number, make: (width: number) => RenderElement[]): RenderElement {
  const { Box } = els
  const perRow = cols >= 66 ? 3 : cols >= 44 ? 2 : 1
  const width = Math.floor((cols - (perRow - 1)) / perRow)

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={cols}>
      {make(width)}
    </Box>
  )
}

/** A heavy meter: filled cells in `color`, the rest as hairline. */
export function meter(els: Els, pal: Palette, percent: number, width: number, color: string): RenderElement {
  const { Text } = els
  const w = Math.max(1, width)
  const n = Math.round((Math.min(100, Math.max(0, percent)) / 100) * w)

  return (
    <Text>
      <Text color={color}>{'━'.repeat(n)}</Text>
      <Text color={pal.hairline}>{'─'.repeat(w - n)}</Text>
    </Text>
  )
}

/** A labeled bar sized to the pane, with a short tail on the right. */
export function barRow(els: Els, pal: Palette, key: string, label: string, share: number, color: string, tail: string, cols: number, isQuiet = false): RenderElement {
  const { Box, Text } = els
  const labelW = Math.min(18, Math.max(8, Math.floor(cols * 0.28)))
  const tailW = Math.min(14, tail.length + 2)
  const barW = Math.max(4, cols - labelW - tailW - 2)
  const filled = Math.round(Math.min(1, Math.max(0, share)) * barW)

  return (
    <Box key={key} flexDirection="row">
      <Text color={isQuiet ? pal.muted : pal.text}>{padCells(fit(label, labelW), labelW)} </Text>
      <Text color={color}>{'━'.repeat(filled)}</Text>
      <Text color={pal.hairline}>{'─'.repeat(barW - filled)}</Text>
      <Text color={isQuiet ? pal.muted : pal.text}>{` ${padStartCells(fit(tail, tailW - 1), tailW - 1)}`}</Text>
    </Box>
  )
}

/** A rounded card with a small capital title. */
export function card(els: Els, pal: Palette, key: string, title: string, body: RenderElement | string, border: string, width: number): RenderElement {
  const { Box, Text } = els

  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} width={width}>
      {title ? <Text color={border === pal.hairline ? pal.muted : border}>{fit(title.toUpperCase(), Math.max(1, width - 4))}</Text> : null}
      {typeof body === 'string' ? <Text color={pal.text}>{body}</Text> : body}
    </Box>
  )
}

/** The calm empty state every pane uses. */
export function emptyState(els: Els, pal: Palette, text: string, cols: number): RenderElement {
  const { Box, Text } = els

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={pal.hairline} paddingX={1} width={cols}>
      <Text color={pal.text}>{text}</Text>
    </Box>
  )
}
