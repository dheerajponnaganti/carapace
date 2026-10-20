import { expect, test } from 'claude-code/testing'

import { bubbles } from '../footer/footer-logic'

import {
  TIDE_GLYPHS,
  depthLabel,
  depthLabelWidth,
  mergeRuns,
  diveConnector,
  easedValue,
  narrowConnector,
  refillTime,
  riseDots,
  riseLevel,
  riseStep,
  tide,
  tideLevel,
  wipeName,
} from './bar-art'

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

test('the tide is as wide as asked, with glyphs from the wave set only', () => {
  const cells = tide(24, 2.6, 3)
  expect(cells.length).toBe(24)
  for (const cell of cells) expect((TIDE_GLYPHS as readonly string[]).includes(cell.glyph)).toBe(true)
  expect(tide(0, 2.6, 3).length).toBe(0)
  expect(near(tideLevel(0), 0.6)).toBe(true)
  expect(near(tideLevel(100), 3.8)).toBe(true)
})

test('the tide rolls: a new phase moves the crests', () => {
  const at = (phase: number) => tide(24, 2.6, phase).map(cell => cell.glyph).join('')
  expect(at(0)).not.toBe(at(1))
})

test('the rise climbs in eight quarter-second frames, then stops at the top', () => {
  expect(riseStep(0)).toBe(0)
  expect(riseStep(600)).toBe(2)
  expect(riseStep(2000)).toBe(8)
  expect(riseStep(9999)).toBe(8)
  expect(near(riseLevel(8), 4.4)).toBe(true)
  expect(riseDots(2).length).toBe(10)
})

test('depth labels run 0 m, 12 m, 24 m in four cells', () => {
  expect(depthLabel(0)).toBe(' 0 m ')
  expect(depthLabel(1)).toBe('12 m ')
  expect(depthLabel(2)).toBe('24 m ')
})

test('connectors: the first row hangs, the middle joins, the last closes, one row runs straight', () => {
  expect([0, 1, 2].map(row => diveConnector(row, 3))).toEqual(['─┬─ ', ' ├─ ', ' └─ '])
  expect(diveConnector(0, 1)).toBe('──  ')
  for (const row of [0, 1, 2]) expect(diveConnector(row, 3).length).toBe(4)
  expect(narrowConnector(0, 3)).toBe('┬─ ')
  expect(narrowConnector(1, 3)).toBe('├─ ')
  expect(narrowConnector(2, 3)).toBe('└─ ')
  expect(narrowConnector(0, 1)).toBe('└─ ')
})

test('a refill shows the local clock time, lowercase', () => {
  expect(refillTime(new Date(2026, 9, 14, 16, 10).toISOString())).toBe('4:10 pm')
  expect(refillTime(new Date(2026, 9, 14, 0, 5).toISOString())).toBe('12:05 am')
  expect(refillTime(new Date(2026, 9, 14, 12, 0).toISOString())).toBe('12:00 pm')
  expect(refillTime(null)).toBe('')
  expect(refillTime('not a time')).toBe('')
})

test('the gauge eases from the old value to the new one and lands on it', () => {
  expect(near(easedValue(10, 50, 0), 10)).toBe(true)
  expect(near(easedValue(10, 50, 500), 45)).toBe(true)
  expect(near(easedValue(10, 50, 1000), 50)).toBe(true)
  expect(near(easedValue(10, 50, 5000), 50)).toBe(true)
})

test('a new step draws in from the left over half a second', () => {
  expect(wipeName('Build it', undefined, 0)).toBe('Build it')
  expect(wipeName('Build it', 0, 0)).toBe('')
  expect(wipeName('Build it', 0, 250)).toBe('Buil')
  expect(wipeName('Build it', 0, 500)).toBe('Build it')
})

test('bubbles rise: a dot, a ring on the low row, a ring on the high row, then a pop', () => {
  const column = [0, 1, 2, 3, 4].map(frame => {
    const field = bubbles(8, frame)

    return field.low[0] + field.high[0]
  })
  expect(column).toEqual(['· ', '∘ ', ' ∘', ' °', '  '])
})

test('the bubble field is two rows of eight, sparse, and only the bubble glyphs', () => {
  const field = bubbles(8, 0)
  expect(field.low.length).toBe(8)
  expect(field.high.length).toBe(8)
  const up = [...field.low, ...field.high].filter(ch => ch !== ' ')
  expect(up.length).toBeGreaterThan(0)
  expect(up.length).toBeLessThan(8)
  for (const ch of up) expect(['·', '∘', '°'].includes(ch)).toBe(true)
  expect(bubbles(0, 0).low.length).toBe(0)
})

test('mergeRuns joins adjacent same-colored cells and keeps characters and colors in order', () => {
  const cells = [
    { text: 'a', color: 'x' },
    { text: 'b', color: 'x' },
    { text: 'c', color: 'y' },
    { text: 'd', color: 'x' },
  ]
  const runs = mergeRuns(cells)

  expect(runs).toEqual([
    { text: 'ab', color: 'x' },
    { text: 'c', color: 'y' },
    { text: 'd', color: 'x' },
  ])
  expect(runs.flatMap(run => [...run.text].map(() => run.color))).toEqual(cells.map(cell => cell.color))
})
