import { expect, test } from 'claude-code/testing'

import { safeText, safeTree, wantsSafe } from '../shared/safe-glyphs'
import { cells } from '../shared/look'

test('every symbol carapace draws has a one-cell stand-in, and trees keep their shape', () => {
  expect(safeText('◇ Build · 2s ▼ 30% ━━━─── ▂▃▅ ✓ ⌬ Shipyard')).toBe('o Build . 2s v 30% ===--- _-= v # Shipyard')
  for (const ch of safeText('─━┬├└▁▂▃▄▅●○◆◇◉✓✕▸▼·°…‖⋯⚑⚓⛁')) expect(cells(ch)).toBe(1)
  const tree = { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['━━ ok'] }, { type: 'Button', props: { label: '⌬ Shipyard' } }, { type: 'engine', ref: 2 }] }
  expect(safeTree(tree)).toEqual({ type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['== ok'] }, { type: 'Button', props: { label: '# Shipyard' } }, { type: 'engine', ref: 2 }] })
})

test('safe symbols turn on in the old Windows console, or when asked; never in Windows Terminal or an editor unless asked', () => {
  expect(wantsSafe(undefined, { os: 'Windows_NT' })).toBe(true)
  expect(wantsSafe('auto', { os: 'Windows_NT', wt: 'abc' })).toBe(false)
  expect(wantsSafe(undefined, { os: 'Windows_NT', term: 'vscode' })).toBe(false)
  expect(wantsSafe(undefined, {})).toBe(false)
  expect(wantsSafe('on', {})).toBe(true)
  expect(wantsSafe('off', { os: 'Windows_NT' })).toBe(false)
  expect(wantsSafe('auto', { ascii: '1' })).toBe(true)
})
