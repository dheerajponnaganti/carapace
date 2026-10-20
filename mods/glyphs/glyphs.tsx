import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import { safeTree, wantsSafe } from '../shared/safe-glyphs'

/** Store key: the person's choice from /mods glyphs (on, off or auto). */
export const GLYPHS_KEY = 'glyphsChoice'
const safeAtom = atom({ plugin: 'carapace', key: 'glyphsSafe' } as const, false)

// Registered first, so its render hook wraps every drawing carapace makes and swaps wide-drawn symbols when asked.
export function registerGlyphs(on: On): void {
  on('session.start', { cwd: /[\w\W]/ }, async ($, e, next) => {
    const env = { os: await $.env.get('OS'), wt: await $.env.get('WT_SESSION'), term: await $.env.get('TERM_PROGRAM'), ascii: await $.env.get('CARAPACE_ASCII') }
    const isSafe = wantsSafe(await $.store.get(GLYPHS_KEY), env)
    await update($, safeAtom, () => isSafe)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', async ($, e, next) => {
    const drawn = await next(e)

    return (await read($, safeAtom)) ? safeTree(drawn) : drawn
  }).catch(($, e, next) => next(e))
}
