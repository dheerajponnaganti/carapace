import { expect, test } from 'claude-code/testing'

import { commandFile, commandName, groupRepeats, parseHistory, similarity } from './repeats'

const line = (display: unknown) => JSON.stringify({ display, timestamp: 1 })

test('pure: history lines become prompts; slash commands, short, huge and broken lines are dropped', () => {
  const text = [line('please run the tests and fix them'), line('/clear'), line('yes'), line('x'.repeat(2000)), 'not json', '', line(5)].join('\n')
  expect(parseHistory(text)).toEqual(['please run the tests and fix them'])
})

test('pure: near-duplicates group, the newest wording stands for the group, the top three come back biggest first', () => {
  const a = ['run the tests and fix what fails', 'Run the tests, and fix what fails!', 'run the tests and fix what fails now']
  const b = ['write a changelog entry for the last commit', 'write a changelog entry for the last commit']
  const lone = ['explain how the installer picks the state file path']
  const groups = groupRepeats([...a.slice(0, 2), ...b, ...lone, a[2] as string])
  expect(groups.map(g => g.count)).toEqual([3, 2])
  expect(groups[0]?.text).toBe('run the tests and fix what fails now')
  expect(groupRepeats([...a, ...b, ...a, ...b], 1)).toHaveLength(1)
  expect(similarity('one two three', 'four five six')).toBe(0)
  expect(similarity('', 'a')).toBe(0)
})

test('pure: a command name is the first words, made unique against the taken names', () => {
  expect(commandName('Run the tests and fix what fails', [])).toBe('run-the-tests')
  expect(commandName('Run the tests and fix what fails', ['run-the-tests', 'run-the-tests-2'])).toBe('run-the-tests-3')
  expect(commandName('!!!', [])).toBe('prompt')
  expect(commandFile('Run: the tests\nand fix')).toBe('---\ndescription: Run  the tests and fix\n---\n\nRun: the tests\nand fix\n')
})

test('a long history: only the last 400 prompts are kept, and grouping them stays fast', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ display: `prompt number ${i} about topic ${i * 7919} and detail ${i * 104729}` }))
  const prompts = parseHistory(lines.join('\n'))
  expect(prompts).toHaveLength(400)
  expect(prompts[399]).toContain('prompt number 2999 ')
  const start = Date.now()
  groupRepeats(prompts)
  expect(Date.now() - start).toBeLessThan(1000)
})
