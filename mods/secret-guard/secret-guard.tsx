import { atom, update } from 'claude-code'
import type { On } from 'claude-code'

import { denyReason, maskDeep, secretTarget } from './secret-logic'

const OFF_KEY = 'secretGuard:off'
const blockedAtom = atom({ plugin: 'carapace', key: 'secretGuardBlocked' } as const, 0)
const maskedAtom = atom({ plugin: 'carapace', key: 'secretGuardMasked' } as const, 0)

export function registerSecretGuard(on: On): void {
  // Paths the person allowed once; a reload clears them, which is the safe side.
  const allowed = new Set<string>()
  let blocked = 0
  let masked = 0

  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    await $.command.register({ name: 'secrets', description: 'Secret guard: status, on, off, allow <path>', argumentHint: '[on|off|allow <path>]' })

    return next(e)
  })

  // The matcher /./ matches every tool: masking covers all results, blocking only Read, Grep and Bash.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    if ((await $.store.get(OFF_KEY)) === true) return next(e)
    const path = secretTarget(e.tool, e as unknown as Record<string, unknown>)
    if (path !== null) {
      if (allowed.delete(path)) return next(e)
      blocked++
      await update($, blockedAtom, () => blocked)
      return { deny: denyReason(path) }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const m = maskDeep(ran)
    if (m.count === 0) return ran
    masked += m.count
    await update($, maskedAtom, () => masked)
    const { ref: _ref, ...rest } = m.value as typeof ran & { ref?: number }

    return rest as typeof ran
  }).catch(($, e, next) => next(e)) // a guard bug must not stop every tool; fails open

  on('command.run', { command: 'secrets' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'on' || args === 'off') await $.store.set(OFF_KEY, args === 'off')
    else if (args.startsWith('allow ') && args.slice(6).trim() !== '') {
      allowed.add(args.slice(6).trim())
      return { text: `Allowed once: ${args.slice(6).trim()}. The next read of that path goes through.` }
    }
    const isOn = (await $.store.get(OFF_KEY)) !== true

    return { text: `Secret guard is ${isOn ? 'on' : 'off'}. This session: ${blocked} blocked, ${masked} masked.` }
  })
}
