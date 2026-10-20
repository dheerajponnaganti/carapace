import { expect, test } from 'claude-code/testing'

import { cells, cutCells, fit, padCells } from './look'

test('cells counts terminal cells: wide characters and emoji take two, marks none', () => {
  expect(cells('abc')).toBe(3)
  expect(cells('漢字')).toBe(4)
  expect(cells('👨‍👩‍👧')).toBe(2)
  expect(cells('🇮🇪')).toBe(2)
  expect(cells('é')).toBe(1)
  expect(cells('◆ Crew ✓')).toBe(8)
})

test('fit cuts by cells and never splits a character', () => {
  expect(fit('plain ascii title', 10)).toBe('plain asc…')
  expect(fit('漢字漢字漢字', 7)).toBe('漢字漢…')
  expect(cutCells('👨‍👩‍👧 family', 1)).toBe('')
  const title = 'Fix 🔥 the 漢字 login 🇮🇪 page'
  for (const width of [5, 8, 11, 14]) {
    const cut = cells(fit(title, width))
    expect(cut <= width && cut >= width - 1).toBe(true)
  }
})

test('padCells pads to a cell width', () => {
  expect(cells(padCells('漢字', 6))).toBe(6)
  expect(padCells('ab', 4)).toBe('ab  ')
})
