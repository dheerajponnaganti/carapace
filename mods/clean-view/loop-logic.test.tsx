import { expect, test } from 'claude-code/testing'

import { detect, normalise, push, similarity } from './loop-logic'
import type { LoopEvent } from './loop-logic'

const bash = (command: string, text: string, isError = true): LoopEvent => ({ tool: 'Bash', isError, text, command })
const edit = (file: string, after: string): LoopEvent => ({ tool: 'Edit', isError: false, text: '', file, after })
const run = (events: LoopEvent[]) => events.reduce<LoopEvent[]>((h, ev) => push(h, ev), [])

test('normalise hides numbers, paths, times and hashes', () => {
  const a = normalise('Error at /Users/me/app/src/a.ts:12 on 2026-10-18T10:00:01Z commit deadbeef1 took 35ms')
  const b = normalise('Error at /tmp/x/b.ts:99 on 2026-11-01 08:15:22 commit 0123abcd9 took 7ms')
  expect(a).toBe(b)
})

test('similarity is high for one error with different numbers, low for different errors', () => {
  expect(similarity('TypeError: x is undefined at line 4', 'TypeError: x is undefined at line 99')).toBeGreaterThanOrEqual(0.8)
  expect(similarity('TypeError: x is undefined', 'ENOENT: no such file or directory')).toBeLessThan(0.3)
})

test('the same failing command three times is a loop, twice is not', () => {
  const two = run([bash('npm test', 'fail A'), bash('npm test', 'fail B')])
  expect(detect(two)).toBeNull()
  const three = push(two, bash('npm   test', 'fail C'))
  expect(detect(three)).toMatchObject({ kind: 'command', tries: 3, line: 'fail C' })
})

test('the same command with only a number changed counts as the same', () => {
  const h = run([bash('node run.js --port 3001', 'boom'), bash('node run.js --port 3002', 'bam'), bash('node run.js --port 3003', 'bim')])
  expect(detect(h)?.tries).toBe(3)
})

test('a passing run of the command does not count as a try', () => {
  const h = run([bash('npm test', 'x'), bash('npm test', '', false), bash('npm test', 'y')])
  expect(detect(h)).toBeNull()
})

test('three near-identical failures from different commands are a loop', () => {
  const h = run([bash('a', 'Error: cannot find module /a/1.js'), bash('b', 'Error: cannot find module /b/22.js'), bash('c', 'Error: cannot find module /c/3.js\nstack')])
  expect(detect(h)).toMatchObject({ kind: 'error', tries: 3 })
})

test('three different failures are not a loop', () => {
  const h = run([bash('a', 'permission denied'), bash('b', 'module not found'), bash('c', 'syntax error near token')])
  expect(detect(h)).toBeNull()
})

test('a different result in between clears the run', () => {
  const h = run([bash('a', 'same error here'), bash('b', 'same error here'), bash('c', 'all fine', false)])
  expect(detect(h)).toBeNull()
  expect(detect(push(h, bash('d', 'same error here')))).toBeNull()
})

test('editing a file back and forth is a loop', () => {
  expect(detect(run([edit('a.ts', 'A'), edit('a.ts', 'B'), edit('a.ts', 'A')]))).toBeNull()
  expect(detect(run([edit('a.ts', 'A'), edit('a.ts', 'B'), edit('a.ts', 'A'), edit('a.ts', 'B')]))).toMatchObject({ kind: 'edit', tries: 4 })
})

test('steady progress on one file or flips across files are not a loop', () => {
  expect(detect(run([edit('a.ts', 'A'), edit('a.ts', 'B'), edit('a.ts', 'C'), edit('a.ts', 'D')]))).toBeNull()
  expect(detect(run([edit('a.ts', 'A'), edit('b.ts', 'B'), edit('a.ts', 'A'), edit('b.ts', 'B')]))).toBeNull()
})
