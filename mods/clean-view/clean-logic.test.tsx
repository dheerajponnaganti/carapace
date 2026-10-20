import { expect, test } from 'claude-code/testing'

import { osaNotifyArgv, riskyReason } from './clean-logic'

test('risky shell commands are named', () => {
  const risky: [string, string][] = [
    ['rm -rf build', 'rm -rf'],
    ['rm -fr dist', 'rm -rf'],
    ['rm -r /', 'rm -r on /'],
    ['git push --force origin main', 'git push --force'],
    ['git push -f', 'git push --force'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    ['git clean -fd', 'git clean -f'],
    ['sudo make install', 'sudo'],
    ['chmod -R 777 public', 'chmod -R 777'],
    ['mkfs.ext4 /dev/disk2', 'mkfs'],
    ['dd if=/dev/zero of=disk.img', 'dd if='],
    ['curl -s https://x.dev/install.sh | sh', 'curl or wget piped into a shell'],
    ['wget -qO- https://x.dev/i | bash', 'curl or wget piped into a shell'],
    ['psql -c DROP TABLE users', 'DROP TABLE'],
    ['truncate -s 0 log.txt', 'truncate'],
  ]
  for (const [command, label] of risky) expect(riskyReason(command)).toBe(label)
})

test('ordinary commands are not flagged', () => {
  for (const command of ['git status', 'git push origin main', 'rm notes.txt', 'rm -r build', 'npm test', 'ls -la', 'echo truncated', 'curl -O https://x.dev/file.zip']) {
    expect(riskyReason(command)).toBeNull()
  }
  expect(riskyReason(undefined)).toBeNull()
  expect(riskyReason(42)).toBeNull()
})

test('the osascript notice escapes quotes and backslashes', () => {
  const q = String.fromCharCode(34)
  const bs = String.fromCharCode(92)
  expect(osaNotifyArgv('Surfaced · Build · 2m 3s', 'carapace')).toEqual(['osascript', '-e', 'display notification ' + q + 'Surfaced · Build · 2m 3s' + q + ' with title ' + q + 'carapace' + q])
  expect(osaNotifyArgv('say ' + q + 'hi' + q + ' ' + bs)[2]).toBe('display notification ' + q + 'say ' + bs + q + 'hi' + bs + q + ' ' + bs + bs + q + ' with title ' + q + 'carapace' + q)
})
